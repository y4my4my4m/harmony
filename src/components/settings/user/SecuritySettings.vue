<template>
  <div class="security-settings">
    <div class="settings-header">
      <h2 class="settings-title">Security</h2>
      <p class="settings-description">
        Manage your account security and authentication settings.
      </p>
    </div>

    <!-- Password Change Section -->
    <div class="settings-section">
      <h3 class="section-title">Change Password</h3>
      <p class="section-description">
        Update your password to keep your account secure. You'll need to enter your current password to confirm this change.
      </p>
      
      <form @submit.prevent="handlePasswordChange" class="password-form">
        <div class="form-group">
          <label class="form-label">Current Password</label>
          <div class="password-input-wrapper">
            <input
              v-model="passwordForm.currentPassword"
              :type="showCurrentPassword ? 'text' : 'password'"
              class="form-input"
              :class="{ 'error': passwordErrors.currentPassword }"
              placeholder="Enter your current password"
              autocomplete="current-password"
              @input="clearError('currentPassword')"
            />
            <button 
              type="button" 
              class="toggle-password-btn"
              @click="showCurrentPassword = !showCurrentPassword"
              tabindex="-1"
            >
              <EyeIcon v-if="!showCurrentPassword" />
              <EyeOffIcon v-else />
            </button>
          </div>
          <span v-if="passwordErrors.currentPassword" class="error-message">
            {{ passwordErrors.currentPassword }}
          </span>
        </div>

        <div class="form-group">
          <label class="form-label">New Password</label>
          <div class="password-input-wrapper">
            <input
              v-model="passwordForm.newPassword"
              :type="showNewPassword ? 'text' : 'password'"
              class="form-input"
              :class="{ 'error': passwordErrors.newPassword }"
              placeholder="Enter new password (min 6 characters)"
              autocomplete="new-password"
              @input="clearError('newPassword')"
            />
            <button 
              type="button" 
              class="toggle-password-btn"
              @click="showNewPassword = !showNewPassword"
              tabindex="-1"
            >
              <EyeIcon v-if="!showNewPassword" />
              <EyeOffIcon v-else />
            </button>
          </div>
          <span v-if="passwordErrors.newPassword" class="error-message">
            {{ passwordErrors.newPassword }}
          </span>
          <div class="form-hint" v-if="!passwordErrors.newPassword">
            Password must be at least 6 characters long
          </div>
        </div>

        <div class="form-group">
          <label class="form-label">Confirm New Password</label>
          <div class="password-input-wrapper">
            <input
              v-model="passwordForm.confirmPassword"
              :type="showConfirmPassword ? 'text' : 'password'"
              class="form-input"
              :class="{ 'error': passwordErrors.confirmPassword }"
              placeholder="Confirm your new password"
              autocomplete="new-password"
              @input="clearError('confirmPassword')"
            />
            <button 
              type="button" 
              class="toggle-password-btn"
              @click="showConfirmPassword = !showConfirmPassword"
              tabindex="-1"
            >
              <EyeIcon v-if="!showConfirmPassword" />
              <EyeOffIcon v-else />
            </button>
          </div>
          <span v-if="passwordErrors.confirmPassword" class="error-message">
            {{ passwordErrors.confirmPassword }}
          </span>
        </div>

        <div class="settings-actions">
          <button 
            type="submit" 
            class="btn btn-primary"
            :disabled="passwordLoading || !isPasswordFormValid"
          >
            <span v-if="!passwordLoading">Update Password</span>
            <div v-else class="loading-spinner"></div>
          </button>
        </div>
      </form>
    </div>

    <!-- Two-Factor Authentication Section -->
    <div class="settings-section">
      <h3 class="section-title">Two-Factor Authentication</h3>
      <p class="section-description">
        Add an extra layer of security to your account by requiring a verification code from your phone.
      </p>

      <!-- 2FA Not Enabled -->
      <div v-if="!twoFactorEnabled && !showEnroll2FA" class="twofa-status">
        <div class="status-badge status-disabled">
          <ShieldIcon />
          <span>Two-Factor Authentication is Disabled</span>
        </div>
        <p class="status-text">
          Secure your account with an authenticator app like Google Authenticator or Authy.
        </p>
        <button 
          class="btn btn-primary"
          @click="startEnroll2FA"
          :disabled="twoFactorLoading"
        >
          Enable Two-Factor Authentication
        </button>
      </div>

      <!-- 2FA Enrollment Flow -->
      <div v-if="showEnroll2FA" class="twofa-enroll">
        <div class="enroll-step" v-if="enrollStep === 1">
          <h4 class="step-title">Step 1: Scan QR Code</h4>
          <p class="step-description">
            Scan this QR code with your authenticator app.
          </p>
          <div class="qr-code-container">
            <div v-if="qrCodeLoading" class="qr-loading">
              <div class="loading-spinner"></div>
              <p>Generating QR code...</p>
            </div>
            <div v-else-if="qrCodeDataUrl" class="qr-code">
              <img :src="qrCodeDataUrl" alt="2FA QR Code" />
            </div>
          </div>
          <div class="secret-key">
            <p class="secret-label">Or enter this key manually:</p>
            <code class="secret-code">{{ totpSecret }}</code>
            <button 
              type="button"
              class="btn-copy"
              @click="copySecret"
              title="Copy secret key"
            >
              <CopyIcon />
            </button>
          </div>
          <button 
            class="btn btn-primary"
            @click="enrollStep = 2"
            :disabled="!totpSecret"
          >
            Next: Verify Code
          </button>
          <button 
            class="btn btn-secondary"
            @click="cancelEnroll2FA"
          >
            Cancel
          </button>
        </div>

        <div class="enroll-step" v-if="enrollStep === 2">
          <h4 class="step-title">Step 2: Verify Code</h4>
          <p class="step-description">
            Enter the 6-digit code from your authenticator app to confirm setup.
          </p>
          <form @submit.prevent="verifyAndEnable2FA">
            <div class="form-group">
              <label class="form-label">Verification Code</label>
              <input
                v-model="verificationCode"
                type="text"
                class="form-input code-input"
                :class="{ 'error': twoFactorError }"
                placeholder="000000"
                maxlength="6"
                pattern="[0-9]*"
                inputmode="numeric"
                autocomplete="one-time-code"
                @input="clearTwoFactorError"
              />
              <span v-if="twoFactorError" class="error-message">{{ twoFactorError }}</span>
            </div>
            <div class="settings-actions">
              <button 
                type="submit" 
                class="btn btn-primary"
                :disabled="twoFactorLoading || verificationCode.length !== 6"
              >
                <span v-if="!twoFactorLoading">Verify & Enable</span>
                <div v-else class="loading-spinner"></div>
              </button>
              <button 
                type="button"
                class="btn btn-secondary"
                @click="enrollStep = 1"
              >
                Back
              </button>
            </div>
          </form>
        </div>

        <!-- Recovery Codes Display -->
        <div class="enroll-step" v-if="enrollStep === 3">
          <h4 class="step-title">✅ Success! Save Your Recovery Codes</h4>
          <p class="step-description warning">
            <strong>Important:</strong> Save these recovery codes in a safe place. Each can be used once if you lose access to your authenticator app.
          </p>
          <div class="recovery-codes">
            <code v-for="(code, index) in recoveryCodes" :key="index" class="recovery-code">
              {{ code }}
            </code>
          </div>
          <div class="settings-actions">
            <button 
              class="btn btn-primary"
              @click="copyRecoveryCodes"
            >
              <CopyIcon />
              Copy All Codes
            </button>
            <button 
              class="btn btn-secondary"
              @click="finishEnroll2FA"
            >
              I've Saved These Codes
            </button>
          </div>
        </div>
      </div>

      <!-- 2FA Enabled -->
      <div v-if="twoFactorEnabled && !showEnroll2FA" class="twofa-status">
        <div class="status-badge status-enabled">
          <ShieldIcon />
          <span>Two-Factor Authentication is Enabled</span>
        </div>
        <p class="status-text">
          Your account is protected with two-factor authentication.
        </p>
        <button 
          class="btn btn-danger"
          @click="showDisable2FAModal = true"
          :disabled="twoFactorLoading"
        >
          Disable Two-Factor Authentication
        </button>
      </div>
    </div>

    <!-- Disable 2FA Confirmation Modal -->
    <div v-if="showDisable2FAModal" class="modal-overlay" @click="showDisable2FAModal = false">
      <div class="modal-content" @click.stop>
        <h3 class="modal-title">Disable Two-Factor Authentication?</h3>
        <p class="modal-description">
          This will make your account less secure. Enter your password to confirm.
        </p>
        <form @submit.prevent="disable2FA">
          <div class="form-group">
            <label class="form-label">Password</label>
            <input
              v-model="disable2FAPassword"
              type="password"
              class="form-input"
              placeholder="Enter your password"
              autocomplete="current-password"
            />
          </div>
          <div class="modal-actions">
            <button 
              type="submit"
              class="btn btn-danger"
              :disabled="twoFactorLoading || !disable2FAPassword"
            >
              <span v-if="!twoFactorLoading">Disable 2FA</span>
              <div v-else class="loading-spinner"></div>
            </button>
            <button 
              type="button"
              class="btn btn-secondary"
              @click="showDisable2FAModal = false"
            >
              Cancel
            </button>
          </div>
        </form>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import QRCode from 'qrcode'

