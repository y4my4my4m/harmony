<template>
  <div class="server-encryption-settings">
    <div class="settings-section">
      <h2 class="section-title">🔐 Server Encryption Policy</h2>
      <p class="section-description">
        Control end-to-end encryption requirements for this server
      </p>
    </div>

    <div v-if="loading" class="loading-state">
      <LoadingSpinner :size="40" />
      <p>Loading encryption settings...</p>
    </div>

    <div v-else class="settings-card">
      <!-- Current Status -->
      <div class="status-card" :class="statusClass">
        <div class="status-icon">
          {{ statusIcon }}
        </div>
        <div class="status-info">
          <h4>{{ statusTitle }}</h4>
          <p>{{ statusDescription }}</p>
        </div>
      </div>

      <!-- Encryption Mode Selection -->
      <div class="setting-group">
        <label class="setting-label">
          Encryption Mode
          <span class="setting-hint">Choose how encryption is enforced</span>
        </label>

        <div class="mode-options">
          <div
            v-for="mode in encryptionModes"
            :key="mode.value"
            class="mode-option"
            :class="{ selected: currentMode === mode.value }"
            @click="selectMode(mode.value as 'disabled' | 'optional' | 'required')"
          >
            <div class="mode-header">
              <input
                type="radio"
                :id="`mode-${mode.value}`"
                :value="mode.value"
                v-model="currentMode"
                :disabled="!canModify"
              />
              <label :for="`mode-${mode.value}`">
                <span class="mode-icon">{{ mode.icon }}</span>
                <span class="mode-name">{{ mode.name }}</span>
              </label>
            </div>
            <p class="mode-description">{{ mode.description }}</p>
            
            <div v-if="mode.value === 'required'" class="mode-warning">
              <span class="warning-icon">⚠️</span>
              <span>Users without encryption keys won't be able to send messages</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Server-wide Settings -->
      <div class="setting-group">
        <label class="setting-label">Additional Options</label>

        <div class="checkbox-option">
          <input
            type="checkbox"
            id="force-key-setup"
            v-model="forceKeySetup"
            :disabled="!canModify || currentMode === 'disabled'"
          />
          <label for="force-key-setup">
            <span class="option-name">Prompt users to set up encryption</span>
            <span class="option-hint">Show setup wizard for users without keys</span>
          </label>
        </div>

        <div class="checkbox-option">
          <input
            type="checkbox"
            id="encrypt-attachment-metadata"
            checked
            disabled
          />
          <label for="encrypt-attachment-metadata">
            <span class="option-name">Encrypt attachment metadata</span>
            <span class="option-hint">File URLs, names, and types are encrypted within message content when encryption is enabled</span>
          </label>
        </div>

        <div class="checkbox-option disabled-option">
          <input
            type="checkbox"
            id="encrypt-attachments"
            v-model="encryptAttachments"
            disabled
          />
          <label for="encrypt-attachments">
            <span class="option-name">Encrypt file blobs <span class="coming-soon-badge">Coming soon</span></span>
            <span class="option-hint">Encrypt file data before upload so files are unreadable in storage without decryption keys</span>
          </label>
        </div>
      </div>

      <!-- Voice / Video E2EE -->
      <div class="setting-group">
        <label class="setting-label">
          Voice &amp; Video Encryption
          <span class="setting-hint">End-to-end encrypt call media so the media server can't access it</span>
        </label>

        <div class="checkbox-option">
          <input
            type="checkbox"
            id="voice-e2ee"
            :checked="voiceEncryptionMode === 'required'"
            :disabled="!canModify"
            @change="voiceEncryptionMode = ($event.target as HTMLInputElement).checked ? 'required' : 'disabled'"
          />
          <label for="voice-e2ee">
            <span class="option-name">Require end-to-end encrypted voice/video</span>
            <span class="option-hint">Call audio/video is encrypted before reaching the SFU. Unlike messages, calls are all-or-nothing.</span>
          </label>
        </div>

        <div v-if="voiceEncryptionMode === 'required'" class="mode-warning">
          <span class="warning-icon">⚠️</span>
          <span>Participants who haven't set up encryption (and federated/legacy clients) will be unable to join encrypted calls.</span>
        </div>
      </div>

      <!-- Server Encryption Status -->
      <div class="setting-group">
        <label class="setting-label">Server Statistics</label>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.total }}</div>
            <div class="stat-label">Total Members</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.withKeys }}</div>
            <div class="stat-label">With Encryption</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.percentage }}%</div>
            <div class="stat-label">Coverage</div>
          </div>
        </div>

        <div v-if="memberStats.percentage < 100 && currentMode === 'required'" class="warning-banner">
          <span class="warning-icon">⚠️</span>
          <span>
            {{ memberStats.total - memberStats.withKeys }} members need to set up encryption before required mode can function properly
          </span>
        </div>
      </div>

      <!-- Actions handled by parent ServerSettings save button -->

      <!-- Help Section -->
      <div class="help-section">
        <h4>📚 About End-to-End Encryption</h4>
        <ul>
          <li><strong>Disabled:</strong> Messages are stored in plaintext on the server</li>
          <li><strong>Optional:</strong> Users can enable E2EE individually</li>
          <li><strong>Required:</strong> All messages must be encrypted (users need keys)</li>
        </ul>
        <p class="help-note">
          💡 <strong>Note:</strong> End-to-end encryption means the server cannot read message content.
          This provides maximum privacy but disables server-side features like search and content moderation.
        </p>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="error" class="error-banner">
      <span class="error-icon">❌</span>
      <span>{{ error }}</span>
      <button @click="error = null" class="close-btn">×</button>
    </div>

    <!-- Success Display -->
    <div v-if="successMessage" class="success-banner">
      <span class="success-icon">✅</span>
      <span>{{ successMessage }}</span>
      <button @click="successMessage = null" class="close-btn">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { userDataService } from '@/services/userDataService'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

