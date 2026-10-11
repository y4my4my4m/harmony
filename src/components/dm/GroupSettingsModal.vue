<template>
  <BaseModal
    :show="show"
    :title="t('dm.groupSettings.title')"
    @close="handleClose"
  >
    <div class="settings-content">
      <!-- Group Icon Section -->
      <div class="setting-section" role="group" :aria-labelledby="`${uid}-icon-title`">
        <h3 :id="`${uid}-icon-title`" class="section-title">{{ t('dm.groupSettings.groupIcon') }}</h3>
        <div class="icon-upload-section">
          <div class="current-icon">
            <GroupIcon
              :conversation-id="conversationId"
              :icon-path="localIconPath"
              :alt="t('dm.groupSettings.groupIcon')"
              size="xl"
              :clickable="true"
              :loading="uploadingIcon"
              @click="triggerIconUpload"
            />
            <div class="icon-actions">
              <button
                type="button"
                class="icon-btn upload-btn"
                data-testid="group-icon-upload"
                @click="triggerIconUpload"
                :disabled="uploadingIcon"
                :aria-label="t('dm.groupSettings.uploadIcon')"
                :aria-describedby="`${uid}-file-hint`"
                :title="t('dm.groupSettings.uploadIcon')"
              >
                <Icon name="image" aria-hidden="true" />
                {{ t('dm.groupSettings.upload') }}
              </button>
              <button
                v-if="hasCustomIcon"
                type="button"
                class="icon-btn remove-btn"
                @click="removeIcon"
                :disabled="uploadingIcon"
                :aria-label="t('dm.groupSettings.removeIcon')"
                :title="t('dm.groupSettings.removeIcon')"
              >
                <Icon name="trash" aria-hidden="true" />
                {{ t('dm.groupSettings.remove') }}
              </button>
            </div>
          </div>

          <!-- Pointer-only drop target; the Upload button is the keyboard path. -->
          <div
            class="drop-zone"
            :class="{ 'drag-over': isDragOver, 'uploading': uploadingIcon }"
            @drop="handleDrop"
            @dragover.prevent="isDragOver = true"
            @dragleave="isDragOver = false"
            @click="triggerIconUpload"
          >
            <Icon name="upload" aria-hidden="true" />
            <span>{{ t('dm.groupSettings.dropHint') }}</span>
            <small :id="`${uid}-file-hint`">{{ t('dm.groupSettings.fileHint') }}</small>
          </div>

          <!-- Upload Progress -->
          <div v-if="uploadingIcon" class="upload-progress">
            <div
              class="progress-bar"
              role="progressbar"
              :aria-label="t('dm.groupSettings.uploadingIcon')"
              aria-valuemin="0"
              aria-valuemax="100"
              :aria-valuenow="uploadProgress"
            >
              <div class="progress-fill" :style="{ width: `${uploadProgress}%` }"></div>
            </div>
            <span class="progress-text" aria-hidden="true">{{ t('dm.groupSettings.uploadProgress', { percent: uploadProgress }) }}</span>
          </div>
        </div>
      </div>

      <!-- Group Name Section -->
      <div class="setting-section">
        <h3 class="section-title">
          <label :for="`${uid}-name`">{{ t('dm.groupSettings.groupName') }}</label>
        </h3>
        <div class="name-input-section">
          <input
            :id="`${uid}-name`"
            v-model="localGroupName"
            type="text"
            class="group-name-input"
            :placeholder="defaultGroupName"
            maxlength="50"
            :aria-describedby="`${uid}-name-help ${uid}-name-count`"
          />
          <span :id="`${uid}-name-count`" class="char-count">{{ localGroupName.length }}/50</span>
        </div>
        <p :id="`${uid}-name-help`" class="input-help">{{ t('dm.groupSettings.groupNameHelp') }}</p>
      </div>

      <!-- Save changes (consistent with Server Settings, Channel Edit, etc.) -->
      <div v-if="hasGroupNameChanges" class="settings-actions">
        <button
          type="button"
          class="save-btn"
          :disabled="savingGroupName"
          :aria-busy="savingGroupName || undefined"
          @click="saveGroupName"
        >
          {{ savingGroupName ? t('dm.groupSettings.saving') : t('dm.groupSettings.saveChanges') }}
        </button>
      </div>

      <!-- Participants Section -->
      <div class="setting-section">
        <div class="section-header">
          <h3 :id="`${uid}-participants-title`" class="section-title">
            {{ t('dm.groupSettings.participants', { count: displayParticipants.length }) }}
          </h3>
          <button
            type="button"
            class="add-participant-btn"
            aria-haspopup="dialog"
            :aria-label="t('dm.groupSettings.addParticipant')"
            :title="t('dm.groupSettings.addParticipant')"
            @click="showAddParticipant = true"
          >
            <Icon name="user-plus" aria-hidden="true" />
            {{ t('dm.groupSettings.add') }}
          </button>
        </div>

        <ul class="participants-list" :aria-labelledby="`${uid}-participants-title`">
          <li
            v-for="participant in displayParticipants"
            :key="participant.id"
            class="participant-item"
            :class="{ 'is-creator': participant.id === conversation.created_by }"
          >
            <Avatar
              :src="participant.avatar_url"
              size="sm"
              class="participant-avatar"
            />
            <div class="participant-info">
              <div class="participant-name">
                <DisplayName :user-id="participant.id" :fallback="participant.display_name || participant.username" :truncate="true" />
                <span v-if="participant.id === conversation.created_by" class="creator-badge">
                  {{ t('dm.groupSettings.creator') }}
                </span>
              </div>
              <div v-if="!participant.is_local" class="participant-handle">
                {{ participant.handle }}
              </div>
            </div>

            <!-- Participant Actions -->
            <div class="participant-actions">
              <button
                v-if="canRemoveParticipant(participant)"
                type="button"
                class="action-btn remove-participant"
                :aria-label="t('dm.groupSettings.removeParticipant', { name: participant.display_name || participant.username })"
                :title="t('dm.groupSettings.removeParticipant', { name: participant.display_name || participant.username })"
                @click="removeParticipant(participant)"
              >
                <Icon name="user-x" aria-hidden="true" />
              </button>
            </div>
          </li>
        </ul>
      </div>

      <!-- Danger Zone -->
      <div class="setting-section danger-zone">
        <h3 class="section-title danger-title">{{ t('dm.groupSettings.dangerZone') }}</h3>
        <div class="danger-actions">
          <button
            type="button"
            class="danger-btn leave-group"
            aria-haspopup="dialog"
            @click="showLeaveConfirm = true"
          >
            <Icon name="x" aria-hidden="true" />
            {{ t('dm.groupSettings.leaveGroup') }}
          </button>
          <button
            v-if="isCreator"
            type="button"
            class="danger-btn delete-group"
            aria-haspopup="dialog"
            @click="showDeleteConfirm = true"
          >
            <Icon name="trash" aria-hidden="true" />
            {{ t('dm.groupSettings.deleteGroup') }}
          </button>
        </div>
      </div>
    </div>

    <!-- Hidden file input -->
    <input
      ref="fileInput"
      type="file"
      accept="image/*"
      style="display: none"
      @change="handleFileSelect"
    />

    <!-- Add Participant Modal -->
    <GroupChatInviteModal
      :show="showAddParticipant"
      :conversation-id="conversationId"
      :existing-participants="participants"
      @close="showAddParticipant = false"
      @users-added="handleUsersAdded"
    />

    <!-- Confirmation Modals -->
    <ConfirmationModal
      :show="showLeaveConfirm"
      :title="t('dm.groupSettings.leaveGroup')"
      :message="t('dm.groupSettings.leaveConfirmMessage')"
      :confirm-button-text="t('dm.groupSettings.leave')"
      @confirm="leaveGroup"
      @close="showLeaveConfirm = false"
    />

    <ConfirmationModal
      :show="showDeleteConfirm"
      :title="t('dm.groupSettings.deleteGroup')"
      :message="t('dm.groupSettings.deleteConfirmMessage')"
      :confirm-button-text="t('common.delete')"
      :require-confirmation="true"
      confirmation-text="DELETE"
      @confirm="deleteGroup"
      @close="showDeleteConfirm = false"
    />
  </BaseModal>
