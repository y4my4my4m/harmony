<template>
  <div class="auth-wrapper" @mousemove="updateBackgroundRotation" :style="authStyles">
    <!-- Background Elements -->
    <div class="bg-overlay"></div>
    <div class="bg-particles">
      <div 
        v-for="particle in particles" 
        :key="particle.id" 
        class="particle" 
        :style="{
          left: particle.left,
          top: particle.top,
          'animation-delay': particle.delay,
          'animation-duration': particle.duration,
          width: particle.size,
          height: particle.size,
          transform: `translate(${particle.parallaxX}px, ${particle.parallaxY}px)`
        }"
      ></div>
    </div>

    <!-- Main Auth Container -->
    <div class="auth-container">
      <!-- Left Panel - Branding -->
      <div class="auth-branding">
        <div class="brand-content">
          <div class="logo-container" @click="themeStore.testAudio('ui_click')">
            <img src="/icon_3d.png" alt="Harmony Logo" class="brand-logo" />
            <div class="logo-glow"></div>
          </div>
          <h1 class="brand-title">
            <span class="harmony-logo">
              <span 
                v-for="(letter, index) in ['H', 'a', 'r', 'm', 'o', 'n', 'y']" 
                :key="index"
                class="letter" 
                :data-letter="letter"
                :style="{
                  '--cursor-offset-x': letterTransforms[index] ? `${letterTransforms[index].x}px` : '0px',
                  '--cursor-offset-y': letterTransforms[index] ? `${letterTransforms[index].y}px` : '0px'
                }"
              >
                {{ letter }}
              </span>
            </span>
          </h1>
          <p class="brand-subtitle">
            Connect, communicate, and create together in perfect harmony
          </p>
          
          <!-- Feature highlights -->
          <div class="features-preview">
            <div class="feature-item">
              <div class="feature-icon">💬</div>
              <span>Real-time messaging</span>
            </div>
            <div class="feature-item">
              <div class="feature-icon">🎮</div>
              <span>Gaming communities</span>
            </div>
            <div class="feature-item">
              <div class="feature-icon">🎵</div>
              <span>Voice channels</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Right Panel - Auth Form -->
      <div class="auth-panel">
        <div class="auth-form-container"  @mouseenter="onAuthPanelHover(true)" @mouseleave="onAuthPanelHover(false)" :class="{ 'hovered': isAuthPanelHovered }">
          <!-- Form Header -->
          <div class="form-header">
            <h2 class="form-title">
              {{ isLogin ? 'Welcome back!' : 'Create an account' }}
            </h2>
            <p class="form-subtitle">
              {{ isLogin ? 'We\'re so excited to see you again!' : 'Join the community and start your journey' }}
            </p>
          </div>

          <!-- Auth Form -->
          <form @submit.prevent="handleSubmit" class="auth-form">
            <div class="input-group">
              <label class="input-label">Email</label>
              <div class="input-container">
                <input 
                  v-model="email" 
                  type="email" 
                  class="form-input"
                  :class="{ 'error': emailError, 'focused': emailFocused }"
                  @focus="emailFocused = true"
                  @blur="emailFocused = false; validateEmail()"
                  @input="emailError = ''"
                  required
                  autocomplete="email"
                />
                <div class="input-icon">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M20 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.89 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm0 4l-8 5-8-5V6l8 5 8-5v2z"/>
                  </svg>
                </div>
              </div>
              <span v-if="emailError" class="error-message">{{ emailError }}</span>
            </div>

            <div class="input-group">
              <label class="input-label">Password</label>
              <div class="input-container">
                <input 
                  v-model="password" 
                  :type="showPassword ? 'text' : 'password'"
                  class="form-input"
                  :class="{ 'error': passwordError, 'focused': passwordFocused }"
                  @focus="passwordFocused = true"
                  @blur="passwordFocused = false; validatePassword()"
                  @input="passwordError = ''"
                  required
                  :autocomplete="isLogin ? 'current-password' : 'new-password'"
                />
                <button 
                  type="button" 
                  class="password-toggle"
                  @click="showPassword = !showPassword"
                >
                  <svg v-if="showPassword" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                  </svg>
                  <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                  </svg>
                </button>
              </div>
              <span v-if="passwordError" class="error-message">{{ passwordError }}</span>
            </div>

            <!-- Remember me / Forgot password for login -->
            <div v-if="isLogin" class="form-options">
              <label class="checkbox-container">
                <input type="checkbox" v-model="rememberMe" />
                <span class="checkmark"></span>
                Remember me
              </label>
              <button type="button" class="link-button" @click="showForgotPasswordModal = true">Forgot password?</button>
            </div>

            <!-- Submit Button -->
            <button 
              type="submit" 
              class="submit-btn"
              :class="{ 'loading': isLoading }"
              :disabled="isLoading"
            >
              <span v-if="!isLoading">{{ isLogin ? 'Log In' : 'Create Account' }}</span>
              <div v-else class="loading-spinner"></div>
            </button>

            <!-- Divider -->
            <div class="divider">
              <span>{{ isLogin ? 'Don\'t have an account?' : 'Already have an account?' }}</span>
            </div>

            <!-- Switch Mode Button -->
            <button 
              type="button" 
              class="switch-mode-btn"
              @click="toggleMode"
            >
              {{ isLogin ? 'Register' : 'Log In' }}
            </button>
          </form>

          <!-- Terms for registration -->
          <p v-if="!isLogin" class="terms-text">
            By registering, you agree to our 
            <a href="#" class="link">Terms of Service</a> and 
            <a href="#" class="link">Privacy Policy</a>
          </p>
        </div>
      </div>
    </div>

    <!-- Loading overlay -->
    <div v-if="isLoading" class="loading-overlay">
      <div class="loading-content">
        <div class="loading-spinner large"></div>
        <p>{{ isLogin ? 'Signing you in...' : 'Creating your account...' }}</p>
      </div>
    </div>

    <!-- Forgot Password Modal -->
    <div v-if="showForgotPasswordModal" class="modal-overlay" @click="showForgotPasswordModal = false">
      <div class="modal-content" @click.stop>
        <button class="modal-close" @click="showForgotPasswordModal = false" aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        </button>
        
        <h3 class="modal-title">Reset Your Password</h3>
        <p class="modal-description">
          {{ forgotPasswordStep === 1 
            ? 'Enter your email address and we\'ll send you a password reset link.' 
            : 'Check your email for a password reset link. If you don\'t see it, check your spam folder.' 
          }}
        </p>

        <form v-if="forgotPasswordStep === 1" @submit.prevent="handleForgotPassword" class="modal-form">
          <div class="input-group">
            <label class="input-label">Email Address</label>
            <input 
              v-model="forgotPasswordEmail" 
              type="email" 
              class="form-input"
              :class="{ 'error': forgotPasswordError }"
              placeholder="your.email@example.com"
              required
              autocomplete="email"
            />
            <span v-if="forgotPasswordError" class="error-message">{{ forgotPasswordError }}</span>
          </div>

          <div class="modal-actions">
            <button 
              type="submit" 
              class="submit-btn"
              :disabled="forgotPasswordLoading || !forgotPasswordEmail"
            >
              <span v-if="!forgotPasswordLoading">Send Reset Link</span>
              <div v-else class="loading-spinner"></div>
            </button>
            <button 
              type="button" 
              class="cancel-btn"
              @click="showForgotPasswordModal = false"
            >
              Cancel
            </button>
          </div>
        </form>

        <div v-else class="modal-success">
          <div class="success-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" fill="#43b581" opacity="0.2"/>
              <path d="M9 12l2 2 4-4" stroke="#43b581" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
          <p class="success-message">
            Password reset email sent to <strong>{{ forgotPasswordEmail }}</strong>
          </p>
          <button 
            class="submit-btn"
            @click="closeForgotPasswordModal"
          >
            Got it
          </button>
        </div>
      </div>
    </div>

    <!-- 2FA Verification Modal -->
    <div v-if="show2FAModal" class="modal-overlay" @click="close2FAModal">
      <div class="modal-content" @click.stop>
        <button class="modal-close" @click="close2FAModal" aria-label="Close">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
            <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z" fill="currentColor"/>
          </svg>
        </button>
        
        <div class="twofa-header">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" style="color: #5865f2;">
            <path d="M12 1L3 5v6c0 5.55 3.84 10.74 9 12 5.16-1.26 9-6.45 9-12V5l-9-4zm0 10.99h7c-.53 4.12-3.28 7.79-7 8.94V12H5V6.3l7-3.11v8.8z" fill="currentColor"/>
          </svg>
          <h3 class="modal-title">Two-Factor Authentication</h3>
        </div>
        
        <p class="modal-description">
          Enter the 6-digit verification code from your authenticator app.
        </p>

        <form @submit.prevent="handle2FAVerification" class="modal-form">
          <div class="input-group">
            <label class="input-label">Verification Code</label>
            <input 
              v-model="twoFactorCode" 
              type="text"
              class="form-input twofa-code-input"
              :class="{ 'error': twoFactorError }"
              placeholder="000000"
              maxlength="6"
              pattern="[0-9]*"
              inputmode="numeric"
              autocomplete="one-time-code"
              autofocus
              @input="twoFactorError = ''"
            />
            <span v-if="twoFactorError" class="error-message">{{ twoFactorError }}</span>
          </div>

          <div class="modal-actions">
            <button 
              type="submit" 
              class="submit-btn"
              :disabled="twoFactorLoading || twoFactorCode.length !== 6"
            >
              <span v-if="!twoFactorLoading">Verify</span>
              <div v-else class="loading-spinner"></div>
            </button>
            <button 
              type="button" 
              class="cancel-btn"
              @click="close2FAModal"
            >
              Cancel
            </button>
          </div>
        </form>

        <p class="modal-help-text">
          Lost access to your authenticator? Contact support for account recovery.
        </p>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useThemeStore } from '@/stores/useTheme'
