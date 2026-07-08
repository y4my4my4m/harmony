<template>
  <div class="auth-wrapper" @mousemove="handleMouseMove" :style="authStyles">
    <!-- Animated gradient overlay -->
    <div class="bg-gradient-overlay"></div>
    <div class="bg-noise"></div>

    <!-- Main Auth Container -->
    <div class="auth-container">
      <!-- Branding Section (Desktop) -->
      <div class="auth-branding">
        <div class="brand-card">
          <div class="brand-content">
            <div class="logo-container" @click="themeStore.playAudio('ui_click')">
              <img src="/icon_3d.webp" alt="Harmony Logo" class="brand-logo" />
              <div class="logo-pulse"></div>
            </div>
            
            <h1 class="brand-title">
              <span class="harmony-text" @mouseenter="isHoveringTitle = true" @mouseleave="isHoveringTitle = false">
                <span 
                  v-for="(letter, index) in instanceNameLetters" 
                  :key="index"
                  class="letter" 
                  :style="{ 
                    '--letter-index': index,
                    '--offset-x': letterOffsets[index]?.x || 0,
                    '--offset-y': letterOffsets[index]?.y || 0
                  }"
                >{{ letter }}</span>
              </span>
            </h1>
            
            <p class="brand-tagline">{{ instanceDescription }}</p>
            
            <!-- Feature Pills -->
            <div class="feature-pills">
              <div class="pill">
                <span class="pill-icon-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/>
                  </svg>
                </span>
                <span>{{ $t('auth.features.realTimeMessaging') }}</span>
              </div>
              <div class="pill">
                <span class="pill-icon-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <circle cx="12" cy="12" r="10"/>
                    <line x1="2" y1="12" x2="22" y2="12"/>
                    <path d="M12 2a15.3 15.3 0 014 10 15.3 15.3 0 01-4 10 15.3 15.3 0 01-4-10 15.3 15.3 0 014-10z"/>
                  </svg>
                </span>
                <span>{{ $t('auth.features.federated') || 'Federated' }}</span>
              </div>
              <div class="pill">
                <span class="pill-icon-wrap">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  </svg>
                </span>
                <span>{{ $t('auth.features.endToEnd') || 'E2E Encrypted' }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Auth Form Panel -->
      <div class="auth-panel">
        <div 
          class="auth-card" 
          :class="{ 'loading-state': isLoading, 'card-focused': isCardFocused }"
          @focusin="isCardFocused = true"
          @focusout="isCardFocused = false"
        >
          <!-- Mobile Logo -->
          <div class="mobile-logo">
            <img src="/icon_3d.webp" alt="Harmony" />
            <h1 class="mobile-title">{{ displayTitle }}</h1>
          </div>

          <!-- Form Header -->
          <div class="form-header">
            <h2>{{ isLogin ? $t('auth.welcomeBack') : $t('auth.createAccount') }}</h2>
            <p>{{ isLogin ? $t('auth.welcomeBackSubtitle') : $t('auth.createAccountSubtitle') }}</p>
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
              <span class="oauth-icon" v-html="provider.icon"></span>
              <span class="oauth-label">{{ $t(`auth.oauth.${provider.id}`) || `Continue with ${provider.name}` }}</span>
              <span v-if="oauthLoading === provider.id" class="oauth-spinner"></span>
            </button>
          </div>

          <!-- Divider (only show if OAuth providers are enabled) -->
          <div v-if="enabledOAuthProviders.length > 0" class="divider">
            <span>{{ $t('auth.orContinueWith') || 'or' }}</span>
          </div>

          <!-- Email/Password Form -->
          <form @submit.prevent="handleSubmit" class="auth-form" data-testid="auth-form">
            <div class="input-group" :class="{ 'focused': emailFocused, 'has-value': email, 'error': emailError }">
              <input 
                v-model="email" 
                type="email" 
                id="email"
                data-testid="auth-email"
                placeholder=" "
                @focus="emailFocused = true"
                @blur="emailFocused = false; validateEmail()"
                @input="emailError = ''"
                required
                autocomplete="email"
              />
              <label for="email">{{ $t('auth.email') }}</label>
              <div class="input-line"></div>
              <span v-if="emailError" class="error-text" data-testid="auth-email-error">{{ emailError }}</span>
            </div>

            <div class="input-group" :class="{ 'focused': passwordFocused, 'has-value': password, 'error': passwordError }">
              <input 
                v-model="password" 
                :type="showPassword ? 'text' : 'password'"
                id="password"
                data-testid="auth-password"
                placeholder=" "
                @focus="passwordFocused = true"
                @blur="passwordFocused = false; validatePassword()"
                @input="passwordError = ''"
                required
                :autocomplete="isLogin ? 'current-password' : 'new-password'"
              />
              <label for="password">{{ $t('auth.password') }}</label>
              <button 
                type="button" 
                class="password-toggle"
                @click="showPassword = !showPassword"
                tabindex="-1"
              >
                <svg v-if="showPassword" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24"/>
                  <line x1="1" y1="1" x2="23" y2="23"/>
                </svg>
                <svg v-else viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <div class="input-line"></div>
              <span v-if="passwordError" class="error-text">{{ passwordError }}</span>
            </div>

            <!-- Login Options -->
            <div v-if="isLogin" class="form-options">
              <label class="remember-me">
                <input type="checkbox" v-model="rememberMe" />
                <span class="checkbox-visual"></span>
                <span>{{ $t('auth.rememberMe') }}</span>
              </label>
              <button type="button" class="forgot-link" @click="showForgotPasswordModal = true">
                {{ $t('auth.forgotPassword') }}
              </button>
            </div>

            <!-- Submit Button -->
            <button 
              type="submit" 
              class="submit-btn"
              data-testid="auth-submit"
              :disabled="isLoading"
            >
              <span v-if="!isLoading" class="btn-text">
                {{ isLogin ? $t('auth.logIn') : $t('auth.createAccountButton') }}
              </span>
              <span v-else class="btn-loader">
                <span class="dot"></span>
                <span class="dot"></span>
                <span class="dot"></span>
              </span>
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
            {{ $t('auth.termsPrefix') || 'By registering, you agree to our' }}
            <a v-if="instanceSettings.settings.termsUrl" :href="instanceSettings.settings.termsUrl" target="_blank" rel="noopener">{{ $t('auth.termsOfService') || 'Terms of Service' }}</a>
            <template v-if="instanceSettings.settings.termsUrl && instanceSettings.settings.privacyUrl">
              {{ $t('auth.and') || ' and ' }}
            </template>
            <a v-if="instanceSettings.settings.privacyUrl" :href="instanceSettings.settings.privacyUrl" target="_blank" rel="noopener">{{ $t('auth.privacyPolicy') || 'Privacy Policy' }}</a>
          </p>
        </div>
      </div>
    </div>

    <!-- Powered by Harmony -->
    <a href="https://github.com/y4my4my4m/harmony" target="_blank" rel="noopener" class="powered-by">
      Powered by <strong>Harmony</strong>
    </a>

    <!-- Forgot Password Modal -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showForgotPasswordModal" class="modal-backdrop" @click.self="showForgotPasswordModal = false">
          <div class="modal-card reset-modal">
            <button class="modal-close" @click="showForgotPasswordModal = false">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>

            <div v-if="forgotPasswordStep === 1" class="modal-content">
              <!-- Decorative header -->
              <div class="modal-header-decoration">
                <div class="decoration-ring"></div>
                <div class="decoration-ring delay"></div>
                <div class="modal-icon-wrapper">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0110 0v4"/>
                  </svg>
                </div>
              </div>

              <h3>{{ $t('auth.resetYourPassword') }}</h3>
              <p class="modal-description">{{ $t('auth.enterEmailForReset') }}</p>

              <form @submit.prevent="handleForgotPassword" class="modal-form">
                <div class="input-group modal-input" :class="{ 'focused': forgotEmailFocused, 'has-value': forgotPasswordEmail, 'error': forgotPasswordError }">
                  <input 
                    v-model="forgotPasswordEmail" 
                    type="email"
                    id="forgot-email"
                    placeholder=" "
                    @focus="forgotEmailFocused = true"
                    @blur="forgotEmailFocused = false"
                    required
                    autocomplete="email"
                  />
                  <label for="forgot-email">{{ $t('auth.email') }}</label>
                  <div class="input-line"></div>
                  <span v-if="forgotPasswordError" class="error-text">{{ forgotPasswordError }}</span>
                </div>

                <div class="modal-actions stacked">
                  <button type="submit" class="btn-primary" :disabled="forgotPasswordLoading || !forgotPasswordEmail">
                    <span v-if="!forgotPasswordLoading">{{ $t('auth.sendResetLink') }}</span>
                    <span v-else class="btn-loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
                  </button>
                  <button type="button" class="btn-text-only" @click="showForgotPasswordModal = false">
                    {{ $t('auth.backToLogin') || 'Back to login' }}
                  </button>
                </div>
              </form>
            </div>

            <div v-else class="modal-content success">
              <div class="success-animation">
                <div class="success-ring"></div>
                <div class="success-icon">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
              </div>
              <h3>{{ $t('auth.checkEmail') }}</h3>
              <p class="modal-description">
                {{ $t('auth.checkEmailForReset') }}
              </p>
              <div class="email-preview">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"/>
                </svg>
                <span>{{ forgotPasswordEmail }}</span>
              </div>
              <button class="btn-primary full-width" @click="closeForgotPasswordModal">
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
        <div v-if="show2FAModal" class="modal-backdrop" @click.self="close2FAModal">
          <div class="modal-card">
            <button class="modal-close" @click="close2FAModal">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"/>
                <line x1="6" y1="6" x2="18" y2="18"/>
              </svg>
            </button>

            <div class="modal-content">
              <div class="modal-icon shield">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                  <path d="M9 12l2 2 4-4"/>
                </svg>
              </div>
              <h3>{{ $t('auth.twoFactorAuth') }}</h3>
              <p class="modal-description">{{ useRecoveryCode ? $t('auth.enterRecoveryCode') : $t('auth.enter6DigitCode') }}</p>

              <form @submit.prevent="handle2FAVerification" class="modal-form">
                <div class="code-input-container">
                  <input 
                    v-model="twoFactorCode"
                    type="text"
                    class="code-input"
                    :class="{ 'error': twoFactorError }"
                    :placeholder="useRecoveryCode ? 'XXXXXXXX' : '000000'"
                    :maxlength="useRecoveryCode ? 8 : 6"
                    :inputmode="useRecoveryCode ? 'text' : 'numeric'"
                    autocomplete="one-time-code"
                    autofocus
                    @input="handleCodeInput"
                  />
                  <span v-if="twoFactorError" class="error-text centered">{{ twoFactorError }}</span>
                </div>

                <div class="modal-actions">
                  <button type="button" class="btn-secondary" @click="close2FAModal" :disabled="twoFactorLoading">
                    {{ $t('common.cancel') }}
                  </button>
                  <button 
                    type="submit" 
                    class="btn-primary" 
                    :disabled="twoFactorLoading || (useRecoveryCode ? twoFactorCode.length !== 8 : twoFactorCode.length !== 6)"
                  >
                    <span v-if="!twoFactorLoading">{{ $t('auth.verify') }}</span>
                    <span v-else class="btn-loader"><span class="dot"></span><span class="dot"></span><span class="dot"></span></span>
                  </button>
                </div>

                <button 
                  type="button" 
                  class="toggle-recovery" 
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/useTheme'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useToast } from 'vue-toastification'
import { supabase, setRememberMe, getRememberMe } from '@/supabase'
import { getRandomLoginBackground } from '@/utils/backgroundUtils'
import { adminService } from '@/services/AdminService'
import { getStoredInstance } from '@/services/instanceConfig'
import { isTauriDesktop } from '@/utils/platform'
import type { Provider } from '@supabase/supabase-js'

interface Props {
  isLogin?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isLogin: true
})

