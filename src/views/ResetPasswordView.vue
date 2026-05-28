<template>
  <div class="reset-password-wrapper" :style="authStyles">
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
        }"
      ></div>
    </div>

    <!-- Main Container -->
    <div class="reset-password-container">
      <!-- Left Panel - Branding -->
      <div class="auth-branding">
        <div class="brand-content">
          <div class="logo-container">
            <img src="/icon_3d.webp" alt="Harmony Logo" class="brand-logo" />
            <div class="logo-glow"></div>
          </div>
          <h1 class="brand-title">
            <span class="harmony-logo">Harmony</span>
          </h1>
          <p class="brand-subtitle">
            Reset your password to regain access to your account
          </p>
        </div>
      </div>

      <!-- Right Panel - Reset Form -->
      <div class="auth-panel">
        <div class="auth-form-container">
          <!-- Success State -->
          <div v-if="isSuccess" class="success-state">
            <div class="success-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#43b581" opacity="0.2"/>
                <path d="M9 12l2 2 4-4" stroke="#43b581" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </div>
            <h2 class="form-title">Password Reset Successful!</h2>
            <p class="form-subtitle">
              Your password has been updated. You can now log in with your new password.
            </p>
            <button 
              type="button" 
              class="submit-btn"
              @click="goToLogin"
            >
              Go to Login
            </button>
          </div>

          <!-- Error State (Invalid/Expired Token) -->
          <div v-else-if="isError" class="error-state">
            <div class="error-icon">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="10" fill="#ed4245" opacity="0.2"/>
                <path d="M12 8v4M12 16h.01" stroke="#ed4245" stroke-width="2" stroke-linecap="round"/>
              </svg>
            </div>
            <h2 class="form-title">Invalid or Expired Link</h2>
            <p class="form-subtitle">
              {{ errorMessage || 'This password reset link is invalid or has expired. Please request a new one.' }}
            </p>
            <button 
              type="button" 
              class="submit-btn"
              @click="goToLogin"
            >
              Go to Login
            </button>
          </div>

          <!-- Reset Form -->
          <div v-else-if="isValidToken">
            <div class="form-header">
              <h2 class="form-title">Reset Your Password</h2>
              <p class="form-subtitle">
                Enter your new password below
              </p>
            </div>

            <form @submit.prevent="handleResetPassword" class="auth-form">
              <div class="input-group">
                <label class="input-label">New Password</label>
                <div class="input-container">
                  <input 
                    v-model="newPassword" 
                    :type="showPassword ? 'text' : 'password'"
                    class="form-input"
                    :class="{ 'error': passwordError, 'focused': passwordFocused }"
                    @focus="passwordFocused = true"
                    @blur="passwordFocused = false"
                    @input="passwordError = ''"
                    required
                    autocomplete="new-password"
                    placeholder="Enter your new password"
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

              <div class="input-group">
                <label class="input-label">Confirm New Password</label>
                <div class="input-container">
                  <input 
                    v-model="confirmPassword" 
                    :type="showConfirmPassword ? 'text' : 'password'"
                    class="form-input"
                    :class="{ 'error': confirmPasswordError, 'focused': confirmPasswordFocused }"
                    @focus="confirmPasswordFocused = true"
                    @blur="confirmPasswordFocused = false"
                    @input="confirmPasswordError = ''"
                    required
                    autocomplete="new-password"
                    placeholder="Confirm your new password"
                  />
                  <button 
                    type="button" 
                    class="password-toggle"
                    @click="showConfirmPassword = !showConfirmPassword"
                  >
                    <svg v-if="showConfirmPassword" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/>
                    </svg>
                    <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/>
                    </svg>
                  </button>
                </div>
                <span v-if="confirmPasswordError" class="error-message">{{ confirmPasswordError }}</span>
              </div>

              <!-- Submit Button -->
              <button 
                type="submit" 
                class="submit-btn"
                :class="{ 'loading': isLoading }"
                :disabled="isLoading || !newPassword || !confirmPassword"
              >
                <span v-if="!isLoading">Reset Password</span>
                <div v-else class="loading-spinner"></div>
              </button>

              <!-- Back to Login -->
              <div class="divider">
                <span>Remember your password?</span>
              </div>

              <button 
                type="button" 
                class="switch-mode-btn"
                @click="goToLogin"
              >
                Back to Login
              </button>
            </form>
          </div>

          <!-- Loading state while checking token -->
          <div v-else class="loading-state">
            <div class="loading-spinner large"></div>
            <p class="form-subtitle">Verifying password reset link...</p>
          </div>
        </div>
      </div>
    </div>

    <!-- MFA Verification Modal -->
    <div v-if="showMFAModal" class="modal-overlay" @click="closeMFAModal">
      <div class="modal-content" @click.stop>
        <button class="modal-close" @click="closeMFAModal" aria-label="Close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor">
            <path d="M18 6L6 18M6 6l12 12" stroke-width="2" stroke-linecap="round"/>
          </svg>
        </button>

        <div class="modal-header">
          <div class="modal-icon">
            <svg width="48" height="48" viewBox="0 0 24 24" fill="none">
              <circle cx="12" cy="12" r="10" stroke="#0EA5E9" stroke-width="2"/>
              <path d="M12 6v6l4 2" stroke="#0EA5E9" stroke-width="2" stroke-linecap="round"/>
            </svg>
          </div>
          <h2 class="modal-title">Two-Factor Authentication</h2>
          <p class="modal-subtitle">
            {{ useRecoveryCode ? 'Enter your 8-character recovery code' : 'Enter the 6-digit code from your authenticator app' }}
          </p>
        </div>

        <form @submit.prevent="handleMFAVerification" class="modal-form">
          <div class="input-group">
            <label class="input-label">
              {{ useRecoveryCode ? 'Recovery Code' : '6-Digit Code' }}
            </label>
            <input 
              v-model="mfaCode" 
              type="text"
              :maxlength="useRecoveryCode ? 8 : 6"
              class="form-input"
              :class="{ 'error': mfaError }"
              @input="mfaError = ''"
              required
              :placeholder="useRecoveryCode ? 'XXXXXXXX' : '000000'"
              autocomplete="off"
            />
            <span v-if="mfaError" class="error-message">{{ mfaError }}</span>
          </div>

          <button 
            type="submit" 
            class="submit-btn"
            :class="{ 'loading': mfaLoading }"
            :disabled="mfaLoading"
          >
            <span v-if="!mfaLoading">Verify & Reset Password</span>
            <div v-else class="loading-spinner"></div>
          </button>

          <button 
            type="button" 
            class="switch-mode-btn"
            @click="toggleRecoveryCode"
          >
            {{ useRecoveryCode ? 'Use Authenticator Code' : 'Use Recovery Code' }}
          </button>

          <button 
            type="button" 
            class="cancel-btn"
            @click="closeMFAModal"
          >
            Cancel
          </button>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onBeforeUnmount } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import { useAuthStore } from '@/stores/auth'