// Icons
import EyeIcon from '@/components/icons/Eye.vue'
import EyeOffIcon from '@/components/icons/EyeOff.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import CopyIcon from '@/components/icons/Copy.vue'

// Props
interface Props {
  loading?: boolean
}

const props = defineProps<Props>()

// Composables
const authStore = useAuthStore()
const toast = useToast()

// Password Change State
const passwordForm = ref({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordErrors = ref({
  currentPassword: '',
  newPassword: '',
  confirmPassword: ''
})

const passwordLoading = ref(false)
const showCurrentPassword = ref(false)
const showNewPassword = ref(false)
const showConfirmPassword = ref(false)

// 2FA State
const twoFactorEnabled = ref(false)
const twoFactorLoading = ref(false)
const showEnroll2FA = ref(false)
const enrollStep = ref(1)
const qrCodeDataUrl = ref('')
const qrCodeLoading = ref(false)
const totpSecret = ref('')
const factorId = ref('')
const verificationCode = ref('')
const recoveryCodes = ref<string[]>([])
const twoFactorError = ref('')
const showDisable2FAModal = ref(false)
const disable2FAPassword = ref('')

// Computed
const isPasswordFormValid = computed(() => {
  return (
    passwordForm.value.currentPassword.length > 0 &&
    passwordForm.value.newPassword.length >= 6 &&
    passwordForm.value.confirmPassword.length >= 6 &&
    passwordForm.value.newPassword === passwordForm.value.confirmPassword
  )
})

// Methods
const clearError = (field: 'currentPassword' | 'newPassword' | 'confirmPassword') => {
  passwordErrors.value[field] = ''
}

const clearTwoFactorError = () => {
  twoFactorError.value = ''
}

const validatePasswordForm = (): boolean => {
  let isValid = true

  if (!passwordForm.value.currentPassword) {
    passwordErrors.value.currentPassword = 'Current password is required'
    isValid = false
  }

  if (!passwordForm.value.newPassword) {
    passwordErrors.value.newPassword = 'New password is required'
    isValid = false
  } else if (passwordForm.value.newPassword.length < 6) {
    passwordErrors.value.newPassword = 'Password must be at least 6 characters'
    isValid = false
  }

  if (!passwordForm.value.confirmPassword) {
    passwordErrors.value.confirmPassword = 'Please confirm your new password'
    isValid = false
  } else if (passwordForm.value.newPassword !== passwordForm.value.confirmPassword) {
    passwordErrors.value.confirmPassword = 'Passwords do not match'
    isValid = false
  }

  return isValid
}

const handlePasswordChange = async () => {
  if (!validatePasswordForm()) return

  passwordLoading.value = true

  try {
    // First, verify the current password by attempting to sign in
    const email = authStore.session?.user?.email
    if (!email) {
      throw new Error('User email not found')
    }

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: passwordForm.value.currentPassword
    })

    if (signInError) {
      passwordErrors.value.currentPassword = 'Current password is incorrect'
      return
    }

    // Update to new password
    const { error: updateError } = await supabase.auth.updateUser({
      password: passwordForm.value.newPassword
    })

    if (updateError) throw updateError

    toast.success('Password updated successfully')
    
    // Clear form
    passwordForm.value = {
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    }
  } catch (error: any) {
    console.error('Password change error:', error)
    toast.error(error.message || 'Failed to update password')
  } finally {
    passwordLoading.value = false
  }
}

