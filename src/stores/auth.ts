import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/ProfileService';
import { useChatStore } from '@/stores/useChat';
import { UserStatus } from '@/types';
import router from '@/router';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as Session | null,
    isPasswordResetMode: false, // Flag to track if we're in password reset flow
  }),
  getters: {
    isLoggedIn: (state) => {
      // Don't treat recovery sessions as logged in - user must complete password reset
      if (state.isPasswordResetMode) {
        return false;
      }
      return !!state.session;
    }
  },
  actions: {
    // Helper to decode JWT payload (without verification - just for reading AAL)
    decodeJWT(token: string): any {
      try {
        const base64Url = token.split('.')[1];
        const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        const jsonPayload = decodeURIComponent(atob(base64).split('').map(c => {
          return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
        }).join(''));
        return JSON.parse(jsonPayload);
      } catch (e) {
        console.error('Failed to decode JWT:', e);
        return null;
      }
    },

    // Helper to get AAL from session - must decode the JWT token
    getAAL(session: Session | null): string {
      if (!session) return 'none';
      
      // AAL is encoded in the JWT token, not directly on user object
      try {
        const decoded = this.decodeJWT(session.access_token);
        return decoded?.aal || 'aal1';
      } catch (e) {
        console.error('Failed to get AAL from token:', e);
        return 'aal1';
      }
    },

    /**
     * 🔒 CRITICAL SECURITY: Validate if session meets MFA requirements
     * 
     * Returns true if:
     * - User has no MFA enabled (AAL1 is sufficient)
     * - User has MFA enabled AND session is at AAL2
     * 
     * Returns false if:
     * - User has MFA enabled but session is at AAL1 (MFA not completed)
     * 
     * This prevents the MFA bypass vulnerability where:
     * 1. Tab A is logged in as UserA (no MFA)
     * 2. Tab B logs out then starts login as UserB (has MFA)
     * 3. Tab B creates AAL1 session before MFA verification
     * 4. Tab A refreshes and picks up Tab B's AAL1 session
     * 5. Without this check, Tab A would be logged in as UserB bypassing MFA!
     */
    async validateSessionForMFA(session: Session): Promise<boolean> {
      try {
        // Get the AAL from the session token
        const aal = this.getAAL(session);
        
        // If already at AAL2, session is valid
        if (aal === 'aal2') {
          console.log('✅ Session at AAL2 - MFA verified');
          return true;
        }
        
        // Session is at AAL1, need to check if user has MFA enabled
        const { data: factors, error } = await supabase.auth.mfa.listFactors();
        
        if (error) {
          console.error('❌ Failed to check MFA factors:', error);
          // On error, be conservative - reject the session
          return false;
        }
        
        const has2FA = factors?.totp?.some((f: any) => f.status === 'verified');
        
        if (has2FA) {
          // User has MFA but session is AAL1 - this is an incomplete login!
          console.warn('🚨 AAL1 session detected for user with MFA enabled - blocking access');
          return false;
        }
        
        // User doesn't have MFA, AAL1 is sufficient
        console.log('✅ Session at AAL1, no MFA required');
        return true;
        
      } catch (error) {
        console.error('❌ Error validating session MFA:', error);
        // On error, be conservative - reject the session
        return false;
      }
    },
    async initializeAuth() {
      const { data: getSessionData } = await supabase.auth.getSession();
      const session = getSessionData.session;
      
      // Check if we're on password reset page or have recovery token in URL
      // This handles the case where Supabase has already processed the recovery token
      // before the PASSWORD_RECOVERY event fires
      const currentPath = window.location.pathname;
      const hashParams = new URLSearchParams(window.location.hash.substring(1));
      const queryParams = new URLSearchParams(window.location.search);
      const type = hashParams.get('type') || queryParams.get('type');
      
      if (currentPath === '/reset-password' && (type === 'recovery' || session)) {
        // This is likely a recovery session - don't treat it as logged in
        console.log('🔒 Recovery session detected on initialization - entering password reset mode');
        this.isPasswordResetMode = true;
        // Keep the session - it's needed for updateUser to work
        // But isLoggedIn will return false because of isPasswordResetMode
        this.session = session;
      } else if (session) {
        // 🚨 CRITICAL SECURITY: Check AAL2 on session restoration
        // This prevents MFA bypass when another tab creates an AAL1 session
        // and this tab picks it up from localStorage on refresh
        const isValid = await this.validateSessionForMFA(session);
        
        if (isValid) {
          this.session = session;
        } else {
          console.warn('🚨 Session restoration blocked - AAL1 session with MFA enabled (MFA bypass prevented)');
          // Sign out the incomplete session to prevent other tabs from using it
          await supabase.auth.signOut();
          this.session = null;
        }
      } else {
        this.session = null;
      }

      // Initialize notification system for existing session
      if (this.session?.user?.id) {
        // DO NOT force status to online - let userDataService handle status properly
        this.setupOfflineHandlers(this.session.user.id);
        // Note: Notification system is now initialized by RouteAwareInitialization
        // to only load unread count initially (full list loads on-demand)
        
        // Initialize encryption service if user has keys
        this.initializeEncryptionIfAvailable(this.session.user.id);
      }

      supabase.auth.onAuthStateChange(async (event, session) => {
        const wasLoggedIn = !!this.session;
        const previousUserId = this.session?.user?.id;
        
        console.log(`🔐 Auth event: ${event}, AAL: ${this.getAAL(session)}`);
        
        // Handle PASSWORD_RECOVERY event - don't treat recovery sessions as full logins
        // When Supabase processes a recovery token, it creates a session and fires this event
        // We need to prevent this session from granting full app access
        if (event === 'PASSWORD_RECOVERY') {
          console.log('🔒 PASSWORD_RECOVERY event detected - entering password reset mode');
          
          // Set password reset mode flag - this prevents isLoggedIn from returning true
          this.isPasswordResetMode = true;
          
          // Keep the session - it's needed for updateUser({ password }) to work
          // The recovery session has special permissions to update password even with 2FA
          // But we prevent it from being treated as "logged in" via isPasswordResetMode
          this.session = session;
          
          // If not already on reset-password page, redirect there
          const currentPath = window.location.pathname;
          if (currentPath !== '/reset-password') {
            router.push('/reset-password');
          }
          
          return;
        }
        
        // Clear password reset mode on other auth events (like SIGNED_OUT or USER_UPDATED)
        if (event === 'SIGNED_OUT' || event === 'USER_UPDATED') {
          this.isPasswordResetMode = false;
        }
        
        // IMPORTANT: During MFA_CHALLENGE_VERIFIED, the AAL upgrade happens AFTER the event
        // So we must allow this event through without AAL checking
        if (event === 'MFA_CHALLENGE_VERIFIED') {
          console.log('✅ MFA challenge verified - allowing session through');
          this.session = session;
          
          if (session?.user?.id) {
            this.setupOfflineHandlers(session.user.id);
          }
          return; // Early return, skip AAL validation for this event
        }
        
        // 🚨 CRITICAL MFA ENFORCEMENT FOR ALL SESSION EVENTS
        // Validate AAL2 for any event that provides a session
        // This prevents MFA bypass via localStorage cross-tab contamination
        // 
        // The attack vector this protects against:
        // 1. Tab A has a valid session
        // 2. Tab B starts login for a user with MFA, creates AAL1 session  
        // 3. Tab A receives storage change event, gets AAL1 session
        // 4. Without this check, Tab A would accept the incomplete session
        if (session) {
          const isValid = await this.validateSessionForMFA(session);
          
          if (!isValid) {
            console.warn(`🚨 ${event} event with invalid AAL1 session (MFA enabled) - rejecting`);
            // Don't set the session - this is an incomplete MFA login from another tab
            // or an attempted bypass
            return;
          }
        }
        
        // Session is valid (either AAL2 with MFA, or AAL1 without MFA requirement)
        this.session = session;
        
        if (session?.user?.id) {
          this.setupOfflineHandlers(session.user.id);
        } else if (wasLoggedIn && previousUserId) {
          await this.setUserOffline(previousUserId);
          this.cleanupNotificationSystem();
        }
      });
    },

    async setUserOnline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Online);
        console.log('User set to online:', userId);
      } catch (error) {
        console.error('Error setting user online:', error);
      }
    },

    async setUserOffline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Offline);
        console.log('User set to offline:', userId);
      } catch (error) {
        console.error('Error setting user offline:', error);
      }
    },

    async initializeEncryptionIfAvailable(authUserId: string) {
      try {
        console.log('🔐 Initializing Megolm encryption service...');
        
        // Initialize the Megolm encryption service
        // The service internally converts auth_user_id to profile_id
        const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
        await megolmMessageEncryptionService.initialize(authUserId);
        
        // Check if user has recovery key set up
        const hasRecoveryKey = await megolmMessageEncryptionService.hasRecoveryKey();
        
        if (hasRecoveryKey) {
          console.log('🔐 User has recovery key set up');
          console.log('ℹ️ User needs to enter recovery phrase to unlock encryption');
          
          // Encryption is set up but NOT unlocked
          // User must enter recovery phrase in Settings > Encryption to unlock
        } else {
          console.log('ℹ️ Encryption service initialized but user has no recovery key yet');
          console.log('ℹ️ User can set up encryption in Settings > Encryption');
        }
      } catch (error) {
        console.error('❌ Failed to initialize encryption:', error);
      }
    },

    setupOfflineHandlers(_userId: string) {
      // Clean up any existing handlers first
      this.cleanupOfflineHandlers();
      
      // Handle browser/tab close - immediate cleanup and status update
      const handleBeforeUnload = (_event: BeforeUnloadEvent) => {
        // Immediately cleanup presence (this should trigger presence leave event)
        if ((window as any).__harmonyPresenceCleanup) {
          (window as any).__harmonyPresenceCleanup();
        }

        // For beforeunload, we rely primarily on the presence system cleanup
        // The presence "leave" event should automatically handle offline status for other users
        // We can't reliably do async Supabase calls here due to timing constraints
      };

      // Handle page visibility for better status management
      const handleVisibilityChange = async () => {
        if (document.hidden) {
          // The ActivityTracker will handle automatic Away/Offline transitions
          // No need to set timers here - let the activity system manage it
          console.log('📱 Tab hidden - activity tracker will handle status changes')
        } else {
          // User returned to tab - activity tracker will detect this automatically
          console.log('📱 Tab visible - activity tracker will restore status if needed')
        }
      };

      // Add event listeners
      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('unload', handleBeforeUnload);
      window.addEventListener('pagehide', handleBeforeUnload); // Additional event for mobile
      document.addEventListener('visibilitychange', handleVisibilityChange);

      // Store references for cleanup
      (window as any).__harmonyOfflineHandlers = {
        beforeunload: handleBeforeUnload,
        unload: handleBeforeUnload,
        pagehide: handleBeforeUnload,
        visibilitychange: handleVisibilityChange
      };
    },

    cleanupOfflineHandlers() {
      const handlers = (window as any).__harmonyOfflineHandlers;
      if (handlers) {
        window.removeEventListener('beforeunload', handlers.beforeunload);
        window.removeEventListener('unload', handlers.unload);
        window.removeEventListener('pagehide', handlers.pagehide);
        document.removeEventListener('visibilitychange', handlers.visibilitychange);
        delete (window as any).__harmonyOfflineHandlers;
      }
    },

    async login(email: string, password: string) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      // Check if user has 2FA enabled
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified');
      
      if (totpFactor) {
        // User has 2FA enabled
        // IMPORTANT: Do NOT set this.session yet - even though a session exists,
        // it's at AAL1 (password-only) and should not grant access until AAL2
        console.log('🔒 2FA required - session is AAL1, need AAL2 verification');
        
        // The session exists in Supabase's storage but at AAL1
        // Our RLS policies should check for AAL2, providing backend protection
        // We also don't set it in our store for frontend protection
        
        // Create MFA challenge immediately
        const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
          factorId: totpFactor.id
        });
        
        if (challengeError) throw challengeError;
        
        return {
          requires2FA: true,
          factorId: totpFactor.id,
          challengeId: challengeData.id,
          session: null
        };
      }
      
      // No 2FA, session is at AAL1 which is sufficient
      // Set session and proceed
      this.session = data.session;
      return {
        requires2FA: false,
        factorId: null,
        challengeId: null,
        session: data.session
      };
    },

    async verify2FA(factorId: string, challengeId: string, code: string) {
      // Verify the 2FA code using the existing challenge
      const { data: verifyData, error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId,
        code
      });

      if (verifyError) {
        console.error('❌ MFA verify error:', verifyError)
        throw verifyError;
      }

      // Wait for storage to update with the new session
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Get the upgraded session (now at AAL2)
      const { data: sessionData } = await supabase.auth.getSession();
      this.session = sessionData.session;
      
      console.log('✅ 2FA verified - session upgraded to AAL2');
      
      return { session: sessionData.session };
    },

    async register(email: string, password: string) {
      const { data, error } = await supabase.auth.signUp({ email, password });
      if (error) throw error;
      this.session = data.session;
    },

    async resetPassword(email: string) {
      const { data, error } = await supabase.auth.resetPasswordForEmail(email, {
        redirectTo: `${window.location.origin}/reset-password`
      });
      if (error) throw error;
      return { data, error };
    },

    /**
     * Clear password reset mode - called after successful password reset
     */
    clearPasswordResetMode() {
      this.isPasswordResetMode = false;
    },

    async logout() {
      // Set user offline before logging out
      if (this.session?.user?.id) {
        await this.setUserOffline(this.session.user.id);
      }
      this.cleanupOfflineHandlers();
      
      // ✅ PERFORMANCE FIX: Cleanup state persistence before logout
      try {
        const { statePersistence } = await import('@/services/StatePersistence')
        await statePersistence.cleanup()
        console.log('✅ State persistence cleaned up on logout')
      } catch (error) {
        console.error('❌ Error cleaning up state persistence:', error)
      }
      
      // should make it async but for some reason it's bugging...
      supabase.auth.signOut();
      this.session = null;

      // Redirect to login page
      router.push('/login');
    },

    /**
     * Initialize the Discord-like notification system
     */
    async initializeNotificationSystem(userId: string) {
      try {
        console.log('🔔 Initializing notification system for user:', userId);
        
        // Dynamic import to avoid circular dependencies
        const { useNotificationStore } = await import('@/stores/useNotification');
        const notificationStore = useNotificationStore();
        
        // Check if already initialized
        if (notificationStore.isInitialized) {
          console.log('⚠️ Notification system already initialized, skipping...');
          return;
        }
        
        // Initialize the notification store
        await notificationStore.initialize(userId);
        
        console.log('✅ Notification system initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize notification system:', error);
      }
    },

    /**
     * Cleanup notification system on logout
     */
    cleanupNotificationSystem() {
      try {
        console.log('🔔 Cleaning up notification system');
        
        // Dynamic import to avoid issues during cleanup
        import('@/stores/useNotification').then(({ useNotificationStore }) => {
          const notificationStore = useNotificationStore();
          
          // Clean up real-time subscriptions
          if (notificationStore.realtimeSubscription) {
            supabase.removeChannel(notificationStore.realtimeSubscription);
            notificationStore.realtimeSubscription = null;
          }
          
          // Reset state
          notificationStore.$reset();
          notificationStore.isInitialized = false;
          
          console.log('✅ Notification system cleaned up');
        }).catch(error => {
          console.error('❌ Error during notification cleanup:', error);
        });
        
        // Reset view context
        import('@/services/ViewContextTracker').then(({ viewContextTracker }) => {
          viewContextTracker.reset();
        }).catch(error => {
          console.error('❌ Error resetting view context:', error);
        });
        
      } catch (error) {
        console.error('❌ Error cleaning up notification system:', error);
      }
    },
  },
});
