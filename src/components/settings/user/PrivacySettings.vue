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
        Account Security
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
            <span v-if="!passwordLoading">Update Password</span>
            <div v-else class="loading-spinner"></div>
          </button>
        </form>
      </div>

      <!-- Two-Factor Authentication -->
      <div class="subsection">
        <h4 class="subsection-title">Two-Factor Authentication</h4>
        <p class="subsection-description">
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
            class="btn btn-primary btn-sm"
            @click="startEnroll2FA"
            :disabled="twoFactorLoading"
          >
            Enable Two-Factor Authentication
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
              <div class="step-actions">
                <button 
                  type="submit" 
                  class="btn btn-primary btn-sm"
                  :disabled="twoFactorLoading || verificationCode.length !== 6"
                >
                  <span v-if="!twoFactorLoading">Verify & Enable</span>
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
            <h5 class="step-title">✅ Success! Save Your Recovery Codes</h5>
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
                Copy All Codes
              </button>
              <button 
                class="btn btn-secondary btn-sm"
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
            class="btn btn-danger btn-sm"
            @click="showDisable2FAModal = true"
            :disabled="twoFactorLoading"
          >
            Disable Two-Factor Authentication
          </button>
        </div>
      </div>
    </div>

    <!-- Encryption Settings -->
    <div class="settings-section security-section">
      <h3 class="section-title">
        <ShieldIcon class="section-icon" />
        Encryption Settings
      </h3>
      <EncryptionSettings :loading="loading" />
    </div>

    <!-- Privacy Settings -->
    <div class="settings-section">
      <h3 class="section-title">Direct Messages</h3>

      <div class="setting-item disabled-option">
        <div class="setting-info">
          <h4 class="setting-label">
            Allow direct messages from server members
            <span class="coming-soon-badge">Coming soon</span>
          </h4>
          <p class="setting-description">
            When enabled, members of servers you share will be able to DM you. When this preference is wired up, you'll be able to override it per-server.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.allowDMFromServerMembers"
            disabled
          />
        </div>
      </div>

      <div class="setting-item disabled-option">
        <div class="setting-info">
          <h4 class="setting-label">
            Allow direct messages from people you follow
            <span class="coming-soon-badge">Coming soon</span>
          </h4>
          <p class="setting-description">
            Restrict who can DM you to accounts you follow (locally or across the fediverse).
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.allowDMFromFollows"
            disabled
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data & Privacy</h3>
      
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
      <h3 class="section-title">Blocked Users</h3>
      
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
      <h3 class="section-title">Muted Users</h3>
      
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
        Save Changes
      </button>
      <button 
        class="btn btn-secondary" 
        @click="resetSettings"
        :disabled="loading || !hasChanges"
      >
        Reset
      </button>
    </div>

    <!-- Disable 2FA Confirmation Modal -->
    <!-- Asks for the current TOTP code (or a recovery code). Verifying the
         code via `mfa.challengeAndVerify` upgrades the session to AAL2,
         which is what Supabase requires before `mfa.unenroll` will accept
         the call. This replaces the previous password-only flow that
         couldn't actually complete the unenroll from an AAL1 session. -->
    <div v-if="showDisable2FAModal" class="modal-overlay" @click="closeDisable2FAModal">
      <div class="modal-content" @click.stop>
        <h3 class="modal-title">Disable Two-Factor Authentication?</h3>
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
              :placeholder="useDisableRecoveryCode ? 'XXXXXXXX' : '123456'"
              :maxlength="useDisableRecoveryCode ? 8 : 6"
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
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import Avatar from '@/components/common/Avatar.vue'
import ShieldIcon from '@/components/icons/Shield.vue'
import EyeIcon from '@/components/icons/Eye.vue'
import EyeOffIcon from '@/components/icons/EyeOff.vue'
import CopyIcon from '@/components/icons/Copy.vue'
import EncryptionSettings from '@/components/encryption/EncryptionSettings.vue'

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
// Code the user types to authorize the unenroll. 6 digits for TOTP, 8 chars
// for recovery code - `useDisableRecoveryCode` toggles which one we expect.
const disable2FACode = ref('')
const useDisableRecoveryCode = ref(false)
const disable2FAError = ref('')

