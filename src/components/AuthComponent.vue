<template>
  <AuthShell :mascot-pose="mascotPose" :busy="isLoading">
    <div class="form-header">
      <h2 :id="formTitleId">{{ isLogin ? $t('auth.welcomeBack') : $t('auth.createAccount') }}</h2>
      <p v-if="!isLogin">{{ $t('auth.createAccountSubtitle') }}</p>
    </div>

    <!-- OAuth Providers -->
    <div v-if="enabledOAuthProviders.length > 0" class="oauth-section">
      <button 
        v-for="provider in enabledOAuthProviders" 
        :key="provider.id"
        class="oauth-btn"
        :class="[`oauth-${provider.id}`, { 'loading': oauthLoading === provider.id }]"
        @click="handleOAuthLogin(provider.id)"
        :disabled="isLoading || oauthLoading !== null"
      >
        <span class="oauth-icon" aria-hidden="true" v-html="provider.icon"></span>
        <span class="oauth-label">{{ $t(`auth.oauth.${provider.id}`) }}</span>
        <span v-if="oauthLoading === provider.id" class="oauth-spinner" aria-hidden="true"></span>
      </button>
    </div>

    <!-- Divider (only show if OAuth providers are enabled) -->
    <div v-if="enabledOAuthProviders.length > 0" class="divider">
      <span>{{ $t('auth.orContinueWith') }}</span>
    </div>

    <!-- Email/Password Form -->
    <form
      @submit.prevent="handleSubmit"
      class="auth-form"
      data-testid="auth-form"
      :aria-labelledby="formTitleId"
      novalidate
    >
      <div class="input-group" :class="{ 'focused': emailFocused, 'has-value': email, 'error': emailError }">
        <input 
          ref="emailInput"
          v-model="email" 
          type="email" 
          id="email"
          data-testid="auth-email"
          placeholder=" "
          :aria-invalid="emailError ? 'true' : undefined"
          :aria-describedby="emailError ? 'email-error' : undefined"
          @focus="emailFocused = true"
          @blur="emailFocused = false; validateEmail()"
          @input="emailError = ''; formError = ''"
          required
          autocomplete="email"
        />
        <label for="email">{{ $t('auth.email') }}</label>
        <div class="input-line"></div>
        <!-- Mounted while empty: a live region inserted together with its text is not announced reliably. -->
        <span id="email-error" class="error-text" role="alert" data-testid="auth-email-error">{{ emailError }}</span>
      </div>

      <div class="input-group" :class="{ 'focused': passwordFocused, 'has-value': password, 'error': passwordError }">
        <input 
          ref="passwordInput"
          v-model="password" 
          :type="showPassword ? 'text' : 'password'"
          id="password"
          data-testid="auth-password"
          placeholder=" "
          :aria-invalid="passwordError ? 'true' : undefined"
          :aria-describedby="passwordError ? 'password-error' : undefined"
          @focus="passwordFocused = true"
          @blur="passwordFocused = false; validatePassword()"
          @input="passwordError = ''; formError = ''"
          required
          :autocomplete="isLogin ? 'current-password' : 'new-password'"
        />
        <label for="password">{{ $t('auth.password') }}</label>
        <button 
          type="button" 
          class="password-toggle"
          data-testid="auth-password-toggle"
          :aria-label="$t('auth.showPassword')"
          :aria-pressed="showPassword ? 'true' : 'false'"
          aria-controls="password"
          @click="showPassword = !showPassword"
        >
          <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
            <line x1="1" y1="1" x2="23" y2="23"/>
          </svg>
          <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
            <circle cx="12" cy="12" r="3"/>
          </svg>
        </button>
        <div class="input-line"></div>
        <span id="password-error" class="error-text" role="alert" data-testid="auth-password-error">{{ passwordError }}</span>
      </div>

      <!-- Login Options -->
      <div v-if="isLogin" class="form-options">
        <label class="remember-me">
          <input type="checkbox" class="remember-me__input" data-testid="auth-remember-me" v-model="rememberMe" />
          <span class="checkbox-visual" aria-hidden="true"></span>
          <span>{{ $t('auth.rememberMe') }}</span>
        </label>
        <button type="button" class="forgot-link" aria-haspopup="dialog" @click="openForgotPassword">
          {{ $t('auth.forgotPassword') }}
        </button>
      </div>

      <p id="auth-form-error" class="form-error" role="alert" data-testid="auth-form-error">{{ formError }}</p>

      <!-- aria-disabled, not disabled: a disabled button drops keyboard focus to <body>. -->
      <button 
        type="submit" 
        class="submit-btn"
        data-testid="auth-submit"
        :aria-disabled="isLoading ? 'true' : undefined"
        :aria-busy="isLoading ? 'true' : undefined"
        :class="{ 'is-busy': isLoading }"
      >
        <span v-if="!isLoading" class="btn-text">
          {{ isLogin ? $t('auth.logIn') : $t('auth.createAccountButton') }}
        </span>
        <template v-else>
          <span class="sr-only">{{ isLogin ? $t('auth.signingIn') : $t('auth.creatingAccount') }}</span>
          <span class="btn-loader" aria-hidden="true">
            <span class="dot"></span>
            <span class="dot"></span>
            <span class="dot"></span>
          </span>
        </template>
      </button>
    </form>

    <!-- Switch Mode -->
    <div class="switch-mode">
      <span>{{ isLogin ? $t('auth.dontHaveAccount') : $t('auth.alreadyHaveAccount') }}</span>
      <button type="button" @click="toggleMode" data-testid="auth-switch-mode">
        {{ isLogin ? $t('auth.register') : $t('auth.logIn') }}
      </button>
    </div>

    <!-- Terms -->
    <p v-if="!isLogin && (instanceSettings.settings.termsUrl || instanceSettings.settings.privacyUrl)" class="terms">
      {{ $t('auth.termsPrefix') }}
      <a v-if="instanceSettings.settings.termsUrl" :href="safeHref(instanceSettings.settings.termsUrl)" target="_blank" rel="noopener">{{ $t('auth.termsOfService') }}</a>
      <template v-if="instanceSettings.settings.termsUrl && instanceSettings.settings.privacyUrl">
        {{ $t('auth.and') }}
      </template>
      <a v-if="instanceSettings.settings.privacyUrl" :href="safeHref(instanceSettings.settings.privacyUrl)" target="_blank" rel="noopener">{{ $t('auth.privacyPolicy') }}</a>
    </p>

    <!-- Forgot Password Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showForgotPasswordModal" class="modal-backdrop" @click.self="closeForgotPasswordModal">
          <div
            ref="forgotDialogEl"
            class="modal-card reset-modal"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="forgotTitleId"
            :aria-describedby="forgotDescriptionId"
            tabindex="-1"
            data-testid="forgot-password-dialog"
          >
            <button type="button" class="modal-close" :aria-label="$t('common.close')" @click="closeForgotPasswordModal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>

            <div v-if="forgotPasswordStep === 1" class="modal-content">
              <!-- Decorative header -->
              <div class="modal-header-decoration" aria-hidden="true">
                <div class="modal-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0110 0v4"/>
                  </svg>
                </div>
              </div>

              <h3 :id="forgotTitleId">{{ $t('auth.resetYourPassword') }}</h3>
              <p :id="forgotDescriptionId" class="modal-description">{{ $t('auth.enterEmailForReset') }}</p>

              <form @submit.prevent="handleForgotPassword" class="modal-form" novalidate>
                <div class="input-group modal-input" :class="{ 'focused': forgotEmailFocused, 'has-value': forgotPasswordEmail, 'error': forgotPasswordError }">
                  <input 
                    v-model="forgotPasswordEmail" 
                    type="email"
                    id="forgot-email"
                    data-testid="forgot-email"
                    placeholder=" "
                    :aria-invalid="forgotPasswordError ? 'true' : undefined"
                    :aria-describedby="forgotPasswordError ? 'forgot-email-error' : undefined"
                    @focus="forgotEmailFocused = true"
                    @blur="forgotEmailFocused = false"
                    @input="forgotPasswordError = ''"
                    required
                    autocomplete="email"
                  />
                  <label for="forgot-email">{{ $t('auth.email') }}</label>
                  <div class="input-line"></div>
                  <span id="forgot-email-error" class="error-text" role="alert">{{ forgotPasswordError }}</span>
                </div>

                <div class="modal-actions stacked">
                  <button
                    type="submit"
                    class="btn-primary"
                    data-testid="forgot-submit"
                    :aria-disabled="forgotPasswordLoading ? 'true' : undefined"
                    :aria-busy="forgotPasswordLoading ? 'true' : undefined"
                  >
                    <span v-if="!forgotPasswordLoading">{{ $t('auth.sendResetLink') }}</span>
                    <template v-else>
                      <span class="sr-only">{{ $t('auth.sendingResetLink') }}</span>
                      <span class="btn-loader" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
                    </template>
                  </button>
                  <button type="button" class="btn-text-only" @click="closeForgotPasswordModal">
                    {{ $t('auth.backToLogin') }}
                  </button>
                </div>
              </form>
            </div>

            <div v-else class="modal-content success">
              <div class="success-animation" aria-hidden="true">
                <div class="success-ring"></div>
                <div class="success-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              </div>
              <h3 :id="forgotTitleId">{{ $t('auth.checkEmail') }}</h3>
              <p :id="forgotDescriptionId" class="modal-description">
                {{ $t('auth.checkEmailForReset') }}
              </p>
              <div class="email-preview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                </svg>
                <span>{{ forgotPasswordEmail }}</span>
              </div>
              <button type="button" class="btn-primary full-width" data-autofocus @click="closeForgotPasswordModal">
                {{ $t('auth.gotIt') }}
              </button>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>

    <!-- 2FA Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <!-- The pending aal1 session ends only through an explicit cancel: no backdrop or Escape dismissal. -->
        <div v-if="show2FAModal" class="modal-backdrop" data-testid="twofa-backdrop">
          <div
            ref="twoFactorDialogEl"
            class="modal-card"
            role="dialog"
            aria-modal="true"
            :aria-labelledby="twoFactorTitleId"
            :aria-describedby="twoFactorDescriptionId"
            tabindex="-1"
            data-testid="twofa-dialog"
          >
            <button
              type="button"
              class="modal-close"
              data-testid="twofa-close"
              :aria-label="$t('auth.cancelSignIn')"
              :disabled="twoFactorLoading"
              @click="cancel2FA"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>

            <div class="modal-content">
              <div class="modal-icon shield" aria-hidden="true">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
              </div>
              <h3 :id="twoFactorTitleId">{{ $t('auth.twoFactorAuth') }}</h3>
              <p :id="twoFactorDescriptionId" class="modal-description">{{ useRecoveryCode ? $t('auth.enterRecoveryCode') : $t('auth.enter6DigitCode') }}</p>

              <form @submit.prevent="handle2FAVerification" class="modal-form" novalidate>
                <div class="code-input-container">
                  <label for="twofa-code" class="sr-only">{{ useRecoveryCode ? $t('auth.recoveryCode') : $t('auth.verificationCode') }}</label>
                  <input 
                    id="twofa-code"
                    ref="twoFactorInput"
                    v-model="twoFactorCode"
                    type="text"
                    class="code-input"
                    data-testid="twofa-code"
                    :class="{ 'error': twoFactorError }"
                    :placeholder="useRecoveryCode ? RECOVERY_CODE_PLACEHOLDER : '000000'"
                    :maxlength="useRecoveryCode ? RECOVERY_CODE_MAX_LENGTH : 6"
                    :inputmode="useRecoveryCode ? 'text' : 'numeric'"
                    :aria-invalid="twoFactorError ? 'true' : undefined"
                    :aria-describedby="twoFactorError ? 'twofa-code-error' : undefined"
                    autocomplete="one-time-code"
                    autocapitalize="off"
                    spellcheck="false"
                    @input="handleCodeInput"
                  />
                  <span id="twofa-code-error" class="error-text centered" role="alert" data-testid="twofa-error">{{ twoFactorError }}</span>
                </div>

                <div class="modal-actions">
                  <button type="button" class="btn-secondary" data-testid="twofa-cancel" @click="cancel2FA" :disabled="twoFactorLoading">
                    {{ $t('common.cancel') }}
                  </button>
                  <button 
                    type="submit" 
                    class="btn-primary" 
                    data-testid="twofa-submit"
                    :aria-busy="twoFactorLoading ? 'true' : undefined"
                    :disabled="!twoFactorLoading && (useRecoveryCode ? recoveryCodeLength(twoFactorCode) < RECOVERY_CODE_MIN_LENGTH : twoFactorCode.length !== 6)"
                    :aria-disabled="twoFactorLoading ? 'true' : undefined"
                  >
                    <span v-if="!twoFactorLoading">{{ $t('auth.verify') }}</span>
                    <template v-else>
                      <span class="sr-only">{{ $t('auth.verifying') }}</span>
                      <span class="btn-loader" aria-hidden="true"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
                    </template>
                  </button>
                </div>

                <button 
                  type="button" 
                  class="toggle-recovery" 
                  data-testid="twofa-toggle-recovery"
                  @click="toggleRecoveryCodeMode"
                  :disabled="twoFactorLoading"
                >
                  {{ useRecoveryCode ? $t('auth.useAuthenticatorCode') : $t('auth.useRecoveryCode') }}
                </button>
              </form>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </AuthShell>
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { ref, computed, onMounted, nextTick, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useRoute, useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useToast } from 'vue-toastification'
import { supabase, setRememberMe, getRememberMe } from '@/supabase'
import AuthShell, { type MascotPose } from '@/components/auth/AuthShell.vue'
import { adminService } from '@/services/AdminService'
import { isTauriDesktop } from '@/utils/platform'
import type { Provider } from '@supabase/supabase-js'
import { RECOVERY_CODE_MIN_LENGTH, RECOVERY_CODE_MAX_LENGTH, RECOVERY_CODE_PLACEHOLDER, recoveryCodeLength } from '@/utils/mfaConstants'
import { securityErrorMessage } from '@/services/AccountSecurityService'
import { authErrorMessage } from '@/utils/authErrorMessage'
import { consumePostAuthRedirect } from '@/utils/postAuthRedirect'
import { runtimeConfig } from '@/services/runtimeConfig'
import { useDialog } from '@/composables/useDialog'
import { useAnnouncer } from '@/composables/useAnnouncer'

