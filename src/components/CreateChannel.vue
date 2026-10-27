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
        :max-length="NAME_MAX_LENGTH"
        :show-char-count="true"
        :error-message="channelNameError"
        :hint="channelNameHint"
        autofocus
        required
        @input="validateChannelName"
      />
      <!-- NOTE: Removed @enter handler - form @submit.prevent handles Enter key.
           Having both caused double channel creation! -->
      
      <fieldset class="channel-type-section">
        <legend class="section-label">{{ $t('channel.channelType') }}</legend>
        <div class="channel-type-grid">
          <label class="channel-type-option" :class="{ active: channelType === 0 }">
            <input
              v-model="channelType"
              type="radio"
              class="channel-type-radio sr-only"
              :name="typeGroupName"
              :value="0"
              :aria-labelledby="`${typeGroupName}-text`"
              :aria-describedby="`${typeGroupName}-text-desc`"
              data-testid="channel-type-text"
            />
            <span class="option-icon text-channel" aria-hidden="true">
              <Icon name="hash" :size="24" />
            </span>
            <span class="option-content">
              <span :id="`${typeGroupName}-text`" class="option-title">{{ $t('channel.text') }}</span>
              <span :id="`${typeGroupName}-text-desc`" class="option-description">{{ $t('channel.textDesc') }}</span>
            </span>
            <span v-if="channelType === 0" class="option-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </span>
          </label>

          <label class="channel-type-option" :class="{ active: channelType === 1 }">
            <input
              v-model="channelType"
              type="radio"
              class="channel-type-radio sr-only"
              :name="typeGroupName"
              :value="1"
              :aria-labelledby="`${typeGroupName}-voice`"
              :aria-describedby="`${typeGroupName}-voice-desc`"
              data-testid="channel-type-voice"
            />
            <span class="option-icon voice-channel" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 14C13.66 14 15 12.66 15 11V5C15 3.34 13.66 2 12 2S9 3.34 9 5V11C9 12.66 10.34 14 12 14M19 11C19 14.53 16.39 17.44 13 17.93V21H11V17.93C7.61 17.44 5 14.53 5 11H7A5 5 0 0 0 12 16A5 5 0 0 0 17 11H19Z"/>
              </svg>
            </span>
            <span class="option-content">
              <span :id="`${typeGroupName}-voice`" class="option-title">{{ $t('channel.voice') }}</span>
              <span :id="`${typeGroupName}-voice-desc`" class="option-description">{{ $t('channel.voiceDesc') }}</span>
            </span>
            <span v-if="channelType === 1" class="option-check" aria-hidden="true">
              <svg viewBox="0 0 24 24" fill="currentColor">
                <path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/>
              </svg>
            </span>
          </label>
        </div>
      </fieldset>
      
      <div class="encryption-option">
        <div class="encryption-option-text">
          <span class="section-label">{{ $t('channel.private.label') }}</span>
          <span class="encryption-option-hint">{{ $t('channel.private.hint') }}</span>
        </div>
        <ToggleSwitch
          :model-value="isPrivate"
          :label="$t('channel.private.label')"
          @change="(value: boolean) => { isPrivate = value }"
        />
      </div>
      <div v-if="isPrivate" class="private-roles">
        <span class="encryption-option-hint">{{ $t('channel.private.whoCanSee') }}</span>
        <div class="private-role-list">
          <label v-for="role in assignableRoles" :key="role.id" class="private-role">
            <input v-model="allowedRoleIds" type="checkbox" :value="role.id" />
            <span class="role-dot" :style="{ background: role.color || '#99aab5' }"></span>
            <span>{{ role.name }}</span>
          </label>
          <span v-if="assignableRoles.length === 0" class="encryption-option-hint">{{ $t('channel.private.noRoles') }}</span>
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
          :label="$t('channelEncryption.create.label')"
          :aria-disabled="encryptionRequired"
          :tabindex="encryptionRequired ? -1 : 0"
          @change="(value: boolean) => { encryptOnCreate = value }"
          @keydown.enter.prevent="toggleEncryptOnCreate"
          @keydown.space.prevent="toggleEncryptOnCreate"
        />
      </div>
      <div v-if="channelType === 1" class="encryption-option" data-testid="create-voice-encryption">
        <div class="encryption-option-text">
          <span class="section-label">{{ $t('channelEncryption.create.voiceLabel') }}</span>
          <span class="encryption-option-hint">
            {{ voiceEncryptionRequired ? $t('channelEncryption.settings.voiceRequired') : $t('channelEncryption.create.voiceHint') }}
          </span>
        </div>
        <ToggleSwitch
          :model-value="encryptVoiceOnCreate"
          :disabled="voiceEncryptionRequired"
          :class="{ disabled: voiceEncryptionRequired }"
          :label="$t('channelEncryption.create.voiceLabel')"
          :aria-disabled="voiceEncryptionRequired"
          :tabindex="voiceEncryptionRequired ? -1 : 0"
          @change="(value: boolean) => { encryptVoiceOnCreate = value }"
          @keydown.enter.prevent="toggleEncryptVoiceOnCreate"
          @keydown.space.prevent="toggleEncryptVoiceOnCreate"
        />
      </div>
      <div v-if="encryptOnCreate && botCount > 0" class="encryption-warning" role="note">
        <Icon name="alert-triangle" :size="14" />
        <span>{{ $t('channelEncryption.create.integrationWarning') }}</span>
      </div>
      <div v-if="offersHistory" class="encryption-option" data-testid="create-history-visibility">
        <div class="encryption-option-text">
          <label :for="`${optionsId}-history`" class="section-label">{{ $t('channelEncryption.settings.historyLabel') }}</label>
          <span class="encryption-option-hint">{{ historyHint }}</span>
        </div>
        <select :id="`${optionsId}-history`" v-model="historyVisibility" class="option-select">
          <option value="all">{{ $t('channelEncryption.settings.historyAll') }}</option>
          <option value="pinned">{{ $t('channelEncryption.settings.historyPinned') }}</option>
          <option value="none">{{ $t('channelEncryption.settings.historyNone') }}</option>
        </select>
      </div>

      <div v-if="createOptions" class="more-options">
        <button
          type="button"
          class="more-options-toggle"
          :aria-expanded="moreOpen ? 'true' : 'false'"
          :aria-controls="`${optionsId}-more`"
          data-testid="create-channel-more"
          @click="moreOpen = !moreOpen"
        >
          <Icon :name="moreOpen ? 'chevron-down' : 'chevron-right'" :size="16" />
          <span>{{ $t('channel.createOptions.more') }}</span>
        </button>
        <div v-show="moreOpen" :id="`${optionsId}-more`" class="more-options-body">
          <div class="option-field">
            <label :for="`${optionsId}-description`" class="section-label">{{ $t('channel.edit.description') }}</label>
            <textarea
              :id="`${optionsId}-description`"
              v-model="description"
              class="option-textarea"
              :placeholder="$t('channel.edit.descriptionPlaceholder')"
              maxlength="1024"
              rows="2"
            />
          </div>
          <div v-if="channelType === 0" class="option-field">
            <label :for="`${optionsId}-slowmode`" class="section-label">{{ $t('channel.edit.slowmode') }}</label>
            <div class="slowmode-control">
              <input
                :id="`${optionsId}-slowmode`"
                v-model.number="slowmodeIndex"
                type="range"
                min="0"
                :max="SLOWMODE_STEPS.length - 1"
                step="1"
                class="slowmode-slider"
                :aria-valuetext="formatSlowmode(t, slowmodeSeconds, 'long')"
                :aria-describedby="`${optionsId}-slowmode-hint`"
              />
              <span class="slowmode-value" aria-hidden="true">{{ formatSlowmode(t, slowmodeSeconds, 'short') }}</span>
            </div>
            <span :id="`${optionsId}-slowmode-hint`" class="encryption-option-hint">{{ $t('channel.edit.slowmodeHint') }}</span>
          </div>
        </div>
      </div>

      <div v-if="categoryId" class="category-info">
        <div class="info-badge">
          <svg class="info-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M3 4C3 3.44772 3.44772 3 4 3H20C20.5523 3 21 3.44772 21 4V6C21 6.55228 20.5523 7 20 7H4C3.44772 7 3 6.55228 3 6V4Z"/>
          </svg>
          <span>{{ privateCategoryName ? $t('category.private.channelFollows', { category: privateCategoryName }) : $t('channel.willBeAddedToCategory') }}</span>
        </div>
      </div>

      <p v-if="formError" class="form-error" role="alert" data-testid="create-channel-error">
        {{ formError }}
      </p>
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
import { setChannelEncryption, type ChannelEncryptionChange } from '@/services/ChannelEncryptionService'
import { roleService, type ServerRole } from '@/services/RoleService'
import { useServerChannelStore } from '@/stores/useServerChannel'
import {
  isRequiredMode,
  normalizeServerMode,
  normalizeVoiceMode,
  type ServerEncryptionMode,
  type VoiceEncryptionMode,
} from '@/utils/channelEncryption'
import { NAME_MAX_LENGTH, finalizeChannelNameFor, formatChannelNameFor, nameLength, namesKeepSpaces } from '@/utils/channelName'
import { SLOWMODE_STEPS, formatSlowmode } from '@/utils/slowmode'
import { hasCapability } from '@/services/instanceCapabilities'
import type { HistoryVisibility } from '@/utils/channelEncryption'
import { uid } from '@/utils/a11y/focus'

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
const serverChannelStore = useServerChannelStore()

