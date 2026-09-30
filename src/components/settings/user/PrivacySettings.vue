<template>
  <div class="privacy-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.privacy') }}</h2>
      <p class="settings-description">
        Control who can interact with you, manage your account security, and control how your data is used.
      </p>
    </div>

    <!-- Security Section -->
    <div class="settings-section security-section">
      <h3 class="section-title">
        <ShieldIcon class="section-icon" />
        Account security
      </h3>
      
      <!-- Password Change -->
      <div class="subsection">
        <h4 class="subsection-title">{{ $t('auth.changePassword') }}</h4>
        <p class="subsection-description">
          Update your password to keep your account secure. You'll need to enter your current password to confirm this change.
        </p>
        
        <form @submit.prevent="handlePasswordChange" class="password-form" autocomplete="off">
          <div class="form-group">
            <label class="form-label">{{ $t('auth.currentPassword') }}</label>
            <div class="password-input-wrapper">
              <input
                v-model="passwordForm.currentPassword"
                :type="showCurrentPassword ? 'text' : 'password'"
                class="form-input"
                :class="{ 'error': passwordErrors.currentPassword }"
                :placeholder="$t('auth.currentPassword')"
                name="current-password-change"
                autocomplete="current-password"
                @input="clearPasswordError('currentPassword')"
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
            <label class="form-label">{{ $t('auth.newPassword') }}</label>
            <div class="password-input-wrapper">
              <input
                v-model="passwordForm.newPassword"
                :type="showNewPassword ? 'text' : 'password'"
                class="form-input"
                :class="{ 'error': passwordErrors.newPassword }"
                :placeholder="$t('auth.newPassword')"
                name="new-password-change"
                autocomplete="new-password"
                @input="clearPasswordError('newPassword')"
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
          </div>

          <div class="form-group">
            <label class="form-label">{{ $t('auth.confirmNewPassword') }}</label>
            <div class="password-input-wrapper">
              <input
                v-model="passwordForm.confirmPassword"
                :type="showConfirmPassword ? 'text' : 'password'"
                class="form-input"
                :class="{ 'error': passwordErrors.confirmPassword }"
                :placeholder="$t('auth.confirmNewPassword')"
                name="confirm-password-change"
                autocomplete="new-password"
                @input="clearPasswordError('confirmPassword')"
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

          <button 
            type="submit" 
            class="btn btn-primary"
            :disabled="passwordLoading || !isPasswordFormValid"
          >
            <span v-if="!passwordLoading">Update password</span>
            <div v-else class="loading-spinner"></div>
          </button>
        </form>
      </div>

      <!-- Two-Factor Authentication -->
      <div class="subsection">
        <h4 class="subsection-title">Two-factor authentication</h4>
        <p class="subsection-description">
          Add an extra layer of security to your account by requiring a verification code from your phone.
        </p>

        <!-- 2FA Not Enabled -->
        <div v-if="!twoFactorEnabled && !showEnroll2FA" class="twofa-status">
          <div class="status-badge status-disabled">
            <ShieldIcon />
            <span>Two-factor authentication is disabled</span>
          </div>
          <p class="status-text">
            Secure your account with an authenticator app like Google Authenticator or Authy.
          </p>
          <button 
            class="btn btn-primary btn-sm"
            @click="startEnroll2FA"
            :disabled="twoFactorLoading"
          >
            Enable two-factor authentication
          </button>
        </div>

        <!-- 2FA Enrollment Flow -->
        <div v-if="showEnroll2FA" class="twofa-enroll">
          <div class="enroll-step" v-if="enrollStep === 1">
            <h5 class="step-title">Step 1: Scan QR Code</h5>
            <p class="step-description">
              Scan this QR code with your authenticator app.
            </p>
            <div class="qr-code-container">
              <div v-if="qrCodeLoading" class="qr-loading">
                <LoadingSpinner :size="24" />
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
            <div class="step-actions">
              <button 
                class="btn btn-primary btn-sm"
                @click="enrollStep = 2"
                :disabled="!totpSecret"
              >
                Next: Verify Code
              </button>
              <button 
                class="btn btn-secondary btn-sm"
                @click="cancelEnroll2FA"
              >
                Cancel
              </button>
            </div>
          </div>

          <div class="enroll-step" v-if="enrollStep === 2">
            <h5 class="step-title">Step 2: Verify Code</h5>
            <p class="step-description">
              Enter the 6-digit code from your authenticator app to confirm setup.
            </p>
            <form @submit.prevent="verifyAndEnable2FA">
              <div class="form-group">
                <label class="form-label">Verification code</label>
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
              <div class="step-actions">
                <button 
                  type="submit" 
                  class="btn btn-primary btn-sm"
                  :disabled="twoFactorLoading || verificationCode.length !== 6"
                >
                  <span v-if="!twoFactorLoading">Verify & enable</span>
                  <div v-else class="loading-spinner"></div>
                </button>
                <button 
                  type="button"
                  class="btn btn-secondary btn-sm"
                  @click="enrollStep = 1"
                >
                  Back
                </button>
              </div>
            </form>
          </div>

          <!-- Recovery Codes Display -->
          <div class="enroll-step" v-if="enrollStep === 3">
            <h5 class="step-title">Save your recovery codes</h5>
            <p class="step-description warning">
              <strong>Important:</strong> Save these recovery codes in a safe place. Each can be used once if you lose access to your authenticator app.
            </p>
            <div class="recovery-codes">
              <code v-for="(code, index) in recoveryCodes" :key="index" class="recovery-code">
                {{ code }}
              </code>
            </div>
            <div class="step-actions">
              <button 
                class="btn btn-primary btn-sm"
                @click="copyRecoveryCodes"
              >
                <CopyIcon />
                Copy all codes
              </button>
              <button 
                class="btn btn-secondary btn-sm"
                @click="finishEnroll2FA"
              >
                I've saved these codes
              </button>
            </div>
          </div>
        </div>

        <!-- 2FA Enabled -->
        <div v-if="twoFactorEnabled && !showEnroll2FA" class="twofa-status">
          <div class="status-badge status-enabled">
            <ShieldIcon />
            <span>Two-factor authentication is enabled</span>
          </div>
          <p class="status-text">
            Your account is protected with two-factor authentication.
          </p>
          <button 
            class="btn btn-danger btn-sm"
            @click="showDisable2FAModal = true"
            :disabled="twoFactorLoading"
          >
            Disable two-factor authentication
          </button>
        </div>
      </div>
    </div>

    <!-- Encryption Settings -->
    <div class="settings-section security-section">
      <h3 class="section-title">
        <ShieldIcon class="section-icon" />
        Encryption settings
      </h3>
      <EncryptionSettings :loading="loading" />
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data & privacy</h3>
      
      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Strip tracking parameters from URLs</h4>
          <p class="setting-description">
            Automatically remove tracking parameters (like ?si=...) from URLs in your messages for YouTube, X/Twitter, TikTok, Instagram, and Facebook.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.stripUrlTrackers"
            @change="onUrlStripChange"
          />
        </div>
      </div>

    </div>

    <div class="settings-section">
      <h3 class="section-title">Blocked users</h3>
      
      <div v-if="blockedUsers.length === 0" class="empty-state">
        <p>You haven't blocked anyone yet.</p>
      </div>
      
      <div v-else class="blocked-users-list">
        <div 
          v-for="user in blockedUsers" 
          :key="user.id"
          class="blocked-user-item"
        >
          <div class="user-info">
            <Avatar :src="user.avatar_url" size="sm" class="user-avatar" />
            <div class="user-details">
              <span class="user-name">{{ user.display_name }}</span>
              <span class="user-username">{{ user.username }}</span>
            </div>
          </div>
          <button 
            class="unblock-btn"
            @click="unblockUser(user.id)"
          >
            Unblock
          </button>
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Muted users</h3>
      
      <div v-if="mutedUsers.length === 0" class="empty-state">
        <p>You haven't muted anyone yet.</p>
      </div>
      
      <div v-else class="blocked-users-list">
        <div 
          v-for="user in mutedUsers" 
          :key="user.id"
          class="blocked-user-item"
        >
          <div class="user-info">
            <Avatar :src="user.avatar_url" size="sm" class="user-avatar" />
            <div class="user-details">
              <span class="user-name">{{ user.display_name }}</span>
              <span class="user-username">{{ user.username }}</span>
            </div>
          </div>
          <button 
            class="unblock-btn"
            @click="unmuteUser(user.id)"
          >
            Unmute
          </button>
        </div>
      </div>
    </div>

    <div class="settings-actions">
      <button 
        class="btn btn-primary" 
        @click="saveSettings"
        :disabled="loading || !hasChanges"
      >
        <span v-if="loading" class="loading-spinner"></span>
        Save changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>

    <!-- Disable 2FA Confirmation Modal.
         Takes the current TOTP code or a recovery code. Verifying via
         `mfa.challengeAndVerify` upgrades the session to AAL2, which
         Supabase requires before `mfa.unenroll` is accepted. -->
    <div v-if="showDisable2FAModal" class="modal-overlay" @click="closeDisable2FAModal">
      <div class="modal-content" @click.stop>
        <h3 class="modal-title">Disable two-factor authentication?</h3>
        <p class="modal-description">
          This will make your account less secure. Enter your
          {{ useDisableRecoveryCode ? 'recovery code' : '6-digit authenticator code' }}
          to confirm.
        </p>
        <form @submit.prevent="disable2FA">
          <div class="form-group">
            <label class="form-label">
              {{ useDisableRecoveryCode ? 'Recovery code' : 'Authenticator code' }}
            </label>
            <input
              v-model="disable2FACode"
              :type="useDisableRecoveryCode ? 'text' : 'tel'"
              :inputmode="useDisableRecoveryCode ? 'text' : 'numeric'"
              class="form-input"
              :placeholder="useDisableRecoveryCode ? RECOVERY_CODE_PLACEHOLDER : '123456'"
              :maxlength="useDisableRecoveryCode ? RECOVERY_CODE_MAX_LENGTH : 6"
              :pattern="useDisableRecoveryCode ? undefined : '[0-9]*'"
              autocomplete="one-time-code"
              @input="onDisable2FACodeInput"
            />
            <p v-if="disable2FAError" class="form-error">{{ disable2FAError }}</p>
          </div>
          <button
            type="button"
            class="link-button"
            @click="toggleDisableRecoveryCodeMode"
          >
            {{ useDisableRecoveryCode ? 'Use authenticator code instead' : 'Use a recovery code instead' }}
          </button>
          <div class="modal-actions">
            <button 
              type="submit"
              class="btn btn-danger"
              :disabled="twoFactorLoading || !isDisable2FACodeValid"
            >
              <span v-if="!twoFactorLoading">Disable 2FA</span>
              <div v-else class="loading-spinner"></div>
            </button>
            <button 
              type="button"
              class="btn btn-secondary"
              @click="closeDisable2FAModal"
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
import { authErrorMessage } from '@/utils/authErrorMessage'
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import type { User } from '@/types'
import { useAuthStore } from '@/stores/auth'
import { useActivityPubStore } from '@/stores/useActivityPub'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import QRCode from 'qrcode'
import { isUrlTrackingStrippingEnabled, setUrlTrackingStrippingEnabled } from '@/utils/urlTrackerStripper'

