<template>
  <div class="server-encryption-settings">
    <div class="settings-section">
      <h2 class="section-title">Server encryption policy</h2>
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
          <Icon :name="statusIcon" :size="24" />
        </div>
        <div class="status-info">
          <h4>{{ statusTitle }}</h4>
          <p>{{ statusDescription }}</p>
        </div>
      </div>

      <!-- Encryption Mode Selection -->
      <div class="setting-group">
        <label class="setting-label">
          Encryption mode
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
                <span class="mode-icon"><Icon :name="mode.icon" :size="18" /></span>
                <span class="mode-name">{{ mode.name }}</span>
              </label>
            </div>
            <p class="mode-description">{{ mode.description }}</p>
            
            <div v-if="mode.value === 'required'" class="mode-warning">
              <span class="warning-icon"><Icon name="alert-triangle" :size="16" /></span>
              <span>Users without encryption keys won't be able to send messages</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Server-wide Settings -->
      <div class="setting-group">
        <label class="setting-label">Additional options</label>

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

        <p class="attachment-note">
          <Icon name="info" :size="14" />
          <span>In encrypted channels, file links, names and types are encrypted with the message. The files themselves are stored unencrypted.</span>
        </p>

      </div>

      <!-- Voice / Video E2EE -->
      <div class="setting-group">
        <label class="setting-label">
          Voice &amp; video encryption
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
            <span class="option-name">Require end-to-end encrypted voice and video</span>
            <span class="option-hint">Every voice channel encrypts calls before they reach the media server. Without this, channel managers choose per voice channel.</span>
          </label>
        </div>

        <div v-if="voiceEncryptionMode === 'required'" class="mode-warning">
          <span class="warning-icon"><Icon name="alert-triangle" :size="16" /></span>
          <span>Participants who haven't set up encryption (and federated/legacy clients) will be unable to join encrypted calls.</span>
        </div>
      </div>

      <!-- Server Encryption Status -->
      <div class="setting-group">
        <label class="setting-label">Server statistics</label>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.total }}</div>
            <div class="stat-label">Total members</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.withKeys }}</div>
            <div class="stat-label">With encryption</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ memberStats.percentage }}%</div>
            <div class="stat-label">Coverage</div>
          </div>
        </div>

        <div v-if="memberStats.percentage < 100 && currentMode === 'required'" class="warning-banner">
          <span class="warning-icon"><Icon name="alert-triangle" :size="16" /></span>
          <span>
            {{ memberStats.total - memberStats.withKeys }} members need to set up encryption before required mode can function properly
          </span>
        </div>
      </div>

      <!-- Actions handled by parent ServerSettings save button -->

      <!-- Help Section -->
      <div class="help-section">
        <h4>About end-to-end encryption</h4>
        <ul>
          <li><strong>Disabled:</strong> channels can't turn on encryption, and messages are stored as plaintext.</li>
          <li><strong>Optional:</strong> channel managers turn encryption on per channel. New channels start unencrypted.</li>
          <li><strong>Required:</strong> every channel is encrypted, and members need encryption keys to post.</li>
        </ul>
        <p class="help-note">
          <strong>Note:</strong> End-to-end encryption means the server cannot read message content.
          This provides maximum privacy but disables server-side features like search and content moderation.
        </p>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="error" class="error-banner">
      <span class="error-icon"><Icon name="x-circle" :size="16" /></span>
      <span>{{ error }}</span>
      <button @click="error = null" class="close-btn">×</button>
    </div>

    <!-- Success Display -->
    <div v-if="successMessage" class="success-banner">
      <span class="success-icon"><Icon name="check-circle" :size="16" /></span>
      <span>{{ successMessage }}</span>
      <button @click="successMessage = null" class="close-btn">×</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { ref, computed, onMounted } from 'vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { userDataService } from '@/services/userDataService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

interface Props {
  serverId: string
}

const props = defineProps<Props>()
const { confirm } = useConfirmDialog()
const serverChannelStore = useServerChannelStore()

// State
const loading = ref(true)
const saving = ref(false)
const error = ref<string | null>(null)
const successMessage = ref<string | null>(null)

// No policy row resolves as 'disabled' (channel_messages_encrypted).
const currentMode = ref<'disabled' | 'optional' | 'required'>('disabled')
const originalMode = ref<'disabled' | 'optional' | 'required'>('disabled')
// The UI shows required_local_only as required; saving keeps the stored variant.
const storedRequiredMode = ref<'required' | 'required_local_only'>('required')
const forceKeySetup = ref(false)
const originalForceKeySetup = ref(false)
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
    icon: 'unlock',
    description: "Channels can't turn on encryption. The server can read every message."
  },
  {
    value: 'optional',
    name: 'Optional',
    icon: 'lock',
    description: 'Channel managers turn encryption on per channel. New channels start unencrypted.'
  },
  {
    value: 'required',
    name: 'Required',
    icon: 'shield-check',
    description: "Every channel is encrypted and can't be turned off. Members need encryption keys to post."
  }
]

// Computed
// server_encryption_settings_modify admits the server owner only.
const canModify = computed(() => {
  const currentUser = userDataService.getCurrentUser()
  const server = serverChannelStore.servers.find(sv => sv.id === props.serverId)
  return !!currentUser?.id && !!server?.owner && server.owner === currentUser.id
})

const hasChanges = computed(() => {
  return currentMode.value !== originalMode.value ||
         forceKeySetup.value !== originalForceKeySetup.value ||
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
    case 'disabled': return 'unlock'
    case 'optional': return 'lock'
    case 'required': return 'shield-check'
    default: return 'help-circle'
  }
})