const newChannelName = ref('')
const channelType = ref(0) // Default to text channel
const typeGroupName = uid('channel-type')
const optionsId = uid('channel-options')

// Description, slowmode and encryption go in the create_channel call. An instance before 1.9.1
// takes the six arguments of 1.9.0 and encryption afterwards, and More options stays hidden.
const createOptions = computed(() => hasCapability('channel-create-options'))
const moreOpen = ref(false)
const description = ref('')
const slowmodeIndex = ref(0)
const slowmodeSeconds = computed(() => SLOWMODE_STEPS[slowmodeIndex.value] ?? 0)
const historyVisibility = ref<HistoryVisibility>('all')

// Private: @everyone loses View Channel; the chosen roles keep it (create_channel).
const isPrivate = ref(false)
const allowedRoleIds = ref<string[]>([])
const serverRoles = ref<ServerRole[]>([])
const assignableRoles = computed(() => serverRoles.value.filter(r => !r.is_default))

// A channel in a private category starts with the category's permissions (create_channel).
const privateCategoryName = computed(() => {
  if (!props.categoryId || !serverChannelStore.isPrivateCategory(props.categoryId)) return null
  return serverChannelStore.categories.find(c => c.id === props.categoryId)?.name ?? null
})
const loadRoles = async () => {
  if (!props.serverId) return
  const roles = await roleService.getRolesForServer(props.serverId)
  serverRoles.value = [...roles].sort((a, b) => b.position - a.position)
}