import { useToast } from 'vue-toastification'
import { supabase } from '@/supabase'

// Props
interface Props {
  isLogin?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  isLogin: true
})

// Composables
const router = useRouter()
const authStore = useAuthStore()
const themeStore = useThemeStore()
const toast = useToast()

// Reactive state
const email = ref('')
const password = ref('')
const rememberMe = ref(false)
const showPassword = ref(false)
const isLoading = ref(false)

// Focus states
const emailFocused = ref(false)
const passwordFocused = ref(false)

// Validation states
const emailError = ref('')
const passwordError = ref('')

// Forgot password state
const showForgotPasswordModal = ref(false)
const forgotPasswordEmail = ref('')
const forgotPasswordStep = ref(1) // 1 = input email, 2 = success
const forgotPasswordLoading = ref(false)
const forgotPasswordError = ref('')

// 2FA state
const show2FAModal = ref(false)
const twoFactorCode = ref('')
const twoFactorError = ref('')
const twoFactorLoading = ref(false)
const pendingFactorId = ref('')

// Background
const randomBg = ref('')
const bgRotation = ref(0)
const bgParallaxX = ref(0)
const bgParallaxY = ref(0)
const particles = ref<Array<{
  id: number
  left: string
  top: string
  delay: string
  duration: string
  size: string
  parallaxX: number
  parallaxY: number
}>>([])