const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const instanceSettings = useInstanceSettingsStore()
const toast = useToast()

// All available OAuth Providers (removed Apple - requires paid $99/year developer account)
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

const email = ref('')
const password = ref('')
// Initialize from the persisted preference so the checkbox reflects the
// user's last choice across visits to the login page (defaults to `true`
// for first-time visitors, matching the pre-fix hardcoded `persistSession`
// behavior - see `src/supabase.ts`).
const rememberMe = ref(getRememberMe())
const showPassword = ref(false)
const isLoading = ref(false)
const oauthLoading = ref<string | null>(null)
const isCardFocused = ref(false)

// Focus states
const emailFocused = ref(false)
const passwordFocused = ref(false)

// Validation states
const emailError = ref('')
const passwordError = ref('')

// Forgot password state
const showForgotPasswordModal = ref(false)
const forgotPasswordEmail = ref('')
const forgotPasswordStep = ref(1)
const forgotPasswordLoading = ref(false)
const forgotPasswordError = ref('')
const forgotEmailFocused = ref(false)

// 2FA state
const show2FAModal = ref(false)
const twoFactorCode = ref('')
const twoFactorError = ref('')
const twoFactorLoading = ref(false)
const pendingFactorId = ref('')
const pendingChallengeId = ref('')
const useRecoveryCode = ref(false)