// Components
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import EyeIcon from '@/components/icons/Eye.vue'
import EyeOffIcon from '@/components/icons/EyeOff.vue'
import CopyIcon from '@/components/icons/Copy.vue'
import EncryptionSettings from '@/components/encryption/EncryptionSettings.vue'
import { RECOVERY_CODE_MIN_LENGTH, RECOVERY_CODE_MAX_LENGTH, RECOVERY_CODE_PLACEHOLDER } from '@/utils/mfaConstants'

// Props
interface Props {
  profile: User | null
  loading: boolean
}

const props = defineProps<Props>()

// Emits
const emit = defineEmits<{
  'update-privacy': [settings: any]
}>()

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
// Authorizes the unenroll: 6 digits for TOTP, 8 chars for a recovery code.
// `useDisableRecoveryCode` selects which form is expected.
const disable2FACode = ref('')
const useDisableRecoveryCode = ref(false)
const disable2FAError = ref('')

const isDisable2FACodeValid = computed(() => {
  if (useDisableRecoveryCode.value) {
    return disable2FACode.value.trim().length >= RECOVERY_CODE_MIN_LENGTH
  }
  return /^\d{6}$/.test(disable2FACode.value)
})

// Privacy State
const settings = ref({
  stripUrlTrackers: true,
})

