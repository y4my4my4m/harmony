<template>
  <div class="callback-wrapper">
    <div class="callback-card">
      <div v-if="status === 'loading'" class="callback-content">
        <div class="loader">
          <div class="loader-ring"></div>
          <img src="/icon_3d.webp" alt="Harmony" class="loader-logo" />
        </div>
        <h2>{{ $t('auth.callback.signingIn') || 'Signing you in...' }}</h2>
        <p>{{ $t('auth.callback.pleaseWait') || 'Please wait while we complete your authentication.' }}</p>
      </div>

      <!-- MFA challenge: OAuth user enrolled in 2FA -->
      <div v-else-if="status === 'mfa'" class="callback-content mfa">
        <div class="mfa-icon shield">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
            <path d="M9 12l2 2 4-4"/>
          </svg>
        </div>
        <h2>{{ $t('auth.twoFactorAuth') || 'Two-factor authentication' }}</h2>
        <p>{{ useRecoveryCode ? ($t('auth.enterRecoveryCode') || 'Enter one of your recovery codes.') : ($t('auth.enter6DigitCode') || 'Enter the 6-digit verification code from your authenticator app.') }}</p>

        <form @submit.prevent="handleMFAVerification" class="mfa-form">
          <input
            v-model="mfaCode"
            type="text"
            class="code-input"
            :class="{ 'error': mfaError }"
            :placeholder="useRecoveryCode ? RECOVERY_CODE_PLACEHOLDER : '000000'"
            :maxlength="useRecoveryCode ? RECOVERY_CODE_MAX_LENGTH : 6"
            :inputmode="useRecoveryCode ? 'text' : 'numeric'"
            autocomplete="one-time-code"
            autofocus
            @input="handleMFACodeInput"
          />
          <p v-if="mfaError" class="error-text">{{ mfaError }}</p>

          <button
            type="submit"
            class="btn-primary"
            :disabled="mfaLoading || (useRecoveryCode ? mfaCode.length < RECOVERY_CODE_MIN_LENGTH : mfaCode.length !== 6)"
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

      <div v-else-if="status === 'error'" class="callback-content error">
        <div class="error-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="15" y1="9" x2="9" y2="15"/>
            <line x1="9" y1="9" x2="15" y2="15"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.error') || 'Authentication failed' }}</h2>
        <p>{{ errorMessage }}</p>
        <button @click="goToLogin" class="btn-primary">
          {{ $t('auth.callback.tryAgain') || 'Try again' }}
        </button>
      </div>

      <!-- Success: brief flash before redirect -->
      <div v-else-if="status === 'success'" class="callback-content success">
        <div class="success-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 11.08V12a10 10 0 11-5.93-9.14"/>
            <polyline points="22 4 12 14.01 9 11.01"/>
          </svg>
        </div>
        <h2>{{ $t('auth.callback.success') || 'Signed in' }}</h2>
        <p>{{ $t('auth.callback.redirecting') || 'Redirecting you now...' }}</p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onBeforeUnmount } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { isTauriRuntime } from '@/services/instanceConfig'
import type { Session } from '@supabase/supabase-js'
import { consumePostAuthRedirect } from '@/utils/postAuthRedirect'
import { RECOVERY_CODE_MIN_LENGTH, RECOVERY_CODE_MAX_LENGTH, RECOVERY_CODE_PLACEHOLDER } from '@/utils/mfaConstants'

const router = useRouter()
const authStore = useAuthStore()

// An MFA-enrolled OAuth user lands at AAL1 after the provider redirect.
// The 'mfa' state challenges them inline instead of signing them out.
const status = ref<'loading' | 'mfa' | 'success' | 'error'>('loading')
const errorMessage = ref('')

// MFA challenge state; valid only when status === 'mfa'.
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
  // Tear down the AAL1 session. Left in storage, another tab picks it up via
  // INITIAL_SESSION, hits validateSessionForMFA's reject branch and signs out
  // anyway; clearing here closes the window where the stale token lives.
  authStore._pendingMFAVerification = false
  try { await supabase.auth.signOut() } catch (err) {
    debug.error('Failed to sign out AAL1 session on MFA cancel:', err)
  }
  authStore.session = null
  router.push('/login')
}