</template>

<script setup lang="ts">
import { ref, computed, watch, useId } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import BaseModal from '@/components/common/BaseModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import GroupChatInviteModal from '@/components/dm/GroupChatInviteModal.vue'
import DisplayName from '@/components/DisplayName.vue'
import ConfirmationModal from '@/components/ConfirmationModal.vue'
import { useT } from '@/composables/useT'
import { uploadGroupIcon, deleteGroupIcon } from '@/utils/groupIconUtils'
import { imageSourceError } from '@/utils/uploadValidation'
import { useImageCrop } from '@/composables/useImageCrop'
import { useDMStore, type DMConversation, type DMUser } from '@/stores/useDM'
import { useUserData } from '@/composables/useUserData'
import { supabase } from '@/supabase'
import { useRouter } from 'vue-router'

interface Props {
  show: boolean
  conversation: DMConversation
  conversationId: string
  participants: DMUser[]
}

const props = defineProps<Props>()

const emit = defineEmits<{
  close: []
  updated: []
}>()

// Local participants list - fetched when modal opens if conversation.participants is empty
const loadedParticipants = ref<DMUser[]>([])

const displayParticipants = computed(() => {
  const fromProps = props.participants || []
  if (fromProps.length > 0) return fromProps
  return loadedParticipants.value
})