const originalSettings = ref({ ...settings.value })
const blockedUsers = ref<User[]>([])
const mutedUsers = ref<User[]>([])
const activityPubStore = useActivityPubStore()
let blocksMutesLastFetchedAt = 0
const CACHE_TTL_MS = 30000

// Computed
const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

// Methods
// eslint-disable-next-line unused-imports/no-unused-vars
const onSettingChange = () => {
  // Empty: the template binds it to enable the save button via hasChanges.
}

// The URL-tracker flag lives in localStorage and is read by the message-send
// pipeline (`unifiedContentProcessing.ts`) on every send. Applied on toggle
// rather than on Save Changes so the next message reflects it.
const onUrlStripChange = () => {
  setUrlTrackingStrippingEnabled(settings.value.stripUrlTrackers)
  originalSettings.value.stripUrlTrackers = settings.value.stripUrlTrackers
}

const saveSettings = () => {
  setUrlTrackingStrippingEnabled(settings.value.stripUrlTrackers)
  
  emit('update-privacy', settings.value)
  originalSettings.value = { ...settings.value }
}

const resetSettings = () => {
  settings.value = { ...originalSettings.value }
}

const unblockUser = async (userId: string) => {
  try {
    const profileId = props.profile?.id
    if (!profileId) return

    const { error } = await supabase
      .from('user_blocks')
      .delete()
      .eq('blocker_id', profileId)
      .eq('blocked_user_id', userId)

    if (error) throw error

    blockedUsers.value = blockedUsers.value.filter(user => user.id !== userId)
    activityPubStore.loadBlockingData()
    toast.success('User unblocked')
  } catch (error: any) {
    debug.error('Failed to unblock user:', error)
    toast.error('Failed to unblock user')
  }
}