const check2FAStatus = async () => {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) throw error

    // Check if TOTP factor is verified
    const totpFactor = data?.totp?.find((f: any) => f.status === 'verified')
    twoFactorEnabled.value = !!totpFactor
    
    if (totpFactor) {
      factorId.value = totpFactor.id
    }
  } catch (error: any) {
    console.error('2FA status check error:', error)
  }
}

const startEnroll2FA = async () => {
  twoFactorLoading.value = true
  qrCodeLoading.value = true
  showEnroll2FA.value = true
  enrollStep.value = 1

  try {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Harmony Authenticator'
    })

    if (error) throw error

    totpSecret.value = data.totp.secret
    factorId.value = data.id

    // Generate QR code
    const otpauthUrl = data.totp.uri
    qrCodeDataUrl.value = await QRCode.toDataURL(otpauthUrl, {
      width: 256,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#ffffff'
      }
    })
  } catch (error: any) {
    console.error('2FA enrollment error:', error)
    toast.error('Failed to start 2FA enrollment')
    showEnroll2FA.value = false
  } finally {
    twoFactorLoading.value = false
    qrCodeLoading.value = false
  }
}

const verifyAndEnable2FA = async () => {
  if (verificationCode.value.length !== 6) {
    twoFactorError.value = 'Please enter a 6-digit code'
    return
  }

  twoFactorLoading.value = true
  twoFactorError.value = ''

  try {
    const { data, error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factorId.value,
      code: verificationCode.value
    })

    if (error) throw error

    // Generate recovery codes (10 random codes)
    recoveryCodes.value = Array.from({ length: 10 }, () => 
      Math.random().toString(36).substring(2, 10).toUpperCase()
    )

    enrollStep.value = 3
    toast.success('Two-Factor Authentication enabled!')
  } catch (error: any) {
    console.error('2FA verification error:', error)
    twoFactorError.value = 'Invalid verification code'
  } finally {
    twoFactorLoading.value = false
  }
}