interface Props {
  serverId: string
}

const props = defineProps<Props>()
const { confirm } = useConfirmDialog()

const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

const currentMode = ref<'disabled' | 'optional' | 'required'>('optional')
const originalMode = ref<'disabled' | 'optional' | 'required'>('optional')
const forceKeySetup = ref(false)
const encryptAttachments = ref(true)
const originalForceKeySetup = ref(false)
const originalEncryptAttachments = ref(true)
// Voice/video E2EE: disabled | required (no per-call "optional" - LiveKit E2EE
// is room-wide, so a call is either fully encrypted or not).
const voiceEncryptionMode = ref<'disabled' | 'required'>('disabled')
const originalVoiceEncryptionMode = ref<'disabled' | 'required'>('disabled')

const memberStats = ref({
  total: 0,
  withKeys: 0,
  percentage: 0
})

// Encryption mode options
const encryptionModes = [
  {
    value: 'disabled',
    name: 'Disabled',
    icon: '🔓',
    description: 'Messages are not encrypted. Server can read all content.'
  },
  {
    value: 'optional',
    name: 'Optional',
    icon: '🔒',
    description: 'Encryption available but not required. Users choose individually.'
  },
  {
    value: 'required',
    name: 'Required',
    icon: '🔐',
    description: 'All messages must be encrypted. Users need encryption keys to participate.'
  }
]

const canModify = computed(() => {
  const currentUser = userDataService.getCurrentUser()
  // Only server owner/admins can modify
  // TODO: Check actual permissions
  return !!currentUser
})

const hasChanges = computed(() => {
  return currentMode.value !== originalMode.value ||
         forceKeySetup.value !== originalForceKeySetup.value ||
         encryptAttachments.value !== originalEncryptAttachments.value ||
         voiceEncryptionMode.value !== originalVoiceEncryptionMode.value
})

const statusClass = computed(() => {
  switch (currentMode.value) {
    case 'disabled': return 'status-disabled'
    case 'optional': return 'status-optional'
    case 'required': return 'status-required'
    default: return ''
  }
})

const statusIcon = computed(() => {
  switch (currentMode.value) {
    case 'disabled': return '🔓'
    case 'optional': return '🔒'
    case 'required': return '🔐'
    default: return '❓'
  }
})

const statusTitle = computed(() => {
  switch (currentMode.value) {
    case 'disabled': return 'Encryption Disabled'
    case 'optional': return 'Optional Encryption'
    case 'required': return 'Encryption Required'
    default: return 'Unknown'
  }
})

const statusDescription = computed(() => {
  switch (currentMode.value) {
    case 'disabled':
      return 'Messages are stored in plaintext. Server operators can read content.'
    case 'optional':
      return 'Users can enable E2EE for their messages. Mixed encryption mode.'
    case 'required':
      return 'All messages are end-to-end encrypted. Maximum privacy enabled.'
    default:
      return ''
  }
})

