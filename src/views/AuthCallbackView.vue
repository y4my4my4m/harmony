<template>
  <div class="callback-wrapper">
    <div class="callback-card">
      <!-- Loading State -->
      <div v-if="status === 'loading'" class="callback-content">
        <div class="loader">
          <div class="loader-ring"></div>
          <img src="/icon_3d.webp" alt="Harmony" class="loader-logo" />
        </div>
        <h2>{{ $t('auth.callback.signingIn') || 'Signing you in...' }}</h2>
        <p>{{ $t('auth.callback.pleaseWait') || 'Please wait while we complete your authentication.' }}</p>
      </div>

      <!-- MFA Challenge State (OAuth user with 2FA enrolled) -->
      <div v-else-if="status === 'mfa'" class="callback-content mfa">
        <div class="mfa-icon shield">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <h2>{{ $t('auth.twoFactorAuth') || 'Two-Factor Authentication' }}</h2>
        <p>{{ useRecoveryCode ? ($t('auth.enterRecoveryCode') || 'Enter one of your recovery codes.') : ($t('auth.enter6DigitCode') || 'Enter the 6-digit verification code from your authenticator app.') }}</p>

        <form @submit.prevent="handleMFAVerification" class="mfa-form">
          <input
            v-model="mfaCode"
            type="text"
            class="code-input"
            :class="{ 'error': mfaError }"
            :placeholder="useRecoveryCode ? 'XXXXXXXX' : '000000'"
            :maxlength="useRecoveryCode ? 8 : 6"
            :inputmode="useRecoveryCode ? 'text' : 'numeric'"
            autocomplete="one-time-code"
            autofocus
            @input="handleMFACodeInput"
          />
          <p v-if="mfaError" class="error-text">{{ mfaError }}</p>

          <button
            type="submit"
            class="btn-primary"
            :disabled="mfaLoading || (useRecoveryCode ? mfaCode.length !== 8 : mfaCode.length !== 6)"
          >
            <span v-if="!mfaLoading">{{ $t('auth.verify') || 'Verify' }}</span>
            <span v-else>...</span>
          </button>

          <button
            type="button"
            class="link-button"
            @click="toggleRecoveryCodeMode"
            :disabled="mfaLoading"
          >
            {{ useRecoveryCode ? ($t('auth.useAuthenticatorCode') || 'Use authenticator code instead') : ($t('auth.useRecoveryCode') || 'Use a recovery code instead') }}
          </button>

          <button
            type="button"
            class="link-button cancel-link"
            @click="cancelMfaAndGoToLogin"
            :disabled="mfaLoading"
          >
            {{ $t('common.cancel') || 'Cancel' }}
          </button>
        </form>
      </div>

      <!-- Error State -->
      <div v-else-if="status === 'error'" class="callback-content error">
        <div class="error-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.error') || 'Authentication Failed' }}</h2>
        <p>{{ errorMessage }}</p>
        <button @click="goToLogin" class="btn-primary">
          {{ $t('auth.callback.tryAgain') || 'Try Again' }}
        </button>
      </div>

      <!-- Success State (brief flash before redirect) -->
      <div v-else-if="status === 'success'" class="callback-content success">
        <div class="success-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.success') || 'Welcome!' }}</h2>
        <p>{{ $t('auth.callback.redirecting') || 'Redirecting you now...' }}</p>
      </div>
    </div>

    <!-- Background -->
    <div class="bg-gradient"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import type { Session } from '@supabase/supabase-js'

const router = useRouter()
const authStore = useAuthStore()

// Added 'mfa' state: an OAuth user who is MFA-enrolled lands at AAL1
// after the provider redirect; we challenge them inline here rather than
// the previous behavior of signing them out with a confusing error toast.
const status = ref<'loading' | 'mfa' | 'success' | 'error'>('loading')
const errorMessage = ref('')

// MFA challenge state (only used when status === 'mfa')
const pendingFactorId = ref('')
const pendingChallengeId = ref('')
const mfaCode = ref('')
const mfaError = ref('')
const mfaLoading = ref(false)
const useRecoveryCode = ref(false)

const goToLogin = () => {
  router.push('/login')
}

const handleMFACodeInput = () => {
  mfaError.value = ''
  if (useRecoveryCode.value) {
    mfaCode.value = mfaCode.value.toUpperCase()
  }
}

const toggleRecoveryCodeMode = () => {
  useRecoveryCode.value = !useRecoveryCode.value
  mfaCode.value = ''
  mfaError.value = ''
}