// Background & effects
const randomBg = ref('')
const mouseX = ref(0)
const mouseY = ref(0)
const bgOffsetX = ref(0)
const bgOffsetY = ref(0)
const isHoveringTitle = ref(false)
const letterOffsets = ref<Record<number, { x: number; y: number }>>({})

// Instance branding
const instanceName = ref('Harmony')
const instanceDescription = ref('Connect, communicate, and create together')
// Native/universal client picks an instance explicitly — show its domain so it's
// clear which server you're signing into. Web/PWA falls back to the brand name.
const displayTitle = computed(() => {
  const stored = getStoredInstance()
  if (stored) {
    try { return new URL(stored.origin).host } catch { /* fall through */ }
  }
  return instanceName.value
})
const instanceNameLetters = computed(() => displayTitle.value.split(''))

const authStyles = computed(() => ({
  '--bg-image': randomBg.value,
  '--mouse-x': `${mouseX.value}px`,
  '--mouse-y': `${mouseY.value}px`,
  '--bg-offset-x': `${bgOffsetX.value}px`,
  '--bg-offset-y': `${bgOffsetY.value}px`,
  '--blur-amount': isCardFocused.value ? '12px' : '4px',
}))

// Mouse tracking with subtle parallax
const handleMouseMove = (e: MouseEvent) => {
  mouseX.value = e.clientX
  mouseY.value = e.clientY
  
  // Subtle parallax on background
  const centerX = window.innerWidth / 2
  const centerY = window.innerHeight / 2
  bgOffsetX.value = (e.clientX - centerX) * 0.015
  bgOffsetY.value = (e.clientY - centerY) * 0.015
  
  if (isHoveringTitle.value) {
    updateLetterOffsets(e)
  }
}

