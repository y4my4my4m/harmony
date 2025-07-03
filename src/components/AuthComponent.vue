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
          height: particle.size
        }"
      ></div>
    </div>

    <!-- Main Auth Container -->
    <div class="auth-container">
      <!-- Left Panel - Branding -->
      <div class="auth-branding">
        <div class="brand-content">
          <div class="logo-container" @click="playSound('/assets/sounds/pirori-wet.mp3')">
            <img src="/icon_3d.png" alt="Harmony Logo" class="brand-logo" />
            <div class="logo-glow"></div>
          </div>
          <h1 class="brand-title">
            <span class="harmony-logo">
              <span class="letter" data-letter="H">H</span>
              <span class="letter" data-letter="a">a</span>
              <span class="letter" data-letter="r">r</span>
              <span class="letter" data-letter="m">m</span>
              <span class="letter" data-letter="o">o</span>
              <span class="letter" data-letter="n">n</span>
              <span class="letter" data-letter="y">y</span>
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
        <div class="auth-form-container">
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
              <button type="button" class="link-button">Forgot password?</button>
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
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import { useToast } from 'vue-toastification'
import { useAudioEffects } from '@/composables/useCommonUI'

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
const toast = useToast()
const { playSound } = useAudioEffects()

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

// Background
const randomBg = ref('')
const bgRotation = ref(0)
const particles = ref<Array<{
  id: number
  left: string
  top: string
  delay: string
  duration: string
  size: string
}>>([])

// Computed
const authStyles = computed(() => ({
  '--random-bg': randomBg.value,
  '--bg-rotation': `${bgRotation.value}deg`
}))

// Methods
const initializeParticles = () => {
  particles.value = Array.from({ length: 8 }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    delay: `${Math.random() * 3}s`,
    duration: `${4 + Math.random() * 4}s`,
    size: `${4 + Math.random() * 6}px`
  }))
}

const updateBackgroundRotation = (event: MouseEvent) => {
  const x = event.clientX - window.innerWidth / 2
  const y = event.clientY - window.innerHeight / 2
  const angle = Math.atan2(y, x) * (180 / Math.PI)
  bgRotation.value = angle
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
      await authStore.login(email.value, password.value)
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

const toggleMode = () => {
  const route = props.isLogin ? '/register' : '/login'
  router.push(route)
}

// Lifecycle
onMounted(() => {
  randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 64) + 1}.png')`
  initializeParticles()
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
  overflow: hidden;
  font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
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
  backdrop-filter: blur(2px);
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
  max-width: 1200px;
  margin: 0 auto;
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
  overflow: hidden;
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
    transform: translateY(0px) rotate(0deg) scale(1);
    background-position: 0% 50%;
  }
  25% { 
    transform: translateY(-8px) rotate(2deg) scale(1.05);
    background-position: 50% 0%;
  }
  50% { 
    transform: translateY(0px) rotate(0deg) scale(1);
    background-position: 100% 50%;
  }
  75% { 
    transform: translateY(-4px) rotate(-1deg) scale(1.02);
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
  background: rgba(255, 255, 255, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 20px;
  padding: 40px;
  box-shadow: 
    0 20px 40px rgba(0, 0, 0, 0.1),
    0 0 0 1px rgba(255, 255, 255, 0.2);
  border: 1px solid rgba(255, 255, 255, 0.3);
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
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid white;
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
    padding: 20px;
  }
  
  .auth-form-container {
    padding: 32px 24px;
  }
  
  .features-preview {
    display: none;
  }
}

@media (max-width: 480px) {
  .auth-form-container {
    padding: 24px 20px;
    margin: 0 8px;
    border-radius: 16px;
  }
  
  .form-title {
    font-size: 1.5rem;
  }
  
  .form-options {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
}
</style>