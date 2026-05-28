import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Session } from '@supabase/supabase-js';
import { updateUserStatus } from '@/services/ProfileService';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { UserStatus } from '@/types';
import { debug } from '@/utils/debug';
import { userStorage } from '@/utils/userScopedStorage';
import { realtimeApiService } from '@/services/RealtimeApiService';

export const useAuthStore = defineStore('auth', {
  state: () => ({
    session: null as Session | null,
    isPasswordResetMode: false, // Flag to track if we're in password reset flow
    _mfaValidatedForSession: null as string | null, // Track which session we already validated MFA for
    _sessionCacheTimestamp: null as number | null, // Cache timestamp to prevent redundant getSession() calls
    _sessionCacheTimeout: 5000, // Cache session for 5 seconds to prevent duplicate calls
    _pendingMFAVerification: false, // True while MFA login flow is in progress (prevents onAuthStateChange interference)
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
     * Read the JWT's `amr` (Authentication Methods References) claim and
     * return the list of method names. Supabase records the methods the
     * session was authenticated with - `password` after `signInWithPassword`,
     * `totp` after `mfa.verify`, `oauth` after a third-party callback, etc.
     *
     * Crucially, AMR persists through token refresh: it's session metadata,
     * not a one-shot value. So a session that was once AAL2 (password+totp)
     * still has `totp` in `amr` after Supabase's automatic AAL2 expiry
     * downgrade to AAL1 (~24h default). That's how we distinguish "long
     * session whose MFA grace period expired" (safe - keep the user logged
     * in per docs/2FA_SECURITY_MODEL.md) from "fresh AAL1 mid-login that
     * never completed MFA" (unsafe - must reject, BUGS.md C11/M64).
     */
    getAMR(session: Session | null): string[] {
      if (!session) return [];
      try {
        const decoded = this.decodeJWT(session.access_token);
        const amr = decoded?.amr;
        if (!Array.isArray(amr)) return [];
        // GoTrue emits objects like `{ method: 'totp', timestamp: ... }`,
        // but older specs allow plain strings - accept both shapes.
        return amr
          .map((entry: any) => (typeof entry === 'string' ? entry : entry?.method))
          .filter((m: any): m is string => typeof m === 'string');
      } catch (e) {
        debug.error('Failed to get AMR from token:', e);
        return [];
      }
    },

    /**
     * 🔒 CRITICAL SECURITY: Validate if a session is allowed to be adopted
     * by this tab.
     *
     * Three accepted shapes (return true):
     * - User has no MFA enabled (AAL1 is sufficient).
     * - User has MFA, session is at AAL2 (just verified).
     * - User has MFA, session is at AAL1, AND the session's `amr` claim
     *   contains `totp` (i.e. MFA was completed earlier in this session
     *   and AAL2 has since expired naturally - the documented long-session
     *   UX in `docs/2FA_SECURITY_MODEL.md`).
     *
     * One rejected shape (return false):
     * - User has MFA, session is at AAL1, AND `amr` does NOT contain `totp`.
     *   This is either a fresh password sign-in that hasn't yet completed
     *   MFA (must redirect to challenge), or an OAuth callback for an
     *   MFA-enrolled user (must show MFA challenge before granting access).
     *
     * The `amr` check is what closes the cross-tab MFA bypass without
     * forcing every MFA user to re-enter their TOTP daily:
     *   1. Tab A is logged in as UserA (no MFA).
     *   2. Tab B logs out then starts password login as UserB (has MFA).
     *   3. Tab B creates AAL1 session (amr=['password']) before TOTP verify.
     *   4. Tab A refreshes and picks up Tab B's AAL1 session from storage.
     *   5. Without this guard, Tab A would be logged in as UserB at AAL1.
     *   6. With this guard, the AMR lacks `totp`, so we reject + sign out.
     *
     * Conversely, a UserB session that DID complete MFA (amr includes
     * `totp`), then sat for 25h until AAL2 expired, is restored cleanly.
     */
    async validateSessionForMFA(session: Session): Promise<boolean> {
      try {
        const aal = this.getAAL(session);
        if (aal === 'aal2') {
          debug.log('✅ Session at AAL2 - MFA verified');
          return true;
        }

        // AAL1: distinguish "post-MFA, AAL2-expired" from "pre-MFA, mid-login".
        const amr = this.getAMR(session);
        if (amr.includes('totp')) {
          // The AAL2 grace window has lapsed but the user previously
          // completed TOTP verification on this session. Per
          // docs/2FA_SECURITY_MODEL.md the documented model accepts AAL1
          // here so users stay logged in across days/weeks like Mastodon,
          // Discord, GitHub, etc. - 2FA gates the LOGIN, not the SESSION.
          debug.log('✅ AAL1 session with prior TOTP verification - accepting (AAL2 expired post-login, refresh-token still valid)');
          return true;
        }

        // AMR has no totp. Definitive check: does the user actually have
        // MFA enrolled? If not, AAL1 is fine. If yes, this is a mid-login
        // session and we must reject so the caller routes to MFA challenge.
        const { data: factors, error } = await supabase.auth.mfa.listFactors();
        if (error) {
          debug.error('❌ Failed to check MFA factors:', error);
          // Conservative on error - same fallback as before the fix.
          return false;
        }

        const has2FA = factors?.totp?.some((f: any) => f.status === 'verified');
        if (has2FA) {
          debug.warn('🚨 AAL1 session for MFA-enrolled user without prior TOTP verification - blocking (mid-login or OAuth without MFA challenge)');
          return false;
        }

        debug.log('✅ Session at AAL1, no MFA enrolled - accepting');
        return true;
      } catch (error) {
        debug.error('❌ Error validating session MFA:', error);
        return false;
      }
    },
    async initializeAuth() {
      // PERFORMANCE: Check if we recently fetched session to avoid duplicate calls
      const now = Date.now()
      if (this._sessionCacheTimestamp && (now - this._sessionCacheTimestamp) < this._sessionCacheTimeout) {
        debug.log('⚡ Using cached session (avoiding duplicate getSession call)')
        // Use existing session from state
        const session = this.session
        if (!session) {
          // If no cached session, still need to fetch - and MUST validate
          // before adopting it, even on a cache "hit". Otherwise a tab can
          // pick up an AAL1 session written by another tab between cache
          // refreshes and skip MFA entirely (BUGS.md C11 / M64).
          const { data: getSessionData } = await supabase.auth.getSession()
          const refetched = getSessionData.session
          if (refetched) {
            const isValid = await this.validateSessionForMFA(refetched)
            if (isValid) {
              this.session = refetched
              this._mfaValidatedForSession = refetched.access_token
            } else {
              debug.warn('🚨 Cached-path session restoration blocked: AAL1 with MFA enabled')
              try { await supabase.auth.signOut() } catch { /* ignore */ }
              this.session = null
            }
          } else {
            this.session = null
          }
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
        } else if (currentPath === '/auth/callback') {
          // OAuth callback path: Supabase's `detectSessionInUrl: true` has
          // already exchanged the OAuth code for an AAL1 session by the time
          // we get here (it runs at client-create time, which is before
          // initializeAuth). If we run validateSessionForMFA on it now, an
          // MFA-enrolled user gets rejected → signed out → AuthCallbackView
          // mounts and finds no session, throws "Authentication failed",
          // and the user is permanently locked out of OAuth login.
          //
          // Defer everything to AuthCallbackView, which has its own MFA
          // challenge flow. We:
          //   - Leave the session untouched in localStorage (the view will
          //     read it via getSession()).
          //   - Don't adopt it into Pinia (so isLoggedIn=false until the
          //     view explicitly adopts after successful validation/MFA).
          //   - Set _pendingMFAVerification so SIGNED_IN / INITIAL_SESSION
          //     events fired during the OAuth processing are skipped by
          //     `onAuthStateChange` (they'd otherwise hit the same
          //     validateSessionForMFA rejection path).
          //   - AuthCallbackView clears the flag after it adopts the session
          //     itself or routes the user to MFA challenge / login.
          debug.log('🔒 OAuth callback detected on initialization - deferring session adoption to AuthCallbackView');
          this._pendingMFAVerification = true;
          this.session = null;
        } else if (session) {
          // Check AAL2 on session restoration
          // This prevents MFA bypass when another tab creates an AAL1 session
          // and this tab picks it up from localStorage on refresh
          const isValid = await this.validateSessionForMFA(session);
          
          if (isValid) {
            this.session = session;
            this._sessionCacheTimestamp = Date.now()
            // PERFORMANCE: Remember we validated this session to avoid redundant validation
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
        
        // Load blocking/muting data on session restoration (page refresh)
        // This must happen BEFORE any chat components render
        const activityPubStore = useActivityPubStore();
        await activityPubStore.loadBlockingData();
        // Home-timeline realtime + followedUsers must be ready before social UI mounts.
        void activityPubStore.initialize().catch((err) => {
          debug.error('ActivityPub initialize on session restore failed:', err);
        });

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
        // If already logged in with same user, IGNORE most events
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
          // Skip validation if MFA flow is in progress - the AAL1 session is
          // expected and will be upgraded to AAL2 by verify2FA()
          if (this._pendingMFAVerification) {
            debug.log('🔒 SIGNED_IN during pending MFA verification - skipping (will upgrade to AAL2)');
            return;
          }
          const isValid = await this.validateSessionForMFA(session);
          if (!isValid) {
            debug.warn('🚨 SIGNED_IN with invalid AAL1 session (MFA enabled) - signing out');
            // Match initializeAuth(): we must actively destroy the AAL1
            // session, otherwise it sits in Supabase storage where the next
            // tab/refresh will pick it up and silently log in without MFA.
            this.session = null;
            this.isPasswordResetMode = false;
            try {
              await supabase.auth.signOut();
            } catch (signOutError) {
              debug.error('Failed to sign out invalid AAL1 session:', signOutError);
            }
            userStorage.clearCurrentUser();
            this.cleanupNotificationSystem();
            return;
          }
          
          debug.log('✅ New login validated');
          this.isPasswordResetMode = false;
          this.session = session;
          if (session.user?.id) {
            // Set user-scoped storage for the new user
            userStorage.setCurrentUser(session.user.id);
            this.setupOfflineHandlers(session.user.id);
            
            // Re-initialize user settings after login
            // This ensures theme and other settings load for the new user
            this.initializeUserSettings(session.user.id);
            
            // Load blocking/muting data immediately after login
            // This ensures blocked users are hidden in all views
            const activityPubStore = useActivityPubStore();
            activityPubStore.loadBlockingData();
          }
          return;
        }
        
        // Handle INITIAL_SESSION (app startup)
        if (event === 'INITIAL_SESSION' && session) {
          // The comment used to say "already validated in initializeAuth", but
          // this branch also runs when `this.session` was previously null and
          // INITIAL_SESSION fires from another tab's just-created AAL1 session
          // - i.e. an MFA-required session that hasn't completed verification.
          // Re-validate before adopting unless we explicitly remember
          // validating it from initializeAuth() (this tab's own boot path).
          if (!this.session) {
            // Skip when an MFA flow is in progress (login() / verify2FA() /
            // OAuth callback). gotrue-js fires INITIAL_SESSION as a microtask
            // when its `_emitInitialSession` runs after `detectSessionInUrl`
            // exchanges the OAuth code; this microtask runs BEFORE
            // AuthCallbackView mounts. Without this guard, the AAL1 OAuth
            // session would be torn down by `validateSessionForMFA` before
            // the callback view's MFA challenge UI ever appears.
            if (this._pendingMFAVerification) {
              debug.log('🔒 INITIAL_SESSION during pending MFA verification - skipping')
              return
            }
            const alreadyValidated = this._mfaValidatedForSession === session.access_token
            const isValid = alreadyValidated || (await this.validateSessionForMFA(session))
            if (!isValid) {
              debug.warn('🚨 INITIAL_SESSION blocked: AAL1 session with MFA enabled (BUGS.md C11)')
              try { await supabase.auth.signOut() } catch { /* ignore */ }
              this.session = null
              this.cleanupNotificationSystem()
              return
            }
            this._mfaValidatedForSession = session.access_token
            this.session = session;
            if (session.user?.id) {
              // Set user-scoped storage for the current user
              userStorage.setCurrentUser(session.user.id);
              this.setupOfflineHandlers(session.user.id);
              
              // Load blocking/muting data on app startup
              // This ensures blocked users are hidden in all views
              const activityPubStore = useActivityPubStore();
              activityPubStore.loadBlockingData();
            }
          }
          return;
        }
        
        // TOKEN_REFRESHED / catch-all path. Previously this assigned `session`
        // unconditionally, which let an AAL1 session sneak in via any
        // unhandled event when `this.session` was null. Validate before adopt.
        if (session) {
          // If we already have a logged-in session, just refresh tokens.
          if (this.session) {
            this.session = session;
            return;
          }
          // Same MFA-in-progress guard as above - without it, a
          // TOKEN_REFRESHED arriving while AuthCallbackView is mid-challenge
          // would tear down the AAL1 session before verification completes.
          if (this._pendingMFAVerification) {
            debug.log(`🔒 ${event} during pending MFA verification - skipping`)
            return
          }
          const isValid = await this.validateSessionForMFA(session);
          if (!isValid) {
            debug.warn(`🚨 ${event} blocked: AAL1 session with MFA enabled (BUGS.md C11)`)
            try { await supabase.auth.signOut() } catch { /* ignore */ }
            this.session = null
            return
          }
          this._mfaValidatedForSession = session.access_token
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
        // Best-effort Redis offline (keepalive lets it finish after page unload).
        // If this fails, the Redis TTL key auto-expires after 90s.
        realtimeApiService.goOffline().catch(() => {})

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
      // CRITICAL ORDERING: set the pending-MFA flag BEFORE signInWithPassword.
      //
      // `signInWithPassword` resolves with an AAL1 session and immediately
      // queues a `SIGNED_IN` event as a microtask. The `await`s below for
      // the suspended-user check and `listFactors` yield the event loop,
      // letting that microtask run *before* we know whether MFA is needed.
      //
      // If the flag is set inside the `if (totpFactor)` branch (where it
      // used to live), the SIGNED_IN handler runs while the flag is still
      // false, calls `validateSessionForMFA` which rejects the AAL1 session
      // for an MFA-enrolled user, and signs the user out. By the time
      // `listFactors` runs, the session is already gone - `totpFactor` is
      // undefined and `login()` returns `{ requires2FA: false }` despite
      // the user clearly having 2FA. The login UI then shows "Welcome
      // back!", navigates to /chat, and the protected route renders blank
      // because the session is null. This was the user-reported bug:
      // "log in, but nothing loads, and the MFA modal never appeared".
      //
      // Hoisting the flag to the very top means the SIGNED_IN handler
      // returns early, the AAL1 session survives, listFactors actually
      // finds the factor, and we either route to the MFA modal (2FA users)
      // or finalize the session ourselves (non-2FA users) below.
      this._pendingMFAVerification = true;

      try {
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
            // Sign out the user immediately. The `finally` below will clear
            // the flag - we don't reset it here to avoid the SIGNED_OUT
            // handler racing against a half-cleared state.
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
          debug.log('🔒 2FA required - session is AAL1, need AAL2 verification');

          const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
            factorId: totpFactor.id,
          });

          if (challengeError) {
            // Reset the flag here (rather than rely on `finally`) because
            // we still want to throw upward to the caller - the login UI
            // shows the error and lets the user retry.
            this._pendingMFAVerification = false;
            throw challengeError;
          }

          // KEEP the flag set across the function return - `verify2FA` in
          // its `finally` block clears it once MFA actually completes.
          return {
            requires2FA: true,
            factorId: totpFactor.id,
            challengeId: challengeData.id,
            session: null,
          };
        }

        // No 2FA path: the SIGNED_IN handler skipped (because of our flag),
        // so we have to do its work ourselves - adopt the session AND run
        // the same post-login setup it would have run. Mirror the
        // `event === 'SIGNED_IN'` block in `onAuthStateChange` exactly so
        // non-2FA login produces identical state regardless of which path
        // got to it.
        this._pendingMFAVerification = false;
        this.isPasswordResetMode = false;
        this.session = data.session;
        if (data.session?.user?.id) {
          userStorage.setCurrentUser(data.session.user.id);
          this.setupOfflineHandlers(data.session.user.id);
          this.initializeUserSettings(data.session.user.id);
          const activityPubStore = useActivityPubStore();
          // Fire and forget - matches the SIGNED_IN handler's pattern
          // (it doesn't await this either, and we don't want to block
          // the login UI on a slow blocks/mutes query).
          activityPubStore.loadBlockingData();
        }

        return {
          requires2FA: false,
          factorId: null,
          challengeId: null,
          session: data.session,
        };
      } catch (err) {
        // Any failure path - sign-in error, suspended user, MFA challenge
        // error - must clear the flag so subsequent login attempts (or a
        // page refresh that triggers a fresh INITIAL_SESSION) aren't stuck
        // in the "skip SIGNED_IN" state.
        this._pendingMFAVerification = false;
        throw err;
      }
    },

    async verify2FA(factorId: string, challengeId: string, code: string) {
      try {
        // Race against a timeout to prevent infinite spinner on mobile
        const verifyPromise = supabase.auth.mfa.verify({
          factorId,
          challengeId,
          code,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MFA verification timed out. Please try logging in again.')), 30000),
        );

        const { error: verifyError } = await Promise.race([
          verifyPromise,
          timeoutPromise,
        ]);

        if (verifyError) {
          debug.error('❌ MFA verify error:', verifyError);
          throw verifyError;
        }

        await new Promise((resolve) => setTimeout(resolve, 500));

        const { data: sessionData } = await supabase.auth.getSession();
        this.session = sessionData.session;

        // The `MFA_CHALLENGE_VERIFIED` event handler only runs
        // `setupOfflineHandlers` - it skips `userStorage.setCurrentUser`,
        // `initializeUserSettings`, and `activityPubStore.loadBlockingData`,
        // all of which the SIGNED_IN handler runs. We mirror those here so
        // 2FA users land in the same fully-initialized state as non-2FA
        // users (otherwise the chat view loads with default theme, no
        // user-scoped storage, and stale block lists).
        this.isPasswordResetMode = false;
        if (sessionData.session?.user?.id) {
          userStorage.setCurrentUser(sessionData.session.user.id);
          this.setupOfflineHandlers(sessionData.session.user.id);
          this.initializeUserSettings(sessionData.session.user.id);
          const activityPubStore = useActivityPubStore();
          activityPubStore.loadBlockingData();
        }

        debug.log('✅ 2FA verified - session upgraded to AAL2');

        return { session: sessionData.session };
      } finally {
        this._pendingMFAVerification = false;
      }
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

      // Null session and sign out FIRST - this makes isLoggedIn false immediately,
      // preventing reactive components from firing queries with stale/undefined data
      // (e.g. user_roles with server_id=undefined, get_supporter_badge after auth gone)
      this.session = null;
      await supabase.auth.signOut();

      // Redirect to login BEFORE clearing stores so that components unmount
      // before store resets trigger reactive watchers
      const { default: router } = await import('@/router');
      router.push('/login');

      // Clear user-scoped localStorage on logout
      userStorage.clearCurrentUser();
      
      // Clear stores in the background after navigation - order no longer matters
      // since components have already unmounted
      try {
        const { useProfileStore } = await import('@/stores/useProfile')
        const profileStore = useProfileStore()
        profileStore.clearProfile()
      } catch (error) {
        debug.error('❌ Error clearing profile store:', error)
      }
      
      try {
        const { useVisualTheme } = await import('@/composables/useVisualTheme')
        const visualTheme = useVisualTheme()
        visualTheme.reset()
      } catch (error) {
        debug.error('❌ Error resetting visual theme:', error)
      }
      
      try {
        const { useActivityPubStore } = await import('@/stores/useActivityPub')
        const activityPubStore = useActivityPubStore()
        activityPubStore.cleanupRealtimeSubscriptions()
        activityPubStore.clearTimelineCache()
        // BUGS.md Pattern B / #3 v2: a typed action on the store, replacing
        // the previous unsafe `as unknown as { ... }` cast. The earlier
        // version also had a dead-code branch checking `bookmarks?.posts`
        // - `bookmarks` is actually `TimelinePost[]`, so the array was
        // never cleared. See `resetUserRelationshipState` for the full
        // set of fields covered.
        activityPubStore.resetUserRelationshipState()
      } catch (error) {
        debug.error('❌ Error clearing ActivityPub timeline:', error)
      }

      try {
        // BUGS.md Pattern B / #1: voice channel state was persisted to a
        // global localStorage key and never cleared on logout, so the next
        // user on a shared device would auto-reconnect to the previous
        // user's channel. Force-leave first, then clear the saved state.
        const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
        const voiceStore = useUnifiedVoiceChannelStore()
        if (voiceStore.isConnected) {
          await voiceStore.leaveVoiceChannel()
        }
        voiceStore.clearVoiceChannelState()
        voiceStore.stopVoiceSessionHeartbeat()
      } catch (error) {
        debug.error('❌ Error clearing voice channel state:', error)
      }

      try {
        // BUGS.md Pattern B / #4: reactions Maps + the 30 s reconcile
        // interval were never stopped on logout, leaking memory + CPU
        // across user sessions in the same tab. The custom `$dispose`
        // exposed by useReactions clears the interval and any pending
        // reconcile timeouts.
        const { useReactionsStore } = await import('@/stores/useReactions')
        const reactionsStore = useReactionsStore() as any
        if (typeof reactionsStore.$dispose === 'function') {
          try { reactionsStore.$dispose() } catch { /* noop */ }
        }
      } catch (error) {
        debug.error('❌ Error clearing reactions store:', error)
      }

      try {
        // BUGS.md Pattern B / #4 v2: `usePostReactionsStore` is a setup
        // store, so Pinia's built-in `$reset()` throws ("does not implement
        // $reset") and the previous `try/catch` silently swallowed it.
        // The store now exposes a `$dispose` that clears its Maps + Sets
        // and pending reconcile timeouts.
        const { usePostReactionsStore } = await import('@/stores/postReactions')
        const postReactionsStore = usePostReactionsStore() as any
        if (typeof postReactionsStore.$dispose === 'function') {
          try { postReactionsStore.$dispose() } catch { /* noop */ }
        }
      } catch (error) {
        debug.error('❌ Error clearing post reactions store:', error)
      }

      try {
        // BUGS.md Pattern B / #5 + M11: cleanupBroadcastHandlers now also
        // clears the DND check `setInterval` (see useNotification change in
        // this PR), so the interval no longer fires against a stale store
        // after logout.
        const { useNotificationStore } = await import('@/stores/useNotification')
        const notificationStore = useNotificationStore() as any
        if (typeof notificationStore.cleanupBroadcastHandlers === 'function') {
          notificationStore.cleanupBroadcastHandlers()
        }
      } catch (error) {
        debug.error('❌ Error cleaning up notification store:', error)
      }

      try {
        const { useEmojiCacheStore } = await import('@/stores/useEmojiCache')
        const emojiCacheStore = useEmojiCacheStore()
        emojiCacheStore.cleanupRealtimeSubscriptions()
      } catch (error) {
        debug.error('❌ Error cleaning up emoji cache:', error)
      }
      
      try {
        const { useChatStore } = await import('@/stores/useChat')
        const chatStore = useChatStore()
        chatStore.unsubscribeFromMessages()
        chatStore.clearAllCaches()
        chatStore.replyMessageCache.clear()
        chatStore.jumpedToMessages.clear()
        chatStore.$reset()
      } catch (error) {
        debug.error('❌ Error clearing chat store:', error)
      }

      try {
        const { useDMStore } = await import('@/stores/useDM')
        const dmStore = useDMStore()
        dmStore.cleanup()
      } catch (error) {
        debug.error('❌ Error clearing DM store:', error)
      }

      try {
        const { useServerChannelStore } = await import('@/stores/useServerChannel')
        const serverStore = useServerChannelStore()
        await serverStore.cleanupSubscriptions()
        serverStore.$reset()
      } catch (error) {
        debug.error('❌ Error clearing server channel store:', error)
      }

      try {
        const { useServerUsersStore } = await import('@/stores/useServerUsers')
        const serverUsersStore = useServerUsersStore()
        serverUsersStore.cleanup()
      } catch (error) {
        debug.error('❌ Error clearing server users store:', error)
      }

      try {
        const { usePushNotifications } = await import('@/composables/usePushNotifications')
        const pushNotifications = usePushNotifications()
        pushNotifications.resetState()
      } catch (error) {
        debug.error('❌ Error resetting push notification state:', error)
      }

      try {
        const { statePersistence } = await import('@/services/StatePersistence')
        await statePersistence.cleanup()
      } catch (error) {
        debug.error('❌ Error cleaning up state persistence:', error)
      }

      try {
        // BUGS.md H50: module-level permission/role caches are outside Pinia
        // state and were never cleared on logout, leaking the previous
        // user's permission map to the next user on a shared device.
        const { clearAllPermissionCaches } = await import('@/composables/useServerPermissions')
        clearAllPermissionCaches()
      } catch (error) {
        debug.error('❌ Error clearing permission caches:', error)
      }
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
        
        // Clean up notification broadcast handlers + disconnect user event channel
        Promise.all([
          import('@/stores/useNotification').then(({ useNotificationStore }) => {
            const notificationStore = useNotificationStore();
            notificationStore.cleanupBroadcastHandlers();
            notificationStore.$reset();
            notificationStore.isInitialized = false;
          }),
          import('@/services/UserEventChannel').then(({ userEventChannel }) => {
            userEventChannel.disconnect();
          })
        ]).then(() => {
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
        
        // PERFORMANCE: Initialize theme from localStorage FIRST (instant, synchronous)
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
        
        // Eagerly initialize audio theme in background so sounds are ready on first interaction
        import('./useTheme').then(({ useThemeStore }) => {
          const themeStore = useThemeStore();
          if (!themeStore.isInitialized) {
            themeStore.initialize().catch(() => {});
          }
        });
        
        debug.log('✅ User settings initialized');
      } catch (error) {
        debug.error('❌ Error initializing user settings:', error);
      }
    },
  },
});