const updateLetterOffsets = (e: MouseEvent) => {
  const letters = document.querySelectorAll('.letter')
  letters.forEach((letter, index) => {
    const rect = letter.getBoundingClientRect()
    const centerX = rect.left + rect.width / 2
    const centerY = rect.top + rect.height / 2
    
    const dx = e.clientX - centerX
    const dy = e.clientY - centerY
    const distance = Math.sqrt(dx * dx + dy * dy)
    
    const maxDistance = 150
    const maxOffset = 30
    
    if (distance < maxDistance) {
      const force = (maxDistance - distance) / maxDistance
      letterOffsets.value[index] = {
        x: -(dx / distance) * force * maxOffset,
        y: -(dy / distance) * force * maxOffset
      }
    } else {
      letterOffsets.value[index] = { x: 0, y: 0 }
    }
  })
}

watch(isHoveringTitle, (hovering) => {
  if (!hovering) {
    letterOffsets.value = {}
  }
})

// Validation
const validateEmail = () => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!email.value) {
    emailError.value = 'Email is required'
  } else if (!emailRegex.test(email.value)) {
    emailError.value = 'Please enter a valid email address'
  } else {
    emailError.value = ''
  }
}

const validatePassword = () => {
  if (!password.value) {
    passwordError.value = 'Password is required'
  } else if (!props.isLogin && password.value.length < 6) {
    passwordError.value = 'Password must be at least 6 characters'
  } else {
    passwordError.value = ''
  }
}