const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()

// State
const newPassword = ref('')
const confirmPassword = ref('')
const showPassword = ref(false)
const showConfirmPassword = ref(false)
const passwordFocused = ref(false)
const confirmPasswordFocused = ref(false)
const passwordError = ref('')
const confirmPasswordError = ref('')
const isLoading = ref(false)
const isSuccess = ref(false)
const isError = ref(false)
const errorMessage = ref('')
const isValidToken = ref(false)
const isPasswordResetMode = ref(false)
let authStateListener: { subscription: { unsubscribe: () => void } } | null = null

// MFA State
const requiresMFA = ref(false)
const showMFAModal = ref(false)
const mfaCode = ref('')
const mfaError = ref('')
const mfaLoading = ref(false)
const mfaFactorId = ref('')
const mfaChallengeId = ref('')
const useRecoveryCode = ref(false)

// Background particles
const particles = ref<Array<{ id: number; left: string; top: string; delay: string; duration: string; size: string }>>([])
const randomBg = ref('')

// Styles
const authStyles = computed(() => ({
  '--random-bg': randomBg.value
}))

// Initialize particles
const initializeParticles = () => {
  const particleCount = 20
  particles.value = Array.from({ length: particleCount }, (_, i) => ({
    id: i,
    left: `${Math.random() * 100}%`,
    top: `${Math.random() * 100}%`,
    delay: `${Math.random() * 3}s`,
    duration: `${3 + Math.random() * 4}s`,
    size: `${10 + Math.random() * 20}px`
  }))
}

