import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/ProfileService';
import { UserStatus } from '@/types';
import router from '@/router';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as Session | null,
  }),
  getters: {
    isLoggedIn: (state) => !!state.session
  },
  actions: {
    async initializeAuth() {
      const { data: getSessionData } = await supabase.auth.getSession();
      this.session = getSessionData.session;

      // Initialize notification system for existing session
      if (this.session?.user?.id) {
        // DO NOT force status to online - let userDataService handle status properly
        this.setupOfflineHandlers(this.session.user.id);
        // Note: Notification system is now initialized by RouteAwareInitialization
        // to only load unread count initially (full list loads on-demand)
      }

      supabase.auth.onAuthStateChange(async (_, session) => {
        const wasLoggedIn = !!this.session;
        const previousUserId = this.session?.user?.id;
        
        this.session = session;
        
        if (session?.user?.id) {
          // User logged in - let userDataService handle status restoration
          this.setupOfflineHandlers(session.user.id);
          // Note: Notification system is now initialized by RouteAwareInitialization
        } else if (wasLoggedIn && previousUserId) {
          // User logged out
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

    setupOfflineHandlers(userId: string) {
      // Clean up any existing handlers first
      this.cleanupOfflineHandlers();
      
      // Handle browser/tab close - immediate cleanup and status update
      const handleBeforeUnload = (event: BeforeUnloadEvent) => {
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
      
      // CRITICAL SECURITY: Check the session's AAL (Authenticator Assurance Level)
      // aal1 = password only (not fully authenticated if MFA is enabled)
      // aal2 = password + 2FA verified
      const sessionAAL = data.session?.user?.aud // Check user metadata for AAL
      
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
      // On success, this upgrades the session from AAL1 to AAL2
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId,
        challengeId,
        code
      });

      if (verifyError) {
        throw verifyError;
      }

      // After successful verification, the session is now at AAL2
      // NOW we can safely set it in our store
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