// OAuth Login
const handleOAuthLogin = async (providerId: string) => {
  oauthLoading.value = providerId

  // Persist the remember-me preference BEFORE the OAuth redirect. The
  // session won't actually be created until the OAuth callback returns,
  // but the storage adapter consults this preference at write-time, so
  // it has to be set in the originating tab's localStorage *now* - the
  // callback runs after a full page navigation and reads the same key.
  setRememberMe(rememberMe.value)

  try {
    // Check if user is already logged in - if so, warn them about potential account linking
    const { data: { session } } = await supabase.auth.getSession()
    if (session) {
      debug.warn('User is already logged in when initiating OAuth. This may cause account linking.')
      debug.log('Current session:', {
        userId: session.user.id,
        email: session.user.email,
        existingIdentities: session.user.identities?.map((id: any) => ({
          provider: id.provider,
          email: id.email || id.identity_data?.email
        })) || []
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
    toast.error(error.message || `Failed to sign in with ${providerId}`)
    oauthLoading.value = null
  }
}

// Email/Password Submit
const handleSubmit = async () => {
  validateEmail()
  validatePassword()
  
  if (emailError.value || passwordError.value) {
    return
  }

  isLoading.value = true
  
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

      toast.success('Welcome back!')
    } else {
      // New signups also respect the toggle so a user signing up on a
      // shared computer can keep their session tab-bound.
      setRememberMe(rememberMe.value)
      await authStore.register(email.value, password.value)
      toast.success('Account created successfully!')
      router.push('/new-profile')
    }
  } catch (error: any) {
    debug.error('Auth error:', error)
    toast.error(error.message || 'Authentication failed')
  } finally {
    isLoading.value = false
  }
}

// 2FA Verification
const handle2FAVerification = async () => {
  const expectedLength = useRecoveryCode.value ? 8 : 6
  if (twoFactorCode.value.length !== expectedLength) {
    twoFactorError.value = `Please enter a ${expectedLength}-${useRecoveryCode.value ? 'character' : 'digit'} code`
    return
  }

  twoFactorLoading.value = true
  twoFactorError.value = ''

  try {
    if (useRecoveryCode.value) {
      const { data: sessionData } = await supabase.auth.getSession()
      const userId = sessionData.session?.user?.id

      if (!userId) {
        throw new Error('User session not found')
      }

      // Atomic server-side redeem: verifies AND consumes the recovery code,
      // then removes the MFA factors in the same transaction. The old flow
      // (verify_recovery_code + client-side mfa.unenroll from an AAL1
      // session) made the client the security boundary - see BUGS.md C11.
      const { data: redeemed, error } = await supabase.rpc('redeem_recovery_code_and_disable_mfa', {
        p_code: twoFactorCode.value
      })

      if (error) throw error
      if (!redeemed) {
        throw new Error('Invalid or already used recovery code')
      }

      await supabase.auth.refreshSession().catch(() => {})
      const { data: refreshedSession } = await supabase.auth.getSession()
      authStore.session = refreshedSession.session
      
      show2FAModal.value = false
      toast.warning('Welcome back! Please re-enable Two-Factor Authentication in your settings.', { timeout: 8000 })
      router.push('/settings/privacy')
    } else {
      await authStore.verify2FA(pendingFactorId.value, pendingChallengeId.value, twoFactorCode.value)
      show2FAModal.value = false
      toast.success('Welcome back!')
      router.push('/chat')
    }
  } catch (error: any) {
    debug.error('2FA verification error:', error)
    twoFactorError.value = error.message || `Invalid ${useRecoveryCode.value ? 'recovery' : 'verification'} code`
  } finally {
    twoFactorLoading.value = false
  }
}

const toggleRecoveryCodeMode = () => {
  useRecoveryCode.value = !useRecoveryCode.value
  twoFactorCode.value = ''
  twoFactorError.value = ''
}

const handleCodeInput = () => {
  twoFactorError.value = ''
  if (useRecoveryCode.value) {
    twoFactorCode.value = twoFactorCode.value.toUpperCase()
  }
}

const close2FAModal = async () => {
  show2FAModal.value = false
  twoFactorCode.value = ''
  twoFactorError.value = ''
  pendingFactorId.value = ''
  pendingChallengeId.value = ''
  useRecoveryCode.value = false
  authStore._pendingMFAVerification = false

  // Defense-in-depth: sign out the AAL1 session that signInWithPassword
  // wrote to localStorage. Without this, the unfinished MFA session
  // lingers in shared browser storage until the next page load triggers
  // INITIAL_SESSION → validateSessionForMFA → signOut. While that
  // self-heal is enough to prevent any actual access (validateSessionForMFA
  // still rejects the AAL1+MFA combination), it's cleaner to clear the
  // token immediately when the user explicitly cancels the flow.
  try {
    await supabase.auth.signOut()
  } catch (err) {
    debug.error('Failed to sign out AAL1 session on 2FA modal cancel:', err)
  }
}

// Forgot Password
const handleForgotPassword = async () => {
  forgotPasswordError.value = ''
  
  if (!forgotPasswordEmail.value) {
    forgotPasswordError.value = 'Email is required'
    return
  }

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
  if (!emailRegex.test(forgotPasswordEmail.value)) {
    forgotPasswordError.value = 'Please enter a valid email address'
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
      forgotPasswordError.value = 'Email service not configured. Please contact support.'
    } else {
      forgotPasswordStep.value = 2
    }
  } finally {
    forgotPasswordLoading.value = false
  }
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
      const envProviders = import.meta.env.VITE_ENABLED_OAUTH_PROVIDERS
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

const loadInstanceBranding = async () => {
  try {
    const config = await adminService.getInstanceConfig()
    if (config?.instance) {
      instanceName.value = config.instance.name || 'Harmony'
      instanceDescription.value = config.instance.description || 'Connect, communicate, and create together'
    }
  } catch (error) {
    debug.warn('Failed to load instance branding, using defaults:', error)
  }
}

onMounted(async () => {
  randomBg.value = await getRandomLoginBackground()
  await Promise.all([
    loadInstanceBranding(),
    loadEnabledOAuthProviders()
  ])
})
</script>

<style scoped>
/* ========================================
   CSS Variables & Base Styles
   ======================================== */
.auth-wrapper {
  --primary: var(--harmony-primary, #0EA5E9);
  --primary-hover: var(--harmony-primary-hover, #0284C7);
  --primary-glow: rgba(14, 165, 233, 0.4);
  --surface: rgba(17, 17, 23, 0.92);
  --surface-light: rgba(255, 255, 255, 0.03);
  --surface-hover: rgba(255, 255, 255, 0.06);
  --border: rgba(255, 255, 255, 0.08);
  --border-focus: rgba(14, 165, 233, 0.5);
  --text: #ffffff;
  --text-muted: rgba(255, 255, 255, 0.6);
  --text-dim: rgba(255, 255, 255, 0.4);
  --error: #ef4444;
  --success: #22c55e;
  
  min-height: 100vh;
  width: 100%;
  display: flex;
  font-family: var(--font-family);
  background: var(--bg-image) center/cover no-repeat fixed;
  background-position: calc(50% + var(--bg-offset-x, 0px)) calc(50% + var(--bg-offset-y, 0px));
  position: relative;
  overflow: hidden;
}

/* ========================================
   Background Effects
   ======================================== */
.bg-gradient-overlay {
  position: fixed;
  inset: 0;
  background: 
    radial-gradient(ellipse 80% 50% at var(--mouse-x, 50%) var(--mouse-y, 50%), 
      rgba(14, 165, 233, 0.12) 0%, 
      transparent 50%),
    linear-gradient(135deg, 
      rgba(0, 0, 0, 0.7) 0%, 
      rgba(0, 0, 0, 0.4) 50%, 
      rgba(0, 0, 0, 0.8) 100%);
  backdrop-filter: blur(var(--blur-amount, 4px));
  pointer-events: none;
  transition: backdrop-filter 0.5s ease;
}

.bg-noise {
  position: fixed;
  inset: 0;
  background-image: url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)'/%3E%3C/svg%3E");
  opacity: 0.03;
  pointer-events: none;
}

/* ========================================
   Layout
   ======================================== */
.auth-container {
  position: relative;
  z-index: 10;
  min-height: 100vh;
  width: 100%;
  display: flex;
}

.auth-branding {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 48px;
  position: relative;
  overflow: hidden;
}

/* Glass brand card */
.brand-card {
  position: relative;
  z-index: 1;
  background: rgba(255, 255, 255, 0.03);
  backdrop-filter: blur(12px);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 32px;
  padding: 48px 40px;
  max-width: 460px;
  width: 100%;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.02) inset,
    0 24px 48px rgba(0, 0, 0, 0.15);
}

.brand-content {
  text-align: center;
}

.logo-container {
  position: relative;
  display: inline-block;
  margin-bottom: 28px;
  cursor: pointer;
}

.brand-logo {
  width: 88px;
  height: 88px;
  filter: drop-shadow(0 8px 24px rgba(14, 165, 233, 0.3));
  transition: transform 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
}

.logo-container:hover .brand-logo {
  transform: scale(1.08) rotate(-5deg);
}

.logo-pulse {
  position: absolute;
  inset: -16px;
  border-radius: 50%;
  background: radial-gradient(circle, var(--primary-glow) 0%, transparent 70%);
  animation: pulse 3s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { transform: scale(1); opacity: 0.3; }
  50% { transform: scale(1.2); opacity: 0.6; }
}

.brand-title {
  font-size: 3.25rem;
  font-weight: 800;
  margin: 0 0 12px;
  line-height: 1.05;
  letter-spacing: -0.02em;
}

.harmony-text {
  display: inline-block;
}

.letter {
  display: inline-block;
  background: linear-gradient(160deg, #fff 20%, rgba(255,255,255,0.7) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  transition: transform 0.15s ease-out;
  transform: translate(
    calc(var(--offset-x, 0) * 1px), 
    calc(var(--offset-y, 0) * 1px)
  );
}

.letter:hover {
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  -webkit-background-clip: text;
  background-clip: text;
}

.brand-tagline {
  font-size: 1.05rem;
  color: var(--text-muted);
  margin: 0 0 36px;
  line-height: 1.6;
  max-width: 320px;
  margin-left: auto;
  margin-right: auto;
}

.feature-pills {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  justify-content: center;
}

.pill {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 18px;
  background: rgba(255, 255, 255, 0.04);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 100px;
  font-size: 0.85rem;
  font-weight: 500;
  color: var(--text-muted);
  transition: all 0.25s ease;
}

.pill:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(14, 165, 233, 0.3);
  color: var(--text);
  transform: translateY(-2px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.15);
}

.pill-icon-wrap {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, var(--primary), var(--primary-hover));
  border-radius: 50%;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(14, 165, 233, 0.3);
}

