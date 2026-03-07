import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/ProfileService';
import { useChatStore } from '@/stores/useChat';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { UserStatus } from '@/types';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as Session | null,
    isPasswordResetMode: false, // Flag to track if we're in password reset flow
    _mfaValidatedForSession: null as string | null, // Track which session we already validated MFA for
    _sessionCacheTimestamp: null as number | null, // Cache timestamp to prevent redundant getSession() calls
    _sessionCacheTimeout: 5000, // Cache session for 5 seconds to prevent duplicate calls
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
        debug.error('Failed to decode JWT:', e);
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
        debug.error('Failed to get AAL from token:', e);
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
          debug.log('✅ Session at AAL2 - MFA verified');
          return true;
        }
        
        // Session is at AAL1, need to check if user has MFA enabled
        const { data: factors, error } = await supabase.auth.mfa.listFactors();
        
        if (error) {
          debug.error('❌ Failed to check MFA factors:', error);
          // On error, be conservative - reject the session
          return false;
        }
        
        const has2FA = factors?.totp?.some((f: any) => f.status === 'verified');
        
        if (has2FA) {
          // User has MFA but session is AAL1 - this is an incomplete login!
          debug.warn('🚨 AAL1 session detected for user with MFA enabled - blocking access');
          return false;
        }
        
        // User doesn't have MFA, AAL1 is sufficient
        debug.log('✅ Session at AAL1, no MFA required');
        return true;
        
      } catch (error) {
        debug.error('❌ Error validating session MFA:', error);
        // On error, be conservative - reject the session
        return false;
      }
    },
    async initializeAuth() {
      // ✅ PERFORMANCE: Check if we recently fetched session to avoid duplicate calls
      const now = Date.now()
      if (this._sessionCacheTimestamp && (now - this._sessionCacheTimestamp) < this._sessionCacheTimeout) {
        debug.log('⚡ Using cached session (avoiding duplicate getSession call)')
        // Use existing session from state
        const session = this.session
        if (!session) {
          // If no cached session, still need to fetch
          const { data: getSessionData } = await supabase.auth.getSession()
          this.session = getSessionData.session
          this._sessionCacheTimestamp = now
        }
      } else {
        const { data: getSessionData } = await supabase.auth.getSession()
        const session = getSessionData.session
        this._sessionCacheTimestamp = now
        
        // Check if we're on password reset page or have recovery token in URL
        // This handles the case where Supabase has already processed the recovery token
        // before the PASSWORD_RECOVERY event fires
        const currentPath = window.location.pathname;
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const queryParams = new URLSearchParams(window.location.search);
        const type = hashParams.get('type') || queryParams.get('type');
        
        if (currentPath === '/reset-password' && (type === 'recovery' || session)) {
          // This is likely a recovery session - don't treat it as logged in
          debug.log('🔒 Recovery session detected on initialization - entering password reset mode');
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
            this._sessionCacheTimestamp = Date.now()
            // ✅ PERFORMANCE: Remember we validated this session to avoid redundant validation
            // on INITIAL_SESSION event that fires immediately after
            this._mfaValidatedForSession = session.access_token;
            // Set user-scoped storage for the current user
            if (session.user?.id) {
              userStorage.setCurrentUser(session.user.id);
            }
          } else {
            debug.warn('🚨 Session restoration blocked - AAL1 session with MFA enabled (MFA bypass prevented)');
            // Sign out the incomplete session to prevent other tabs from using it
            await supabase.auth.signOut();
            this.session = null;
          }
        } else {
          this.session = null;
        }
      }

      // Initialize notification system for existing session
      if (this.session?.user?.id) {
        // DO NOT force status to online - let userDataService handle status properly
        this.setupOfflineHandlers(this.session.user.id);
        // Note: Notification system is now initialized by RouteAwareInitialization
        // to only load unread count initially (full list loads on-demand)
        
        // ✅ CRITICAL: Load blocking/muting data on session restoration (page refresh)
        // This must happen BEFORE any chat components render
        const activityPubStore = useActivityPubStore();
        await activityPubStore.loadBlockingData();
        
        // LAZY: Don't initialize encryption on load - only when needed
        // Encryption will be initialized when:
        // 1. User opens encryption settings
        // 2. User views/creates encrypted messages
        // 3. Server requires encryption
        // This prevents unnecessary initialization for users who don't use encryption
      }

      supabase.auth.onAuthStateChange(async (event, session) => {
        const currentUserId = this.session?.user?.id;
        const newUserId = session?.user?.id;
        
        // =====================================================================
        // CRITICAL: If already logged in with same user, IGNORE most events
        // This prevents re-validation on tab visibility changes, token refresh, etc.
        // Supabase fires SIGNED_IN when tab becomes visible - we must ignore it
        // =====================================================================
        if (currentUserId && newUserId === currentUserId) {
          // Same user - only handle actual logout or user data changes
          if (event === 'SIGNED_OUT') {
            debug.log('🔐 Auth event: SIGNED_OUT');
            this.isPasswordResetMode = false;
            this.session = null;
            this.cleanupNotificationSystem();
            return;
          }
          if (event === 'USER_UPDATED') {
            debug.log('🔐 Auth event: USER_UPDATED - updating session');
            this.session = session;
            return;
          }
          // SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION with same user = IGNORE
          // These fire on tab visibility changes and would break connections
          return;
        }
        
        // =====================================================================
        // Not logged in, or different user - process the event
        // =====================================================================
        debug.log(`🔐 Auth event: ${event}, AAL: ${this.getAAL(session)}`);
        
        // Handle PASSWORD_RECOVERY event
        if (event === 'PASSWORD_RECOVERY') {
          debug.log('🔒 PASSWORD_RECOVERY event detected - entering password reset mode');
          this.isPasswordResetMode = true;
          this.session = session;
          
          const currentPath = window.location.pathname;
          if (currentPath !== '/reset-password') {
            // Dynamic import to avoid circular dependency with router
            const { default: router } = await import('@/router');
            router.push('/reset-password');
          }
          return;
        }
        
        // Handle SIGNED_OUT
        if (event === 'SIGNED_OUT') {
          debug.log('🔐 Auth event: SIGNED_OUT');
          this.isPasswordResetMode = false;
          this.session = null;
          if (currentUserId) {
            await this.setUserOffline(currentUserId);
          }
          // Clear user-scoped localStorage on logout
          userStorage.clearCurrentUser();
          this.cleanupNotificationSystem();
          return;
        }
        
        // Handle MFA_CHALLENGE_VERIFIED
        if (event === 'MFA_CHALLENGE_VERIFIED') {
          debug.log('✅ MFA challenge verified - allowing session through');
          this.session = session;
          if (session?.user?.id) {
            this.setupOfflineHandlers(session.user.id);
          }
          return;
        }
        
        // Handle new login (SIGNED_IN with different/new user)
        if (event === 'SIGNED_IN' && session) {
          // Validate MFA for new logins only
          const isValid = await this.validateSessionForMFA(session);
          if (!isValid) {
            debug.warn('🚨 SIGNED_IN with invalid AAL1 session (MFA enabled) - rejecting');
            return;
          }
          
          debug.log('✅ New login validated');
          this.isPasswordResetMode = false;
          this.session = session;
          if (session.user?.id) {
            // Set user-scoped storage for the new user
            userStorage.setCurrentUser(session.user.id);
            this.setupOfflineHandlers(session.user.id);
            
            // ✅ CRITICAL: Re-initialize user settings after login
            // This ensures theme and other settings load for the new user
            this.initializeUserSettings(session.user.id);
            
            // ✅ Load blocking/muting data immediately after login
            // This ensures blocked users are hidden in all views
            const activityPubStore = useActivityPubStore();
            activityPubStore.loadBlockingData();
          }
          return;
        }
        
        // Handle INITIAL_SESSION (app startup)
        if (event === 'INITIAL_SESSION' && session) {
          // Already validated in initializeAuth, just set session if not set
          if (!this.session) {
            this.session = session;
            if (session.user?.id) {
              // Set user-scoped storage for the current user
              userStorage.setCurrentUser(session.user.id);
              this.setupOfflineHandlers(session.user.id);
              
              // ✅ Load blocking/muting data on app startup
              // This ensures blocked users are hidden in all views
              const activityPubStore = useActivityPubStore();
              activityPubStore.loadBlockingData();
            }
          }
          return;
        }
        
        // TOKEN_REFRESHED, USER_UPDATED without current session - just update
        if (session) {
          this.session = session;
        }
      });
    },

    async setUserOnline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Online);
        debug.log('User set to online:', userId);
      } catch (error) {
        debug.error('Error setting user online:', error);
      }
    },

    async setUserOffline(userId: string) {
      try {
        await updateUserStatus(userId, UserStatus.Offline);
        debug.log('User set to offline:', userId);
      } catch (error) {
        debug.error('Error setting user offline:', error);
      }
    },

    async initializeEncryptionIfAvailable(authUserId: string) {
      try {
        debug.log('🔐 Initializing Megolm encryption service...');
        
        // Initialize the Megolm encryption service
        // The service internally converts auth_user_id to profile_id
        const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
        await megolmMessageEncryptionService.initialize(authUserId);
        
        // Check if user has recovery key set up
        const hasRecoveryKey = await megolmMessageEncryptionService.hasRecoveryKey();
        
        if (hasRecoveryKey) {
          debug.log('🔐 User has recovery key set up');
          debug.log('ℹ️ User needs to enter recovery phrase to unlock encryption');
          
          // Encryption is set up but NOT unlocked
          // User must enter recovery phrase in Settings > Encryption to unlock
        } else {
          debug.log('ℹ️ Encryption service initialized but user has no recovery key yet');
          debug.log('ℹ️ User can set up encryption in Settings > Encryption');
        }
      } catch (error) {
        debug.error('❌ Failed to initialize encryption:', error);
      }
    },

    setupOfflineHandlers(_userId: string) {
      // Clean up any existing handlers first
      this.cleanupOfflineHandlers();
      
      // Handle browser/tab close - cleanup presence
      const handleBeforeUnload = (_event: BeforeUnloadEvent) => {
        if ((window as any).__harmonyPresenceCleanup) {
          (window as any).__harmonyPresenceCleanup();
        }
      };

      // Add event listeners for page close only
      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('unload', handleBeforeUnload);
      window.addEventListener('pagehide', handleBeforeUnload);

      // Store references for cleanup
      (window as any).__harmonyOfflineHandlers = {
        beforeunload: handleBeforeUnload,
        unload: handleBeforeUnload,
        pagehide: handleBeforeUnload
      };
    },

    cleanupOfflineHandlers() {
      const handlers = (window as any).__harmonyOfflineHandlers;
      if (handlers) {
        window.removeEventListener('beforeunload', handlers.beforeunload);
        window.removeEventListener('unload', handlers.unload);
        window.removeEventListener('pagehide', handlers.pagehide);
        delete (window as any).__harmonyOfflineHandlers;
      }
    },

    async login(email: string, password: string) {
      const { data, error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) throw error;
      
      // Check if user is suspended BEFORE allowing further login
      if (data.user) {
        const { data: profile } = await supabase
          .from('profiles')
          .select('is_suspended, suspension_reason')
          .eq('auth_user_id', data.user.id)
          .maybeSingle();
        
        if (profile?.is_suspended) {
          // Sign out the user immediately
          await supabase.auth.signOut();
          throw new Error(
            profile.suspension_reason 
              ? `Your account has been suspended: ${profile.suspension_reason}`
              : 'Your account has been suspended. Please contact an administrator.'
          );
        }
      }
      
      // Check if user has 2FA enabled
      const { data: factors } = await supabase.auth.mfa.listFactors();
      const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified');
      
      if (totpFactor) {
        // User has 2FA enabled
        // IMPORTANT: Do NOT set this.session yet - even though a session exists,
        // it's at AAL1 (password-only) and should not grant access until AAL2
        debug.log('🔒 2FA required - session is AAL1, need AAL2 verification');
        
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
        debug.error('❌ MFA verify error:', verifyError)
        throw verifyError;
      }

      // Wait for storage to update with the new session
      await new Promise(resolve => setTimeout(resolve, 500));
      
      // Get the upgraded session (now at AAL2)
      const { data: sessionData } = await supabase.auth.getSession();
      this.session = sessionData.session;
      
      debug.log('✅ 2FA verified - session upgraded to AAL2');
      
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
      
      // Clear user-scoped localStorage on logout
      userStorage.clearCurrentUser();
      
      // ✅ CRITICAL: Clear profile store to prevent data leakage between users
      try {
        const { useProfileStore } = await import('@/stores/useProfile')
        const profileStore = useProfileStore()
        profileStore.clearProfile()
        debug.log('✅ Profile store cleared on logout')
      } catch (error) {
        debug.error('❌ Error clearing profile store:', error)
      }
      
      // ✅ CRITICAL: Reset visual theme to prevent theme leakage between users
      try {
        const { useVisualTheme } = await import('@/composables/useVisualTheme')
        const visualTheme = useVisualTheme()
        visualTheme.reset()
        debug.log('✅ Visual theme reset on logout')
      } catch (error) {
        debug.error('❌ Error resetting visual theme:', error)
      }
      
      // ✅ CRITICAL: Clear ActivityPub timeline to prevent data leakage
      try {
        const { useActivityPubStore } = await import('@/stores/useActivityPub')
        const activityPubStore = useActivityPubStore()
        activityPubStore.clearTimelineCache()
        debug.log('✅ ActivityPub timeline cleared on logout')
      } catch (error) {
        debug.error('❌ Error clearing ActivityPub timeline:', error)
      }
      
      // Clear chat store caches to prevent data leakage between users
      try {
        const { useChatStore } = await import('@/stores/useChat')
        const chatStore = useChatStore()
        chatStore.unsubscribeFromMessages()
        chatStore.clearAllCaches()
        chatStore.replyMessageCache.clear()
        chatStore.jumpedToMessages.clear()
        chatStore.$reset()
        debug.log('✅ Chat store cleared on logout')
      } catch (error) {
        debug.error('❌ Error clearing chat store:', error)
      }

      // Clear DM store to prevent conversation leakage between users
      try {
        const { useDMStore } = await import('@/stores/useDM')
        const dmStore = useDMStore()
        dmStore.cleanup()
        debug.log('✅ DM store cleared on logout')
      } catch (error) {
        debug.error('❌ Error clearing DM store:', error)
      }

      // Clear server channel store
      try {
        const { useServerChannelStore } = await import('@/stores/useServerChannel')
        const serverStore = useServerChannelStore()
        serverStore.$reset()
        debug.log('✅ Server channel store cleared on logout')
      } catch (error) {
        debug.error('❌ Error clearing server channel store:', error)
      }

      // Cleanup state persistence before logout
      try {
        const { statePersistence } = await import('@/services/StatePersistence')
        await statePersistence.cleanup()
        debug.log('✅ State persistence cleaned up on logout')
      } catch (error) {
        debug.error('❌ Error cleaning up state persistence:', error)
      }
      
      // should make it async but for some reason it's bugging...
      supabase.auth.signOut();
      this.session = null;

      // Redirect to login page (dynamic import to avoid circular dependency)
      const { default: router } = await import('@/router');
      router.push('/login');
    },

    /**
     * Initialize the Discord-like notification system
     */
    async initializeNotificationSystem(userId: string) {
      try {
        debug.log('🔔 Initializing notification system for user:', userId);
        
        // Dynamic import to avoid circular dependencies
        const { useNotificationStore } = await import('@/stores/useNotification');
        const notificationStore = useNotificationStore();
        
        // Check if already initialized
        if (notificationStore.isInitialized) {
          debug.log('⚠️ Notification system already initialized, skipping...');
          return;
        }
        
        // Initialize the notification store
        await notificationStore.initialize(userId);
        
        debug.log('✅ Notification system initialized successfully');
      } catch (error) {
        debug.error('❌ Failed to initialize notification system:', error);
      }
    },

    /**
     * Cleanup notification system on logout
     */
    cleanupNotificationSystem() {
      try {
        debug.log('🔔 Cleaning up notification system');
        
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
          
          debug.log('✅ Notification system cleaned up');
        }).catch(error => {
          debug.error('❌ Error during notification cleanup:', error);
        });
        
        // Reset view context
        import('@/services/ViewContextTracker').then(({ viewContextTracker }) => {
          viewContextTracker.reset();
        }).catch(error => {
          debug.error('❌ Error resetting view context:', error);
        });

        // Lock encryption and clear stored session keys from IndexedDB
        import('@/services/encryption/MegolmMessageEncryptionService').then(async ({ megolmMessageEncryptionService }) => {
          await megolmMessageEncryptionService.lockEncryption();
          debug.log('🔒 Encryption locked on logout');
        }).catch(error => {
          debug.error('❌ Error locking encryption:', error);
        });
        
      } catch (error) {
        debug.error('❌ Error cleaning up notification system:', error);
      }
    },

    /**
     * Initialize user settings after login
     * Ensures theme and other user-specific settings are loaded for the new user
     * OPTIMIZED: Loads from localStorage first (instant), then fetches profile in background
     */
    async initializeUserSettings(userId: string) {
      try {
        debug.log('🔄 Initializing user settings for:', userId);
        
        // ✅ PERFORMANCE: Initialize theme from localStorage FIRST (instant, synchronous)
        // This gives immediate visual feedback while profile loads in background
        const { useVisualTheme } = await import('@/composables/useVisualTheme');
        const visualTheme = useVisualTheme();
        
        // Initialize theme immediately (loads from localStorage first, then Supabase)
        // This is non-blocking for the UI - theme applies instantly from localStorage
        const themeInitPromise = visualTheme.initialize();
        
        // Fetch profile in parallel (non-blocking)
        // Theme will use cached profile data if available, or fetch from Supabase
        const { useProfileStore } = await import('@/stores/useProfile');
        const profileStore = useProfileStore();
        const profilePromise = profileStore.fetchProfileByAuthUserId(userId);
        
        // Wait for both to complete (but theme already applied from localStorage)
        await Promise.all([themeInitPromise, profilePromise]);
        
        // If profile was fetched and has appearance_settings, theme will have loaded it
        // If not, theme will have used localStorage (which is fine)
        
        debug.log('✅ User settings initialized');
      } catch (error) {
        debug.error('❌ Error initializing user settings:', error);
      }
    },
  },
});
