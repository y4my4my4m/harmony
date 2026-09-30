<template>
  <BaseModal 
    :show="show"
    :title="$t('channel.create')"
    :subtitle="$t('channel.createNew')"
    icon="hash"
    @close="closeForm"
  >
    <form @submit.prevent="createChannel" class="channel-form">
      <ModernInput
        v-model="newChannelName"
        :label="$t('channel.channelName')"
        :placeholder="$t('channel.placeholders.channelName')"
        :max-length="100"
        :show-char-count="true"
        :error-message="channelNameError"
        :hint="channelNameHint"
        autofocus
        required
        @input="validateChannelName"
      />
      <!-- NOTE: Removed @enter handler - form @submit.prevent handles Enter key.
           Having both caused double channel creation! -->
      
      <div class="channel-type-section">
        <label class="section-label">{{ $t('channel.channelType') }}</label>
        <div class="channel-type-grid">
          <div 
            class="channel-type-option"
            :class="{ active: channelType === 0 }"
            @click="setChannelType(0)"
          >
            <div class="option-icon text-channel">
              <Icon name="hash" :size="24" />
            </div>
            <div class="option-content">
              <h4 class="option-title">{{ $t('channel.text') }}</h4>
              <p class="option-description">{{ $t('channel.textDesc') }}</p>
            </div>
            <div class="option-check" v-if="channelType === 0">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </div>
          </div>
          
          <div 
            class="channel-type-option"
            :class="{ active: channelType === 1 }"
            @click="setChannelType(1)"
          >
            <div class="option-icon voice-channel">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14C13.66 14 15 12.66 15 11V5C15 3.34 13.66 2 12 2S9 3.34 9 5V11C9 12.66 10.34 14 12 14M19 11C19 14.53 16.39 17.44 13 17.93V21H11V17.93C7.61 17.44 5 14.53 5 11H7A5 5 0 0 0 12 16A5 5 0 0 0 17 11H19Z"/>
              </svg>
            </div>
            <div class="option-content">
              <h4 class="option-title">{{ $t('channel.voice') }}</h4>
              <p class="option-description">{{ $t('channel.voiceDesc') }}</p>
            </div>
            <div class="option-check" v-if="channelType === 1">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </div>
          </div>
        </div>
      </div>
      
      <div v-if="encryptionPolicy !== 'disabled'" class="encryption-option">
        <div class="encryption-option-text">
          <span class="section-label">{{ $t('channelEncryption.create.label') }}</span>
          <span class="encryption-option-hint">
            {{ encryptionRequired ? $t('channelEncryption.settings.serverRequired') : $t('channelEncryption.create.hint') }}
          </span>
        </div>
        <ToggleSwitch
          :model-value="encryptOnCreate"
          :disabled="encryptionRequired"
          :class="{ disabled: encryptionRequired }"
          role="switch"
          :aria-checked="encryptOnCreate"
          :aria-label="$t('channelEncryption.create.label')"
          :aria-disabled="encryptionRequired"
          :tabindex="encryptionRequired ? -1 : 0"
          @change="(value: boolean) => { encryptOnCreate = value }"
          @keydown.enter.prevent="toggleEncryptOnCreate"
          @keydown.space.prevent="toggleEncryptOnCreate"
        />
      </div>
      <div v-if="encryptOnCreate && botCount > 0" class="encryption-warning" role="note">
        <Icon name="alert-triangle" :size="14" />
        <span>{{ $t('channelEncryption.create.integrationWarning') }}</span>
      </div>

      <div v-if="categoryId" class="category-info">
        <div class="info-badge">
          <svg class="info-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4V6C21 6.55228 20.5523 7 20 7H4C3.44772 7 3 6.55228 3 6V4Z"/>
          </svg>
          <span>{{ $t('channel.willBeAddedToCategory') }}</span>
        </div>
      </div>
    </form>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton
          variant="ghost"
          :text="$t('common.cancel')"
          @click="closeForm"
        />
        <UnifiedButton
          variant="primary"
          :text="$t('channel.createButton')"
          :disabled="!canCreate"
          :loading="isCreating"
          @click="createChannel"
        />
      </div>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n'
import BaseModal from '@/components/common/BaseModal.vue'
import ModernInput from '@/components/common/ModernInput.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import Icon from '@/components/common/Icon.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import { supabase } from '@/supabase'
import { useToast } from 'vue-toastification'
import { setChannelEncryption } from '@/services/ChannelEncryptionService'
import { isRequiredMode, normalizeServerMode, type ServerEncryptionMode } from '@/utils/channelEncryption'