// Props
interface Props {
  isLogin?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isLogin: true
})

// Composables
const router = useRouter()
const route = useRoute()
const { t } = useI18n()
const authStore = useAuthStore()
const instanceSettings = useInstanceSettingsStore()
const toast = useToast()
const { polite } = useAnnouncer()

const formTitleId = `auth-title-${useId()}`

// Supported OAuth providers. Apple is absent: it requires a paid Apple
// developer account ($99/year).
const allOAuthProviders = [
  {
    id: 'google',
    name: 'Google',
    icon: `<svg viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>`
  },
  {
    id: 'twitch',
    name: 'Twitch',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M11.571 4.714h1.715v5.143H11.57zm4.715 0H18v5.143h-1.714zM6 0L1.714 4.286v15.428h5.143V24l4.286-4.286h3.428L22.286 12V0zm14.571 11.143l-3.428 3.428h-3.429l-3 3v-3H6.857V1.714h13.714z"/></svg>`
  },
  {
    id: 'github',
    name: 'GitHub',
    icon: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.374 0 0 5.373 0 12c0 5.302 3.438 9.8 8.207 11.387.599.111.793-.261.793-.577v-2.234c-3.338.726-4.033-1.416-4.033-1.416-.546-1.387-1.333-1.756-1.333-1.756-1.089-.745.083-.729.083-.729 1.205.084 1.839 1.237 1.839 1.237 1.07 1.834 2.807 1.304 3.492.997.107-.775.418-1.305.762-1.604-2.665-.305-5.467-1.334-5.467-5.931 0-1.311.469-2.381 1.236-3.221-.124-.303-.535-1.524.117-3.176 0 0 1.008-.322 3.301 1.23A11.509 11.509 0 0112 5.803c1.02.005 2.047.138 3.006.404 2.291-1.552 3.297-1.23 3.297-1.23.653 1.653.242 2.874.118 3.176.77.84 1.235 1.911 1.235 3.221 0 4.609-2.807 5.624-5.479 5.921.43.372.823 1.102.823 2.222v3.293c0 .319.192.694.801.576C20.566 21.797 24 17.3 24 12c0-6.627-5.373-12-12-12z"/></svg>`
  }
]