const cancelMfaAndGoToLogin = async () => {
  // The user clicked "Cancel" instead of completing MFA. Tear down the
  // AAL1 session - leaving it in storage means a different tab on the
  // same browser would pick it up via INITIAL_SESSION, hit
  // validateSessionForMFA's reject branch, and call signOut anyway, but
  // doing it here makes the intent explicit and avoids the brief window
  // where the stale token sits around.
  authStore._pendingMFAVerification = false
  try { await supabase.auth.signOut() } catch (err) {
    debug.error('Failed to sign out AAL1 session on MFA cancel:', err)
  }
  authStore.session = null
  router.push('/login')
}

/**
 * Final post-login navigation: profile-existence check, then redirect.
 * Called from BOTH the no-MFA path (validateSessionForMFA returned true
 * directly) and the post-MFA path (after successful verify2FA). The
 * `authStore.session` must already be populated at this point -
 * `verify2FA` updates it itself, and the no-MFA path sets it explicitly
 * just before calling this helper.
 */
const finalizeLoginAndRedirect = async (session: Session) => {
  status.value = 'success'
  const { data: existingProfile } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()

  setTimeout(() => {
    if (!existingProfile || !existingProfile.username) {
      router.push('/new-profile')
    } else {
      router.push('/chat')
    }
  }, 800)
}

const handleMFAVerification = async () => {
  const expectedLength = useRecoveryCode.value ? 8 : 6
  if (mfaCode.value.length !== expectedLength) {
    mfaError.value = `Please enter a ${expectedLength}-${useRecoveryCode.value ? 'character' : 'digit'} code`
    return
  }

  mfaLoading.value = true
  mfaError.value = ''

  try {
    if (useRecoveryCode.value) {
      // Recovery-code path: verify the code, then unenroll the factor
      // (mirroring `AuthComponent.handle2FAVerification`'s recovery flow).
      // The user is in a recovery scenario - they presumably lost their
      // authenticator - so it makes sense to disable MFA and route them
      // to settings to re-enable it later.
      const { data: sessionData } = await supabase.auth.getSession()
      const userId = sessionData.session?.user?.id
      if (!userId) throw new Error('User session not found')

      const { data: isValid, error } = await supabase.rpc('verify_recovery_code', {
        p_user_id: userId,
        p_code: mfaCode.value,
      })
      if (error) throw error
      if (!isValid) {
        mfaError.value = 'Invalid or already-used recovery code'
        return
      }

      await supabase.auth.mfa.unenroll({ factorId: pendingFactorId.value })

      const { data: refreshed } = await supabase.auth.getSession()
      // Adopt the (now-unenrolled, AAL1-OK-because-no-MFA) session.
      authStore.session = refreshed.session
      authStore._pendingMFAVerification = false

      if (!refreshed.session) {
        throw new Error('Session lost after recovery-code unenroll')
      }
      await finalizeLoginAndRedirect(refreshed.session)
    } else {
      // TOTP path: `verify2FA` runs `mfa.verify`, awaits the AAL2 session,
      // and (post-fix) runs the same post-login setup that the SIGNED_IN
      // handler would have run. We just need to navigate after it.
      const { session: verifiedSession } = await authStore.verify2FA(
        pendingFactorId.value,
        pendingChallengeId.value,
        mfaCode.value,
      )
      if (!verifiedSession) {
        throw new Error('No session after MFA verification')
      }
      await finalizeLoginAndRedirect(verifiedSession)
    }
  } catch (error: any) {
    debug.error('OAuth callback MFA verification error:', error)
    mfaError.value = error?.message || 'Verification failed'
  } finally {
    mfaLoading.value = false
  }
}