// Letter effects
const letterElements = ref<HTMLElement[]>([])
const letterTransforms = ref<Record<number, { x: number; y: number }>>({})

// Auth panel hover effect
const isAuthPanelHovered = ref(false)

// Computed
const authStyles = computed(() => ({
  '--random-bg': randomBg.value,
  '--bg-rotation': `${bgRotation.value}deg`,
  '--bg-parallax-x': `${bgParallaxX.value}px`,
  '--bg-parallax-y': `${bgParallaxY.value}px`,
  '--auth-blur': isAuthPanelHovered.value ? '15px' : '2px'
}))

// Methods
const initializeParticles = () => {
  particles.value = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    delay: `${Math.random() * 3}s`,
    duration: `${4 + Math.random() * 4}s`,
    size: `${4 + Math.random() * 6}px`,
    parallaxX: 0,
    parallaxY: 0
  }))
}

const updateBackgroundRotation = (event: MouseEvent) => {
  const x = event.clientX - window.innerWidth / 2
  const y = event.clientY - window.innerHeight / 2
  const angle = Math.atan2(y, x) * (180 / Math.PI)
  bgRotation.value = angle

  // Add parallax effect for background
  const parallaxStrength = -10
  bgParallaxX.value = (x / window.innerWidth) * parallaxStrength
  bgParallaxY.value = (y / window.innerHeight) * parallaxStrength

  // Update particle parallax
  particles.value.forEach((particle, index) => {
    const strength = (index % 3 + 1) * 5 // Different strengths for depth
    particle.parallaxX = (x / window.innerWidth) * strength
    particle.parallaxY = (y / window.innerHeight) * strength
  })

  // Update letter positions (scared effect)
  updateLetterPositions(event)
}