// Enabled OAuth providers (will be filtered based on config)
const enabledOAuthProviders = ref<typeof allOAuthProviders>([])

// Reactive state
const email = ref('')
const password = ref('')
// Seeded from the persisted preference so the checkbox carries the last
// choice across visits. Defaults to `true` for first-time visitors, matching
// `persistSession` in `src/supabase.ts`.
const rememberMe = ref(getRememberMe())
const showPassword = ref(false)
const isLoading = ref(false)
const oauthLoading = ref<string | null>(null)

// Focus states
const emailFocused = ref(false)
const passwordFocused = ref(false)

// Validation states
const emailError = ref('')
const passwordError = ref('')
// Server answer to a submit (wrong credentials, rate limit), shown above the button.
const formError = ref('')
const emailInput = ref<HTMLInputElement | null>(null)
const passwordInput = ref<HTMLInputElement | null>(null)

// Forgot password state
const showForgotPasswordModal = ref(false)
const forgotPasswordEmail = ref('')
const forgotPasswordStep = ref(1)
const forgotPasswordLoading = ref(false)
const forgotPasswordError = ref('')
const forgotEmailFocused = ref(false)
const forgotDialogEl = ref<HTMLElement | null>(null)

// 2FA state
const show2FAModal = ref(false)
const twoFactorCode = ref('')
const twoFactorError = ref('')
const twoFactorLoading = ref(false)
const pendingFactorId = ref('')
const pendingChallengeId = ref('')
const useRecoveryCode = ref(false)
const twoFactorDialogEl = ref<HTMLElement | null>(null)
const twoFactorInput = ref<HTMLInputElement | null>(null)