async function loadSettings() {
  loading.value = true
  error.value = null

  try {
    const { data: policy, error: policyError } = await supabase
      .from('server_encryption_settings')
      .select('*')
      .eq('server_id', props.serverId)
      .maybeSingle()

    if (policyError) throw policyError

    if (policy) {
      currentMode.value = policy.encryption_mode || 'optional'
      forceKeySetup.value = policy.force_key_setup || false
      encryptAttachments.value = policy.encrypt_attachments !== false
      voiceEncryptionMode.value = policy.voice_encryption_mode === 'required' ? 'required' : 'disabled'
      
      originalMode.value = currentMode.value
      originalForceKeySetup.value = forceKeySetup.value
      originalEncryptAttachments.value = encryptAttachments.value
      originalVoiceEncryptionMode.value = voiceEncryptionMode.value
    } else {
      await createDefaultPolicy()
    }

    await loadMemberStats()

    debug.log('Encryption settings loaded')
  } catch (err: any) {
    debug.error('Failed to load encryption settings:', err)
    error.value = err.message || 'Failed to load settings'
  } finally {
    loading.value = false
  }
}

async function createDefaultPolicy() {
  const { error: createError } = await supabase
    .from('server_encryption_settings')
    .insert({
      server_id: props.serverId,
      encryption_mode: 'optional',
      force_key_setup: false,
      encrypt_attachments: true
    })

  if (createError) {
    debug.error('Failed to create default policy:', createError)
  }
}

async function loadMemberStats() {
  try {
    const { data, error } = await supabase
      .rpc('get_server_encryption_stats', { p_server_id: props.serverId })

    if (error) throw error

    if (data) {
      memberStats.value.total = data.total || 0
      memberStats.value.withKeys = data.with_keys || 0
      memberStats.value.percentage = data.percentage || 0
    }
  } catch (err) {
    debug.error('Failed to load member stats:', err)
  }
}

function selectMode(mode: 'disabled' | 'optional' | 'required') {
  if (!canModify.value) return
  currentMode.value = mode

  // Auto-enable force key setup for required mode
  if (mode === 'required') {
    forceKeySetup.value = true
  }

  // Disable options if encryption is disabled
  if (mode === 'disabled') {
    forceKeySetup.value = false
    encryptAttachments.value = false
  }
}

async function saveSettings() {
  if (!canModify.value || saving.value) return

  saving.value = true
  error.value = null
  successMessage.value = null

  try {
    if (currentMode.value === 'required' && memberStats.value.percentage < 50) {
      const confirmed = await confirm({
        title: 'Enable required encryption',
        message: `Warning: Only ${memberStats.value.percentage}% of members have encryption keys set up. ` +
          'Required mode will prevent users without keys from participating. Continue?',
        confirmButtonText: 'Continue',
        dangerAction: true,
      })
      if (!confirmed) {
        saving.value = false
        return
      }
    }

    const policyData = {
      server_id: props.serverId,
      encryption_mode: currentMode.value,
      force_key_setup: forceKeySetup.value,
      encrypt_attachments: encryptAttachments.value,
      voice_encryption_mode: voiceEncryptionMode.value,
      updated_at: new Date().toISOString()
    }

    const { error: saveError } = await supabase
      .from('server_encryption_settings')
      .upsert(policyData, {
        onConflict: 'server_id'
      })

    if (saveError) throw saveError

    originalMode.value = currentMode.value
    originalForceKeySetup.value = forceKeySetup.value
    originalEncryptAttachments.value = encryptAttachments.value
    originalVoiceEncryptionMode.value = voiceEncryptionMode.value

    successMessage.value = 'Encryption settings saved successfully!'
    
    setTimeout(() => {
      successMessage.value = null
    }, 3000)

    debug.log('Encryption settings saved')
  } catch (err: any) {
    debug.error('Failed to save encryption settings:', err)
    error.value = err.message || 'Failed to save settings'
  } finally {
    saving.value = false
  }
}

function resetSettings() {
  currentMode.value = originalMode.value
  forceKeySetup.value = originalForceKeySetup.value
  encryptAttachments.value = originalEncryptAttachments.value
  voiceEncryptionMode.value = originalVoiceEncryptionMode.value
  error.value = null
  successMessage.value = null
}

// Expose for parent component
defineExpose({
  hasChanges,
  saveSettings,
  resetSettings
})

onMounted(() => {
  loadSettings()
})
</script>

<style scoped>
.server-encryption-settings {
  margin-top: 24px;
}

.settings-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
  padding: 20px;
  margin-bottom: 16px;
}

.loading-state {
  text-align: center;
  padding: 48px 0;
}

.status-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  border-radius: 12px;
  margin-bottom: 24px;
  border: 2px solid;
}

.status-card.status-disabled {
  background: rgba(var(--color-danger-rgb), 0.1);
  border-color: var(--color-danger);
}