const updateLetterPositions = (event: MouseEvent) => {
  letterElements.value.forEach((letter, index) => {
    if (!letter) return

    const rect = letter.getBoundingClientRect()
    const letterCenterX = rect.left + rect.width / 2
    const letterCenterY = rect.top + rect.height / 2

    const deltaX = event.clientX - letterCenterX
    const deltaY = event.clientY - letterCenterY
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY)

    // Increased effect radius and strength for better responsiveness
    const effectRadius = 250
    const maxOffset = 100

    if (distance < effectRadius && distance > 0) {
      const force = Math.pow((effectRadius - distance) / effectRadius, 1.5) // Ease-out curve
      const offsetX = -(deltaX / distance) * force * maxOffset
      const offsetY = -(deltaY / distance) * force * maxOffset

      letterTransforms.value[index] = {
        x: offsetX,
        y: offsetY
      }
    } else {
      letterTransforms.value[index] = { x: 0, y: 0 }
    }
  })
}

const initializeLetterElements = async () => {
  await nextTick()
  letterElements.value = Array.from(document.querySelectorAll('.letter')) as HTMLElement[]
}

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

const handleSubmit = async () => {
  validateEmail()
  validatePassword()
  
  if (emailError.value || passwordError.value) {
    return
  }

  isLoading.value = true
  
  try {
    if (props.isLogin) {
      // Attempt login
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.value,
        password: password.value
      })

      if (error) {
        // Check if error is due to 2FA requirement
        if (error.message?.includes('MFA') || error.message?.includes('factor')) {
          // Need to show 2FA modal
          show2FAModal.value = true
          isLoading.value = false
          return
        }
        throw error
      }

      // Check if user has 2FA enabled
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified')

      if (totpFactor) {
        // User has 2FA enabled, need verification
        pendingFactorId.value = totpFactor.id
        show2FAModal.value = true
        isLoading.value = false
        return
      }

      // No 2FA, proceed with login
      authStore.session = data.session
      toast.success('Welcome back!')
    } else {
      await authStore.register(email.value, password.value)
      toast.success('Account created successfully!')
      router.push('/new-profile')
    }
  } catch (error: any) {
    console.error('Auth error:', error)
    toast.error(error.message || 'Authentication failed')
  } finally {
    isLoading.value = false
  }
}