const { titleId: forgotTitleId, descriptionId: forgotDescriptionId, focusInitial: focusForgotStart } = useDialog({
  open: showForgotPasswordModal,
  element: forgotDialogEl,
  onClose: () => closeForgotPasswordModal(),
})

const { titleId: twoFactorTitleId, descriptionId: twoFactorDescriptionId } = useDialog({
  open: show2FAModal,
  element: twoFactorDialogEl,
  // The pending aal1 session ends only through Cancel.
  closeOnEscape: false,
  initialFocus: '#twofa-code',
})

// Covers its eyes while a hidden password is typed, peeks while it is shown,
// looks sorry after a rejected sign-in until the form is edited.
const mascotPose = computed<MascotPose>(() => {
  if (showPassword.value && password.value) return 'peek'
  if (passwordFocused.value && !showPassword.value) return 'hide'
  if (formError.value) return 'oops'
  return 'idle'
})

// Validation
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

const validateEmail = () => {
  if (!email.value) {
    emailError.value = t('auth.errors.emailRequired')
  } else if (!EMAIL_PATTERN.test(email.value)) {
    emailError.value = t('auth.errors.invalidEmail')
  } else {
    emailError.value = ''
  }
}

const validatePassword = () => {
  if (!password.value) {
    passwordError.value = t('auth.errors.passwordRequired')
  } else if (!props.isLogin && password.value.length < 6) {
    passwordError.value = t('auth.errors.passwordTooShort')
  } else {
    passwordError.value = ''
  }
}

// OAuth Login
const handleOAuthLogin = async (providerId: string) => {
  oauthLoading.value = providerId

  // Persist the remember-me preference BEFORE the OAuth redirect. The session
  // is not created until the OAuth callback returns, but the storage adapter
  // consults this preference at write-time, so it must already be in the
  // originating tab's localStorage - the callback runs after a full page
  // navigation and reads the same key.
  setRememberMe(rememberMe.value)

  try {
    // Check if user is already logged in - if so, warn them about potential account linking
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      debug.warn('User is already logged in when initiating OAuth. This may cause account linking.')
      // Providers only; addresses are not logged.
      debug.log('Current session:', {
        userId: session.user.id,
        existingIdentityProviders: session.user.identities?.map((id: any) => id.provider) || []
      })
    }
    
    // Native desktop: run the provider flow in a popup window so the main
    // app stays put (an in-place webview navigation has no back button).
    const usePopupFlow = isTauriDesktop()

    const { data, error } = await supabase.auth.signInWithOAuth({
      provider: providerId as Provider,
      options: {
        redirectTo: `${window.location.origin}/auth/callback`,
        skipBrowserRedirect: usePopupFlow,
        queryParams: providerId === 'google' ? {
          access_type: 'offline',
          prompt: 'consent',
        } : undefined
      }
    })
    
    if (error) throw error

    if (usePopupFlow) {
      if (!data?.url) throw new Error('No authorization URL returned')
      const { signInViaOAuthPopup } = await import('@/services/tauriOAuth')
      const next = await signInViaOAuthPopup(data.url)
      // The popup persisted the session to shared storage; a full
      // navigation boots the app with it (same as the web redirect flow).
      window.location.assign(next)
      return
    }

    // The browser will redirect to the OAuth provider
  } catch (error: any) {
    if (error?.message === 'oauth-cancelled') {
      oauthLoading.value = null
      return
    }
    debug.error('OAuth error:', error)
    formError.value = authErrorMessage(error, t('auth.errors.oauthFailed', { provider: providerId }))
    oauthLoading.value = null
  }
}