const finishEnroll2FA = async () => {
  showEnroll2FA.value = false
  await check2FAStatus()
  enrollStep.value = 1
  verificationCode.value = ''
  qrCodeDataUrl.value = ''
  totpSecret.value = ''
  recoveryCodes.value = []
}

const cancelEnroll2FA = async () => {
  // Clean up enrollment
  if (factorId.value) {
    try {
      await supabase.auth.mfa.unenroll({ factorId: factorId.value })
    } catch (error) {
      console.error('Error canceling 2FA enrollment:', error)
    }
  }

  showEnroll2FA.value = false
  enrollStep.value = 1
  verificationCode.value = ''
  qrCodeDataUrl.value = ''
  totpSecret.value = ''
  factorId.value = ''
}

const disable2FA = async () => {
  if (!disable2FAPassword.value) return

  twoFactorLoading.value = true

  try {
    // Verify password
    const email = authStore.session?.user?.email
    if (!email) throw new Error('User email not found')

    const { error: signInError } = await supabase.auth.signInWithPassword({
      email,
      password: disable2FAPassword.value
    })

    if (signInError) {
      toast.error('Incorrect password')
      return
    }

    // Disable 2FA
    const { error } = await supabase.auth.mfa.unenroll({
      factorId: factorId.value
    })

    if (error) throw error

    toast.success('Two-Factor Authentication disabled')
    showDisable2FAModal.value = false
    disable2FAPassword.value = ''
    await check2FAStatus()
  } catch (error: any) {
    console.error('2FA disable error:', error)
    toast.error('Failed to disable 2FA')
  } finally {
    twoFactorLoading.value = false
  }
}

const copySecret = async () => {
  try {
    await navigator.clipboard.writeText(totpSecret.value)
    toast.success('Secret key copied to clipboard')
  } catch (error) {
    console.error('Copy error:', error)
    toast.error('Failed to copy secret key')
  }
}

const copyRecoveryCodes = async () => {
  try {
    const codesText = recoveryCodes.value.join('\n')
    await navigator.clipboard.writeText(codesText)
    toast.success('Recovery codes copied to clipboard')
  } catch (error) {
    console.error('Copy error:', error)
    toast.error('Failed to copy recovery codes')
  }
}