// Server floor: 'disabled' hides the option, a required mode fixes it on.
const encryptionPolicy = ref<ServerEncryptionMode>('disabled')
const encryptOnCreate = ref(false)
const botCount = ref(0)
const encryptionRequired = computed(() => isRequiredMode(encryptionPolicy.value))

// Voice channels: 'required' fixes voice on; otherwise the channel decides.
const voiceEncryptionMode = ref<VoiceEncryptionMode>('disabled')
const encryptVoiceOnCreate = ref(false)
const voiceEncryptionRequired = computed(() => voiceEncryptionMode.value === 'required')

// Messages encrypted from creation, chosen under 'optional' or fixed on by a required mode.
const offersHistory = computed(() =>
  createOptions.value && hasCapability('encrypted-history') && encryptionPolicy.value !== 'disabled' && encryptOnCreate.value)
const historyHint = computed(() => {
  switch (historyVisibility.value) {
    case 'pinned': return t('channelEncryption.settings.historyPinnedHint')
    case 'none': return t('channelEncryption.settings.historyNoneHint')
    default: return t('channelEncryption.settings.historyAllHint')
  }
})

const toggleEncryptOnCreate = () => {
  if (!encryptionRequired.value) encryptOnCreate.value = !encryptOnCreate.value
}

const toggleEncryptVoiceOnCreate = () => {
  if (!voiceEncryptionRequired.value) encryptVoiceOnCreate.value = !encryptVoiceOnCreate.value
}