// Email/Password Submit
const handleSubmit = async () => {
  if (isLoading.value) return
  formError.value = ''
  validateEmail()
  validatePassword()
  
  if (emailError.value || passwordError.value) {
    // The field reads its label, invalid state and linked error.
    ;(emailError.value ? emailInput.value : passwordInput.value)?.focus()
    return
  }

  isLoading.value = true
  polite(props.isLogin ? t('auth.signingIn') : t('auth.creatingAccount'))
  
  try {
    if (props.isLogin) {
      // Persist the remember-me preference BEFORE signInWithPassword. The
      // session-aware storage adapter in `src/supabase.ts` reads this on
      // every `setItem` and routes the freshly-issued session token to
      // either `localStorage` (remember) or `sessionStorage` (this tab
      // only). Setting it after `login()` would land the token in the
      // wrong store.
      setRememberMe(rememberMe.value)

      const result = await authStore.login(email.value, password.value)

      if (result.requires2FA) {
        pendingFactorId.value = result.factorId!
        pendingChallengeId.value = result.challengeId!
        show2FAModal.value = true
        isLoading.value = false
        return
      }
    } else {
      // New signups also respect the toggle so a user signing up on a
      // shared computer can keep their session tab-bound.
      setRememberMe(rememberMe.value)
      await authStore.register(email.value, password.value)
      if (!authStore.session) {
        // Email confirmation is enabled: GoTrue issues no session until the
        // link in the confirmation email is followed.
        toast.info(t('auth.confirmEmailSent', { email: email.value }), { timeout: 10000 })
        router.push('/login')
        return
      }
      router.push('/new-profile')
    }
  } catch (error: any) {
    debug.error('Auth error:', error)
    formError.value = authErrorMessage(error, t('auth.callback.failed'))
  } finally {
    isLoading.value = false
  }
}

// 2FA Verification
const handle2FAVerification = async () => {
  if (twoFactorLoading.value) return
  if (useRecoveryCode.value) {
    if (recoveryCodeLength(twoFactorCode.value) < RECOVERY_CODE_MIN_LENGTH) {
      twoFactorError.value = t('security.mfa.recoveryCodeExample')
      return
    }
  } else if (!/^\d{6}$/.test(twoFactorCode.value)) {
    twoFactorError.value = t('security.mfa.enterAuthenticatorCode')
    return
  }

  twoFactorLoading.value = true
  twoFactorError.value = ''

  try {
    if (useRecoveryCode.value) {
      // The redeem RPC consumes the code and removes the factors server-side; the
      // database leaves it reachable from this aal1 session and rate-limits it.
      await authStore.completeRecoverySignIn(twoFactorCode.value)
      show2FAModal.value = false
      toast.warning(t('security.mfa.recoverySignedIn'), { timeout: 10000 })
      router.push('/settings/security')
    } else {
      await authStore.verify2FA(pendingFactorId.value, pendingChallengeId.value, twoFactorCode.value)
      show2FAModal.value = false
      router.push(consumePostAuthRedirect('/chat'))
    }
  } catch (error: any) {
    debug.error('2FA verification error:', error)
    twoFactorError.value = securityErrorMessage(error, useRecoveryCode.value
      ? t('security.mfa.recoveryCodeInvalid')
      : t('security.mfa.verificationFailed'))
    if (!useRecoveryCode.value) twoFactorCode.value = ''
  } finally {
    twoFactorLoading.value = false
  }
  if (twoFactorError.value) {
    await nextTick()
    twoFactorInput.value?.focus()
  }
}

const toggleRecoveryCodeMode = async () => {
  useRecoveryCode.value = !useRecoveryCode.value
  twoFactorCode.value = ''
  twoFactorError.value = ''
  await nextTick()
  twoFactorInput.value?.focus()
}

const handleCodeInput = () => {
  twoFactorError.value = ''
  if (useRecoveryCode.value) {
    twoFactorCode.value = twoFactorCode.value.toUpperCase()
  } else {
    twoFactorCode.value = twoFactorCode.value.replace(/\D/g, '').slice(0, 6)
    if (twoFactorCode.value.length === 6 && !twoFactorLoading.value) void handle2FAVerification()
  }
}

const cancel2FA = async () => {
  show2FAModal.value = false
  twoFactorCode.value = ''
  twoFactorError.value = ''
  pendingFactorId.value = ''
  pendingChallengeId.value = ''
  useRecoveryCode.value = false
  await authStore.cancelPendingSignIn()
}

// Forgot Password
const handleForgotPassword = async () => {
  if (forgotPasswordLoading.value) return
  forgotPasswordError.value = ''
  
  if (!forgotPasswordEmail.value) {
    forgotPasswordError.value = t('auth.errors.emailRequired')
    return
  }

  if (!EMAIL_PATTERN.test(forgotPasswordEmail.value)) {
    forgotPasswordError.value = t('auth.errors.invalidEmail')
    return
  }

  forgotPasswordLoading.value = true

  try {
    const { error } = await authStore.resetPassword(forgotPasswordEmail.value)
    if (error) throw error
    forgotPasswordStep.value = 2
  } catch (error: any) {
    debug.error('Password reset error:', error)
    if (error.message?.includes('SMTP') || error.message?.includes('email')) {
      forgotPasswordError.value = t('auth.errors.emailServiceUnavailable')
    } else {
      forgotPasswordStep.value = 2
    }
  } finally {
    forgotPasswordLoading.value = false
  }
  if (forgotPasswordStep.value === 2) {
    // The submit button unmounted with step 1; focus moves to "Got it".
    await nextTick()
    focusForgotStart()
    polite(`${t('auth.checkEmail')}. ${t('auth.checkEmailForReset')}`)
  }
}

const openForgotPassword = () => {
  forgotPasswordStep.value = 1
  forgotPasswordError.value = ''
  showForgotPasswordModal.value = true
}

const closeForgotPasswordModal = () => {
  showForgotPasswordModal.value = false
  forgotPasswordStep.value = 1
  forgotPasswordEmail.value = ''
  forgotPasswordError.value = ''
}

const toggleMode = () => {
  router.push(props.isLogin ? '/register' : '/login')
}