const handle2FAVerification = async () => {
  if (twoFactorCode.value.length !== 6) {
    twoFactorError.value = 'Please enter a 6-digit code'
    return
  }

  twoFactorLoading.value = true
  twoFactorError.value = ''

  try {
    const { data, error } = await supabase.auth.mfa.challenge({
      factorId: pendingFactorId.value
    })

    if (error) throw error

    const challengeId = data.id

    const { error: verifyError } = await supabase.auth.mfa.verify({
      factorId: pendingFactorId.value,
      challengeId: challengeId,
      code: twoFactorCode.value
    })

    if (verifyError) {
      twoFactorError.value = 'Invalid verification code'
      return
    }

    // Success! Get the session
    const { data: sessionData } = await supabase.auth.getSession()
    authStore.session = sessionData.session

    show2FAModal.value = false
    toast.success('Welcome back!')
  } catch (error: any) {
    console.error('2FA verification error:', error)
    twoFactorError.value = 'Verification failed. Please try again.'
  } finally {
    twoFactorLoading.value = false
  }
}

const close2FAModal = () => {
  show2FAModal.value = false
  twoFactorCode.value = ''
  twoFactorError.value = ''
  pendingFactorId.value = ''
}

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

    // Show success step
    forgotPasswordStep.value = 2
  } catch (error: any) {
    console.error('Password reset error:', error)
    
    // Supabase returns error even if email doesn't exist (for security)
    // But we'll still show success to prevent email enumeration
    if (error.message?.includes('SMTP') || error.message?.includes('email')) {
      forgotPasswordError.value = 'Email service not configured. Please contact support.'
    } else {
      // Still show as success to prevent user enumeration
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
  const route = props.isLogin ? '/register' : '/login'
  router.push(route)
}

const onAuthPanelHover = (isHovered: boolean) => {
  isAuthPanelHovered.value = isHovered
}

// Lifecycle
onMounted(async () => {
  randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 65) + 1}.webp')`
  initializeParticles()
  await initializeLetterElements()
})
</script>

<style scoped>
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');

.auth-wrapper {
  min-height: 100vh;
  background: var(--random-bg) center center;
  background-size: cover;
  background-attachment: fixed;
  
  position: relative;
  /* Remove overflow: hidden to allow backdrop-filter to work properly */
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  /* Apply parallax to the background image itself */
  background-position: calc(50% + var(--bg-parallax-x)) calc(50% + var(--bg-parallax-y));
}

.bg-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    135deg,
    rgba(0, 0, 0, 0.7) 0%,
    rgba(0, 0, 0, 0.4) 50%,
    rgba(0, 0, 0, 0.8) 100%
  );
  backdrop-filter: blur(var(--auth-blur, 2px));
  transition: backdrop-filter 0.8s cubic-bezier(0.4, 0, 0.2, 1);
  z-index: 1;
  pointer-events: none;
}

.bg-particles {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}

.particle {
  position: absolute;
  width: var(--size);
  height: var(--size);
  background: linear-gradient(45deg, #5865f2, #7289da);
  border-radius: 50%;
  opacity: 0.6;
  animation: float var(--duration) ease-in-out infinite var(--delay);
}

@keyframes float {
  0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.6; }
  50% { transform: translateY(-20px) rotate(180deg); opacity: 1; }
}

.auth-container {
  position: relative;
  z-index: 10;
  min-height: 100vh;
  display: flex;
  width: 100vw;
  margin: 0;
}

.auth-branding {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  position: relative;
}

.brand-content {
  text-align: center;
  max-width: 400px;
}

.logo-container {
  position: relative;
  display: inline-block;
  margin-bottom: 32px;
  cursor: pointer;
  transition: transform 0.3s ease;
}

.logo-container:hover {
  transform: scale(1.05);
}

.brand-logo {
  width: 120px;
  height: 120px;
  position: relative;
  z-index: 2;
  filter: drop-shadow(0 10px 30px rgba(88, 101, 242, 0.3));
}

.logo-glow {
  position: absolute;
  inset: -20px;
  background: radial-gradient(circle, rgba(88, 101, 242, 0.4) 0%, transparent 70%);
  border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 0.8; transform: scale(1.1); }
}