.pill-icon-wrap svg {
  width: 14px;
  height: 14px;
  color: #fff;
  stroke-width: 2.5;
}

/* ========================================
   Auth Panel & Card
   ======================================== */
.auth-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
}

.auth-card {
  width: 100%;
  max-width: 420px;
  background: var(--surface);
  backdrop-filter: blur(40px);
  border: 1px solid var(--border);
  border-radius: 24px;
  padding: 40px;
  box-shadow: 
    0 0 0 1px rgba(255, 255, 255, 0.02) inset,
    0 32px 64px rgba(0, 0, 0, 0.4);
  transition: all 0.4s ease;
}

.auth-card:hover,
.auth-card.card-focused {
  border-color: rgba(14, 165, 233, 0.2);
  box-shadow: 
    0 0 0 1px rgba(255, 255, 255, 0.04) inset,
    0 32px 64px rgba(0, 0, 0, 0.5),
    0 0 80px rgba(14, 165, 233, 0.08);
}

.auth-card.loading-state {
  pointer-events: none;
  opacity: 0.7;
}

.mobile-logo {
  display: none;
  text-align: center;
  margin-bottom: 24px;
}

.mobile-logo img {
  width: 56px;
  height: 56px;
  margin-bottom: 8px;
}

.mobile-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}