const loadEnabledOAuthProviders = async () => {
  try {
    let enabledProviders: string[] = []

    // Method 1: Try to get from instance_config directly
    try {
      const { data: oauthConfig, error: oauthError } = await supabase
        .from('instance_config')
        .select('config_value')
        .eq('config_key', 'oauth_providers')
        .maybeSingle()

      debug.log('OAuth config query result:', { data: oauthConfig, error: oauthError })

      if (oauthError) {
        debug.warn('Error querying oauth_providers from instance_config:', oauthError)
        debug.warn('Error details:', {
          message: oauthError.message,
          code: oauthError.code,
          details: oauthError.details,
          hint: oauthError.hint
        })
      }

      if (oauthConfig?.config_value) {
        debug.log('Found oauth_providers config:', oauthConfig.config_value)
        let providers = oauthConfig.config_value
        debug.log('Raw providers value type:', typeof providers, providers)
        
        if (typeof providers === 'string') {
          try {
            providers = JSON.parse(providers)
            debug.log('Parsed JSON string:', providers)
          } catch {
            // If not JSON, try splitting by comma
            providers = providers.split(',').map((p: string) => p.trim())
            debug.log('Split comma string:', providers)
          }
        }
        
        if (Array.isArray(providers)) {
          enabledProviders = providers.map((p: string) => p.toLowerCase())
          debug.log('Parsed as array:', enabledProviders)
        } else if (typeof providers === 'object' && providers !== null) {
          // If it's an object like { google: true, twitch: false, github: true }
          enabledProviders = Object.entries(providers)
            .filter(([_, enabled]) => enabled === true || enabled === 'true')
            .map(([provider]) => provider.toLowerCase())
          debug.log('Parsed as object:', enabledProviders)
        } else {
          debug.warn('Unknown providers format:', providers)
        }
      } else {
        debug.log('ℹNo oauth_providers config found in database')
      }
    } catch (dbError) {
      debug.error('Exception querying instance_config for OAuth providers:', dbError)
    }

    // Method 2: Fallback to AdminService config
    if (enabledProviders.length === 0) {
      try {
        const config = await adminService.getInstanceConfig()
        if (config?.instance?.oauthProviders) {
          const providers = config.instance.oauthProviders
          if (Array.isArray(providers)) {
            enabledProviders = providers.map((p: string) => p.toLowerCase())
          } else if (typeof providers === 'object' && providers !== null) {
            enabledProviders = Object.entries(providers)
              .filter(([_, enabled]) => enabled === true || enabled === 'true')
              .map(([provider]) => provider.toLowerCase())
          }
        }
      } catch (configError) {
        debug.warn('Failed to get OAuth providers from instance config:', configError)
      }
    }

    // Method 3: Fallback to environment variable
    if (enabledProviders.length === 0) {
      const envProviders = runtimeConfig.oauthProviders
      if (envProviders) {
        enabledProviders = envProviders.split(',').map((p: string) => p.trim().toLowerCase())
      }
    }

    // Don't default to all providers - if no config found or empty, show none
    // Filter providers based on enabled list
    enabledOAuthProviders.value = allOAuthProviders.filter(provider => 
      enabledProviders.includes(provider.id.toLowerCase())
    )

    debug.log('OAuth providers loaded:', enabledOAuthProviders.value.map(p => p.id))
    if (enabledOAuthProviders.value.length === 0) {
      debug.log('ℹNo OAuth providers enabled - hiding OAuth section')
    }
  } catch (error) {
    debug.warn('Failed to load OAuth provider config, hiding OAuth providers:', error)
    // On error, show no providers (empty array)
    enabledOAuthProviders.value = []
  }
}

// Lifecycle
const SIGN_OUT_REASONS: Record<string, string> = {
  session_revoked: 'security.signOutReason.sessionRevoked',
  insufficient_aal: 'security.signOutReason.insufficientAal',
}

onMounted(async () => {
  const reason = SIGN_OUT_REASONS[String(route.query.reason ?? '')]
  if (reason) toast.info(t(reason), { timeout: 8000 })
  await loadEnabledOAuthProviders()
})
</script>

<style scoped>
.form-header {
  margin-bottom: 28px;
}

.form-header h2 {
  margin: 0;
  font-size: 2rem;
  font-weight: 700;
  line-height: 1.1;
  letter-spacing: -0.02em;
  color: var(--text);
}

.form-header p {
  margin: 8px 0 0;
  font-size: 0.95rem;
  color: var(--text-muted);
}

/* ========================================
   OAuth Buttons
   ======================================== */
.oauth-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 24px;
}

.oauth-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  width: 100%;
  padding: 14px 20px;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 0.95rem;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
  transition: background-color 0.2s ease, border-color 0.2s ease;
  position: relative;
}

.oauth-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-focus);
}

.oauth-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.oauth-btn.loading {
  color: transparent;
}