const loadEncryptionPolicy = async () => {
  if (!props.serverId) return
  const [{ data: policy }, { count }] = await Promise.all([
    supabase
      .from('server_encryption_settings')
      .select('encryption_mode, voice_encryption_mode')
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
  voiceEncryptionMode.value = normalizeVoiceMode(policy?.voice_encryption_mode)
  encryptVoiceOnCreate.value = voiceEncryptionRequired.value
  botCount.value = count || 0
}
const channelNameError = ref('')
// Server refusals and the channel limit: about the request, not the name, so they sit under the
// form and leave Create enabled for another try.
const formError = ref('')
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
      formError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
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
    loadRoles().catch(error => debug.error('Error loading roles:', error))
  } else {
    channelNameError.value = ''
    formError.value = ''
    currentChannelCount.value = 0
  }
}, { immediate: true })

const isAtChannelLimit = computed(() => currentChannelCount.value >= MAX_CHANNELS_PER_SERVER)

const canCreate = computed(() => {
  return newChannelName.value.trim().length > 0 && 
         !channelNameError.value && 
         nameLength(newChannelName.value.trim()) <= NAME_MAX_LENGTH &&
         !isAtChannelLimit.value &&
         !isCheckingLimit.value
})

const channelNameHint = computed(() => {
  if (newChannelName.value.length === 0) {
    return namesKeepSpaces(channelType.value)
      ? t('chatNav.create.voiceHint')
      : t('chatNav.create.textHint')
  }
  
  if (channelNameError.value) {
    return ''
  }
  
  return t('chatNav.create.looksGood')
})

const finalName = () => finalizeChannelNameFor(channelType.value, newChannelName.value)

const validateChannelName = () => {
  // Names format as typed: a trailing separator must survive the keystroke.
  newChannelName.value = formatChannelNameFor(channelType.value, newChannelName.value)
  const name = finalName()

  if (!name) {
    channelNameError.value = t('chatNav.create.nameRequired')
    return
  }

  if (nameLength(name) > NAME_MAX_LENGTH) {
    channelNameError.value = t('chatNav.create.nameTooLong')
    return
  }

  channelNameError.value = ''
}

// The radio group's v-model sets the type; the name re-validates against it.
watch(channelType, () => {
  if (newChannelName.value.trim()) validateChannelName()
})

const createChannel = async () => {
  if (!canCreate.value) return

  // Check limit again before creating (in case it changed)
  if (isAtChannelLimit.value) {
    formError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
    return
  }

  validateChannelName()
  if (channelNameError.value) return

  formError.value = ''
  isCreating.value = true
  
  try {
    // Double-check count before inserting (race condition protection)
    const { count } = await supabase
      .from('channels')
      .select('*', { count: 'exact', head: true })
      .eq('server_id', props.serverId)
    
    if ((count || 0) >= MAX_CHANNELS_PER_SERVER) {
      formError.value = t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
      return
    }

    // A new channel starts at the server floor: messages off under 'optional', voice off unless
    // the server requires it.
    const encryption: ChannelEncryptionChange = {}
    if (encryptOnCreate.value && encryptionPolicy.value === 'optional') encryption.messagesEncrypted = true
    if (channelType.value === 1 && encryptVoiceOnCreate.value && !voiceEncryptionRequired.value) {
      encryption.voiceEncrypted = true
    }
    if (offersHistory.value && historyVisibility.value !== 'all') encryption.historyVisibility = historyVisibility.value

    const args: Record<string, unknown> = {
      p_server_id: props.serverId,
      p_name: finalName(),
      p_type: channelType.value,
      // p_category is a uuid: an empty string is refused (22P02), not read as no category.
      p_category: props.categoryId || null,
      p_private: isPrivate.value,
      p_allowed_role_ids: isPrivate.value ? allowedRoleIds.value : [],
    }
    if (createOptions.value) {
      Object.assign(args, {
        p_description: description.value.trim() || null,
        p_slowmode_seconds: channelType.value === 0 && slowmodeSeconds.value > 0 ? slowmodeSeconds.value : null,
        p_messages_encrypted: encryption.messagesEncrypted ?? null,
        p_voice_encrypted: encryption.voiceEncrypted ?? null,
        p_history_visibility: encryption.historyVisibility ?? null,
      })
    }
    const { data, error } = await supabase.rpc('create_channel', args)

    if (error) throw error

    if (!createOptions.value && Object.keys(encryption).length > 0) {
      try {
        await setChannelEncryption(data.id, encryption)
      } catch (encryptionError: any) {
        debug.error('Error turning on channel encryption:', encryptionError)
        toast.error(t('channelEncryption.create.failed'))
      }
    }

    if (isPrivate.value) serverChannelStore.privateChannels = { ...serverChannelStore.privateChannels, [data.id]: true }
    // A channel in a category takes the category's permissions, which may hide it from @everyone.
    else if (props.categoryId) void serverChannelStore._loadPrivateChannels([data.id])
    emit('channelCreated', data)
    closeForm()
  } catch (error) {
    debug.error('Error creating channel:', error)
    formError.value = createFailureMessage(error)
  } finally {
    isCreating.value = false
  }
}