onMounted(async () => {
  try {
    // The OAuth callback will have the code in the URL
    // Supabase client handles the token exchange automatically
    // when detectSessionInUrl is true (which it is in our config)

    const { data: { session }, error } = await supabase.auth.getSession()

    if (error) throw error

    if (!session) {
      const hashParams = new URLSearchParams(window.location.hash.substring(1))
      const queryParams = new URLSearchParams(window.location.search)

      const errorParam = hashParams.get('error') || queryParams.get('error')
      const errorDescription = hashParams.get('error_description') || queryParams.get('error_description')

      if (errorParam) {
        throw new Error(errorDescription || errorParam)
      }
      throw new Error('No session found after authentication')
    }

    // Debug: Log user info and identities to understand account linking
    if (session.user) {
      const identities = session.user.identities || []
      const primaryEmail = session.user.email

      debug.log('🔐 OAuth callback - User info:', {
        userId: session.user.id,
        email: primaryEmail,
        emailVerified: session.user.email_confirmed_at,
        identities: identities.map((id: any) => ({
          provider: id.provider,
          email: id.email || id.identity_data?.email || 'unknown',
          identityId: id.id,
        })),
      })

      if (identities.length > 1) {
        const identityEmails = identities
          .map((id: any) => id.email || id.identity_data?.email)
          .filter(Boolean)

        const allEmailsMatch = identityEmails.every((email: string) =>
          email?.toLowerCase() === primaryEmail?.toLowerCase()
        )

        if (!allEmailsMatch) {
          debug.error('⚠️ UNEXPECTED ACCOUNT LINKING DETECTED!', {
            primaryEmail,
            linkedEmails: identityEmails,
            identities: identities.map((id: any) => ({
              provider: id.provider,
              email: id.email || id.identity_data?.email,
            })),
          })
          debug.warn('⚠️ Accounts with different emails were linked. This should only happen when emails match!')
        } else {
          debug.log('✅ Account linking detected with matching emails:', identityEmails.join(', '))
        }
      }

      const { data: profile } = await supabase
        .from('profiles')
        .select('is_suspended, suspension_reason')
        .eq('auth_user_id', session.user.id)
        .maybeSingle()

      if (profile?.is_suspended) {
        await supabase.auth.signOut()
        throw new Error(
          profile.suspension_reason
            ? `Your account has been suspended: ${profile.suspension_reason}`
            : 'Your account has been suspended. Please contact an administrator.'
        )
      }
    }

    // BUGS.md C11: Don't bypass MFA validation. The OAuth callback used to
    // assign `authStore.session = session` directly, which skips both
    // `onAuthStateChange`'s SIGNED_IN MFA check and the on-init validation -
    // any MFA-enrolled user could land here at AAL1 and gain full app access.
    const isValid = await authStore.validateSessionForMFA(session)
    if (!isValid) {
      // The session is AAL1; figure out WHY validateSessionForMFA rejected.
      // If the user has a verified TOTP factor, this is a recoverable
      // "MFA needed" state - challenge them inline. If listFactors fails
      // or returns empty (some other validation failure path), give up
      // and redirect to login.
      const { data: factors, error: factorsError } = await supabase.auth.mfa.listFactors()
      if (factorsError) {
        debug.error('Failed to list factors after AAL1 rejection:', factorsError)
        try { await supabase.auth.signOut() } catch { /* ignore */ }
        authStore.session = null
        throw new Error('Authentication failed. Please try again.')
      }

      const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified')
      if (!totpFactor) {
        // No factor → not the "needs MFA" case. Bail.
        debug.warn('🚨 OAuth callback rejected at AAL1 with no MFA factor - unexpected, signing out')
        try { await supabase.auth.signOut() } catch { /* ignore */ }
        authStore.session = null
        throw new Error('Authentication failed. Please try again.')
      }

      // Issue a challenge against the user's verified factor. Set the
      // pending-MFA flag BEFORE the challenge call so any incidental
      // SIGNED_IN/INITIAL_SESSION events that arrive while we're waiting
      // for user input don't trigger validateSessionForMFA's reject path
      // and tear down the AAL1 session out from under us. (Same pattern
      // as `authStore.login()` - see `src/stores/auth.ts:540`.)
      authStore._pendingMFAVerification = true

      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: totpFactor.id,
      })

      if (challengeError) {
        debug.error('Failed to create MFA challenge in OAuth callback:', challengeError)
        authStore._pendingMFAVerification = false
        try { await supabase.auth.signOut() } catch { /* ignore */ }
        authStore.session = null
        throw new Error('Failed to start two-factor verification. Please try again.')
      }

      pendingFactorId.value = totpFactor.id
      pendingChallengeId.value = challengeData.id
      // Show the challenge form and wait for `handleMFAVerification` to
      // finish the login. We do NOT set `authStore.session` here - it
      // gets set by `verify2FA` (or by the recovery-code branch).
      status.value = 'mfa'
      return
    }

    // No MFA needed. Adopt session, clear the deferral flag set by
    // initializeAuth, and proceed to redirect.
    authStore.session = session
    authStore._pendingMFAVerification = false
    await finalizeLoginAndRedirect(session)
  } catch (error: any) {
    debug.error('OAuth callback error:', error)
    // Always clear the deferral flag on the error exit so a subsequent
    // login attempt isn't stuck in the "skip SIGNED_IN" state set by
    // initializeAuth's /auth/callback branch.
    authStore._pendingMFAVerification = false
    status.value = 'error'
    errorMessage.value = error.message || 'An error occurred during authentication'
  }
})