const unmuteUser = async (userId: string) => {
  try {
    const profileId = props.profile?.id
    if (!profileId) return

    const { error } = await supabase
      .from('user_mutes')
      .delete()
      .eq('muter_id', profileId)
      .eq('muted_user_id', userId)

    if (error) throw error

    mutedUsers.value = mutedUsers.value.filter(user => user.id !== userId)
    activityPubStore.loadBlockingData()
    toast.success('User unmuted')
  } catch (error: any) {
    debug.error('Failed to unmute user:', error)
    toast.error('Failed to unmute user')
  }
}

// Password Change Methods
const clearPasswordError = (field: 'currentPassword' | 'newPassword' | 'confirmPassword') => {
  passwordErrors.value[field] = ''
}

const isPasswordFormValid = computed(() => {
  return (
    passwordForm.value.currentPassword.length > 0 &&
    passwordForm.value.newPassword.length >= 6 &&
    passwordForm.value.confirmPassword.length >= 6 &&
    passwordForm.value.newPassword === passwordForm.value.confirmPassword
  )
})

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
    // NOTE: the current password is not verified. Supabase exposes no
    // client-side check for it; authorization rests on the active session.

    const { error: updateError } = await supabase.auth.updateUser({
      password: passwordForm.value.newPassword
    })

    if (updateError) {
      debug.error('Password update error:', updateError)
      
      if (updateError.message.includes('New password should be different') || 
          updateError.message.includes('same')) {
        passwordErrors.value.newPassword = 'New password must be different from current password'
      } else if (updateError.message.includes('Password should be at least')) {
        passwordErrors.value.newPassword = updateError.message
      } else {
        toast.error(updateError.message || 'Failed to update password')
      }
      return
    }

    // `data` carries the full user record; log the outcome only.
    debug.log('Password updated successfully')
    toast.success('Password updated')
    
    passwordForm.value = {
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    }
    
    showCurrentPassword.value = false
    showNewPassword.value = false
    showConfirmPassword.value = false
  } catch (error: any) {
    debug.error('Password change error:', error)
    toast.error(authErrorMessage(error, 'Failed to update password'))
  } finally {
    passwordLoading.value = false
  }
}