.form-header {
  text-align: center;
  margin-bottom: 32px;
}

.form-header h2 {
  font-size: 1.75rem;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 8px;
}

.form-header p {
  font-size: 0.95rem;
  color: var(--text-muted);
  margin: 0;
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
  transition: all 0.2s ease;
  position: relative;
}

.oauth-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  border-color: var(--border-focus);
  transform: translateY(-1px);
}

.oauth-btn:active:not(:disabled) {
  transform: translateY(0);
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
  text-transform: uppercase;
  letter-spacing: 0.1em;
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
  -webkit-box-shadow: 0 0 0 30px rgba(17, 17, 23, 1) inset !important;
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
  color: var(--primary);
}

.input-group.error label {
  color: var(--error);
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
  color: var(--error);
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
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: var(--text-muted);
  cursor: pointer;
}

.remember-me input {
  display: none;
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
  border: 2px solid #fff;
  border-top: none;
  border-right: none;
  transform: rotate(-45deg) translateY(-1px);
}

.forgot-link {
  background: none;
  border: none;
  color: var(--primary);
  font-size: 0.875rem;
  cursor: pointer;
  transition: color 0.2s ease;
}

.forgot-link:hover {
  color: var(--primary-hover);
}

/* ========================================
   Submit Button
   ======================================== */
.submit-btn {
  width: 100%;
  padding: 16px;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
  margin-top: 8px;
}

.submit-btn::before {
  content: '';
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, rgba(255,255,255,0.2) 0%, transparent 50%);
  opacity: 0;
  transition: opacity 0.3s ease;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 12px 32px var(--primary-glow);
}