// Belt-and-suspenders cleanup: if the user navigates away mid-challenge
// (browser back, manual URL change, accidental tab close), the explicit
// exit handlers (`cancelMfaAndGoToLogin`, the success/error branches) may
// not run. Without this `onBeforeUnmount`, `_pendingMFAVerification`
// would stay true for the rest of the page's lifetime and silently
// suppress every SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED for the
// session - including legitimate cross-user logins.
onBeforeUnmount(() => {
  if (authStore._pendingMFAVerification) {
    debug.log('🔒 AuthCallbackView unmounting with pending-MFA flag set - clearing')
    authStore._pendingMFAVerification = false
  }
})
</script>

<style scoped>
.callback-wrapper {
  min-height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #0a0a0f;
  position: relative;
  overflow: hidden;
}

.bg-gradient {
  position: fixed;
  inset: 0;
  background: 
    radial-gradient(ellipse 60% 40% at 50% 40%, rgba(99, 102, 241, 0.15) 0%, transparent 50%),
    radial-gradient(ellipse 40% 30% at 70% 60%, rgba(139, 92, 246, 0.1) 0%, transparent 50%);
  pointer-events: none;
}

.callback-card {
  position: relative;
  z-index: 10;
  background: rgba(17, 17, 23, 0.9);
  backdrop-filter: blur(40px);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 24px;
  padding: 48px;
  min-width: 360px;
  text-align: center;
  box-shadow: 0 32px 64px rgba(0, 0, 0, 0.4);
}

.callback-content {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

.callback-content h2 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.callback-content p {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  margin: 0;
  max-width: 280px;
}

/* Loader */
.loader {
  position: relative;
  width: 80px;
  height: 80px;
  margin-bottom: 8px;
}

.loader-ring {
  position: absolute;
  inset: 0;
  border: 3px solid rgba(99, 102, 241, 0.2);
  border-top-color: #6366f1;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loader-logo {
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  width: 48px;
  height: 48px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Error State */
.error-icon {
  width: 64px;
  height: 64px;
  background: rgba(239, 68, 68, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #ef4444;
  margin-bottom: 8px;
}

.error-icon svg {
  width: 32px;
  height: 32px;
}

.callback-content.error h2 {
  color: #ef4444;
}

/* Success State */
.success-icon {
  width: 64px;
  height: 64px;
  background: rgba(34, 197, 94, 0.1);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #22c55e;
  margin-bottom: 8px;
  animation: scaleIn 0.4s ease;
}

.success-icon svg {
  width: 32px;
  height: 32px;
}

@keyframes scaleIn {
  0% { transform: scale(0); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}

/* Button */
.btn-primary {
  margin-top: 16px;
  padding: 14px 32px;
  background: linear-gradient(135deg, #6366f1 0%, #818cf8 100%);
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px rgba(99, 102, 241, 0.4);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

/* MFA challenge state */
.mfa-icon {
  width: 64px;
  height: 64px;
  background: rgba(99, 102, 241, 0.12);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #818cf8;
  margin-bottom: 8px;
}

.mfa-icon svg {
  width: 32px;
  height: 32px;
}

.mfa-form {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: 100%;
  margin-top: 8px;
}

/* The TOTP input matches the visual style of the login modal's code-input
   for cross-flow consistency - same monospace, centered digits, large
   tap target on mobile. */
.code-input {
  width: 100%;
  text-align: center;
  font-size: 1.75rem;
  letter-spacing: 0.4em;
  padding: 14px 16px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: var(--text-primary, #fff);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}

.code-input:focus {
  border-color: rgba(99, 102, 241, 0.6);
  background: rgba(99, 102, 241, 0.06);
}

.code-input.error {
  border-color: rgba(239, 68, 68, 0.6);
}

.error-text {
  margin: 8px 0 0 0;
  color: #ef4444;
  font-size: 0.875rem;
  text-align: center;
}

.link-button {
  background: none;
  border: none;
  padding: 8px 4px;
  margin-top: 8px;
  color: rgba(255, 255, 255, 0.6);
  font-size: 0.875rem;
  text-decoration: underline;
  cursor: pointer;
  transition: color 0.15s;
}

.link-button:hover:not(:disabled) {
  color: #818cf8;
}

.link-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.link-button.cancel-link {
  color: rgba(255, 255, 255, 0.4);
}

@media (max-width: 480px) {
  .callback-card {
    margin: 20px;
    padding: 32px 24px;
    min-width: auto;
  }
}
</style>