.brand-title {
  font-size: 3.5rem;
  font-weight: 700;
  margin: 0 0 16px;
  line-height: 1;
}

.harmony-logo {
  display: inline-block;
  overflow: visible;
  position: relative;
}

.letter {
  display: inline-block;
  font-size: 3.5rem;
  font-weight: 700;
  position: relative;
  background: linear-gradient(135deg, #5865f2 0%, #7289da 30%, #ed4245 60%, #5865f2 100%);
  background-size: 300% 300%;
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  animation: letterWave 4s ease-in-out infinite;
  text-shadow: 0 0 30px rgba(88, 101, 242, 0.5);
  transform-origin: center;
  cursor: pointer;
  /* Add smooth transitions for the scared effect */
  transition: transform 0.1s ease-out;
  will-change: transform;
}

.letter::before {
  content: attr(data-letter);
  position: absolute;
  top: 0;
  left: 0;
  background: linear-gradient(135deg, #ffffff 0%, #f0f0f0 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
  opacity: 0;
  transition: opacity 0.3s ease;
  z-index: -1;
}

.letter:hover::before {
  opacity: 0.2;
}

.letter:hover {
  transform: scale(1.1) rotate(5deg);
  filter: drop-shadow(0 0 20px rgba(88, 101, 242, 0.8));
}

.letter:nth-child(1) { 
  animation-delay: 0s; 
  --hover-color: #5865f2;
}
.letter:nth-child(2) { 
  animation-delay: 0.2s; 
  --hover-color: #7289da;
}
.letter:nth-child(3) { 
  animation-delay: 0.4s; 
  --hover-color: #ed4245;
}
.letter:nth-child(4) { 
  animation-delay: 0.6s; 
  --hover-color: #57f287;
}
.letter:nth-child(5) { 
  animation-delay: 0.8s; 
  --hover-color: #fee75c;
}
.letter:nth-child(6) { 
  animation-delay: 1s; 
  --hover-color: #eb459e;
}
.letter:nth-child(7) { 
  animation-delay: 1.2s; 
  --hover-color: #5865f2;
}

@keyframes letterWave {
  0%, 100% { 
    transform: translateY(0px) rotate(0deg) scale(1) translate(var(--cursor-offset-x, 0px), var(--cursor-offset-y, 0px));
    background-position: 0% 50%;
  }
  25% { 
    transform: translateY(-8px) rotate(2deg) scale(1.05) translate(var(--cursor-offset-x, 0px), var(--cursor-offset-y, 0px));
    background-position: 50% 0%;
  }
  50% { 
    transform: translateY(0px) rotate(0deg) scale(1) translate(var(--cursor-offset-x, 0px), var(--cursor-offset-y, 0px));
    background-position: 100% 50%;
  }
  75% { 
    transform: translateY(-4px) rotate(-1deg) scale(1.02) translate(var(--cursor-offset-x, 0px), var(--cursor-offset-y, 0px));
    background-position: 50% 100%;
  }
}

.brand-subtitle {
  font-size: 1.1rem;
  color: rgba(255, 255, 255, 0.8);
  margin: 0 0 48px;
  line-height: 1.5;
}

.features-preview {
  display: flex;
  flex-direction: column;
  gap: 16px;
  text-align: left;
}

.feature-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  transition: all 0.3s ease;
}

.feature-item:hover {
  background: rgba(255, 255, 255, 0.1);
  transform: translateX(8px);
}

.feature-icon {
  font-size: 1.5rem;
}

.auth-panel {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
}

.auth-form-container {
  width: 100%;
  max-width: 400px;
  background: rgba(255, 255, 255, 0.85);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  padding: 40px;
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.1),
    0 0 0 1px rgba(255, 255, 255, 0.2),
    inset 0 1px 0 rgba(255, 255, 255, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.3);
  transition: all 0.6s cubic-bezier(0.4, 0, 0.2, 1);
  position: relative;
  overflow: hidden;
}