.status-card.status-optional {
  background: rgba(var(--color-warning-rgb), 0.1);
  border-color: var(--color-warning);
}

.status-card.status-required {
  background: rgba(var(--color-success-rgb), 0.1);
  border-color: var(--color-success);
}

.status-icon {
  font-size: 32px;
}

.status-info h4 {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
}

.status-info p {
  margin: 0;
  color: var(--color-text-secondary);
  font-size: 14px;
}

.setting-group {
  margin-bottom: 32px;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-weight: 600;
  margin-bottom: 16px;
  color: var(--color-text-primary);
}

.setting-hint {
  font-size: 14px;
  font-weight: 400;
  color: var(--color-text-secondary);
}

.mode-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mode-option {
  padding: 16px;
  border: 2px solid var(--color-border);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s;
}

.mode-option:hover {
  border-color: var(--color-primary);
  background: rgba(var(--color-primary-rgb), 0.05);
}

.mode-option.selected {
  border-color: var(--color-primary);
  background: rgba(var(--color-primary-rgb), 0.1);
}

.mode-header {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}

.mode-header label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  flex: 1;
}

.mode-icon {
  font-size: 20px;
}

.mode-name {
  font-weight: 600;
  color: var(--color-text-primary);
}

.mode-description {
  margin: 0 0 0 32px;
  font-size: 14px;
  color: var(--color-text-secondary);
}

.mode-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0 32px;
  padding: 8px 12px;
  background: rgba(var(--color-warning-rgb), 0.1);
  border-radius: 6px;
  font-size: 13px;
  color: var(--color-warning);
}

.warning-icon {
  font-size: 16px;
}

.checkbox-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: 6px;
  margin-bottom: 8px;
}

.checkbox-option:hover {
  background: rgba(var(--color-primary-rgb), 0.05);
}

.checkbox-option label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  flex: 1;
}

.option-name {
  font-weight: 500;
  color: var(--color-text-primary);
}

.option-hint {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.disabled-option {
  opacity: 0.6;
  cursor: default;
}

.disabled-option label {
  cursor: default;
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

.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.stat-card {
  padding: 16px;
  background: var(--color-background-secondary);
  border-radius: 8px;
  text-align: center;
}

.stat-value {
  font-size: 24px;
  font-weight: 700;
  color: var(--color-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 13px;
  color: var(--color-text-secondary);
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: rgba(var(--color-warning-rgb), 0.1);
  border-left: 4px solid var(--color-warning);
  border-radius: 6px;
  color: var(--color-warning);
  font-size: 14px;
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.btn-primary,
.btn-secondary {
  padding: 12px 24px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
  border: none;
}

.btn-primary:hover:not(:disabled) {
  opacity: 0.9;
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--color-text-primary);
  border: 1px solid var(--color-border);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--color-background-secondary);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.help-section {
  margin-top: 32px;
  padding: 20px;
  background: var(--color-background-secondary);
  border-radius: 8px;
}

.help-section h4 {
  margin: 0 0 12px 0;
  color: var(--color-text-primary);
}

.help-section ul {
  margin: 0 0 12px 0;
  padding-left: 20px;
}

.help-section li {
  margin-bottom: 8px;
  color: var(--color-text-secondary);
}

.help-note {
  margin: 0;
  padding: 12px;
  background: rgba(var(--color-primary-rgb), 0.1);
  border-left: 4px solid var(--color-primary);
  border-radius: 4px;
  font-size: 14px;
}

.error-banner,
.success-banner {
  position: fixed;
  bottom: 24px;
  right: 24px;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
  animation: slideIn 0.3s;
  z-index: 1000;
}

.error-banner {
  background: var(--color-danger);
  color: var(--text-on-primary, #ffffff);
}

.success-banner {
  background: var(--color-success);
  color: var(--text-on-primary, #ffffff);
}

.close-btn {
  background: none;
  border: none;
  color: inherit;
  font-size: 24px;
  cursor: pointer;
  padding: 0;
  width: 24px;
  height: 24px;
  display: flex;
  align-items: center;
  justify-content: center;
}

@keyframes slideIn {
  from {
    transform: translateX(100%);
    opacity: 0;
  }
  to {
    transform: translateX(0);
    opacity: 1;
  }
}

@media (max-width: 768px) {
  .stats-grid {
    grid-template-columns: 1fr;
  }

  .actions {
    flex-direction: column;
  }

  .btn-primary,
  .btn-secondary {
    width: 100%;
  }
}
</style>