// Check if user has MFA enabled
const checkMFAStatus = async () => {
  try {
    const { data: factors } = await supabase.auth.mfa.listFactors()
    const totpFactor = factors?.totp?.find((f: any) => f.status === 'verified')
    
    if (totpFactor) {
      debug.log('🔒 User has MFA enabled - will require 2FA verification for password reset')
      requiresMFA.value = true
      mfaFactorId.value = totpFactor.id
    } else {
      debug.log('✅ User does not have MFA enabled')
      requiresMFA.value = false
    }
  } catch (error: any) {
    debug.error('Error checking MFA status:', error)
    // If we can't check MFA status, assume it's not enabled
    requiresMFA.value = false
  }
}

// Check for recovery token on mount
onMounted(async () => {
  randomBg.value = `url('/img/login_bg${Math.floor(Math.random() * 65) + 1}.webp')`
  initializeParticles()

  // Set up listener for PASSWORD_RECOVERY event
  // This fires when Supabase processes the recovery token
  // Note: The auth store will also catch this and set isPasswordResetMode flag
  const authListenerData = supabase.auth.onAuthStateChange(async (event, session) => {
    if (event === 'PASSWORD_RECOVERY' && session) {
      debug.log('🔒 PASSWORD_RECOVERY event detected in ResetPasswordView')
      isValidToken.value = true
      isPasswordResetMode.value = true
      // Router guard will handle preventing navigation
    }
  })
  authStateListener = authListenerData.data

  // Wait a bit for Supabase to process any hash fragments
  await new Promise(resolve => setTimeout(resolve, 500))

  // Check if there's a recovery token in the URL
  // Supabase typically puts it in the hash fragment (#access_token=...&type=recovery)
  // but it can also be in query params (?token=...&type=recovery)
  const hashParams = new URLSearchParams(window.location.hash.substring(1))
  const queryParams = new URLSearchParams(window.location.search)
  
  const accessToken = hashParams.get('access_token') || queryParams.get('access_token') || queryParams.get('token')
  const type = hashParams.get('type') || queryParams.get('type')
  
  // If no token is found in URL, check if we have a valid session
  // (Supabase might have already processed the token)
  if (!accessToken || type !== 'recovery') {
    // Check if we have a session (token might have been processed already)
    const { data: sessionData } = await supabase.auth.getSession()
    
    if (!sessionData.session) {
      isError.value = true
      errorMessage.value = 'Invalid or missing password reset token. Please request a new password reset link.'
      authStateListener?.subscription.unsubscribe()
      return
    }
    // If we have a session, the token was processed - allow password reset
    isValidToken.value = true
    isPasswordResetMode.value = true
    
    // Check if user has MFA enabled
    await checkMFAStatus()
    
    // Router guard will handle preventing navigation
    return
  }

  // Token found in URL - Supabase should process it automatically
  // Wait a moment for Supabase to process the hash fragment
  await new Promise(resolve => setTimeout(resolve, 1000))
  
  // Verify we have a valid session (token was processed)
  try {
    const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
    
    // If we have a session, the token was processed successfully
    if (sessionError || !sessionData.session) {
      isError.value = true
      errorMessage.value = 'This password reset link is invalid or has expired. Please request a new one.'
      authStateListener?.subscription.unsubscribe()
    } else {
      isValidToken.value = true
      isPasswordResetMode.value = true
      
      // Check if user has MFA enabled
      await checkMFAStatus()
      
      // Router guard will handle preventing navigation
    }
  } catch (error: any) {
    debug.error('Error checking recovery token:', error)
    isError.value = true
    errorMessage.value = 'Failed to verify password reset link. Please try again.'
    authStateListener?.subscription.unsubscribe()
  }
})