.auth-form-container::before {
  content: '';
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: linear-gradient(
    135deg,
    rgba(255, 255, 255, 0.1) 0%,
    rgba(255, 255, 255, 0.05) 50%,
    rgba(255, 255, 255, 0.02) 100%
  );
  opacity: 0;
  transition: opacity 0.6s ease;
  pointer-events: none;
  z-index: 1;
}

.auth-form-container.hovered {
  transform: translateY(-8px) scale(1.02);
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(30px);
  box-shadow: 
    0 40px 80px rgba(88, 101, 242, 0.15),
    0 20px 40px rgba(0, 0, 0, 0.1),
    0 0 0 1px rgba(255, 255, 255, 0.4),
    inset 0 1px 0 rgba(255, 255, 255, 0.5),
    0 0 60px rgba(88, 101, 242, 0.1);
  border-color: rgba(88, 101, 242, 0.2);
}

.auth-form-container.hovered::before {
  opacity: 1;
}

.auth-form-container > * {
  position: relative;
  z-index: 2;
}

.form-header {
  text-align: center;
  margin-bottom: 32px;
}

.form-title {
  font-size: 1.75rem;
  font-weight: 600;
  color: #2c2f36;
  margin: 0 0 8px;
}

.form-subtitle {
  font-size: 0.95rem;
  color: #6b7280;
  margin: 0;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.input-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: #374151;
  text-transform: uppercase;
  letter-spacing: 0.025em;
}

.input-container {
  position: relative;
}

.form-input {
  width: 100%;
  padding: 12px 16px;
  padding-right: 48px;
  border: 2px solid #e5e7eb;
  border-radius: 12px;
  font-size: 1rem;
  background: #ffffff;
  color: #1f2937;
  transition: all 0.2s ease;
  outline: none;
}

.form-input:focus,
.form-input.focused {
  border-color: #5865f2;
  box-shadow: 0 0 0 3px rgba(88, 101, 242, 0.1);
}

.form-input.error {
  border-color: #ef4444;
  box-shadow: 0 0 0 3px rgba(239, 68, 68, 0.1);
}

.input-icon {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  color: #9ca3af;
  pointer-events: none;
}

.password-toggle {
  position: absolute;
  right: 16px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: color 0.2s ease;
}

.password-toggle:hover {
  color: #5865f2;
}

.error-message {
  font-size: 0.8rem;
  color: #ef4444;
  margin-top: 4px;
}

.form-options {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin: 8px 0;
}

.checkbox-container {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 0.875rem;
  color: #6b7280;
  cursor: pointer;
}

.checkbox-container input[type="checkbox"] {
  appearance: none;
  width: 16px;
  height: 16px;
  border: 2px solid #d1d5db;
  border-radius: 4px;
  position: relative;
  cursor: pointer;
  transition: all 0.2s ease;
}

.checkbox-container input[type="checkbox"]:checked {
  background: #5865f2;
  border-color: #5865f2;
}

.checkbox-container input[type="checkbox"]:checked::after {
  content: '✓';
  position: absolute;
  top: 50%;
  left: 50%;
  transform: translate(-50%, -50%);
  color: white;
  font-size: 10px;
  font-weight: bold;
}

.link-button {
  background: none;
  border: none;
  color: #5865f2;
  font-size: 0.875rem;
  cursor: pointer;
  text-decoration: none;
  transition: color 0.2s ease;
}

.link-button:hover {
  color: #4752c4;
  text-decoration: underline;
}

.submit-btn {
  width: 100%;
  padding: 14px;
  background: linear-gradient(135deg, #5865f2 0%, #7289da 100%);
  color: white;
  border: none;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
  position: relative;
  overflow: hidden;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 10px 30px rgba(88, 101, 242, 0.4);
}

.submit-btn:disabled {
  opacity: 0.7;
  cursor: not-allowed;
  transform: none;
}

.submit-btn.loading {
  pointer-events: none;
}

.divider {
  display: flex;
  align-items: center;
  gap: 16px;
  margin: 24px 0 16px;
  font-size: 0.875rem;
  color: #9ca3af;
}

.divider::before,
.divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: #e5e7eb;
}