// 2FA Methods
const clearTwoFactorError = () => {
  twoFactorError.value = ''
}

const check2FAStatus = async () => {
  try {
    const { data, error } = await supabase.auth.mfa.listFactors()
    if (error) throw error

    // Only verified factors count; unverified ones are leftovers from
    // incomplete enrollments and must not gate the enable/disable UI.
    const totpFactor = data?.totp?.find((f: any) => f.status === 'verified')
    twoFactorEnabled.value = !!totpFactor

    debug.log('2FA Status Check:', {
      allFactors: data?.totp,
      verifiedFactor: totpFactor,
      enabled: twoFactorEnabled.value,
    })

    factorId.value = totpFactor?.id ?? ''
  } catch (error: any) {
    debug.error('2FA status check error:', error)
    // A transient `listFactors` error must not read as "2FA disabled": that
    // hides the disable button and races the enable flow against the
    // existing factor.
    toast.error(`Could not check 2FA status: ${error?.message ?? 'unknown error'}`)
    // `twoFactorEnabled` and `factorId` keep their previous values here.
  }
}

const startEnroll2FA = async () => {
  twoFactorLoading.value = true
  qrCodeLoading.value = true
  showEnroll2FA.value = true
  enrollStep.value = 1

  twoFactorEnabled.value = false
  factorId.value = ''

  try {
    const { data, error } = await supabase.auth.mfa.enroll({
      factorType: 'totp',
      friendlyName: 'Harmony Authenticator'
    })

    if (error) throw error

    totpSecret.value = data.totp.secret
    factorId.value = data.id

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
    debug.error('2FA enrollment error:', error)
    toast.error('Failed to start 2FA enrollment')
    showEnroll2FA.value = false
    await check2FAStatus()
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
    const { error } = await supabase.auth.mfa.challengeAndVerify({
      factorId: factorId.value,
      code: verificationCode.value
    })

    if (error) {
      debug.error('2FA verification failed:', error)
      throw error
    }

    // challengeAndVerify can return without error; re-read the factor status.
    const { data: factorsAfter } = await supabase.auth.mfa.listFactors()
    const verifiedFactor = factorsAfter?.totp?.find((f: any) => f.id === factorId.value && f.status === 'verified')
    
    if (!verifiedFactor) {
      throw new Error('2FA verification failed - factor not verified')
    }

    // CSPRNG only. Math.random() is not cryptographically secure and yields
    // guessable codes.
    const generateRecoveryCode = (): string => {
      // 5 random bytes -> 10 uppercase hex chars, 40 bits of entropy.
      const bytes = crypto.getRandomValues(new Uint8Array(5))
      return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('').toUpperCase()
    }
    recoveryCodes.value = Array.from({ length: 10 }, generateRecoveryCode)

    const userId = authStore.session?.user?.id
    if (userId) {
      const { error: saveError } = await supabase.rpc('save_recovery_codes', {
        p_user_id: userId,
        p_codes: recoveryCodes.value
      })

      if (saveError) {
        debug.error('Error saving recovery codes:', saveError)
        throw new Error('Failed to save recovery codes')
      }
    }

    enrollStep.value = 3
    toast.success('Two-factor authentication enabled')
  } catch (error: any) {
    debug.error('2FA verification error:', error)
    twoFactorError.value = error.message || 'Invalid verification code'
    
    if (factorId.value) {
      try {
        const { data: factors } = await supabase.auth.mfa.listFactors()
        const factor = factors?.totp?.find((f: any) => f.id === factorId.value)
        
        // Unenroll only unverified factors; a verified one predates this
        // enrollment attempt.
        if (factor && (factor.status as string) === 'unverified') {
          await supabase.auth.mfa.unenroll({ factorId: factorId.value })
          debug.log('Cleaned up unverified factor')
        }
      } catch (cleanupError) {
        debug.error('Error cleaning up failed enrollment:', cleanupError)
      }
    }
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
  if (factorId.value) {
    try {
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const factor = factors?.totp?.find((f: any) => f.id === factorId.value)
      
      // Unverified means enrollment is still in progress.
      if (factor && factor.status !== 'verified') {
      await supabase.auth.mfa.unenroll({ factorId: factorId.value })
      }
    } catch (error) {
      debug.error('Error canceling 2FA enrollment:', error)
    }
  }

  showEnroll2FA.value = false
  enrollStep.value = 1
  verificationCode.value = ''
  qrCodeDataUrl.value = ''
  totpSecret.value = ''
  factorId.value = ''
  await check2FAStatus()
}

const onDisable2FACodeInput = () => {
  disable2FAError.value = ''
}

const toggleDisableRecoveryCodeMode = () => {
  useDisableRecoveryCode.value = !useDisableRecoveryCode.value
  disable2FACode.value = ''
  disable2FAError.value = ''
}

const closeDisable2FAModal = () => {
  if (twoFactorLoading.value) return
  showDisable2FAModal.value = false
  disable2FACode.value = ''
  disable2FAError.value = ''
  useDisableRecoveryCode.value = false
}

/**
 * Steps the session up to AAL2, unenrolls the verified factor, and clears
 * recovery codes. `mfa.unenroll` is rejected below AAL2.
 *
 * TOTP path: `challengeAndVerify` creates a fresh challenge for the existing
 * factor and verifies the code in one call, leaving the session at AAL2.
 *
 * Recovery-code path, for a lost authenticator: the `verify_recovery_code`
 * RPC atomically marks the code used, then the factor is unenrolled. Mirrors
 * `AuthComponent`'s recovery-code login path.
 */
const disable2FA = async () => {
  if (!isDisable2FACodeValid.value) {
    disable2FAError.value = useDisableRecoveryCode.value
      ? 'Enter the 8-character recovery code'
      : 'Enter the 6-digit code from your authenticator'
    return
  }
  if (!factorId.value) {
    // `factorId` is populated by `check2FAStatus`; empty means that check
    // failed.
    toast.error('No active 2FA factor found. Try refreshing the page.')
    return
  }

  twoFactorLoading.value = true
  disable2FAError.value = ''

  try {
    if (useDisableRecoveryCode.value) {
      // `verify_recovery_code` marks the code used atomically.
      const userId = authStore.session?.user?.id
      if (!userId) throw new Error('User session not found')

      const { data: isValid, error: verifyError } = await supabase.rpc('verify_recovery_code', {
        p_user_id: userId,
        p_code: disable2FACode.value.trim().toUpperCase(),
      })

      if (verifyError) throw verifyError
      if (!isValid) {
        disable2FAError.value = 'Invalid or already-used recovery code'
        return
      }
    } else {
      // `challengeAndVerify` raises the session to AAL2 in one round trip.
      const { error: verifyError } = await supabase.auth.mfa.challengeAndVerify({
        factorId: factorId.value,
        code: disable2FACode.value,
      })

      if (verifyError) {
        const errCode = (verifyError as any).error_code
        const errMsg = verifyError.message ?? ''
        if (errCode === 'invalid_code' || /invalid/i.test(errMsg)) {
          disable2FAError.value = 'Invalid 2FA code'
        } else {
          disable2FAError.value = errMsg || 'Failed to verify 2FA code'
        }
        return
      }
    }

    // Recovery codes are deleted BEFORE unenroll; a partial failure would
    // otherwise leave codes that cannot be regenerated.
    const userId = authStore.session?.user?.id
    if (userId) {
      const { error: deleteError } = await supabase
        .from('mfa_recovery_codes')
        .delete()
        .eq('user_id', userId)
      if (deleteError) {
        // Non-fatal; unenroll still proceeds.
        debug.error('Error deleting recovery codes:', deleteError)
      }
    }

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({
      factorId: factorId.value,
    })

    if (unenrollError) {
      if ((unenrollError as any).error_code === 'insufficient_aal') {
        // Unreachable after a successful step-up; message replaces the raw
        // Supabase error code.
        toast.error('Session security level expired. Please log out and log back in with 2FA, then try again.')
      } else {
        throw unenrollError
      }
      return
    }

    toast.success('Two-factor authentication disabled')
    showDisable2FAModal.value = false
    disable2FACode.value = ''
    useDisableRecoveryCode.value = false
    await check2FAStatus()
  } catch (error: any) {
    debug.error('2FA disable error:', error)
    toast.error(error?.message || 'Failed to disable 2FA')
  } finally {
    twoFactorLoading.value = false
  }
}

const copySecret = async () => {
  try {
    await navigator.clipboard.writeText(totpSecret.value)
    toast.success('Secret key copied')
  } catch (error) {
    debug.error('Copy error:', error)
    toast.error('Failed to copy secret key')
  }
}

const copyRecoveryCodes = async () => {
  try {
    const codesText = recoveryCodes.value.join('\n')
    await navigator.clipboard.writeText(codesText)
    toast.success('Recovery codes copied')
  } catch (error) {
    debug.error('Copy error:', error)
    toast.error('Failed to copy recovery codes')
  }
}

onMounted(async () => {
  settings.value.stripUrlTrackers = isUrlTrackingStrippingEnabled()

  const profileId = props.profile?.id
  if (profileId && Date.now() - blocksMutesLastFetchedAt > CACHE_TTL_MS) {
    try {
      const { data: blocks, error: blocksError } = await supabase
        .from('user_blocks')
        .select('blocked_user_id')
        .eq('blocker_id', profileId)

      if (!blocksError && blocks && blocks.length > 0) {
        const blockedIds = blocks.map(b => b.blocked_user_id)
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', blockedIds)

        if (profiles) {
          blockedUsers.value = profiles as User[]
        }
      } else {
        blockedUsers.value = []
      }
    } catch (e) {
      debug.error('Failed to load blocked users:', e)
    }

    try {
      const { data: mutes, error: mutesError } = await supabase
        .from('user_mutes')
        .select('muted_user_id')
        .eq('muter_id', profileId)

      if (!mutesError && mutes && mutes.length > 0) {
        const mutedIds = mutes.map(m => m.muted_user_id)
        const { data: profiles } = await supabase
          .from('profiles')
          .select('id, username, display_name, avatar_url')
          .in('id', mutedIds)

        if (profiles) {
          mutedUsers.value = profiles as User[]
        }
      } else {
        mutedUsers.value = []
      }
    } catch (e) {
      debug.error('Failed to load muted users:', e)
    }

    blocksMutesLastFetchedAt = Date.now()
  }

  // No read for the DM-from-server-members / DM-from-follows toggles:
  // `notification_preferences` has no columns for them and the controls are
  // disabled placeholders.

  originalSettings.value = { ...settings.value }

  check2FAStatus()
})
</script>

<style scoped>
.privacy-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--background-quaternary);
}