// Composables
const { t } = useT()
const uid = `gsm-${useId()}`
const toast = useToast()
const { cropImage } = useImageCrop()
const router = useRouter()
const dmStore = useDMStore()
const { getCurrentUser } = useUserData()

// State
const fileInput = ref<HTMLInputElement>()
const localGroupName = ref('')
const localIconPath = ref<string | undefined>()
const uploadingIcon = ref(false)
const uploadProgress = ref(0)
const isDragOver = ref(false)
const showAddParticipant = ref(false)
const showLeaveConfirm = ref(false)
const showDeleteConfirm = ref(false)
const savingGroupName = ref(false)

// Computed
const currentUser = computed(() => getCurrentUser.value)
const isCreator = computed(() => currentUser.value?.id === props.conversation.created_by)
const hasCustomIcon = computed(() => !!localIconPath.value)

const savedGroupName = computed(() => (props.conversation?.name ?? '').trim())
const hasGroupNameChanges = computed(
  () => (localGroupName.value?.trim() ?? '') !== savedGroupName.value
)

const stripShortcodes = (text: string): string => {
  if (!text) return text
  const stripped = text.replace(/:[a-zA-Z0-9_+-]+:/g, '').replace(/\s+/g, ' ').trim()
  return stripped || text
}

const defaultGroupName = computed(() => {
  if (props.participants.length > 0) {
    const names = props.participants
      .filter(p => p.id !== currentUser.value?.id)
      .slice(0, 3)
      .map(p => stripShortcodes(p.display_name || p.username))
      .join(', ')
    
    if (props.participants.length > 4) {
      return t('dm.groupSettings.defaultNameMore', { names, count: props.participants.length - 4 })
    }
    return names
  }
  return t('dm.groupSettings.defaultName')
})

// Watchers
watch(() => props.conversation, (newConv) => {
  if (newConv) {
    localGroupName.value = newConv.name || ''
    localIconPath.value = newConv.icon_url
  }
}, { immediate: true })

watch(() => props.show, async (isOpen) => {
  if (isOpen && props.conversationId) {
    loadedParticipants.value = []
    if ((props.participants?.length ?? 0) === 0) {
      loadedParticipants.value = await dmStore.getConversationParticipants(props.conversationId)
    }
  }
}, { immediate: true })

// Methods
function handleClose() {
  emit('close')
}

function triggerIconUpload() {
  if (uploadingIcon.value) return
  fileInput.value?.click()
}

function handleFileSelect(event: Event) {
  const target = event.target as HTMLInputElement
  const file = target.files?.[0]
  target.value = ''
  if (file) {
    uploadIconFile(file)
  }
}

function handleDrop(event: DragEvent) {
  event.preventDefault()
  isDragOver.value = false
  
  const file = event.dataTransfer?.files[0]
  if (file && file.type.startsWith('image/')) {
    uploadIconFile(file)
  } else {
    toast.error(t('dm.groupSettings.dropImage'))
  }
}