const statusTitle = computed(() => {
  switch (currentMode.value) {
    case 'disabled': return 'Encryption disabled'
    case 'optional': return 'Optional encryption'
    case 'required': return 'Encryption required'
    default: return 'Unknown'
  }
})

const statusDescription = computed(() => {
  switch (currentMode.value) {
    case 'disabled':
      return 'Messages are stored as plaintext. Server operators can read them.'
    case 'optional':
      return 'Each channel is encrypted or not, as its channel managers choose.'
    case 'required':
      return 'Every channel is end-to-end encrypted.'
    default:
      return ''
  }
})

// Methods
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

    const mode = policy?.encryption_mode
    storedRequiredMode.value = mode === 'required_local_only' ? 'required_local_only' : 'required'
    currentMode.value = mode === 'optional'
      ? 'optional'
      : mode === 'required' || mode === 'required_local_only' ? 'required' : 'disabled'
    forceKeySetup.value = policy?.force_key_setup === true
    voiceEncryptionMode.value = policy?.voice_encryption_mode === 'required' ? 'required' : 'disabled'

    originalMode.value = currentMode.value
    originalForceKeySetup.value = forceKeySetup.value
    originalVoiceEncryptionMode.value = voiceEncryptionMode.value

    await loadMemberStats()

    debug.log('Encryption settings loaded')
  } catch (err: any) {
    debug.error('Failed to load encryption settings:', err)
    error.value = err.message || 'Failed to load settings'
  } finally {
    loading.value = false
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
  }
}

async function saveSettings() {
  if (!canModify.value || saving.value) return

  saving.value = true
  error.value = null
  successMessage.value = null

  try {
    if (currentMode.value === 'disabled' && originalMode.value !== 'disabled') {
      const confirmed = await confirm({
        title: 'Disable encryption',
        message: 'Channels with encryption turned on will send new messages as plaintext. Earlier encrypted messages stay encrypted.',
        confirmButtonText: 'Disable encryption',
        dangerAction: true,
      })
      if (!confirmed) {
        saving.value = false
        return
      }
    }

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
      encryption_mode: currentMode.value === 'required' ? storedRequiredMode.value : currentMode.value,
      force_key_setup: forceKeySetup.value,
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
    originalVoiceEncryptionMode.value = voiceEncryptionMode.value

    successMessage.value = 'Encryption settings saved'
    
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

// Lifecycle
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
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.section-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.settings-card {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
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
  border-radius: var(--radius-lg);
  margin-bottom: 24px;
  border: 2px solid;
}

.status-card.status-disabled {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-color: var(--error);
}

.status-card.status-optional {
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-color: var(--warning);
}

.status-card.status-required {
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border-color: var(--success);
}

.status-icon {
  font-size: 32px;
}

.status-info h4 {
  margin: 0 0 4px 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
}

.status-info p {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.setting-group {
  margin-bottom: 32px;
}

.setting-label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-weight: var(--font-weight-semibold);
  margin-bottom: 16px;
  color: var(--text-primary);
}

.setting-hint {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-normal);
  color: var(--text-secondary);
}

.mode-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mode-option {
  padding: 16px;
  border: 2px solid var(--border-primary);
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.mode-option:hover {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 5%, transparent);
}

.mode-option.selected {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
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
  font-size: var(--font-size-xl);
}

.mode-name {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.mode-description {
  margin: 0 0 0 32px;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.mode-warning {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 12px 0 0 32px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: var(--radius-base);
  font-size: 13px;
  color: var(--warning);
}

.warning-icon {
  font-size: var(--font-size-base);
}

.checkbox-option {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 12px;
  border-radius: var(--radius-base);
  margin-bottom: 8px;
}

.checkbox-option:hover {
  background: color-mix(in srgb, var(--harmony-primary) 5%, transparent);
}

.attachment-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin: 0 0 8px;
  padding: 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.attachment-note :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}

.checkbox-option label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  cursor: pointer;
  flex: 1;
}

.option-name {
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.option-hint {
  font-size: 13px;
  color: var(--text-secondary);
}




.stats-grid {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 12px;
  margin-bottom: 16px;
}

.stat-card {
  padding: 16px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  text-align: center;
}

.stat-value {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  color: var(--harmony-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: 13px;
  color: var(--text-secondary);
}

.warning-banner {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-left: 4px solid var(--warning);
  border-radius: var(--radius-base);
  color: var(--warning);
  font-size: var(--font-size-sm);
}

.actions {
  display: flex;
  gap: 12px;
  margin-top: 24px;
}

.btn-primary,
.btn-secondary {
  padding: 12px 24px;
  border-radius: var(--radius-base);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  border: none;
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.btn-primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-primary);
  border: 1px solid var(--border-primary);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}

.btn-secondary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.help-section {
  margin-top: 32px;
  padding: 20px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
}

.help-section h4 {
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.help-section ul {
  margin: 0 0 12px 0;
  padding-left: 20px;
}

.help-section li {
  margin-bottom: 8px;
  color: var(--text-secondary);
}

.help-note {
  margin: 0;
  padding: 12px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-left: 4px solid var(--harmony-primary);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
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
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-medium);
  z-index: 1000;
}

@media (prefers-reduced-motion: no-preference) {
  .error-banner,
  .success-banner {
    animation: slideIn 0.3s;
  }
}

.error-banner {
  background: var(--error);
  color: var(--text-on-primary);
}

.success-banner {
  background: var(--success);
  color: var(--text-on-primary);
}

.close-btn {
  background: none;
  border: none;
  color: inherit;
  font-size: var(--font-size-2xl);
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