.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}



.setting-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-control {
  flex-shrink: 0;
}

.radio-group {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.radio-option {
  display: flex;
  align-items: center;
  gap: 12px;
  cursor: pointer;
  padding: 8px 0;
}

.radio-option input[type="radio"] {
  width: 20px;
  height: 20px;
  border: 2px solid var(--text-muted);
  border-radius: 50%;
  background-color: transparent;
  cursor: pointer;
}

.radio-option input[type="radio"]:checked {
  border-color: var(--harmony-primary);
  background-color: var(--harmony-primary);
}

.radio-label {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  cursor: pointer;
}

.empty-state {
  text-align: center;
  padding: 40px 20px;
  color: var(--text-secondary);
}

.blocked-users-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.blocked-user-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px;
  background-color: var(--surface-inset);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
}

.user-info {
  display: flex;
  align-items: center;
  gap: 12px;
}

.user-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
}

.user-details {
  display: flex;
  flex-direction: column;
}

.user-name {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.user-username {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.unblock-btn {
  padding: 6px 12px;
  background-color: var(--error);
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-on-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.15s ease;
}

.unblock-btn:hover {
  background-color: var(--error-hover);
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  font-weight: var(--font-weight-medium);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: var(--harmony-primary-hover);
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-hover);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid var(--text-on-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .settings-section {
    padding: 16px;
  }
  
  .setting-item {
    flex-direction: column;
    align-items: stretch;
    gap: 12px;
  }
  
  .setting-info {
    margin-right: 0;
  }
}

/* Security Section Styles */
.security-section {
  border-left: 3px solid var(--harmony-primary);
}

.section-icon {
  width: 20px;
  height: 20px;
  margin-right: 8px;
  vertical-align: middle;
}

.subsection {
  margin-bottom: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid var(--background-quaternary);
}

.subsection:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.subsection-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.subsection-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
  line-height: 1.5;
}

.password-form {
  margin-top: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.password-input-wrapper {
  position: relative;
  display: flex;
  align-items: center;
}

.form-input {
  width: 100%;
  padding: 10px 12px;
  padding-right: 40px;
  background-color: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-input.error {
  border-color: var(--error);
}

.form-input.code-input {
  font-size: var(--font-size-2xl);
  letter-spacing: 0.5em;
  text-align: center;
  font-family: 'Courier New', monospace;
}

.toggle-password-btn {
  position: absolute;
  right: 8px;
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
}

.toggle-password-btn:hover {
  color: var(--text-primary);
}

.error-message {
  display: block;
  color: var(--error);
  font-size: var(--font-size-xs);
  margin-top: 6px;
}

.btn-sm {
  padding: 8px 16px;
  font-size: 13px;
}

/* 2FA Styles */
.twofa-status {
  margin-top: 12px;
}

.status-badge {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  font-size: 13px;
  font-weight: var(--font-weight-medium);
  margin-bottom: 10px;
}

.status-badge svg {
  width: 18px;
  height: 18px;
}

.status-enabled {
  background-color: color-mix(in srgb, var(--success) 10%, transparent);
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}

.status-disabled {
  background-color: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.status-text {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}

.twofa-enroll {
  margin-top: 16px;
}

.enroll-step {
  padding: 16px;
  background-color: var(--surface-inset);
  border-radius: var(--radius-base);
  border: 1px solid var(--input-border);
}

.step-title {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.step-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
}

.step-description.warning {
  color: var(--warning);
}

.qr-code-container {
  display: flex;
  justify-content: center;
  padding: 16px;
  background-color: var(--text-primary);
  border-radius: var(--radius-base);
  margin-bottom: 16px;
}

.qr-loading,
.qr-code {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
}

.qr-code img {
  max-width: 200px;
  height: auto;
}

.secret-key {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px;
  background-color: var(--background-secondary);
  border-radius: var(--radius-sm);
  margin-bottom: 16px;
}

.secret-label {
  font-size: 11px;
  color: var(--text-secondary);
  margin: 0;
  flex-shrink: 0;
}

.secret-code {
  flex: 1;
  font-family: 'Courier New', monospace;
  font-size: 13px;
  color: var(--text-primary);
  background-color: var(--input-bg);
  padding: 6px 10px;
  border-radius: 3px;
  word-break: break-all;
}

.btn-copy {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 6px;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: color 0.15s ease;
  flex-shrink: 0;
}

.btn-copy:hover {
  color: var(--text-primary);
}

.btn-copy svg {
  width: 16px;
  height: 16px;
}

.recovery-codes {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
  margin-bottom: 16px;
}

.recovery-code {
  font-family: 'Courier New', monospace;
  font-size: var(--font-size-xs);
  color: var(--text-primary);
  background-color: var(--background-secondary);
  padding: 10px;
  border-radius: var(--radius-sm);
  text-align: center;
  border: 1px solid var(--background-quaternary);
}

.step-actions {
  display: flex;
  gap: 10px;
  margin-top: 12px;
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
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  max-width: 420px;
  width: 90%;
  border: 1px solid var(--background-quaternary);
}

.modal-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.modal-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 18px 0;
}

.modal-actions {
  display: flex;
  gap: 10px;
  justify-content: flex-end;
  margin-top: 18px;
}

/* Inline error inside the disable-2FA modal's TOTP/recovery input. */
.form-error {
  margin: 6px 0 0 0;
  color: var(--color-error, var(--error));
  font-size: 13px;
}

/* "Use a recovery code instead" toggle in the disable-2FA modal. Matches the
   visual weight of the equivalent toggle in the login MFA modal. */
.link-button {
  background: none;
  border: none;
  padding: 0;
  margin: 8px 0 0 0;
  color: var(--harmony-primary);
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}

.link-button:hover {
  color: var(--harmony-primary-hover);
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

  .step-actions,
  .modal-actions {
    flex-direction: column;
  }

  .btn {
    width: 100%;
  }
}
</style>