// Lifecycle
onMounted(() => {
  check2FAStatus()
})
</script>

<style scoped>
.security-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--h-chat);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
}

.section-description.warning {
  color: #faa61a;
}

.password-form {
  margin-top: 20px;
}

.form-group {
  margin-bottom: 20px;
}

.form-label {
  display: block;
  font-size: 14px;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.password-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.form-input {
  width: 100%;
  padding: 12px;
  padding-right: 44px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: #ffffff;
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: #5865f2;
}

.form-input.error {
  border-color: #ed4245;
}

.form-input.code-input {
  font-size: 24px;
  letter-spacing: 0.5em;
  text-align: center;
  font-family: 'Courier New', monospace;
}

.toggle-password-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
}

.toggle-password-btn:hover {
  color: #ffffff;
}

.toggle-password-btn svg {
  width: 20px;
  height: 20px;
}

.error-message {
  display: block;
  color: #ed4245;
  font-size: 12px;
  margin-top: 6px;
}

.form-hint {
  font-size: 12px;
  color: #72767d;
  margin-top: 6px;
}

.settings-actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.btn {
  padding: 10px 20px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
  justify-content: center;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #5865f2;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.btn-danger {
  background-color: #ed4245;
  color: #ffffff;
}

.btn-danger:hover:not(:disabled) {
  background-color: #c03537;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* 2FA Styles */
.twofa-status {
  margin-top: 16px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  border-radius: 4px;
  font-size: 14px;
  font-weight: 500;
  margin-bottom: 12px;
}

.status-badge svg {
  width: 20px;
  height: 20px;
}

.status-enabled {
  background-color: rgba(67, 181, 129, 0.1);
  color: #43b581;
  border: 1px solid rgba(67, 181, 129, 0.3);
}

.status-disabled {
  background-color: rgba(240, 71, 71, 0.1);
  color: #f04747;
  border: 1px solid rgba(240, 71, 71, 0.3);
}

.status-text {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 16px 0;
}

.twofa-enroll {
  margin-top: 20px;
}

.enroll-step {
  padding: 20px;
  background-color: var(--h-chat-darker);
  border-radius: 8px;
  border: 1px solid var(--h-chat-light);
}

.step-title {
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 8px 0;
}

.step-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
}

.qr-code-container {
  display: flex;
  justify-content: center;
  padding: 20px;
  background-color: #ffffff;
  border-radius: 8px;
  margin-bottom: 20px;
}

.qr-loading,
.qr-code {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
}

.qr-code img {
  max-width: 256px;
  height: auto;
}

.secret-key {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background-color: var(--h-chat);
  border-radius: 4px;
  margin-bottom: 20px;
}

.secret-label {
  font-size: 12px;
  color: #b9bbbe;
  margin: 0;
  flex-shrink: 0;
}

.secret-code {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 14px;
  color: #ffffff;
  background-color: var(--h-chat-darker);
  padding: 8px 12px;
  border-radius: 4px;
  word-break: break-all;
}

.btn-copy {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 8px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
  flex-shrink: 0;
}

.btn-copy:hover {
  color: #ffffff;
}

.btn-copy svg {
  width: 20px;
  height: 20px;
}

.recovery-codes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
  margin-bottom: 20px;
}

.recovery-code {
  font-family: 'Courier New', monospace;
  font-size: 14px;
  color: #ffffff;
  background-color: var(--h-chat);
  padding: 12px;
  border-radius: 4px;
  text-align: center;
  border: 1px solid var(--h-chat-light);
}

/* Modal */
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-content {
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  max-width: 440px;
  width: 90%;
  border: 1px solid var(--h-chat-light);
}

.modal-title {
  font-size: 20px;
  font-weight: 600;
  color: #ffffff;
  margin: 0 0 12px 0;
}

.modal-description {
  font-size: 14px;
  color: #b9bbbe;
  margin: 0 0 20px 0;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 20px;
}

@media (max-width: 768px) {
  .recovery-codes {
    grid-template-columns: 1fr;
  }

  .secret-key {
    flex-direction: column;
    align-items: stretch;
  }

  .btn-copy {
    align-self: center;
  }
}
</style>