.oauth-icon {
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.oauth-icon :deep(svg) {
  width: 100%;
  height: 100%;
}

.oauth-spinner {
  position: absolute;
  width: 20px;
  height: 20px;
  border: 2px solid var(--border);
  border-top-color: var(--primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

/* Provider-specific styles */
.oauth-google:hover { border-color: #4285F4; }
.oauth-twitch:hover { border-color: #9146FF; }
.oauth-github:hover { border-color: var(--text-primary); }

.oauth-twitch .oauth-icon { color: #9146FF; }
.oauth-github .oauth-icon { color: var(--text-primary); }

/* ========================================
   Divider
   ======================================== */
.divider {
  display: flex;
  align-items: center;
  gap: 16px;
  margin-bottom: 24px;
  color: var(--text-dim);
  font-size: 0.8rem;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, var(--border), transparent);
}

/* ========================================
   Form Inputs - with autofill fix
   ======================================== */
.auth-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-group {
  position: relative;
}

.input-group input {
  width: 100%;
  padding: 16px 16px 16px 0;
  background: transparent;
  border: none;
  border-bottom: 1px solid var(--border);
  font-size: 1rem;
  color: var(--text);
  outline: none;
  transition: border-color 0.2s ease;
  caret-color: var(--primary);
}

/* Fix browser autofill styling */
.input-group input:-webkit-autofill,
.input-group input:-webkit-autofill:hover,
.input-group input:-webkit-autofill:focus,
.input-group input:-webkit-autofill:active {
  -webkit-box-shadow: 0 0 0 30px var(--autofill-bg) inset !important;
  -webkit-text-fill-color: var(--text) !important;
  transition: background-color 5000s ease-in-out 0s;
  font-size: 1rem;
}

.input-group input:focus {
  border-color: var(--primary);
}

.input-group label {
  position: absolute;
  left: 0;
  top: 16px;
  font-size: 1rem;
  color: var(--text-muted);
  pointer-events: none;
  transition: all 0.2s ease;
}

/* Label moves up when focused, has value, or autofilled */
.input-group.focused label,
.input-group.has-value label,
.input-group input:not(:placeholder-shown) + label {
  top: -8px;
  font-size: 0.75rem;
  color: var(--text-link);
}

.input-group.error label {
  color: var(--text-danger);
}

.input-group.error input {
  border-color: var(--error);
}

.input-line {
  position: absolute;
  bottom: 0;
  left: 0;
  width: 0;
  height: 2px;
  background: var(--primary);
  transition: width 0.3s ease;
}

.input-group.focused .input-line {
  width: 100%;
}

.error-text {
  position: absolute;
  bottom: -20px;
  left: 0;
  font-size: 0.75rem;
  color: var(--text-danger);
}

.error-text.centered {
  position: static;
  text-align: center;
  margin-top: 8px;
}

.password-toggle {
  position: absolute;
  right: 0;
  top: 12px;
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  transition: color 0.2s ease;
}

.password-toggle:hover {
  color: var(--text);
}

.password-toggle:focus-visible,
.forgot-link:focus-visible,
.modal-close:focus-visible,
.toggle-recovery:focus-visible {
  outline: 2px solid var(--border-focus, var(--primary));
  outline-offset: 2px;
  border-radius: 4px;
}

.password-toggle[aria-pressed='true'] {
  color: var(--text);
}

.form-error {
  margin: 0;
  font-size: 0.875rem;
  color: var(--text-danger);
}

/* Empty alert regions stay in the tree; out of the flex flow while empty. */
.form-error:empty {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
}

.submit-btn.is-busy {
  opacity: 0.7;
  cursor: progress;
}

.password-toggle svg {
  width: 20px;
  height: 20px;
}

/* ========================================
   Form Options
   ======================================== */
.form-options {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-top: 4px;
}

.remember-me {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--text-muted);
  cursor: pointer;
}

/* Visually hidden, still focusable and announced; the custom box draws its state. */
.remember-me__input {
  position: absolute;
  width: 18px;
  height: 18px;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.remember-me__input:focus-visible + .checkbox-visual {
  outline: 2px solid var(--border-focus, var(--primary));
  outline-offset: 2px;
}

.checkbox-visual {
  width: 18px;
  height: 18px;
  border: 1.5px solid var(--border);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
}

.remember-me input:checked + .checkbox-visual {
  background: var(--primary);
  border-color: var(--primary);
}

.remember-me input:checked + .checkbox-visual::after {
  content: '';
  width: 10px;
  height: 6px;
  border: 2px solid var(--text-on-primary);
  border-top: none;
  border-right: none;
  transform: rotate(-45deg) translateY(-1px);
}

.forgot-link {
  background: none;
  border: none;
  color: var(--text-link);
  font-size: 0.875rem;
  cursor: pointer;
  transition: color 0.2s ease;
}

.forgot-link:hover {
  text-decoration: underline;
}

/* ========================================
   Submit Button
   ======================================== */
.submit-btn {
  width: 100%;
  padding: 14px;
  background: var(--harmony-primary-fill);
  border: none;
  border-radius: 8px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-on-primary);
  cursor: pointer;
  transition: background-color 0.15s ease;
  position: relative;
  margin-top: 8px;
}

.submit-btn:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.submit-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
}

.btn-loader {
  display: flex;
  gap: 6px;
  justify-content: center;
}

.btn-loader .dot {
  width: 8px;
  height: 8px;
  background: var(--text-on-primary);
  border-radius: 50%;
  animation: bounce 1.4s ease-in-out infinite;
}

.btn-loader .dot:nth-child(2) { animation-delay: 0.16s; }
.btn-loader .dot:nth-child(3) { animation-delay: 0.32s; }

@keyframes bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}

/* ========================================
   Switch Mode & Terms
   ======================================== */
.switch-mode {
  text-align: center;
  margin-top: 24px;
  font-size: 0.9rem;
  color: var(--text-muted);
}

.switch-mode button {
  background: none;
  border: none;
  color: var(--text-link);
  font-weight: 600;
  cursor: pointer;
  margin-left: 4px;
  transition: color 0.2s ease;
}

.switch-mode button:hover {
  text-decoration: underline;
}

.terms {
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-top: 20px;
  line-height: 1.5;
}

.terms a {
  color: var(--text-link);
  text-decoration: none;
}

.terms a:hover {
  text-decoration: underline;
}

/* ========================================
   Modals - Base Styles
   ======================================== */
.modal-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  padding: 20px;
}

.modal-card {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 24px;
  /* padding: 40px; */
  max-width: 420px;
  width: 100%;
  position: relative;
  box-shadow: var(--shadow-large);
}

.modal-close {
  position: absolute;
  top: 20px;
  right: 20px;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 50%;
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s ease;
}

.modal-close:hover {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--border-focus);
}