const isDisable2FACodeValid = computed(() => {
  if (useDisableRecoveryCode.value) {
    return disable2FACode.value.trim().length === 8
  }
  return /^\d{6}$/.test(disable2FACode.value)
})

// Privacy State
//
// `allowDMFromServerMembers` and `allowDMFromFollows` are visible in the UI
// but currently flagged as "Coming soon" — there is no DB column for either
// (the `notification_preferences` table does not store them) and no
// server-side gate consumes them yet. Keep them in state so when we do
// wire them up, persisting works straight away.
const settings = ref({
  allowDMFromServerMembers: true,
  allowDMFromFollows: true,
  stripUrlTrackers: true, // Default ON
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
const onSettingChange = () => {
  // Settings changed, enable save button
}

// The URL-tracker toggle persists to localStorage and is read by the
// message-send pipeline (`unifiedContentProcessing.ts`) on every send.
// Apply it immediately on toggle so users see the effect on the very
// next message, rather than only after pressing Save Changes.
const onUrlStripChange = () => {
  setUrlTrackingStrippingEnabled(settings.value.stripUrlTrackers)
  originalSettings.value.stripUrlTrackers = settings.value.stripUrlTrackers
}

const saveSettings = () => {
  // Save URL tracker stripping setting to localStorage
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
    // Supabase updateUser will handle password update if user has valid session
    // Note: Supabase doesn't provide a way to verify old password client-side
    // The security relies on having a valid authenticated session
    
    const { data, error: updateError } = await supabase.auth.updateUser({
      password: passwordForm.value.newPassword
    })

    if (updateError) {
      debug.error('Password update error:', updateError)
      
      // Handle specific error cases
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

    debug.log('✅ Password updated successfully:', data)
    toast.success('Password updated successfully!')
    
    // Clear form after successful update
    passwordForm.value = {
      currentPassword: '',
      newPassword: '',
      confirmPassword: ''
    }
    
    // Reset password visibility toggles
    showCurrentPassword.value = false
    showNewPassword.value = false
    showConfirmPassword.value = false
  } catch (error: any) {
    debug.error('Password change error:', error)
    toast.error(error.message || 'Failed to update password')
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

    // Only count VERIFIED factors - unverified factors from incomplete
    // enrollments should never gate enable/disable UI.
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
    // Surface the failure instead of silently flipping the UI to "disabled"
    // - a transient `listFactors` error used to make 2FA appear off when
    // it was actually still enabled, which then cascaded into broken
    // enable/disable UI (the disable button would be hidden, the enable
    // flow would race against an existing factor, etc.).
    toast.error(`Could not check 2FA status: ${error?.message ?? 'unknown error'}`)
    // Intentionally do NOT mutate `twoFactorEnabled` / `factorId` here -
    // keep whatever state we had before so the user's UI doesn't jitter.
  }
}

const startEnroll2FA = async () => {
  twoFactorLoading.value = true
  qrCodeLoading.value = true
  showEnroll2FA.value = true
  enrollStep.value = 1

  // Reset 2FA status to ensure it shows as disabled during enrollment
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
    debug.error('2FA enrollment error:', error)
    toast.error('Failed to start 2FA enrollment')
    showEnroll2FA.value = false
    // Re-check status on error
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

    // Verify the factor is actually verified before proceeding
    const { data: factorsAfter } = await supabase.auth.mfa.listFactors()
    const verifiedFactor = factorsAfter?.totp?.find((f: any) => f.id === factorId.value && f.status === 'verified')
    
    if (!verifiedFactor) {
      throw new Error('2FA verification failed - factor not verified')
    }

    // Generate recovery codes (10 random codes)
    recoveryCodes.value = Array.from({ length: 10 }, () => 
      Math.random().toString(36).substring(2, 10).toUpperCase()
    )

    // Save recovery codes to database
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
    toast.success('Two-Factor Authentication enabled!')
  } catch (error: any) {
    debug.error('2FA verification error:', error)
    twoFactorError.value = error.message || 'Invalid verification code'
    
    // Clean up unverified factor on error
    if (factorId.value) {
      try {
        const { data: factors } = await supabase.auth.mfa.listFactors()
        const factor = factors?.totp?.find((f: any) => f.id === factorId.value)
        
        // Only try to unenroll if factor exists and is unverified
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
  // Refresh 2FA status to show as enabled now
  await check2FAStatus()
  enrollStep.value = 1
  verificationCode.value = ''
  qrCodeDataUrl.value = ''
  totpSecret.value = ''
  recoveryCodes.value = []
}

const cancelEnroll2FA = async () => {
  // Clean up enrollment - only unenroll if factor is not verified yet
  if (factorId.value) {
    try {
      // Check if factor is verified - if not, we can unenroll without AAL2
      const { data: factors } = await supabase.auth.mfa.listFactors()
      const factor = factors?.totp?.find((f: any) => f.id === factorId.value)
      
      // Only unenroll if factor is unverified (enrollment in progress)
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
  // Re-check status to ensure UI is correct
  await check2FAStatus()
}

const onDisable2FACodeInput = () => {
  // Clear error as the user retypes - same UX as the login MFA modal.
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
 * Disable 2FA by stepping the current session up to AAL2 (so Supabase will
 * accept the `mfa.unenroll` call), then unenrolling the verified factor and
 * clearing recovery codes.
 *
 * The previous version asked for the user's password and then bailed out
 * with "log out and log back in" because it never completed the AAL2
 * upgrade. Supabase's `challengeAndVerify` is the canonical step-up path:
 * it creates a fresh challenge for the existing factor and verifies the
 * supplied TOTP in one call, leaving the session at AAL2.
 *
 * For users who lost their authenticator, the modal also accepts a
 * recovery code; we verify it via the existing `verify_recovery_code` RPC
 * (which atomically marks the code as used) and then unenroll the factor.
 * Recovery-code unenroll matches the same flow used by `AuthComponent`'s
 * recovery-code login path.
 */
const disable2FA = async () => {
  if (!isDisable2FACodeValid.value) {
    disable2FAError.value = useDisableRecoveryCode.value
      ? 'Enter the 8-character recovery code'
      : 'Enter the 6-digit code from your authenticator'
    return
  }
  if (!factorId.value) {
    // `factorId` is populated by `check2FAStatus`. If it's empty here the
    // status check probably failed silently; surface that explicitly.
    toast.error('No active 2FA factor found. Try refreshing the page.')
    return
  }

  twoFactorLoading.value = true
  disable2FAError.value = ''

  try {
    if (useDisableRecoveryCode.value) {
      // Recovery-code path: verify the code server-side, then unenroll.
      // The `verify_recovery_code` RPC atomically marks the code as used.
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
      // TOTP path: `challengeAndVerify` upgrades the session to AAL2 in
      // one round-trip. This is what Supabase requires before unenroll.
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

    // Clear recovery codes BEFORE unenroll so that even if unenroll fails
    // partway, we don't leave dangling codes that can't be regenerated.
    const userId = authStore.session?.user?.id
    if (userId) {
      const { error: deleteError } = await supabase
        .from('mfa_recovery_codes')
        .delete()
        .eq('user_id', userId)
      if (deleteError) {
        // Non-fatal - user can retry, and unenroll will still proceed.
        debug.error('Error deleting recovery codes:', deleteError)
      }
    }

    const { error: unenrollError } = await supabase.auth.mfa.unenroll({
      factorId: factorId.value,
    })

    if (unenrollError) {
      if ((unenrollError as any).error_code === 'insufficient_aal') {
        // Should be unreachable with the `challengeAndVerify` step-up, but
        // surface a helpful message rather than the raw Supabase code.
        toast.error('Session security level expired. Please log out and log back in with 2FA, then try again.')
      } else {
        throw unenrollError
      }
      return
    }

    toast.success('Two-Factor Authentication disabled')
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
    toast.success('Secret key copied to clipboard')
  } catch (error) {
    debug.error('Copy error:', error)
    toast.error('Failed to copy secret key')
  }
}

const copyRecoveryCodes = async () => {
  try {
    const codesText = recoveryCodes.value.join('\n')
    await navigator.clipboard.writeText(codesText)
    toast.success('Recovery codes copied to clipboard')
  } catch (error) {
    debug.error('Copy error:', error)
    toast.error('Failed to copy recovery codes')
  }
}

// Initialize
onMounted(async () => {
  // Load URL tracker stripping setting from localStorage
  settings.value.stripUrlTrackers = isUrlTrackingStrippingEnabled()

  const profileId = props.profile?.id
  if (profileId && Date.now() - blocksMutesLastFetchedAt > CACHE_TTL_MS) {
    // Load blocked users
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

    // Load muted users
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

  // The DM-from-server-members / DM-from-follows preferences will be loaded
  // from `notification_preferences` once the columns are added; for now the
  // toggles are disabled UI placeholders so we skip the read.

  originalSettings.value = { ...settings.value }

  // Check 2FA status
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
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
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
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--h-chat-light);
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
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.coming-soon-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  vertical-align: middle;
  margin-left: 6px;
}

.setting-item.disabled-option .setting-label,
.setting-item.disabled-option .setting-description {
  opacity: 0.65;
}

.setting-description {
  font-size: 12px;
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
  border: 2px solid #4f545c;
  border-radius: 50%;
  background-color: transparent;
  cursor: pointer;
}

.radio-option input[type="radio"]:checked {
  border-color: #0EA5E9;
  background-color: var(--harmony-primary);
}

.radio-label {
  font-size: 14px;
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
  background-color: var(--h-chat-darker);
  border-radius: 4px;
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
  font-size: 14px;
  font-weight: 500;
  /* color: var(--text-primary); */
  color: var(--text-primary);
}

.user-username {
  font-size: 12px;
  /* color: var(--text-secondary); */
  color: var(--text-secondary);
}

.unblock-btn {
  padding: 6px 12px;
  background-color: #ed4245;
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.unblock-btn:hover {
  background-color: #c73e41;
}

.settings-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
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
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background-color: #0284C7;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: var(--text-primary);
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
  border-left: 3px solid #0EA5E9;
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
  border-bottom: 1px solid var(--h-chat-light);
}

.subsection:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.subsection-title {
  font-size: 14px;
  font-weight: 600;
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
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
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
  padding: 10px 12px;
  padding-right: 40px;
  background-color: var(--h-chat-darker);
  border: 1px solid var(--h-chat-light);
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: #0EA5E9;
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
  color: #ed4245;
  font-size: 12px;
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
  border-radius: 4px;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 10px;
}

.status-badge svg {
  width: 18px;
  height: 18px;
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
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px 0;
}

.twofa-enroll {
  margin-top: 16px;
}

.enroll-step {
  padding: 16px;
  background-color: var(--h-chat-darker);
  border-radius: 6px;
  border: 1px solid var(--h-chat-light);
}

.step-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.step-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
}

.step-description.warning {
  color: #faa61a;
}

.qr-code-container {
  display: flex;
  justify-content: center;
  padding: 16px;
  background-color: var(--text-primary);
  border-radius: 6px;
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
  background-color: var(--h-chat);
  border-radius: 4px;
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
  background-color: var(--h-chat-darker);
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
  font-size: 12px;
  color: var(--text-primary);
  background-color: var(--h-chat);
  padding: 10px;
  border-radius: 4px;
  text-align: center;
  border: 1px solid var(--h-chat-light);
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
  background-color: var(--h-chat);
  border-radius: 8px;
  padding: 24px;
  max-width: 420px;
  width: 90%;
  border: 1px solid var(--h-chat-light);
}

.modal-title {
  font-size: 18px;
  font-weight: 600;
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
  color: var(--color-error, #ed4245);
  font-size: 13px;
}

/* Subtle "Use a recovery code instead" toggle in the disable-2FA modal -
   matches the visual weight of the equivalent toggle in the login MFA
   modal so the two flows feel consistent. */
.link-button {
  background: none;
  border: none;
  padding: 0;
  margin: 8px 0 0 0;
  color: var(--harmony-primary, #0EA5E9);
  font-size: 13px;
  text-decoration: underline;
  cursor: pointer;
}

.link-button:hover {
  color: var(--harmony-primary-hover, #0284C7);
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