.switch-mode-btn {
  width: 100%;
  padding: 12px;
  background: transparent;
  color: #5865f2;
  border: 2px solid #5865f2;
  border-radius: 12px;
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.3s ease;
}

.switch-mode-btn:hover {
  background: #5865f2;
  color: white;
  transform: translateY(-1px);
}

.terms-text {
  font-size: 0.8rem;
  color: #9ca3af;
  text-align: center;
  margin-top: 20px;
  line-height: 1.4;
}

.link {
  color: #5865f2;
  text-decoration: none;
}

.link:hover {
  text-decoration: underline;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid #40444b;
  border-top: 2px solid #5865f2;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.loading-spinner.large {
  width: 40px;
  height: 40px;
  border-width: 4px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.loading-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.loading-content {
  text-align: center;
  color: white;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 16px;
}

/* Modal Styles */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  animation: fadeIn 0.2s ease-out;
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

.modal-content {
  background: var(--h-chat, #2f3136);
  border-radius: 8px;
  padding: 32px;
  max-width: 440px;
  width: 90%;
  position: relative;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
  animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
  from {
    transform: translateY(20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}

.modal-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: #ffffff;
}

.modal-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 12px 0;
}

.modal-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 24px 0;
  line-height: 1.5;
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.modal-actions {
  display: flex;
  gap: 12px;
  margin-top: 8px;
}

.cancel-btn {
  flex: 1;
  padding: 12px;
  border-radius: 4px;
  border: none;
  background: transparent;
  color: #b9bbbe;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.cancel-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: #ffffff;
}

.modal-success {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  gap: 20px;
}

.success-icon {
  animation: scaleIn 0.4s ease-out;
}

@keyframes scaleIn {
  from {
    transform: scale(0.5);
    opacity: 0;
  }
  to {
    transform: scale(1);
    opacity: 1;
  }
}

.success-message {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.5;
}

.success-message strong {
  color: #ffffff;
  word-break: break-all;
}

/* 2FA Modal Styles */
.twofa-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.twofa-code-input {
  font-size: 24px;
  letter-spacing: 0.5em;
  text-align: center;
  font-family: 'Courier New', monospace;
}

.modal-help-text {
  font-size: 12px;
  color: #72767d;
  text-align: center;
  margin: 16px 0 0 0;
}

/* Responsive Design */
@media (max-width: 1024px) {
  .auth-container {
    flex-direction: column;
  }
  
  .auth-branding {
    padding: 32px 20px;
  }
  
  .brand-title {
    font-size: 2.5rem;
  }
  
  .features-preview {
    flex-direction: row;
    flex-wrap: wrap;
    justify-content: center;
  }
  
  .feature-item {
    flex: 0 1 auto;
  }
}

@media (max-width: 768px) {
  .auth-wrapper {
    min-height: 100vh;
  }
  
  .auth-branding {
    padding: 20px;
    min-height: auto;
  }
  
  .brand-title {
    font-size: 2rem;
  }
  
  .brand-logo {
    width: 80px;
    height: 80px;
  }
  
  .auth-panel {
    padding: 10px;
  }
  
  .auth-form-container {
    padding: 32px 24px;
  }
  
  .features-preview {
    display: none;
  }
  .brand-subtitle {
    margin-bottom: 0;
    padding-bottom: 0;
  }
}

@media (max-width: 480px) {
  .auth-form-container {
    padding: 24px 20px;
    margin: 0 8px;
    border-radius: 16px;
  }
  .auth-branding,
  .auth-panel {
    padding: 0;
  }

  .auth-panel {
    align-items: flex-start;
  }
  
  .form-title {
    font-size: 1.5rem;
  }
  
  .form-options {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }

  .brand-subtitle,
  .brand-logo {
    display: none;
  }
  .divider {
    margin: 0;
  }
}
</style>