.modal-close svg {
  width: 16px;
  height: 16px;
}

.modal-content {
  text-align: center;
}

.modal-content h3 {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 8px;
}

.modal-description {
  font-size: 0.95rem;
  color: var(--text-muted);
  margin: 0 0 28px;
  line-height: 1.6;
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

/* ========================================
   Reset Password Modal - Enhanced
   ======================================== */
.reset-modal {
  max-width: 440px;
  padding: 48px 40px;
}

.modal-header-decoration {
  position: relative;
  width: 80px;
  height: 80px;
  margin: 0 auto 24px;
}

.modal-icon-wrapper {
  position: absolute;
  inset: 8px;
  background: var(--harmony-primary-fill);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-primary);
}

.modal-icon-wrapper svg {
  width: 32px;
  height: 32px;
}

.modal-input {
  text-align: left;
}

.modal-actions.stacked {
  flex-direction: column;
  gap: 12px;
}

.btn-text-only {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.9rem;
  cursor: pointer;
  padding: 8px;
  transition: color 0.2s ease;
}

.btn-text-only:hover {
  color: var(--text);
}

/* Success state */
.success-animation {
  position: relative;
  width: 80px;
  height: 80px;
  margin: 0 auto 24px;
}

.success-ring {
  position: absolute;
  inset: 0;
  border: 3px solid var(--success);
  border-radius: 50%;
}

@media (prefers-reduced-motion: no-preference) {
  .success-ring {
    animation: successRing 0.6s ease-out;
  }

  .success-icon {
    animation: checkDraw 0.4s ease-out 0.3s both;
  }
}

@keyframes successRing {
  0% { transform: scale(0); opacity: 0; }
  50% { opacity: 1; }
  100% { transform: scale(1); opacity: 1; }
}

.success-icon {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-success);
}

.success-icon svg {
  width: 40px;
  height: 40px;
}

@keyframes checkDraw {
  0% { transform: scale(0); opacity: 0; }
  100% { transform: scale(1); opacity: 1; }
}

.email-preview {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 14px 20px;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 12px;
  margin-bottom: 24px;
  color: var(--text-muted);
  font-size: 0.9rem;
}

.email-preview svg {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

.email-preview span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* ========================================
   Standard Modal Styles
   ======================================== */
.modal-icon {
  width: 64px;
  height: 64px;
  margin: 0 auto 20px;
  background: var(--surface-light);
  border-radius: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--primary);
}

.modal-icon svg {
  width: 32px;
  height: 32px;
}

.modal-icon.shield {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
}

.modal-actions {
  display: flex;
  gap: 12px;
}

.btn-primary,
.btn-secondary {
  flex: 1;
  padding: 14px 20px;
  border-radius: 12px;
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background: var(--harmony-primary-fill);
  border: none;
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary.full-width {
  width: 100%;
}

.btn-secondary {
  background: transparent;
  border: 1px solid var(--border);
  color: var(--text-muted);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--surface-light);
  color: var(--text);
}

/* 2FA Code Input */
.code-input-container {
  text-align: center;
}

.code-input {
  width: 100%;
  padding: 16px;
  background: var(--surface-light);
  border: 1px solid var(--border);
  border-radius: 12px;
  font-size: 1.75rem;
  font-family: 'SF Mono', 'Fira Code', monospace;
  letter-spacing: 0.3em;
  text-align: center;
  color: var(--text);
  outline: none;
  transition: border-color 0.2s ease;
}

.code-input:focus {
  border-color: var(--primary);
}

.code-input.error {
  border-color: var(--error);
}

.code-input::placeholder {
  color: var(--text-dim);
  letter-spacing: 0.3em;
}

.toggle-recovery {
  background: none;
  border: none;
  color: var(--text-muted);
  font-size: 0.85rem;
  cursor: pointer;
  transition: color 0.2s ease;
}

.toggle-recovery:hover:not(:disabled) {
  color: var(--text-link);
}

/* ========================================
   Modal Transitions
   ======================================== */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.25s ease;
}

.modal-enter-active .modal-card,
.modal-leave-active .modal-card {
  transition: transform 0.25s ease, opacity 0.25s ease;
}

.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}

.modal-enter-from .modal-card,
.modal-leave-to .modal-card {
  transform: scale(0.95) translateY(10px);
  opacity: 0;
}

/* ========================================
   Animations
   ======================================== */
@keyframes spin {
  to { transform: rotate(360deg); }
}

/* ========================================
   Responsive Design - Mobile
   ======================================== */
@media (max-width: 959px) {
  .form-header h2 {
    font-size: 1.625rem;
  }

  .form-header p {
    font-size: 0.9rem;
  }

  .oauth-section {
    gap: 10px;
  }

  .oauth-btn {
    padding: 14px 16px;
  }

  .switch-mode {
    margin-top: auto;
    padding-top: 24px;
  }
}

@media (max-width: 768px) {
  .modal-card {
    margin: 0;
    max-width: 100%;
    min-height: calc(100 * var(--app-vh));
    border-radius: 0;
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .reset-modal {
    padding: 40px 24px;
  }
}

@media (max-width: 480px) {
  .form-options {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .forgot-link {
    align-self: flex-start;
  }
}

/* Safe area insets for notched phones */
@supports (padding-top: env(safe-area-inset-top)) {
  @media (max-width: 768px) {
    .modal-card {
      padding-top: calc(40px + env(safe-area-inset-top));
      padding-bottom: calc(40px + env(safe-area-inset-bottom));
    }
  }
}
</style>
