<template>
  <div class="server-encryption-settings">
    <div class="settings-section">
      <h2 class="section-title">{{ t('server.encryptionPolicy.title') }}</h2>
      <p class="section-description">
        {{ t('server.encryptionPolicy.description') }}
      </p>
    </div>

    <div v-if="loading" class="loading-state" role="status">
      <LoadingSpinner :size="40" />
      <p>{{ t('server.encryptionPolicy.loading') }}</p>
    </div>

    <div v-else class="settings-card">
      <!-- Current Status -->
      <div class="status-card" :class="statusClass">
        <div class="status-icon" aria-hidden="true">
          <Icon :name="statusIcon" :size="24" />
        </div>
        <div class="status-info">
          <p class="status-title">{{ statusTitle }}</p>
          <p>{{ statusDescription }}</p>
        </div>
      </div>

      <!-- Encryption Mode Selection -->
      <div class="setting-group">
        <div class="setting-label">
          <h3 :id="`${uid}-mode-label`" class="setting-heading">{{ t('server.encryptionPolicy.modeLabel') }}</h3>
          <span :id="`${uid}-mode-hint`" class="setting-hint">{{ t('server.encryptionPolicy.modeHint') }}</span>
        </div>

        <div
          class="mode-options"
          role="radiogroup"
          :aria-labelledby="`${uid}-mode-label`"
          :aria-describedby="`${uid}-mode-hint`"
          data-testid="encryption-mode-group"
        >
          <div
            v-for="mode in encryptionModes"
            :key="mode.value"
            class="mode-option"
            :class="{ selected: currentMode === mode.value }"
            @click="selectMode(mode.value)"
          >
            <div class="mode-header">
              <input
                type="radio"
                :id="`${uid}-mode-${mode.value}`"
                :name="`${uid}-mode`"
                :value="mode.value"
                :checked="currentMode === mode.value"
                :disabled="!canModify"
                :aria-describedby="mode.value === 'required'
                  ? `${uid}-mode-${mode.value}-desc ${uid}-mode-required-warning`
                  : `${uid}-mode-${mode.value}-desc`"
                @change="selectMode(mode.value)"
              />
              <label :for="`${uid}-mode-${mode.value}`">
                <span class="mode-icon" aria-hidden="true"><Icon :name="mode.icon" :size="18" /></span>
                <span class="mode-name">{{ mode.name }}</span>
              </label>
            </div>
            <p :id="`${uid}-mode-${mode.value}-desc`" class="mode-description">{{ mode.description }}</p>

            <div v-if="mode.value === 'required'" :id="`${uid}-mode-required-warning`" class="mode-warning">
              <span class="warning-icon" aria-hidden="true"><Icon name="alert-triangle" :size="16" /></span>
              <span>{{ t('server.encryptionPolicy.requiredWarning') }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Server-wide Settings -->
      <div class="setting-group">
        <div class="setting-label">
          <h3 class="setting-heading">{{ t('server.encryptionPolicy.additionalOptions') }}</h3>
        </div>

        <div class="checkbox-option">
          <input
            type="checkbox"
            :id="`${uid}-force-key-setup`"
            v-model="forceKeySetup"
            :disabled="!canModify || currentMode === 'disabled'"
            :aria-describedby="`${uid}-force-key-setup-hint`"
          />
          <label :for="`${uid}-force-key-setup`">
            <span class="option-name">{{ t('server.encryptionPolicy.forceKeySetup') }}</span>
            <span :id="`${uid}-force-key-setup-hint`" class="option-hint">{{ t('server.encryptionPolicy.forceKeySetupHint') }}</span>
          </label>
        </div>

        <p class="attachment-note">
          <Icon name="info" :size="14" aria-hidden="true" />
          <span>{{ t('server.encryptionPolicy.attachmentNote') }}</span>
        </p>

      </div>

      <!-- Voice / Video E2EE -->
      <div class="setting-group">
        <div class="setting-label">
          <h3 class="setting-heading">{{ t('server.encryptionPolicy.voiceTitle') }}</h3>
          <span class="setting-hint">{{ t('server.encryptionPolicy.voiceHint') }}</span>
        </div>

        <div class="checkbox-option">
          <input
            type="checkbox"
            :id="`${uid}-voice-e2ee`"
            :checked="voiceEncryptionMode === 'required'"
            :disabled="!canModify"
            :aria-describedby="voiceEncryptionMode === 'required'
              ? `${uid}-voice-e2ee-hint ${uid}-voice-e2ee-warning`
              : `${uid}-voice-e2ee-hint`"
            @change="voiceEncryptionMode = ($event.target as HTMLInputElement).checked ? 'required' : 'disabled'"
          />
          <label :for="`${uid}-voice-e2ee`">
            <span class="option-name">{{ t('server.encryptionPolicy.voiceRequire') }}</span>
            <span :id="`${uid}-voice-e2ee-hint`" class="option-hint">{{ t('server.encryptionPolicy.voiceRequireHint') }}</span>
          </label>
        </div>

        <div v-if="voiceEncryptionMode === 'required'" :id="`${uid}-voice-e2ee-warning`" class="mode-warning">
          <span class="warning-icon" aria-hidden="true"><Icon name="alert-triangle" :size="16" /></span>
          <span>{{ t('server.encryptionPolicy.voiceWarning') }}</span>
        </div>
      </div>

      <!-- Server Encryption Status -->
      <div class="setting-group">
        <div class="setting-label">
          <h3 class="setting-heading">{{ t('server.encryptionPolicy.statsTitle') }}</h3>
        </div>

        <dl class="stats-grid">
          <div class="stat-card">
            <dt class="stat-label">{{ t('server.encryptionPolicy.statsTotal') }}</dt>
            <dd class="stat-value">{{ memberStats.total }}</dd>
          </div>
          <div class="stat-card">
            <dt class="stat-label">{{ t('server.encryptionPolicy.statsWithKeys') }}</dt>
            <dd class="stat-value">{{ memberStats.withKeys }}</dd>
          </div>
          <div class="stat-card">
            <dt class="stat-label">{{ t('server.encryptionPolicy.statsCoverage') }}</dt>
            <dd class="stat-value">{{ memberStats.percentage }}%</dd>
          </div>
        </dl>

        <div v-if="memberStats.percentage < 100 && currentMode === 'required'" class="warning-banner">
          <span class="warning-icon" aria-hidden="true"><Icon name="alert-triangle" :size="16" /></span>
          <span>
            {{ t('server.encryptionPolicy.statsWarning', { count: memberStats.total - memberStats.withKeys }) }}
          </span>
        </div>
      </div>

      <!-- Actions handled by parent ServerSettings save button -->

      <!-- Help Section -->
      <div class="help-section">
        <h3 class="help-title">{{ t('server.encryptionPolicy.helpTitle') }}</h3>
        <ul>
          <li v-for="mode in encryptionModes" :key="mode.value">
            <i18n-t :keypath="`server.encryptionPolicy.help.${mode.value}`" tag="span">
              <template #mode><strong>{{ mode.name }}</strong></template>
            </i18n-t>
          </li>
        </ul>
        <p class="help-note">
          <strong>{{ t('server.encryptionPolicy.noteLabel') }}</strong>
          {{ t('server.encryptionPolicy.note') }}
        </p>
      </div>
    </div>

    <!-- Error Display -->
    <div v-if="error" class="error-banner">
      <span class="error-icon" aria-hidden="true"><Icon name="x-circle" :size="16" /></span>
      <span>{{ error }}</span>
      <button type="button" @click="error = null" class="close-btn" :aria-label="t('common.close')" :title="t('common.close')">
        <span aria-hidden="true">×</span>
      </button>
    </div>

    <!-- Success Display -->
    <div v-if="successMessage" class="success-banner">
      <span class="success-icon" aria-hidden="true"><Icon name="check-circle" :size="16" /></span>
      <span>{{ successMessage }}</span>
      <button type="button" @click="successMessage = null" class="close-btn" :aria-label="t('common.close')" :title="t('common.close')">
        <span aria-hidden="true">×</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { ref, computed, onMounted, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useAnnouncer } from '@/composables/useAnnouncer'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { supabase } from '@/supabase'
import { userDataService } from '@/services/userDataService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useConfirmDialog } from '@/composables/useConfirmDialog'

interface Props {
  serverId: string
}

type EncryptionMode = 'disabled' | 'optional' | 'required'

const props = defineProps<Props>()
const { t } = useI18n()
const uid = `ses-${useId()}`
const { polite, assertive } = useAnnouncer()
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

const MODE_ICONS: Record<EncryptionMode, string> = { disabled: 'unlock', optional: 'lock', required: 'shield-check' }

const encryptionModes = computed(() =>
  (['disabled', 'optional', 'required'] as const).map((value) => ({
    value,
    name: t(`server.encryptionPolicy.modes.${value}.name`),
    icon: MODE_ICONS[value],
    description: t(`server.encryptionPolicy.modes.${value}.description`),
  })),
)

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

const statusTitle = computed(() => t(`server.encryptionPolicy.status.${currentMode.value}.title`))

const statusDescription = computed(() => t(`server.encryptionPolicy.status.${currentMode.value}.description`))

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
    error.value = err.message || t('server.encryptionPolicy.loadFailed')
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

function selectMode(mode: EncryptionMode) {
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
        title: t('server.encryptionPolicy.confirmDisable.title'),
        message: t('server.encryptionPolicy.confirmDisable.message'),
        confirmButtonText: t('server.encryptionPolicy.confirmDisable.confirm'),
        dangerAction: true,
      })
      if (!confirmed) {
        saving.value = false
        return
      }
    }

    if (currentMode.value === 'required' && memberStats.value.percentage < 50) {
      const confirmed = await confirm({
        title: t('server.encryptionPolicy.confirmRequired.title'),
        message: t('server.encryptionPolicy.confirmRequired.message', { percentage: memberStats.value.percentage }),
        confirmButtonText: t('common.continue'),
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

    successMessage.value = t('server.encryptionPolicy.saved')
    
    setTimeout(() => {
      successMessage.value = null
    }, 3000)

    debug.log('Encryption settings saved')
  } catch (err: any) {
    debug.error('Failed to save encryption settings:', err)
    error.value = err.message || t('server.encryptionPolicy.saveFailed')
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

// The banners appear with their text; the announcer's persistent regions speak it.
watch(error, (text) => { if (text) assertive(text) })
watch(successMessage, (text) => { if (text) polite(text) })

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

.status-info .status-title {
  margin: 0 0 4px 0;
  color: var(--text-primary);
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

.setting-heading {
  margin: 0;
  font-size: inherit;
  font-weight: inherit;
  color: inherit;
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
  margin: 0 0 16px;
}

.stat-card {
  display: flex;
  flex-direction: column;
  padding: 16px;
  background: var(--surface-inset);
  border-radius: var(--radius-md);
  text-align: center;
}

.stat-value {
  margin-left: 0;
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-link);
  margin-bottom: 4px;
}

.stat-label {
  order: 1;
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
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  border: none;
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
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

.help-section .help-title {
  font-size: var(--font-size-base);
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
  background: var(--error-fill);
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