/** The refusal in words: the channel limit, a permission, else the server's own message. */
function createFailureMessage(error: unknown): string {
  const e = error as { code?: unknown; message?: unknown } | null
  const message = typeof e?.message === 'string' ? e.message : ''
  if (/Channel limit exceeded/i.test(message)) {
    return t('channel.errors.limitReached', { max: MAX_CHANNELS_PER_SERVER })
  }
  if (e?.code === '42501' || /row-level security|permission denied/i.test(message)) {
    return t('channel.errors.createRefused')
  }
  return message ? t('channel.errors.createFailedReason', { reason: message }) : t('channel.errors.createFailed')
}

const closeForm = () => {
  newChannelName.value = ''
  channelType.value = 0
  channelNameError.value = ''
  formError.value = ''
  isPrivate.value = false
  allowedRoleIds.value = []
  moreOpen.value = false
  description.value = ''
  slowmodeIndex.value = 0
  historyVisibility.value = 'all'
  encryptOnCreate.value = isRequiredMode(encryptionPolicy.value)
  encryptVoiceOnCreate.value = voiceEncryptionRequired.value
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
  margin: 0;
  padding: 0;
  border: none;
  min-width: 0;
}

.channel-type-section > legend {
  padding: 0;
  margin-bottom: 12px;
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

.channel-type-option:has(.channel-type-radio:focus-visible) {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: 2px;
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

.option-title,
.option-description {
  display: block;
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

.private-roles {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: -12px;
}

.private-role-list {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
}

.private-role {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
  cursor: pointer;
}

.role-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
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

.option-select {
  flex-shrink: 0;
  max-width: 50%;
  padding: 6px 8px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.more-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.more-options-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  align-self: flex-start;
  padding: 4px 0;
  border: none;
  background: none;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: 600;
  cursor: pointer;
}

.more-options-toggle:hover {
  color: var(--text-primary);
}

.more-options-toggle:focus-visible,
.option-textarea:focus-visible,
.option-select:focus-visible {
  outline: 2px solid var(--border-focus, var(--harmony-primary));
  outline-offset: 2px;
}

.more-options-body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.option-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.option-textarea {
  width: 100%;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  resize: vertical;
}

.slowmode-control {
  display: flex;
  align-items: center;
  gap: 12px;
}

.slowmode-slider {
  flex: 1;
  accent-color: var(--harmony-primary);
}

.slowmode-value {
  min-width: 3em;
  text-align: right;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.form-error {
  margin: var(--space-3) 0 0;
  font-size: var(--font-size-sm);
  color: var(--text-danger);
  line-height: 1.45;
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
  /* --text-link is checked against plain surfaces, not this tint. */
  color: var(--text-primary);
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