// Max channels per server
const MAX_CHANNELS_PER_SERVER = 100

const { t } = useI18n()

interface Props {
  serverId: string
  show: boolean
  categoryId?: string | null
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  channelCreated: [channel: any]
}>()

const toast = useToast()

const newChannelName = ref('')
const channelType = ref(0) // Default to text channel

// Server floor: 'disabled' hides the option, a required mode fixes it on.
const encryptionPolicy = ref<ServerEncryptionMode>('disabled')
const encryptOnCreate = ref(false)
const botCount = ref(0)
const encryptionRequired = computed(() => isRequiredMode(encryptionPolicy.value))

const toggleEncryptOnCreate = () => {
  if (!encryptionRequired.value) encryptOnCreate.value = !encryptOnCreate.value
}

const loadEncryptionPolicy = async () => {
  if (!props.serverId) return
  const [{ data: policy }, { count }] = await Promise.all([
    supabase
      .from('server_encryption_settings')
      .select('encryption_mode')
      .eq('server_id', props.serverId)
      .maybeSingle(),
    supabase
      .from('bot_server_permissions')
      .select('id', { count: 'exact', head: true })
      .eq('server_id', props.serverId)
      .eq('is_active', true),
  ])
  encryptionPolicy.value = normalizeServerMode(policy?.encryption_mode)
  encryptOnCreate.value = isRequiredMode(encryptionPolicy.value)
  botCount.value = count || 0
}
const channelNameError = ref('')
const isCreating = ref(false)
const currentChannelCount = ref(0)
const isCheckingLimit = ref(false)

// Check channel count when modal opens
const checkChannelCount = async () => {
  if (!props.serverId) return
  
  isCheckingLimit.value = true
  try {
    const { count, error } = await supabase
      .from('channels')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', props.serverId)
    
    if (error) {
      debug.error('Error checking channel count:', error)
      return
    }
    
    currentChannelCount.value = count || 0
    
    // If already at limit, show error immediately
    if (currentChannelCount.value >= MAX_CHANNELS_PER_SERVER) {
      channelNameError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
    }
  } catch (error) {
    debug.error('Error checking channel count:', error)
  } finally {
    isCheckingLimit.value = false
  }
}

// Check limit when modal opens
watch(() => props.show, (newShow) => {
  if (newShow) {
    checkChannelCount()
    loadEncryptionPolicy().catch(error => debug.error('Error loading encryption policy:', error))
  } else {
    channelNameError.value = ''
    currentChannelCount.value = 0
  }
}, { immediate: true })

const isAtChannelLimit = computed(() => currentChannelCount.value >= MAX_CHANNELS_PER_SERVER)

const canCreate = computed(() => {
  return newChannelName.value.trim().length > 0 && 
         !channelNameError.value && 
         newChannelName.value.trim().length <= 100 &&
         !isAtChannelLimit.value &&
         !isCheckingLimit.value
})

const channelNameHint = computed(() => {
  if (newChannelName.value.length === 0) {
    return channelType.value === 0 
      ? 'Use lowercase letters, numbers, and dashes'
      : 'Choose a name that describes your voice channel'
  }
  
  if (channelNameError.value) {
    return ''
  }
  
  return 'Looks good'
})

const formatChannelName = (name: string): string => {
  if (channelType.value === 0) {
    // For text channels, convert to  format
    return name
      .toLowerCase()
      .replace(/\s+/g, '-')
      .replace(/[^a-z0-9\-_]/g, '')
      .replace(/--+/g, '-')
      .replace(/^-+|-+$/g, '')
  } else {
    // For voice channels, allow normal naming
    return name.trim()
  }
}

const validateChannelName = () => {
  const name = newChannelName.value.trim()
  
  if (!name) {
    channelNameError.value = 'Channel name is required'
    return
  }
  
  if (name.length < 1) {
    channelNameError.value = 'Channel name must be at least 1 character'
    return
  }
  
  if (name.length > 100) {
    channelNameError.value = 'Channel name must be 100 characters or less'
    return
  }
  
  if (channelType.value === 0) {
    // Text channel validation
    const formatted = formatChannelName(name)
    if (!formatted) {
      channelNameError.value = 'Channel name must contain at least one valid character'
      return
    }
    
    if (formatted.length > 100) {
      channelNameError.value = 'Channel name is too long after formatting'
      return
    }
    
    // Auto-format the name
    newChannelName.value = formatted
  } else {
    // Voice channel validation - more lenient
    if (!/^[a-zA-Z0-9\s\-_.,!?()[\]]+$/.test(name)) {
      channelNameError.value = 'Voice channel name contains invalid characters'
      return
    }
  }
  
  channelNameError.value = ''
}