.submit-btn:hover:not(:disabled)::before {
  opacity: 1;
}

.submit-btn:active:not(:disabled) {
  transform: translateY(0);
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
  background: #fff;
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
  color: var(--primary);
  font-weight: 600;
  cursor: pointer;
  margin-left: 4px;
  transition: color 0.2s ease;
}

.switch-mode button:hover {
  color: var(--primary-hover);
}

.terms {
  text-align: center;
  font-size: 0.8rem;
  color: var(--text-dim);
  margin-top: 20px;
  line-height: 1.5;
}

.terms a {
  color: var(--primary);
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
  box-shadow: 0 32px 64px rgba(0, 0, 0, 0.5);
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

.decoration-ring {
  position: absolute;
  inset: 0;
  border: 2px solid var(--primary);
  border-radius: 50%;
  opacity: 0.2;
  animation: ringPulse 2s ease-out infinite;
}

.decoration-ring.delay {
  animation-delay: 1s;
}

@keyframes ringPulse {
  0% { transform: scale(1); opacity: 0.3; }
  100% { transform: scale(1.5); opacity: 0; }
}

.modal-icon-wrapper {
  position: absolute;
  inset: 8px;
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-primary);
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
  animation: successRing 0.6s ease-out;
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
  color: var(--success);
  animation: checkDraw 0.4s ease-out 0.3s both;
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
  background: rgba(14, 165, 233, 0.1);
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
  background: linear-gradient(135deg, var(--primary) 0%, var(--primary-hover) 100%);
  border: none;
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 8px 24px var(--primary-glow);
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
  color: var(--primary);
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
@media (max-width: 1024px) {
  .auth-container {
    flex-direction: column;
  }
  
  .auth-branding {
    padding: 32px 24px 24px;
  }

  .brand-card {
    padding: 32px 28px;
    max-width: 100%;
    border-radius: 24px;
  }

  .brand-title {
    font-size: 2.25rem;
  }

  .brand-logo {
    width: 64px;
    height: 64px;
  }

  .logo-container {
    margin-bottom: 16px;
  }
  
  .brand-tagline {
    margin-bottom: 20px;
    font-size: 0.95rem;
  }
  
  .feature-pills {
    gap: 8px;
  }
  
  .pill {
    padding: 8px 14px;
    font-size: 0.8rem;
  }

  .pill-icon-wrap {
    width: 24px;
    height: 24px;
  }

  .pill-icon-wrap svg {
    width: 12px;
    height: 12px;
  }
}

@media (max-width: 768px) {
  .auth-branding {
    display: none;
  }

  .auth-panel {
    padding: 0;
    align-items: flex-start;
  }
  
  .auth-card {
    max-width: 100%;
    min-height: 100vh;
    border-radius: 0;
    padding: 60px 24px 40px;
    display: flex;
    flex-direction: column;
  }
  
  .mobile-logo {
    display: block;
  }
  
  .form-header {
    margin-bottom: 28px;
  }
  
  .form-header h2 {
    font-size: 1.5rem;
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
  
  .modal-card {
    margin: 0;
    max-width: 100%;
    min-height: 100vh;
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
  .auth-card {
    padding: 48px 20px 32px;
  }
  
  .form-options {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .forgot-link {
    align-self: flex-start;
  }
}

/* ========================================
   Powered By
   ======================================== */
.powered-by {
  position: fixed;
  bottom: 16px;
  right: 20px;
  z-index: 20;
  font-size: 0.75rem;
  color: var(--text-dim);
  text-decoration: none;
  opacity: 0.6;
  transition: opacity 0.2s ease, color 0.2s ease;
}

.powered-by:hover {
  opacity: 1;
  color: var(--text-muted);
}

.powered-by strong {
  font-weight: 600;
  color: var(--primary);
}

/* Safe area insets for notched phones */
@supports (padding-top: env(safe-area-inset-top)) {
  @media (max-width: 768px) {
    .auth-card {
      padding-top: calc(60px + env(safe-area-inset-top));
      padding-bottom: calc(40px + env(safe-area-inset-bottom));
    }
    
    .modal-card {
      padding-top: calc(40px + env(safe-area-inset-top));
      padding-bottom: calc(40px + env(safe-area-inset-bottom));
    }
  }
}
</style>