// Cleanup auth listener on unmount
onBeforeUnmount(() => {
  if (authStateListener) {
    authStateListener.subscription.unsubscribe()
    authStateListener = null
  }
})


// Validate password
const validatePassword = (): boolean => {
  passwordError.value = ''
  
  if (!newPassword.value) {
    passwordError.value = 'Password is required'
    return false
  }
  
  if (newPassword.value.length < 6) {
    passwordError.value = 'Password must be at least 6 characters'
    return false
  }
  
  return true
}

// Validate confirm password
const validateConfirmPassword = (): boolean => {
  confirmPasswordError.value = ''
  
  if (!confirmPassword.value) {
    confirmPasswordError.value = 'Please confirm your password'
    return false
  }
  
  if (newPassword.value !== confirmPassword.value) {
    confirmPasswordError.value = 'Passwords do not match'
    return false
  }
  
  return true
}

// Handle password reset
const handleResetPassword = async () => {
  // Clear previous errors
  passwordError.value = ''
  confirmPasswordError.value = ''
  
  // Validate
  if (!validatePassword() || !validateConfirmPassword()) {
    return
  }
  
  // If user has MFA enabled, show MFA modal instead of proceeding directly
  if (requiresMFA.value) {
    debug.log('🔒 User has MFA - showing 2FA verification modal')
    
    // Create MFA challenge
    try {
      const { data: challengeData, error: challengeError } = await supabase.auth.mfa.challenge({
        factorId: mfaFactorId.value
      })
      
      if (challengeError) {
        debug.error('MFA challenge error:', challengeError)
        passwordError.value = 'Failed to create MFA challenge. Please try again.'
        return
      }
      
      mfaChallengeId.value = challengeData.id
      showMFAModal.value = true
    } catch (error: any) {
      debug.error('MFA challenge error:', error)
      passwordError.value = 'Failed to create MFA challenge. Please try again.'
    }
    return
  }
  
  // No MFA required, proceed with password reset
  await performPasswordReset()
}

// Perform the actual password reset
const performPasswordReset = async () => {
  isLoading.value = true
  
  try {
    // Supabase will automatically use the recovery token from the URL
    // when calling updateUser with a password
    const { data, error } = await supabase.auth.updateUser({
      password: newPassword.value
    })
    
    if (error) {
      debug.error('Password reset error:', error)
      
      // Handle specific error cases
      if (error.message.includes('expired') || error.message.includes('invalid')) {
        isError.value = true
        errorMessage.value = 'This password reset link has expired. Please request a new one.'
      } else if (error.message.includes('Password should be at least')) {
        passwordError.value = error.message
      } else if (error.message.includes('AAL2') || error.message.includes('aal2')) {
        // User needs AAL2 - this shouldn't happen if we handled MFA correctly
        passwordError.value = 'Multi-factor authentication is required. Please verify your 2FA code.'
      } else {
        passwordError.value = error.message || 'Failed to reset password'
      }
      return
    }
    
    // Success!
    debug.log('✅ Password reset successful:', data)
    isSuccess.value = true
    isPasswordResetMode.value = false
    
    // Clear password reset mode in auth store
    authStore.clearPasswordResetMode()
    
    // Sign out the recovery session - user needs to log in with new password
    await supabase.auth.signOut()
    authStore.session = null
    
    toast.success('Password reset successful! Please log in with your new password.')
    
    // Redirect to login after a short delay
    setTimeout(() => {
      router.push('/login')
    }, 3000)
  } catch (error: any) {
    debug.error('Password reset error:', error)
    passwordError.value = error.message || 'Failed to reset password. Please try again.'
  } finally {
    isLoading.value = false
  }
}

// Navigate to login
const goToLogin = async () => {
  // If we're in password reset mode, sign out and clear the flag
  if (isPasswordResetMode.value && !isSuccess.value) {
    await supabase.auth.signOut()
    authStore.session = null
    authStore.clearPasswordResetMode()
  }
  router.push('/login')
}

