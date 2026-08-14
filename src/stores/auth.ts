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
    isPasswordResetMode: false, // True during the password reset flow
    _mfaValidatedForSession: null as string | null, // Access token of the session already MFA-validated
    _sessionCacheTimestamp: null as number | null, // Guards against redundant getSession() calls
    _sessionCacheTimeout: 5000, // ms
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
     * AMR persists through token refresh: it is session metadata, not a
     * one-shot value. A session that was once AAL2 (password+totp) still
     * has `totp` in `amr` after Supabase's automatic AAL2 expiry downgrade
     * to AAL1 (~24h default). That distinguishes "long session whose MFA
     * grace period expired" (safe - keep the user logged in per
     * docs/2FA_SECURITY_MODEL.md) from "fresh AAL1 mid-login that never
     * completed MFA" (unsafe - must reject, BUGS.md C11/M64).
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
     * CRITICAL SECURITY: Validate if a session is allowed to be adopted
     * by this tab.
     *
     * Three accepted shapes (return true):
     * - User has no MFA enabled (AAL1 is sufficient).
     * - User has MFA, session is at AAL2.
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
     *   6. With this guard, the AMR lacks `totp`: reject and sign out.
     *
     * Conversely, a UserB session that DID complete MFA (amr includes
     * `totp`), then sat for 25h until AAL2 expired, is restored cleanly.
     */
    async validateSessionForMFA(session: Session): Promise<boolean> {
      try {
        const aal = this.getAAL(session);
        if (aal === 'aal2') {
          debug.log('Session at AAL2 - MFA verified');
          return true;
        }

        // AAL1: distinguish "post-MFA, AAL2-expired" from "pre-MFA, mid-login".
        const amr = this.getAMR(session);
        if (amr.includes('totp')) {
          // The AAL2 grace window has lapsed but the user previously
          // completed TOTP verification on this session. Per
          // docs/2FA_SECURITY_MODEL.md, AAL1 is accepted here so sessions
          // survive across days: 2FA gates the login, not the session.
          debug.log('AAL1 session with prior TOTP verification - accepting (AAL2 expired post-login, refresh-token still valid)');
          return true;
        }

        // AMR has no totp. Check enrollment: no MFA enrolled means AAL1 is
        // sufficient; MFA enrolled means this is a mid-login session and
        // must be rejected so the caller routes to the MFA challenge.
        const { data: factors, error } = await supabase.auth.mfa.listFactors();
        if (error) {
          debug.error('Failed to check MFA factors:', error);
          // Fail closed on error.
          return false;
        }

        const has2FA = factors?.totp?.some((f: any) => f.status === 'verified');
        if (has2FA) {
          debug.warn('AAL1 session for MFA-enrolled user without prior TOTP verification - blocking (mid-login or OAuth without MFA challenge)');
          return false;
        }

        debug.log('Session at AAL1, no MFA enrolled - accepting');
        return true;
      } catch (error) {
        debug.error('Error validating session MFA:', error);
        return false;
      }
    },
    async initializeAuth() {
      // PERFORMANCE: reuse a recently fetched session instead of calling getSession() again
      const now = Date.now()
      if (this._sessionCacheTimestamp && (now - this._sessionCacheTimestamp) < this._sessionCacheTimeout) {
        debug.log('Using cached session (avoiding duplicate getSession call)')
        const session = this.session
        if (!session) {
          // No cached session: fetch, and validate before adopting even on
          // a cache hit. Otherwise a tab picks up an AAL1 session written
          // by another tab between cache refreshes and skips MFA entirely
          // (BUGS.md C11 / M64).
          const { data: getSessionData } = await supabase.auth.getSession()
          const refetched = getSessionData.session
          if (refetched) {
            const isValid = await this.validateSessionForMFA(refetched)
            if (isValid) {
              this.session = refetched
              this._mfaValidatedForSession = refetched.access_token
            } else {
              debug.warn('Cached-path session restoration blocked: AAL1 with MFA enabled')
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
        
        const currentPath = window.location.pathname;
        const hashParams = new URLSearchParams(window.location.hash.substring(1));
        const queryParams = new URLSearchParams(window.location.search);
        const type = hashParams.get('type') || queryParams.get('type');
        
        if (currentPath === '/reset-password' && (type === 'recovery' || session)) {
          // Recovery session: keep for updateUser, but isPasswordResetMode blocks isLoggedIn.
          debug.log('Recovery session detected on initialization - entering password reset mode');
          this.isPasswordResetMode = true;
          this.session = session;
        } else if (currentPath === '/auth/callback') {
          // OAuth callback path: Supabase's `detectSessionInUrl: true` runs
          // at client-create time, before initializeAuth, so the OAuth code
          // is already exchanged for an AAL1 session here. Running
          // validateSessionForMFA on it rejects MFA-enrolled users and signs
          // them out; AuthCallbackView then finds no session, throws
          // "Authentication failed", and OAuth login becomes impossible.
          //
          // Adoption is deferred to AuthCallbackView, which owns the MFA
          // challenge flow:
          //   - The session stays untouched in localStorage; the view reads
          //     it via getSession().
          //   - It is not adopted into Pinia, so isLoggedIn stays false until
          //     the view adopts it after validation/MFA.
          //   - _pendingMFAVerification makes `onAuthStateChange` skip the
          //     SIGNED_IN / INITIAL_SESSION events fired during OAuth
          //     processing, which would otherwise hit the same rejection path.
          //   - AuthCallbackView clears the flag once it adopts the session
          //     or routes to MFA challenge / login.
          debug.log('OAuth callback detected on initialization - deferring session adoption to AuthCallbackView');
          this._pendingMFAVerification = true;
          this.session = null;
        } else if (session) {
          // Prevents MFA bypass when another tab creates an AAL1 session
          // and this tab picks it up from localStorage on refresh
          const isValid = await this.validateSessionForMFA(session);
          
          if (isValid) {
            this.session = session;
            this._sessionCacheTimestamp = Date.now()
            // PERFORMANCE: skips revalidation on the INITIAL_SESSION event
            // that fires immediately after
            this._mfaValidatedForSession = session.access_token;
            if (session.user?.id) {
              userStorage.setCurrentUser(session.user.id);
            }
          } else {
            debug.warn('Session restoration blocked - AAL1 session with MFA enabled (MFA bypass prevented)');
            // Sign out the incomplete session to prevent other tabs from using it
            await supabase.auth.signOut();
            this.session = null;
          }
        } else {
          this.session = null;
        }
      }

      // SUSPENSION ENFORCEMENT ON SESSION RESTORE.
      // login() and the OAuth callback already block suspended users, but a
      // user suspended WHILE holding an active session would otherwise keep
      // full access until the JWT expired. Re-checked on every restore; the
      // session is torn down if suspended.
      if (this.session?.user?.id) {
        try {
          const { data: profile } = await supabase
            .from('profiles')
            .select('is_suspended')
            .eq('auth_user_id', this.session.user.id)
            .maybeSingle();
          if (profile?.is_suspended) {
            debug.warn('Session restore blocked - account is suspended');
            try { await supabase.auth.signOut(); } catch { /* ignore */ }
            userStorage.clearCurrentUser();
            this.session = null;
          }
        } catch (err) {
          // Fail open on transient query errors; the next reload re-checks.
          debug.warn('Suspension check on restore failed (continuing):', err);
        }
      }

      if (this.session?.user?.id) {
        // Status is owned by userDataService; do not force it to online here.
        this.setupOfflineHandlers(this.session.user.id);
        // Notification init lives in RouteAwareInitialization.

        // Home-timeline realtime + followedUsers + blocking data must be
        // ready before social UI mounts. initialize() is idempotent and
        // resolves the profile id internally via authContextService, so
        // it does not need userDataService to be ready first.
        const activityPubStore = useActivityPubStore();
        await activityPubStore.initialize().catch((err) => {
          debug.error('ActivityPub initialize on session restore failed:', err);
        });

        // Funding bar - loaded once at session restore, then refreshed in
        // the background. Layouts read this store instead of refetching
        // per-view.
        import('@/stores/useFunding').then(({ useFundingStore }) => {
          const fundingStore = useFundingStore();
          void fundingStore.load();
          fundingStore.startAutoRefresh();
        }).catch((err) => debug.warn('Funding store init failed:', err));

        // LAZY: encryption is not initialized on load. It initializes when
        // the user opens encryption settings, views/creates encrypted
        // messages, or the server requires encryption.
      }

      supabase.auth.onAuthStateChange(async (event, session) => {
        const currentUserId = this.session?.user?.id;
        const newUserId = session?.user?.id;
        
        // Already logged in as the same user: most events are ignored.
        // Supabase fires SIGNED_IN when the tab becomes visible.
        if (currentUserId && newUserId === currentUserId) {
          // Same user - only handle actual logout or user data changes
          if (event === 'SIGNED_OUT') {
            debug.log('Auth event: SIGNED_OUT');
            this.isPasswordResetMode = false;
            this.session = null;
            this.cleanupNotificationSystem();
            return;
          }
          if (event === 'USER_UPDATED') {
            debug.log('Auth event: USER_UPDATED - updating session');
            this.session = session;
            return;
          }
          // SIGNED_IN, TOKEN_REFRESHED, INITIAL_SESSION with same user = IGNORE
          // These fire on tab visibility changes and would break connections
          return;
        }
        
        // Not logged in, or different user - process the event
        debug.log(`Auth event: ${event}, AAL: ${this.getAAL(session)}`);
        
        if (event === 'PASSWORD_RECOVERY') {
          debug.log('PASSWORD_RECOVERY event detected - entering password reset mode');
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
        
        if (event === 'SIGNED_OUT') {
          debug.log('Auth event: SIGNED_OUT');
          this.isPasswordResetMode = false;
          this.session = null;
          if (currentUserId) {
            await this.setUserOffline(currentUserId);
          }
          userStorage.clearCurrentUser();
          this.cleanupNotificationSystem();
          return;
        }
        
        if (event === 'MFA_CHALLENGE_VERIFIED') {
          debug.log('MFA challenge verified - allowing session through');
          this.session = session;
          if (session?.user?.id) {
            this.setupOfflineHandlers(session.user.id);
          }
          return;
        }
        
        if (event === 'SIGNED_IN' && session) {
          // Skip validation if MFA flow is in progress - the AAL1 session is
          // expected and will be upgraded to AAL2 by verify2FA()
          if (this._pendingMFAVerification) {
            debug.log('SIGNED_IN during pending MFA verification - skipping (will upgrade to AAL2)');
            return;
          }
          const isValid = await this.validateSessionForMFA(session);
          if (!isValid) {
            debug.warn('SIGNED_IN with invalid AAL1 session (MFA enabled) - signing out');
            // Mirrors initializeAuth(): the AAL1 session must be destroyed,
            // otherwise it sits in Supabase storage and the next tab/refresh
            // picks it up and logs in without MFA.
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
          
          debug.log('New login validated');
          this.isPasswordResetMode = false;
          this.session = session;
          if (session.user?.id) {
            userStorage.setCurrentUser(session.user.id);
            this.setupOfflineHandlers(session.user.id);
            this.initializeUserSettings(session.user.id);
            const activityPubStore = useActivityPubStore();
            void activityPubStore.initialize().catch((err) =>
              debug.error('ActivityPub initialize after SIGNED_IN failed:', err)
            );
          }
          return;
        }
        
        if (event === 'INITIAL_SESSION' && session) {
          // This branch also runs when `this.session` was null and
          // INITIAL_SESSION fires from another tab's just-created AAL1
          // session - an MFA-required session that has not completed
          // verification. Re-validate before adopting, unless
          // _mfaValidatedForSession records this tab's own boot-path
          // validation from initializeAuth().
          if (!this.session) {
            // Skip when an MFA flow is in progress (login() / verify2FA() /
            // OAuth callback). gotrue-js fires INITIAL_SESSION as a microtask
            // when its `_emitInitialSession` runs after `detectSessionInUrl`
            // exchanges the OAuth code; this microtask runs BEFORE
            // AuthCallbackView mounts. Without this guard, the AAL1 OAuth
            // session would be torn down by `validateSessionForMFA` before
            // the callback view's MFA challenge UI ever appears.
            if (this._pendingMFAVerification) {
              debug.log('INITIAL_SESSION during pending MFA verification - skipping')
              return
            }
            const alreadyValidated = this._mfaValidatedForSession === session.access_token
            const isValid = alreadyValidated || (await this.validateSessionForMFA(session))
            if (!isValid) {
              debug.warn('INITIAL_SESSION blocked: AAL1 session with MFA enabled (BUGS.md C11)')
              try { await supabase.auth.signOut() } catch { /* ignore */ }
              this.session = null
              this.cleanupNotificationSystem()
              return
            }
            this._mfaValidatedForSession = session.access_token
            this.session = session;
            if (session.user?.id) {
              userStorage.setCurrentUser(session.user.id);
              this.setupOfflineHandlers(session.user.id);
              const activityPubStore = useActivityPubStore();
              void activityPubStore.initialize().catch((err) =>
                debug.error('ActivityPub initialize after INITIAL_SESSION failed:', err)
              );
            }
          }
          return;
        }
        
        // TOKEN_REFRESHED / catch-all path. Unconditional assignment would
        // let an AAL1 session in via any unhandled event while
        // `this.session` is null, so validate before adopting.
        if (session) {
          // Already logged in: refresh tokens only.
          if (this.session) {
            this.session = session;
            return;
          }
          // Same MFA-in-progress guard as above - without it, a
          // TOKEN_REFRESHED arriving while AuthCallbackView is mid-challenge
          // would tear down the AAL1 session before verification completes.
          if (this._pendingMFAVerification) {
            debug.log(`${event} during pending MFA verification - skipping`)
            return
          }
          const isValid = await this.validateSessionForMFA(session);
          if (!isValid) {
            debug.warn(`${event} blocked: AAL1 session with MFA enabled (BUGS.md C11)`)
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
        debug.log('Initializing Megolm encryption service...');
        
        const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService');
        // The service internally converts auth_user_id to profile_id
        await megolmMessageEncryptionService.initialize(authUserId);
        
        const hasRecoveryKey = await megolmMessageEncryptionService.hasRecoveryKey();
        
        if (hasRecoveryKey) {
          debug.log('User has recovery key set up');
          debug.log('ℹUser needs to enter recovery phrase to unlock encryption');
          // Recovery key exists but the vault stays locked until the phrase is entered.
        } else {
          debug.log('ℹEncryption service initialized but user has no recovery key yet');
          debug.log('ℹUser can set up encryption in Settings > Encryption');
        }
      } catch (error) {
        debug.error('Failed to initialize encryption:', error);
      }
    },

    setupOfflineHandlers(_userId: string) {
      this.cleanupOfflineHandlers();
      
      const handleBeforeUnload = (_event: BeforeUnloadEvent) => {
        // Best-effort Redis offline (keepalive lets it finish after page unload).
        // If this fails, the Redis TTL key auto-expires after 90s.
        realtimeApiService.goOffline().catch(() => {})

        if ((window as any).__harmonyPresenceCleanup) {
          (window as any).__harmonyPresenceCleanup();
        }
      };

      window.addEventListener('beforeunload', handleBeforeUnload);
      window.addEventListener('unload', handleBeforeUnload);
      window.addEventListener('pagehide', handleBeforeUnload);

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
      // `signInWithPassword` resolves with an AAL1 session and queues a
      // `SIGNED_IN` event as a microtask. The `await`s below for the
      // suspended-user check and `listFactors` yield the event loop, so that
      // microtask runs before MFA requirement is known.
      //
      // Setting the flag inside the `if (totpFactor)` branch instead leaves
      // it false when the SIGNED_IN handler runs: `validateSessionForMFA`
      // rejects the AAL1 session of an MFA-enrolled user and signs out. By
      // the time `listFactors` runs the session is gone, `totpFactor` is
      // undefined, and `login()` returns `{ requires2FA: false }` for a user
      // with 2FA - the UI navigates to /chat with a null session and renders
      // blank, and the MFA modal never appears.
      //
      // With the flag set first, the SIGNED_IN handler returns early, the
      // AAL1 session survives, listFactors finds the factor, and the flow
      // below either routes to the MFA modal or finalizes the session.
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
            // The `finally` below clears the flag; clearing it here would
            // race the SIGNED_OUT handler against half-cleared state.
            await supabase.auth.signOut();
            throw new Error(
              profile.suspension_reason
                ? `Your account has been suspended: ${profile.suspension_reason}`
                : 'Your account has been suspended. Please contact an administrator.'
            );
          }
        }

        const { data: factors } = await supabase.auth.mfa.listFactors();
        const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified');

        if (totpFactor) {
          debug.log('2FA required - session is AAL1, need AAL2 verification');

          const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
            factorId: totpFactor.id,
          });

          if (challengeError) {
            // Cleared here rather than in `finally` because the error
            // propagates to the caller, which lets the user retry.
            this._pendingMFAVerification = false;
            throw challengeError;
          }

          // The flag stays set across this return; `verify2FA` clears it in
          // its `finally` block once MFA completes.
          return {
            requires2FA: true,
            factorId: totpFactor.id,
            challengeId: challengeData.id,
            session: null,
          };
        }

        // No 2FA path: the flag made the SIGNED_IN handler skip, so session
        // adoption and post-login setup happen here. Mirrors the
        // `event === 'SIGNED_IN'` block in `onAuthStateChange` so both paths
        // produce identical state.
        this._pendingMFAVerification = false;
        this.isPasswordResetMode = false;
        this.session = data.session;
        if (data.session?.user?.id) {
          userStorage.setCurrentUser(data.session.user.id);
          this.setupOfflineHandlers(data.session.user.id);
          this.initializeUserSettings(data.session.user.id);
          const activityPubStore = useActivityPubStore();
          void activityPubStore.initialize().catch((err) =>
            debug.error('ActivityPub initialize after login failed:', err)
          );
        }

        return {
          requires2FA: false,
          factorId: null,
          challengeId: null,
          session: data.session,
        };
      } catch (err) {
        // Every failure path - sign-in error, suspended user, MFA challenge
        // error - clears the flag, otherwise later login attempts and a
        // fresh INITIAL_SESSION stay stuck in the "skip SIGNED_IN" state.
        this._pendingMFAVerification = false;
        throw err;
      }
    },

    async verify2FA(factorId: string, challengeId: string, code: string) {
      try {
        // 30s timeout race; without it mobile clients spin forever
        const verifyPromise = supabase.auth.mfa.verify({
          factorId,
          challengeId,
          code,
        });
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('MFA verification timed out. Please try logging in again.')), 30000),
        );

        const { data: verifyData, error: verifyError } = await Promise.race([
          verifyPromise,
          timeoutPromise,
        ]);

        if (verifyError) {
          debug.error('MFA verify error:', verifyError);
          throw verifyError;
        }

        // `mfa.verify` returns the AAL2 session directly. Reading it back
        // through `getSession()` can observe the pre-upgrade storage value,
        // leaving `session` null - `isLoggedIn` stays false and the route
        // guard bounces /chat back to /login with no error shown.
        let verifiedSession = verifyData?.session ?? null;
        if (!verifiedSession) {
          const { data: sessionData } = await supabase.auth.getSession();
          verifiedSession = sessionData.session;
        }
        if (!verifiedSession) {
          throw new Error('MFA verification succeeded but no session was returned. Please try logging in again.');
        }

        this.session = verifiedSession;

        // The `MFA_CHALLENGE_VERIFIED` event handler only runs
        // `setupOfflineHandlers` - it skips `userStorage.setCurrentUser`,
        // `initializeUserSettings`, and `activityPubStore.loadBlockingData`,
        // all of which the SIGNED_IN handler runs. Mirrored here so 2FA
        // users reach the same initialized state; without it the chat view
        // loads with the default theme, no user-scoped storage, and stale
        // block lists.
        this.isPasswordResetMode = false;
        if (verifiedSession.user?.id) {
          userStorage.setCurrentUser(verifiedSession.user.id);
          this.setupOfflineHandlers(verifiedSession.user.id);
          this.initializeUserSettings(verifiedSession.user.id);
          const activityPubStore = useActivityPubStore();
          void activityPubStore.initialize().catch((err) =>
            debug.error('ActivityPub initialize after 2FA failed:', err)
          );
        }

        debug.log('2FA verified - session upgraded to AAL2');

        return { session: verifiedSession };
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

    clearPasswordResetMode() {
      this.isPasswordResetMode = false;
    },

    async logout() {
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

      userStorage.clearCurrentUser();
      
      // Stores are cleared after navigation; order is irrelevant once
      // components have unmounted.
      try {
        const { useProfileStore } = await import('@/stores/useProfile')
        const profileStore = useProfileStore()
        profileStore.clearProfile()
      } catch (error) {
        debug.error('Error clearing profile store:', error)
      }
      
      try {
        const { useVisualTheme } = await import('@/composables/useVisualTheme')
        const visualTheme = useVisualTheme()
        visualTheme.reset()
      } catch (error) {
        debug.error('Error resetting visual theme:', error)
      }
      
      try {
        const { useActivityPubStore } = await import('@/stores/useActivityPub')
        const activityPubStore = useActivityPubStore()
        activityPubStore.cleanupRealtimeSubscriptions()
        activityPubStore.clearTimelineCache()
        // BUGS.md Pattern B / #3 v2: typed store action. `bookmarks` is
        // `TimelinePost[]`, not an object with `.posts`. See
        // `resetUserRelationshipState` for the fields it covers.
        activityPubStore.resetUserRelationshipState()
      } catch (error) {
        debug.error('Error clearing ActivityPub timeline:', error)
      }

      try {
        // BUGS.md Pattern B / #1: voice channel state lives under a global
        // localStorage key. Uncleared, the next user on a shared device
        // auto-reconnects to the previous user's channel. Force-leave
        // before clearing the saved state.
        const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
        const voiceStore = useUnifiedVoiceChannelStore()
        if (voiceStore.isConnected) {
          await voiceStore.leaveVoiceChannel()
        }
        voiceStore.clearVoiceChannelState()
        voiceStore.stopVoiceSessionHeartbeat()
      } catch (error) {
        debug.error('Error clearing voice channel state:', error)
      }

      try {
        // BUGS.md Pattern B / #4: reactions Maps and the 30 s reconcile
        // interval leak across user sessions in the same tab unless
        // stopped. `$dispose` on useReactions clears the interval and any
        // pending reconcile timeouts.
        const { useReactionsStore } = await import('@/stores/useReactions')
        const reactionsStore = useReactionsStore() as any
        if (typeof reactionsStore.$dispose === 'function') {
          try { reactionsStore.$dispose() } catch { /* noop */ }
        }
      } catch (error) {
        debug.error('Error clearing reactions store:', error)
      }

      try {
        // BUGS.md Pattern B / #4 v2: `usePostReactionsStore` is a setup
        // store, so Pinia's `$reset()` throws ("does not implement
        // $reset"). Its `$dispose` clears the Maps, Sets, and pending
        // reconcile timeouts.
        const { usePostReactionsStore } = await import('@/stores/postReactions')
        const postReactionsStore = usePostReactionsStore() as any
        if (typeof postReactionsStore.$dispose === 'function') {
          try { postReactionsStore.$dispose() } catch { /* noop */ }
        }
      } catch (error) {
        debug.error('Error clearing post reactions store:', error)
      }

      try {
        // BUGS.md Pattern B / #5 + M11: cleanupBroadcastHandlers also clears
        // the DND check `setInterval`, which would otherwise fire against a
        // stale store after logout.
        const { useNotificationStore } = await import('@/stores/useNotification')
        const notificationStore = useNotificationStore() as any
        if (typeof notificationStore.cleanupBroadcastHandlers === 'function') {
          notificationStore.cleanupBroadcastHandlers()
        }
      } catch (error) {
        debug.error('Error cleaning up notification store:', error)
      }

      try {
        const { useEmojiCacheStore } = await import('@/stores/useEmojiCache')
        const emojiCacheStore = useEmojiCacheStore()
        emojiCacheStore.cleanupRealtimeSubscriptions()
      } catch (error) {
        debug.error('Error cleaning up emoji cache:', error)
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
        debug.error('Error clearing chat store:', error)
      }

      try {
        const { useDMStore } = await import('@/stores/useDM')
        const dmStore = useDMStore()
        dmStore.cleanup()
      } catch (error) {
        debug.error('Error clearing DM store:', error)
      }

      try {
        const { useServerChannelStore } = await import('@/stores/useServerChannel')
        const serverStore = useServerChannelStore()
        await serverStore.cleanupSubscriptions()
        serverStore.$reset()
      } catch (error) {
        debug.error('Error clearing server channel store:', error)
      }

      try {
        const { useServerUsersStore } = await import('@/stores/useServerUsers')
        const serverUsersStore = useServerUsersStore()
        serverUsersStore.cleanup()
      } catch (error) {
        debug.error('Error clearing server users store:', error)
      }

      try {
        const { usePushNotifications } = await import('@/composables/usePushNotifications')
        const pushNotifications = usePushNotifications()
        pushNotifications.resetState()
      } catch (error) {
        debug.error('Error resetting push notification state:', error)
      }

      try {
        const { statePersistence } = await import('@/services/StatePersistence')
        await statePersistence.cleanup()
      } catch (error) {
        debug.error('Error cleaning up state persistence:', error)
      }

      try {
        // BUGS.md H50: permission/role caches are module-level, outside
        // Pinia state. Uncleared, the previous user's permission map leaks
        // to the next user on a shared device.
        const { clearAllPermissionCaches } = await import('@/composables/useServerPermissions')
        clearAllPermissionCaches()
      } catch (error) {
        debug.error('Error clearing permission caches:', error)
      }
    },

    async initializeNotificationSystem(userId: string) {
      try {
        debug.log('Initializing notification system for user:', userId);

        // Dynamic import avoids a circular dependency with useNotification.
        const { useNotificationStore } = await import('@/stores/useNotification');
        const notificationStore = useNotificationStore();
        
        if (notificationStore.isInitialized) {
          debug.log('Notification system already initialized, skipping...');
          return;
        }
        
        await notificationStore.initialize(userId);
        
        debug.log('Notification system initialized successfully');
      } catch (error) {
        debug.error('Failed to initialize notification system:', error);
      }
    },

    // Called on logout.
    cleanupNotificationSystem() {
      try {
        debug.log('Cleaning up notification system');
        
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
          debug.log('Notification system cleaned up');
        }).catch(error => {
          debug.error('Error during notification cleanup:', error);
        });
        
        import('@/services/ViewContextTracker').then(({ viewContextTracker }) => {
          viewContextTracker.reset();
        }).catch(error => {
          debug.error('Error resetting view context:', error);
        });

        // Lock encryption and clear stored session keys from IndexedDB
        import('@/services/encryption/MegolmMessageEncryptionService').then(async ({ megolmMessageEncryptionService }) => {
          await megolmMessageEncryptionService.lockEncryption();
          debug.log('Encryption locked on logout');
        }).catch(error => {
          debug.error('Error locking encryption:', error);
        });
        
      } catch (error) {
        debug.error('Error cleaning up notification system:', error);
      }
    },

    /**
     * Loads theme from localStorage first, then fetches the profile in the
     * background.
     */
    async initializeUserSettings(userId: string) {
      try {
        debug.log('Initializing user settings for:', userId);

        // Theme from localStorage first (sync) so the UI doesn't flash while profile loads.
        const { useVisualTheme } = await import('@/composables/useVisualTheme');
        const visualTheme = useVisualTheme();
        const themeInitPromise = visualTheme.initialize();
        
        const { useProfileStore } = await import('@/stores/useProfile');
        const profileStore = useProfileStore();
        const profilePromise = profileStore.fetchProfileByAuthUserId(userId);
        
        await Promise.all([themeInitPromise, profilePromise]);
        
        import('./useTheme').then(({ useThemeStore }) => {
          const themeStore = useThemeStore();
          if (!themeStore.isInitialized) {
            themeStore.initialize().catch(() => {});
          }
        });
        
        debug.log('User settings initialized');
      } catch (error) {
        debug.error('Error initializing user settings:', error);
      }
    },
  },
});