async function uploadIconFile(picked: File) {
  if (uploadingIcon.value) return
  const sourceError = imageSourceError(picked)
  if (sourceError) {
    toast.error(sourceError)
    return
  }
  const file = await cropImage(picked, 'group_icon')
  if (!file) return
  
  uploadingIcon.value = true
  uploadProgress.value = 0
  
  try {
    const result = await uploadGroupIcon(
      props.conversationId,
      file,
      (progress) => {
        uploadProgress.value = progress
      }
    )
    
    if (result.success && result.iconPath) {
      localIconPath.value = result.iconPath
      toast.success(t('dm.groupSettings.iconUpdated'))
      emit('updated')
    } else {
      toast.error(result.error || t('dm.groupSettings.iconUploadFailed'))
    }
  } catch (error: any) {
    debug.error('Icon upload failed:', error)
    toast.error(error.message || t('dm.groupSettings.iconUploadFailed'))
  } finally {
    uploadingIcon.value = false
    uploadProgress.value = 0
  }
}

async function removeIcon() {
  if (uploadingIcon.value || !hasCustomIcon.value) return
  
  try {
    const result = await deleteGroupIcon(props.conversationId)
    
    if (result.success) {
      localIconPath.value = undefined
      toast.success(t('dm.groupSettings.iconRemoved'))
      emit('updated')
    } else {
      toast.error(result.error || t('dm.groupSettings.iconRemoveFailed'))
    }
  } catch (error: any) {
    debug.error('Icon removal failed:', error)
    toast.error(error.message || t('dm.groupSettings.iconRemoveFailed'))
  }
}

async function saveGroupName() {
  if (!currentUser.value || !hasGroupNameChanges.value || savingGroupName.value) return

  savingGroupName.value = true
  try {
    const { error } = await supabase.rpc('update_group_name', {
      conversation_uuid: props.conversationId,
      user_profile_id: currentUser.value.id,
      new_name: localGroupName.value.trim() || null
    })

    if (error) {
      debug.error('Failed to update group name:', error)
      toast.error(t('dm.groupSettings.nameUpdateFailed'))
      return
    }

    toast.success(t('dm.groupSettings.nameUpdated'))
    emit('updated')
  } catch (error: any) {
    debug.error('Group name update failed:', error)
    toast.error(error.message || t('dm.groupSettings.nameUpdateFailed'))
  } finally {
    savingGroupName.value = false
  }
}

function canRemoveParticipant(participant: DMUser): boolean {
  // Can't remove yourself or the creator (unless you are the creator removing someone else)
  if (participant.id === currentUser.value?.id) return false
  if (participant.id === props.conversation.created_by && !isCreator.value) return false
  
  // Only creator can remove others, or participants can leave themselves
  return isCreator.value
}

async function removeParticipant(participant: DMUser) {
  if (!canRemoveParticipant(participant) || !currentUser.value) return
  
  try {
    const { error } = await supabase
      .from('conversation_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('conversation_id', props.conversationId)
      .eq('user_id', participant.id)

    if (error) throw error

    toast.success(t('dm.groupSettings.participantRemoved', { name: participant.display_name || participant.username }))
    loadedParticipants.value = await dmStore.getConversationParticipants(props.conversationId)
    emit('updated')
  } catch (error: any) {
    debug.error('Failed to remove participant:', error)
    toast.error(error.message || t('dm.groupSettings.participantRemoveFailed'))
  }
}

function handleUsersAdded() {
  toast.success(t('dm.groupSettings.usersAdded'))
  emit('updated')
}

async function leaveGroup() {
  if (!currentUser.value) return
  
  try {
    const { error } = await supabase
      .from('conversation_participants')
      .update({ left_at: new Date().toISOString() })
      .eq('conversation_id', props.conversationId)
      .eq('user_id', currentUser.value.id)

    if (error) throw error

    showLeaveConfirm.value = false
    toast.success(t('dm.groupSettings.left'))
    emit('close')
    router.push('/dm')
  } catch (error: any) {
    debug.error('Failed to leave group:', error)
    toast.error(error.message || t('dm.groupSettings.leaveFailed'))
  }
}

async function deleteGroup() {
  if (!isCreator.value || !currentUser.value) return
  
  try {
    const { error } = await supabase
      .from('conversations')
      .delete()
      .eq('id', props.conversationId)

    if (error) throw error

    showDeleteConfirm.value = false
    toast.success(t('dm.groupSettings.deleted'))
    emit('close')
    router.push('/dm')
  } catch (error: any) {
    debug.error('Failed to delete group:', error)
    toast.error(error.message || t('dm.groupSettings.deleteFailed'))
  }
}
</script>

<style scoped>
.settings-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  padding: var(--space-4);
  max-height: 70vh;
  overflow-y: auto;
}