/**
 * Post-login navigation: profile-existence check, then redirect.
 * Called from both the no-MFA path (validateSessionForMFA returned true) and
 * the post-MFA path (after verify2FA). `authStore.session` must already be
 * populated: verify2FA updates it, the no-MFA path sets it before calling.
 */
const finalizeLoginAndRedirect = async (session: Session) => {
  status.value = 'success'
  const { data: existingProfile, error: profileError } = await supabase
    .from('profiles')
    .select('id, username')
    .eq('auth_user_id', session.user.id)
    .maybeSingle()

  // On a query error the router guard re-checks; only a confirmed absence
  // goes to the creation wizard.
  const needsProfile = !profileError && (!existingProfile || !existingProfile.username)
  const next = needsProfile ? '/new-profile' : consumePostAuthRedirect('/chat')

  // Native OAuth popup: the session is already persisted to storage shared
  // with the main window. Hand off; the main window closes the popup.
  if (isTauriRuntime()) {
    const { isOAuthPopup, notifyOAuthComplete } = await import('@/services/tauriOAuth')
    if (await isOAuthPopup()) {
      await notifyOAuthComplete(next)
      return
    }
  }

  setTimeout(() => {
    router.push(next)
  }, 800)
}

const handleMFAVerification = async () => {
  // Recovery codes are 10 hex chars since 2026-06; codes issued before that are
  // 8. The verify RPC accepts either, so the client only enforces the minimum.
  if (useRecoveryCode.value) {
    if (mfaCode.value.length < RECOVERY_CODE_MIN_LENGTH) {
      mfaError.value = `Please enter a recovery code of at least ${RECOVERY_CODE_MIN_LENGTH} characters`
      return
    }
  } else if (mfaCode.value.length !== 6) {
    mfaError.value = 'Please enter a 6-digit code'
    return
  }

  mfaLoading.value = true
  mfaError.value = ''

  try {
    if (useRecoveryCode.value) {
      // Recovery-code path: verify the code, then unenroll the factor. The
      // authenticator is presumed lost, so MFA is disabled and re-enabled
      // later from settings.
      //
      // BUGS.md H8 / C11: this verifies and unenrolls client-side from an AAL1
      // session, so the security boundary is in the client. AuthComponent's
      // password-login path uses the atomic `redeem_recovery_code_and_disable_mfa`
      // RPC instead; this path has not been migrated to it.
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
      // Adopt the session; no factor remains, so AAL1 suffices.
      authStore.session = refreshed.session
      authStore._pendingMFAVerification = false

      if (!refreshed.session) {
        throw new Error('Session lost after recovery-code unenroll')
      }
      await finalizeLoginAndRedirect(refreshed.session)
    } else {
      // TOTP path: `verify2FA` runs `mfa.verify`, awaits the AAL2 session, and
      // runs the post-login setup the SIGNED_IN handler would have run.
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
    // The callback URL carries the code; the Supabase client performs the
    // token exchange automatically under detectSessionInUrl.

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

    // Log identities to diagnose account linking.
    if (session.user) {
      const identities = session.user.identities || []
      const primaryEmail = session.user.email

      debug.log('OAuth callback - User info:', {
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
          // debug.error reaches the production console, so addresses stay out
          // of it; providers and counts are enough to identify the case.
          debug.error('Unexpected account linking: identities carry differing emails', {
            identityCount: identities.length,
            providers: identities.map((id: any) => id.provider),
          })
        } else {
          debug.log('Account linking detected across', identityEmails.length, 'matching identities')
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

    // BUGS.md C11: MFA validation must not be bypassed. Assigning
    // `authStore.session = session` directly skips both `onAuthStateChange`'s
    // SIGNED_IN MFA check and the on-init validation, letting an MFA-enrolled
    // user gain full app access at AAL1.
    const isValid = await authStore.validateSessionForMFA(session)
    if (!isValid) {
      // The session is AAL1. A verified TOTP factor means the recoverable
      // "MFA needed" state - challenge inline. A listFactors error or an
      // empty result is some other failure path: redirect to login.
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
        debug.warn('OAuth callback rejected at AAL1 with no MFA factor - unexpected, signing out')
        try { await supabase.auth.signOut() } catch { /* ignore */ }
        authStore.session = null
        throw new Error('Authentication failed. Please try again.')
      }

      // Challenge the verified factor. The pending-MFA flag must be set before
      // the challenge call: SIGNED_IN/INITIAL_SESSION events arriving while
      // awaiting user input would otherwise hit validateSessionForMFA's reject
      // path and tear down the AAL1 session. Same pattern as
      // `authStore.login()` - see `src/stores/auth.ts:540`.
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
      // `handleMFAVerification` finishes the login. `authStore.session` is not
      // set here - `verify2FA` or the recovery-code branch sets it.
      status.value = 'mfa'
      return
    }

    // No MFA. Adopt the session and clear the deferral flag set by
    // initializeAuth.
    authStore.session = session
    authStore._pendingMFAVerification = false
    await finalizeLoginAndRedirect(session)
  } catch (error: any) {
    debug.error('OAuth callback error:', error)
    // Clear the deferral flag on the error exit; otherwise a subsequent login
    // stays stuck in the "skip SIGNED_IN" state set by initializeAuth's
    // /auth/callback branch.
    authStore._pendingMFAVerification = false
    status.value = 'error'
    errorMessage.value = error.message || 'An error occurred during authentication'
  }
})

// Navigating away mid-challenge (browser back, manual URL change, tab close)
// skips the explicit exit handlers (`cancelMfaAndGoToLogin`, the success/error
// branches). Without this, `_pendingMFAVerification` stays true for the page's
// lifetime and suppresses every SIGNED_IN / INITIAL_SESSION / TOKEN_REFRESHED,
// including legitimate cross-user logins.
onBeforeUnmount(() => {
  if (authStore._pendingMFAVerification) {
    debug.log('AuthCallbackView unmounting with pending-MFA flag set - clearing')
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
  background: var(--background-senary);
  position: relative;
  overflow: hidden;
}

.callback-card {
  position: relative;
  z-index: 10;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-xl);
  padding: 48px;
  min-width: 360px;
  text-align: center;
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
  color: var(--text-secondary);
  margin: 0;
  max-width: 280px;
}

.loader {
  position: relative;
  width: 80px;
  height: 80px;
  margin-bottom: 8px;
}

.loader-ring {
  position: absolute;
  inset: 0;
  border: 3px solid color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  border-top-color: var(--harmony-primary);
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

.error-icon {
  width: 64px;
  height: 64px;
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--error);
  margin-bottom: 8px;
}

.error-icon svg {
  width: 32px;
  height: 32px;
}

.callback-content.error h2 {
  color: var(--error);
}

.success-icon {
  width: 64px;
  height: 64px;
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--success);
  margin-bottom: 8px;
}

.success-icon svg {
  width: 32px;
  height: 32px;
}

.btn-primary {
  margin-top: 16px;
  padding: 14px 32px;
  background: var(--harmony-primary);
  border: none;
  border-radius: var(--radius-lg);
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-on-primary);
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.btn-primary:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.mfa-icon {
  width: 64px;
  height: 64px;
  background: color-mix(in srgb, var(--harmony-primary) 12%, transparent);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--harmony-primary);
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

/* Matches the login modal's code-input: same monospace, centered digits,
   large tap target on mobile. */
.code-input {
  width: 100%;
  text-align: center;
  font-size: 1.75rem;
  letter-spacing: 0.4em;
  padding: 14px 16px;
  background: var(--input-bg);
  border: 1px solid var(--border-hover);
  border-radius: var(--radius-lg);
  color: var(--text-primary);
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  outline: none;
  transition: border-color 0.15s, background 0.15s;
}

.code-input:focus {
  border-color: color-mix(in srgb, var(--harmony-primary) 60%, transparent);
  background: color-mix(in srgb, var(--harmony-primary) 6%, transparent);
}

.code-input.error {
  border-color: color-mix(in srgb, var(--error) 60%, transparent);
}

.error-text {
  margin: 8px 0 0 0;
  color: var(--error);
  font-size: 0.875rem;
  text-align: center;
}

.link-button {
  background: none;
  border: none;
  padding: 8px 4px;
  margin-top: 8px;
  color: var(--text-secondary);
  font-size: 0.875rem;
  text-decoration: underline;
  cursor: pointer;
  transition: color 0.15s;
}

.link-button:hover:not(:disabled) {
  color: var(--harmony-primary);
}

.link-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.link-button.cancel-link {
  color: var(--text-muted);
}

@media (max-width: 480px) {
  .callback-card {
    margin: 20px;
    padding: 32px 24px;
    min-width: auto;
  }
}
</style>