// Handle MFA verification
const handleMFAVerification = async () => {
  const expectedLength = useRecoveryCode.value ? 8 : 6
  if (mfaCode.value.length !== expectedLength) {
    mfaError.value = `Please enter a ${expectedLength}-${useRecoveryCode.value ? 'character' : 'digit'} code`
    return
  }

  debug.log('🔐 Starting MFA verification for password reset...')
  mfaLoading.value = true
  mfaError.value = ''

  try {
    if (useRecoveryCode.value) {
      // Verify recovery code
      debug.log('📞 Verifying recovery code...')
      
      const { data: sessionData } = await supabase.auth.getSession()
      const userId = sessionData.session?.user?.id
      
      if (!userId) {
        throw new Error('User session not found')
      }

      const { data: isValid, error } = await supabase.rpc('verify_recovery_code', {
        p_user_id: userId,
        p_code: mfaCode.value
      })

      if (error) throw error

      if (!isValid) {
        throw new Error('Invalid or already used recovery code')
      }

      debug.log('✅ Recovery code verified successfully!')
      
      // Unenroll the TOTP factor since they lost access to their authenticator
      await supabase.auth.mfa.unenroll({ factorId: mfaFactorId.value })
      
      // They no longer have MFA, so we can proceed with password reset
      requiresMFA.value = false
      showMFAModal.value = false
      mfaCode.value = ''
      
      // Now proceed with password reset
      await performPasswordReset()
      
      toast.warning('2FA has been disabled. Please re-enable it after logging in with your new password.')
    } else {
      // Verify TOTP code
      debug.log('📞 Verifying TOTP code...')
      
      const { error: verifyError } = await supabase.auth.mfa.verify({
        factorId: mfaFactorId.value,
        challengeId: mfaChallengeId.value,
        code: mfaCode.value
      })

      if (verifyError) throw verifyError

      debug.log('✅ MFA verified - session upgraded to AAL2')
      
      // Close modal and proceed with password reset
      showMFAModal.value = false
      mfaCode.value = ''
      
      // Now proceed with password reset (session is now AAL2)
      await performPasswordReset()
    }
  } catch (error: any) {
    debug.error('❌ MFA verification error:', error)
    mfaError.value = error.message || 'Invalid code. Please try again.'
  } finally {
    mfaLoading.value = false
  }
}

// Close MFA modal
const closeMFAModal = () => {
  showMFAModal.value = false
  mfaCode.value = ''
  mfaError.value = ''
  useRecoveryCode.value = false
}

// Toggle between TOTP and recovery code
const toggleRecoveryCode = () => {
  useRecoveryCode.value = !useRecoveryCode.value
  mfaCode.value = ''
  mfaError.value = ''
}
</script>