/* Setting Sections */
.setting-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.section-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

/* Icon Upload Section */
.icon-upload-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.current-icon {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.icon-actions {
  display: flex;
  gap: var(--space-2);
}

.icon-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;
}

.upload-btn {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.upload-btn:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.remove-btn {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
}

.remove-btn:hover:not(:disabled) {
  background: var(--error-hover);
  color: var(--text-on-primary);
}

.icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Drag & Drop Zone */
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-6);
  border: 2px dashed var(--border-color);
  border-radius: var(--radius-lg);
  background: var(--background-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.drop-zone:hover,
.drop-zone.drag-over {
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha-light);
}

.drop-zone.uploading {
  pointer-events: none;
  opacity: 0.7;
}

.drop-zone small {
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}

/* Upload Progress */
.upload-progress {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.progress-bar {
  width: 100%;
  height: 4px;
  background: var(--background-tertiary);
  border-radius: var(--radius-full);
  overflow: hidden;
}

.progress-fill {
  height: 100%;
  background: var(--harmony-primary);
  transition: width 0.3s ease;
}

.progress-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  text-align: center;
}

/* Group Name Section */
.name-input-section {
  position: relative;
}

.group-name-input {
  width: 100%;
  padding: var(--space-3);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: var(--font-size-base);
}

.group-name-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
}

.char-count {
  position: absolute;
  bottom: var(--space-1);
  right: var(--space-3);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.input-help {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

/* Save changes (consistent with Server Settings, Channel Edit, etc.) */
.settings-actions {
  display: flex;
  justify-content: flex-end;
  padding-top: var(--space-2);
}

.save-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-4);
  background: var(--harmony-primary);
  color: var(--text-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background 0.2s;
}

.save-btn:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.save-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Participants Section */
.add-participant-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--harmony-primary);
  color: var(--text-primary);
  border: none;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background 0.2s;
}

.add-participant-btn:hover {
  background: var(--harmony-primary-hover);
}

.participants-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 300px;
  overflow-y: auto;
}

.participant-item {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--background-secondary);
  border-radius: var(--radius-md);
  transition: background 0.2s;
}

.participant-item.is-creator {
  background: var(--harmony-primary-alpha-light);
  border: 1px solid var(--harmony-primary-alpha-strong);
}

.participant-info {
  flex: 1;
  min-width: 0;
}

.participant-name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
}

.creator-badge {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  color: var(--text-link);
  background: var(--harmony-primary-alpha-light);
  padding: 2px var(--space-1);
  border-radius: var(--radius-sm);
}

.participant-handle {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.participant-actions {
  display: flex;
  gap: var(--space-1);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-md);
  cursor: pointer;
  transition: all 0.2s;
}

.remove-participant {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
}

.remove-participant:hover {
  background: var(--error-hover);
  color: var(--text-on-primary);
}

/* Danger Zone */
.danger-zone {
  border-top: 1px solid var(--border-color);
  padding-top: var(--space-4);
}

.danger-title {
  color: var(--text-danger);
}

.danger-actions {
  display: flex;
  gap: var(--space-3);
}

.danger-btn {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: color-mix(in srgb, var(--error) 10%, transparent);
  color: var(--text-danger);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;
}

.danger-btn:hover {
  background: var(--error-hover);
  color: var(--text-on-primary);
}

/* Mobile Responsiveness */
@media (max-width: 768px) {
  .settings-content {
    padding: var(--space-3);
  }
  
  .current-icon {
    flex-direction: column;
    align-items: center;
    text-align: center;
  }
  
  .danger-actions {
    flex-direction: column;
  }
}
</style>