const setChannelType = (type: number) => {
  channelType.value = type
  // Re-validate when type changes
  if (newChannelName.value.trim()) {
    validateChannelName()
  }
}

const createChannel = async () => {
  if (!canCreate.value) return

  // Check limit again before creating (in case it changed)
  if (isAtChannelLimit.value) {
    channelNameError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
    return
  }

  validateChannelName()
  if (channelNameError.value) return

  isCreating.value = true
  
  try {
    // Double-check count before inserting (race condition protection)
    const { count } = await supabase
      .from('channels')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', props.serverId)
    
    if ((count || 0) >= MAX_CHANNELS_PER_SERVER) {
      channelNameError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
      return
    }

    const channelData = {
      name: newChannelName.value.trim(),
      server_id: props.serverId,
      type: channelType.value,
      category: props.categoryId
    }

    const { data, error } = await supabase
      .from('channels')
      .insert([channelData])
      .select('*')
      .single()

    if (error) throw error

    // A new channel starts at the server floor; 'optional' starts off.
    if (encryptOnCreate.value && encryptionPolicy.value === 'optional') {
      try {
        await setChannelEncryption(data.id, { messagesEncrypted: true })
      } catch (encryptionError: any) {
        debug.error('Error turning on channel encryption:', encryptionError)
        toast.error(t('channelEncryption.create.failed'))
      }
    }

    emit('channelCreated', data)
    closeForm()
  } catch (error) {
    debug.error('Error creating channel:', error)
    channelNameError.value = t('channel.errors.createFailed')
  } finally {
    isCreating.value = false
  }
}

const closeForm = () => {
  newChannelName.value = ''
  channelType.value = 0
  channelNameError.value = ''
  encryptOnCreate.value = isRequiredMode(encryptionPolicy.value)
  emit('close')
}
</script>

<style scoped>
.channel-form {
  display: flex;
  flex-direction: column;
  gap: 24px;
  margin-bottom: 24px;
}

.channel-type-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-label {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0;
}

.channel-type-grid {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.channel-type-option {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background:  var(--background-quinary);
  border: 2px solid transparent;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  position: relative;
}

.channel-type-option:hover {
  background: color-mix(in srgb, var(--text-primary) 8%, var(--background-quinary));
  border-color: var(--border-hover);
}

.channel-type-option.active {
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border-color: var(--harmony-primary);
}

.option-icon {
  width: 48px;
  height: 48px;
  border-radius: 12px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  color: var(--text-on-primary);
}

.text-channel {
  background: var(--success);
}

.voice-channel {
  background: var(--harmony-primary);
}

.option-icon svg {
  width: 24px;
  height: 24px;
}

.option-content {
  flex: 1;
  min-width: 0;
}

.option-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 4px;
}

.option-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.3;
}

.option-check {
  width: 24px;
  height: 24px;
  background: var(--success);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.option-check svg {
  width: 16px;
  height: 16px;
  color: var(--text-on-primary);
}

.encryption-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.encryption-option-text {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.encryption-option-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.encryption-warning {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 8px 12px;
  margin-top: -12px;
  font-size: var(--font-size-xs);
  line-height: 1.4;
  color: var(--warning);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border-radius: var(--radius-base);
}

.category-info {
  display: flex;
  align-items: center;
  justify-content: center;
}

.info-badge {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background: color-mix(in srgb, var(--harmony-primary) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
  border-radius: 16px;
  font-size: 12px;
  color: var(--harmony-primary);
  font-weight: 500;
}

.info-icon {
  width: 16px;
  height: 16px;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}

/* Responsive design */
@media (max-width: 480px) {
  .channel-type-option {
    flex-direction: column;
    text-align: center;
    gap: 12px;
  }
  
  .option-content {
    text-align: center;
  }
  
  .modal-actions {
    flex-direction: column-reverse;
    gap: 8px;
  }
  
  .modal-actions .modern-button {
    width: 100%;
  }
}

@media (prefers-reduced-motion: no-preference) {
  .channel-type-option {
    animation: slideInUp 0.3s ease-out;
  }

  .channel-type-option:nth-child(2) {
    animation-delay: 0.1s;
  }
}

@keyframes slideInUp {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
</style>