<style scoped>
.reset-password-wrapper {
  min-height: 100vh;
  background: var(--random-bg) center center;
  background-size: cover;
  background-attachment: fixed;
  position: relative;
  font-family: var(--font-family);
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
  background: linear-gradient(45deg, #0EA5E9, #38BDF8);
  border-radius: 50%;
  opacity: 0.6;
  animation: float var(--duration) ease-in-out infinite var(--delay);
}

@keyframes float {
  0%, 100% { transform: translateY(0px) rotate(0deg); opacity: 0.6; }
  50% { transform: translateY(-20px) rotate(180deg); opacity: 1; }
}

.reset-password-container {
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
  transition: transform 0.3s ease;
}

.brand-logo {
  width: 120px;
  height: 120px;
  position: relative;
  z-index: 2;
  filter: drop-shadow(0 10px 30px rgba(14, 165, 233, 0.3));
}

.logo-glow {
  position: absolute;
  inset: -20px;
  background: radial-gradient(circle, rgba(14, 165, 233, 0.4) 0%, transparent 70%);
  border-radius: 50%;
  animation: pulse 3s ease-in-out infinite;
  z-index: 1;
}

@keyframes pulse {
  0%, 100% { opacity: 0.4; transform: scale(1); }
  50% { opacity: 0.6; transform: scale(1.1); }
}

.brand-title {
  font-size: 3rem;
  font-weight: 700;
  margin-bottom: 16px;
  background: linear-gradient(135deg, #0EA5E9 0%, #38BDF8 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.harmony-logo {
  display: inline-block;
}

.brand-subtitle {
  font-size: 1.1rem;
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.6;
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
  max-width: 450px;
  background: rgba(30, 30, 30, 0.95);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  padding: 40px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.form-header {
  text-align: center;
  margin-bottom: 32px;
}

.form-title {
  font-size: 1.75rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-subtitle {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.5;
}

.auth-form {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.input-group {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.input-label {
  font-size: 0.875rem;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.input-container {
  position: relative;
  display: flex;
  align-items: center;
}

.form-input {
  width: 100%;
  padding: 12px 16px;
  padding-right: 48px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 1rem;
  transition: all 0.2s ease;
}

.form-input:focus {
  outline: none;
  border-color: #0EA5E9;
  background: rgba(0, 0, 0, 0.5);
}

.form-input.error {
  border-color: #ed4245;
}

.form-input::placeholder {
  color: rgba(255, 255, 255, 0.4);
}

.password-toggle {
  position: absolute;
  right: 12px;
  background: none;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  padding: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.2s ease;
}

.password-toggle:hover {
  color: rgba(255, 255, 255, 0.9);
}

.error-message {
  font-size: 0.875rem;
  color: #ed4245;
}

.submit-btn {
  width: 100%;
  padding: 14px 24px;
  background: linear-gradient(135deg, #0EA5E9 0%, #38BDF8 100%);
  border: none;
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 1rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
  margin-top: 8px;
}

.submit-btn:hover:not(:disabled) {
  transform: translateY(-2px);
  box-shadow: 0 8px 20px rgba(14, 165, 233, 0.4);
}

.submit-btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.submit-btn.loading {
  pointer-events: none;
}

.loading-spinner {
  width: 20px;
  height: 20px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  margin: 0 auto;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.divider {
  text-align: center;
  margin: 20px 0;
  position: relative;
  color: rgba(255, 255, 255, 0.5);
  font-size: 0.875rem;
}

.switch-mode-btn {
  width: 100%;
  padding: 12px 24px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.switch-mode-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.3);
}

.success-state,
.error-state {
  text-align: center;
  padding: 20px 0;
}

.success-icon,
.error-icon {
  margin: 0 auto 24px;
  width: 64px;
  height: 64px;
}

.success-icon svg,
.error-icon svg {
  width: 100%;
  height: 100%;
}

.loading-state {
  text-align: center;
  padding: 40px 20px;
}

.loading-spinner.large {
  width: 48px;
  height: 48px;
  border-width: 3px;
  margin: 0 auto 20px;
}

@media (max-width: 768px) {
  .reset-password-container {
    flex-direction: column;
  }
  
  .auth-branding {
    padding: 20px;
  }
  
  .brand-title {
    font-size: 2rem;
  }
  
  .auth-panel {
    padding: 20px;
  }
  
  .auth-form-container {
    padding: 30px 20px;
  }
}

/* MFA Modal Styles */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal-content {
  background: rgba(30, 30, 30, 0.98);
  backdrop-filter: blur(20px);
  border-radius: 16px;
  padding: 32px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
  position: relative;
  animation: slideUp 0.3s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(20px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.modal-close {
  position: absolute;
  top: 16px;
  right: 16px;
  background: transparent;
  border: none;
  color: rgba(255, 255, 255, 0.6);
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  transition: all 0.2s ease;
}

.modal-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.9);
}

.modal-header {
  text-align: center;
  margin-bottom: 24px;
}

.modal-icon {
  margin: 0 auto 16px;
  width: 48px;
  height: 48px;
}

.modal-title {
  font-size: 1.5rem;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 8px;
}

.modal-subtitle {
  font-size: 0.95rem;
  color: rgba(255, 255, 255, 0.6);
  line-height: 1.5;
}

.modal-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.cancel-btn {
  width: 100%;
  padding: 12px 24px;
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 8px;
  color: rgba(255, 255, 255, 0.9);
  font-size: 0.95rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.cancel-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.3);
}

@media (max-width: 480px) {
  .modal-content {
    padding: 24px;
  }
}
</style>

