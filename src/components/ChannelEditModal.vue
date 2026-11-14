<template>
  <Teleport to="body">
    <div
      v-if="show"
      class="modal-overlay"
      @mousedown.self="pressedOverlay = true"
      @click.self="onOverlayClick"
    >
      <div
        ref="dialogEl"
        class="modal-container"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        data-testid="channel-edit-dialog"
      >
        <div class="modal-header">
          <h2 :id="titleId" class="modal-title">{{ t('channel.edit.title') }}</h2>
          <button
            type="button"
            class="modal-close"
            :aria-label="t('common.close')"
            :title="t('common.close')"
            @click="requestClose"
          >
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>

        <!-- Tabs: automatic activation, focus and selection move together. -->
        <div
          ref="tablistEl"
          class="modal-tabs"
          role="tablist"
          :aria-labelledby="titleId"
          @keydown="onTabsKeydown"
        >
          <button
            v-for="tab in tabs"
            :key="tab.id"
            :id="`${a11yId}-tab-${tab.id}`"
            type="button"
            role="tab"
            class="modal-tab"
            :class="{ active: activeTab === tab.id }"
            :data-tab="tab.id"
            :aria-selected="activeTab === tab.id ? 'true' : 'false'"
            :aria-controls="`${a11yId}-panel-${tab.id}`"
            :tabindex="activeTab === tab.id ? 0 : -1"
            @click="activeTab = tab.id"
          >
            {{ tab.label }}
          </button>
        </div>

        <div
          :id="`${a11yId}-panel-${activeTab}`"
          class="modal-body"
          role="tabpanel"
          :aria-labelledby="`${a11yId}-tab-${activeTab}`"
          tabindex="0"
        >
          <!-- General tab -->
          <template v-if="activeTab === 'general'">
            <div class="form-group">
              <label for="channel-name">{{ t('channel.channelName') }}</label>
              <input
                id="channel-name"
                v-model="editedName"
                type="text"
                class="form-input"
                @input="onNameInput"
                @keydown.enter="saveChanges"
                ref="nameInput"
              />
              <div class="character-count" aria-hidden="true">{{ nameLength(editedName) }}/{{ NAME_MAX_LENGTH }}</div>
            </div>

            <div class="form-group">
              <label for="channel-description">{{ t('channel.edit.description') }}</label>
              <textarea
                id="channel-description"
                v-model="editedDescription"
                class="form-textarea"
                :placeholder="t('channel.edit.descriptionPlaceholder')"
                maxlength="1024"
                rows="3"
              />
              <div class="character-count" aria-hidden="true">{{ (editedDescription || '').length }}/1024</div>
            </div>

            <div v-if="channel?.type === 0" class="form-group">
              <label for="channel-slowmode">{{ t('channel.edit.slowmode') }}</label>
              <div class="slowmode-control">
                <input
                  id="channel-slowmode"
                  v-model.number="slowmodeIndex"
                  type="range"
                  min="0"
                  :max="SLOWMODE_STEPS.length - 1"
                  step="1"
                  class="slowmode-slider"
                  :aria-valuetext="slowmodeSpoken"
                  :aria-describedby="`${a11yId}-slowmode-hint`"
                />
                <span class="slowmode-value" :class="{ off: editedSlowmode === 0 }" aria-hidden="true">
                  {{ slowmodeLabel }}
                </span>
              </div>
              <div :id="`${a11yId}-slowmode-hint`" class="form-hint">
                {{ t('channel.edit.slowmodeHint') }}
              </div>
            </div>

            <div class="form-group">
              <label>{{ t('channel.channelType') }}</label>
              <div class="channel-type-display">
                <div class="channel-type-icon" aria-hidden="true">
                  <HashTagIcon v-if="channel?.type === 0" />
                  <SpeakerIcon v-else />
                </div>
                <span>{{ channel?.type === 0 ? t('channel.edit.textChannel') : t('channel.edit.voiceChannel') }}</span>
              </div>
              <div class="form-hint">{{ t('channel.edit.typeHint') }}</div>
            </div>

            <ChannelEncryptionSection
              v-if="channel"
              :channel="channel"
              :can-manage="canManageEncryption"
            />
          </template>

          <!-- Permissions tab -->
          <template v-else-if="activeTab === 'permissions'">
            <ChannelPermissionSync
              v-if="channel?.category"
              :channel="channel"
              :saved-state="initialPermState"
              :dirty="permissionsDirty"
              @synced="loadPermissions"
            />
            <div v-if="!rolesLoading && everyoneRole" class="private-card">
              <div class="private-head">
                <Icon name="eye-off" :size="18" class="private-icon" aria-hidden="true" />
                <div class="private-text">
                  <span class="private-title" aria-hidden="true">{{ t('channel.private.label') }}</span>
                  <span :id="`${a11yId}-private-desc`" class="private-desc">{{ t('channel.private.hint') }}</span>
                </div>
                <ToggleSwitch
                  :model-value="isPrivate"
                  :label="t('channel.private.label')"
                  :describedby="`${a11yId}-private-desc`"
                  @change="setPrivate"
                />
              </div>
              <div v-if="isPrivate" class="private-roles">
                <span :id="`${a11yId}-who`" class="perm-rail-label">{{ t('channel.private.whoCanSee') }}</span>
                <div class="private-role-list" role="group" :aria-labelledby="`${a11yId}-who`">
                  <label v-for="role in assignableRoles" :key="role.id" class="private-role">
                    <input
                      type="checkbox"
                      :checked="getPermState(role.id, Permission.VIEW_CHANNEL) === 'allow'"
                      @change="setRoleCanView(role.id, ($event.target as HTMLInputElement).checked)"
                    />
                    <span class="role-color-dot" :style="{ background: role.color || '#99aab5' }" aria-hidden="true"></span>
                    <span>{{ role.name }}</span>
                  </label>
                  <span v-if="assignableRoles.length === 0" class="private-desc">{{ t('channel.private.noRoles') }}</span>
                </div>
              </div>
            </div>
            <PermissionRoleEditor
              v-model:selected-role-id="selectedRoleId"
              :roles="serverRoles"
              :groups="permissionGroups"
              :state="workingPermState"
              :dirty-role-ids="dirtyRoleIds"
              :loading="rolesLoading"
              :legend="t('channel.edit.overrideLegend')"
              @set="setPermState"
              @reset="resetRole"
            />
          </template>

          <!-- Webhooks tab -->
          <template v-else-if="activeTab === 'webhooks'">
            <ChannelWebhooksSection v-if="channel" :channel-id="channel.id" />
          </template>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" @click="requestClose">
            {{ t('common.cancel') }}
          </button>
          <button
            v-if="activeTab === 'general'"
            type="button"
            class="btn btn-primary"
            @click="saveChanges"
            :disabled="!isValidName || isLoading"
          >
            <span v-if="isLoading" class="loading-spinner" aria-hidden="true"></span>
            {{ isLoading ? t('channel.edit.saving') : t('channel.edit.save') }}
          </button>
          <!-- aria-disabled, not disabled: focus stays on the button once the save clears the changes. -->
          <button
            v-else-if="activeTab === 'permissions'"
            type="button"
            class="btn btn-primary"
            :aria-disabled="!permissionsDirty || savingPermissions ? 'true' : undefined"
            @click="savePermissions"
          >
            <span v-if="savingPermissions" class="loading-spinner" aria-hidden="true"></span>
            {{ savingPermissions ? t('channel.edit.saving') : t('channel.edit.savePermissions') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useServerChannelStore } from '@/stores/useServerChannel'
import HashTagIcon from '@/components/icons/HashTag.vue'
import SpeakerIcon from '@/components/icons/Speaker.vue'
import Icon from '@/components/common/Icon.vue'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import ChannelEncryptionSection from '@/components/ChannelEncryptionSection.vue'
import ChannelWebhooksSection from '@/components/ChannelWebhooksSection.vue'
import ChannelPermissionSync from '@/components/ChannelPermissionSync.vue'
import PermissionRoleEditor from '@/components/PermissionRoleEditor.vue'
import type { TriState } from '@/components/ChannelPermissionTriState.vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useDialog } from '@/composables/useDialog'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useRovingTabindex } from '@/composables/useRovingTabindex'
import { uid } from '@/utils/a11y/focus'
import { userDataService } from '@/services/userDataService'
import { channelPermissionGroups } from '@/services/channelPermissionGroups'
import { NAME_MAX_LENGTH, clipName, finalizeChannelNameFor, formatChannelNameFor, nameLength } from '@/utils/channelName'
import { SLOWMODE_STEPS, formatSlowmode, slowmodeStepIndex } from '@/utils/slowmode'
import {
  roleService,
  Permission,
  bitmaskToPermissions,
  type ServerRole,
} from '@/services/RoleService'
import type { Channel } from '@/types'

interface Props {
  show: boolean
  channel: Channel | null
}

interface Emits {
  (e: 'close'): void
  (e: 'updated', channel: Channel): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const serverChannelStore = useServerChannelStore()
const { canManageChannels, canManageWebhooks, isCurrentUserServerOwner } = useServerPermissions()
const { t } = useI18n()
const { confirm } = useConfirmDialog()

const a11yId = uid('channel-edit')
const dialogEl = ref<HTMLElement | null>(null)
const tablistEl = ref<HTMLElement | null>(null)

const canManageEncryption = computed(() =>
  isCurrentUserServerOwner.value
  || canManageChannels.value
  || userDataService.getCurrentUser()?.isAdmin === true)

// The webhook RPCs re-check, channel overrides included.
const canManageChannelWebhooks = computed(() =>
  props.channel?.type === 0 && (canManageEncryption.value || canManageWebhooks.value))

const editedName = ref('')
const editedDescription = ref('')
const slowmodeIndex = ref(0)
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

const editedSlowmode = computed(() => SLOWMODE_STEPS[slowmodeIndex.value] ?? 0)
const slowmodeLabel = computed(() => formatSlowmode(t, editedSlowmode.value, 'short'))
const slowmodeSpoken = computed(() => formatSlowmode(t, editedSlowmode.value, 'long'))

// The name follows its type's rule (utils/channelName.ts) as it is typed. A name left untouched
// is saved as it is.
// The cap counts code points, as char_length does; maxlength would count UTF-16 units.
const onNameInput = (event: Event) => {
  editedName.value = clipName(formatChannelNameFor(props.channel?.type, editedName.value))
  const input = event.target as HTMLInputElement
  if (input.value !== editedName.value) input.value = editedName.value
}
const nameToSave = computed(() => {
  if (editedName.value.trim() === (props.channel?.name ?? '').trim()) return editedName.value.trim()
  return finalizeChannelNameFor(props.channel?.type, editedName.value)
})

const isValidName = computed(() => {
  return nameToSave.value.length > 0 && nameLength(nameToSave.value) <= NAME_MAX_LENGTH
})

// General-tab values as loaded, for the unsaved-changes check.
const savedGeneral = ref({ name: '', description: '', slowmodeIndex: 0 })
const generalDirty = computed(() =>
  editedName.value.trim() !== savedGeneral.value.name.trim()
  || (editedDescription.value ?? '').trim() !== savedGeneral.value.description.trim()
  || slowmodeIndex.value !== savedGeneral.value.slowmodeIndex)

const closeModal = () => {
  emit('close')
}

// Unsaved edits ask before they are dropped.
let closePrompt: Promise<void> | null = null
function requestClose() {
  if (closePrompt) return
  if (!generalDirty.value && !permissionsDirty.value) {
    closeModal()
    return
  }
  closePrompt = (async () => {
    try {
      const discard = await confirm({
        title: t('channel.edit.discardTitle'),
        message: t('channel.edit.discardMessage'),
        confirmButtonText: t('channel.edit.discard'),
        dangerAction: true,
      })
      if (discard) closeModal()
    } finally {
      closePrompt = null
    }
  })()
}

// A drag that starts inside the panel and ends on the overlay is not a click on it.
const pressedOverlay = ref(false)
function onOverlayClick() {
  const pressed = pressedOverlay.value
  pressedOverlay.value = false
  if (pressed) requestClose()
}

const { titleId } = useDialog({
  open: () => props.show,
  element: dialogEl,
  onClose: requestClose,
})

const saveChanges = async () => {
  if (!props.channel || !isValidName.value || isLoading.value) return
  
  const trimmedName = nameToSave.value
  const trimmedDescription = editedDescription.value?.trim() || null
  const currentSlowmode = props.channel.slowmode_seconds ?? 0
  const slowmodeChanged = editedSlowmode.value !== currentSlowmode

  if (trimmedName === props.channel.name && trimmedDescription === props.channel.description && !slowmodeChanged) {
    closeModal()
    return
  }
  
  isLoading.value = true
  
  try {
    await serverChannelStore.updateChannel({
      id: props.channel.id,
      name: trimmedName,
      // null clears the stored description.
      description: trimmedDescription,
      ...(slowmodeChanged ? { slowmode_seconds: editedSlowmode.value } : {})
    })
    
    const updatedChannel = { 
      ...props.channel, 
      name: trimmedName, 
      description: trimmedDescription,
      slowmode_seconds: editedSlowmode.value
    } as any
    emit('updated', updatedChannel)
    closeModal()
  } catch (error: any) {
    debug.error('Failed to update channel:', error)
    const toast = useToast()
    toast.error(error?.message || t('channel.edit.errors.update'))
  } finally {
    isLoading.value = false
  }
}

function resetGeneral(channel: Channel) {
  editedName.value = channel.name || ''
  editedDescription.value = channel.description || ''
  const stepIndex = slowmodeStepIndex(channel.slowmode_seconds)
  slowmodeIndex.value = stepIndex
  savedGeneral.value = { name: editedName.value, description: editedDescription.value, slowmodeIndex: stepIndex }
}

// Watch for channel changes to reset form
watch(() => props.channel, (newChannel) => {
  if (newChannel) resetGeneral(newChannel)
}, { immediate: true })

// Reopening starts from the saved values: discarded edits do not come back.
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    if (props.channel) resetGeneral(props.channel)
    nextTick(() => {
      nameInput.value?.focus()
      nameInput.value?.select()
    })
  }
})

// Tabs + Permissions tab state

type ChannelEditTab = 'general' | 'permissions' | 'webhooks'

// A webhook manager without Manage Channels sees the Webhooks tab alone.
const tabs = computed(() => {
  const list: Array<{ id: ChannelEditTab; label: string }> = []
  if (canManageEncryption.value || !canManageChannelWebhooks.value) {
    list.push({ id: 'general', label: t('channel.edit.tabs.general') }, { id: 'permissions', label: t('channel.permissions') })
  }
  if (canManageChannelWebhooks.value) list.push({ id: 'webhooks', label: t('webhooks.tab') })
  return list
})
const activeTab = ref<ChannelEditTab>('general')

const { onKeydown: onTabsKeydown } = useRovingTabindex(tablistEl, {
  itemSelector: '[role="tab"]',
  orientation: 'horizontal',
  onActivate: (item) => {
    activeTab.value = item.dataset.tab as ChannelEditTab
  },
})

watch([() => props.show, tabs], ([visible]) => {
  if (visible && !tabs.value.some(tab => tab.id === activeTab.value)) {
    activeTab.value = tabs.value[0]?.id ?? 'general'
  }
}, { immediate: true })

const serverRoles = ref<ServerRole[]>([])
const rolesLoading = ref(false)
const savingPermissions = ref(false)

/**
 * Per-role tri-state map for this channel's overrides.
 * Structure: { [roleId]: { [Permission]: 'allow' | 'deny' | 'inherit' } }
 *
 * 'inherit' = no row in channel_permission_overrides (or the bit is 0 in both
 * allow_permissions and deny_permissions).
 * 'allow'   = bit set in allow_permissions.
 * 'deny'    = bit set in deny_permissions.
 *
 * Two copies are held (initial + working) so dirty state is detectable and only
 * changed roles are persisted.
 */
const initialPermState = ref<Record<string, Partial<Record<Permission, TriState>>>>({})
const workingPermState = ref<Record<string, Partial<Record<Permission, TriState>>>>({})
const selectedRoleId = ref<string | null>(null)

// Voice channels add the voice group and drop text-only bits. Saves touch only these bits; the
// rest of an override stays.
const permissionGroups = computed(() => channelPermissionGroups(props.channel?.type))
const editablePermissions = computed(() => permissionGroups.value.flatMap(g => g.permissions))

const everyoneRole = computed(() => serverRoles.value.find(r => r.is_default) || null)
const assignableRoles = computed(() => serverRoles.value.filter(r => !r.is_default))
const isPrivate = computed(() =>
  !!everyoneRole.value && getPermState(everyoneRole.value.id, Permission.VIEW_CHANNEL) === 'deny')

function setPrivate(value: boolean) {
  if (!everyoneRole.value) return
  setPermState(everyoneRole.value.id, Permission.VIEW_CHANNEL, value ? 'deny' : 'inherit')
}

function setRoleCanView(roleId: string, canView: boolean) {
  setPermState(roleId, Permission.VIEW_CHANNEL, canView ? 'allow' : 'inherit')
}

const dirtyRoleIds = computed(() => new Set(serverRoles.value
  .filter(role => JSON.stringify(initialPermState.value[role.id] ?? {}) !== JSON.stringify(workingPermState.value[role.id] ?? {}))
  .map(role => role.id)))

function resetRole(roleId: string) {
  workingPermState.value[roleId] = JSON.parse(
    JSON.stringify(initialPermState.value[roleId] ?? {}),
  )
}

const permissionsDirty = computed(() => {
  return JSON.stringify(initialPermState.value) !== JSON.stringify(workingPermState.value)
})

function getPermState(roleId: string, perm: Permission): TriState {
  return workingPermState.value[roleId]?.[perm] ?? 'inherit'
}

// Inherit is the absence of a key, so returning to the loaded state reads as clean.
function setPermState(roleId: string, perm: Permission, state: TriState) {
  if (!workingPermState.value[roleId]) workingPermState.value[roleId] = {}
  if (state === 'inherit') delete workingPermState.value[roleId][perm]
  else workingPermState.value[roleId][perm] = state
}

async function loadPermissions() {
  if (!props.channel?.server_id) return
  rolesLoading.value = true
  try {
    const [roles, overrides] = await Promise.all([
      roleService.getRolesForServer(props.channel.server_id),
      roleService.getChannelOverrides(props.channel.id),
    ])
    // Sort by position descending (highest-role-first), matching the role manager.
    serverRoles.value = [...roles].sort((a, b) => b.position - a.position)

    const state: typeof initialPermState.value = {}
    for (const role of serverRoles.value) {
      state[role.id] = {}
    }
    for (const ov of overrides) {
      if (ov.target_type !== 'role' || !ov.role_id) continue
      const allowMap = bitmaskToPermissions(BigInt(ov.allow_permissions ?? 0))
      const denyMap = bitmaskToPermissions(BigInt(ov.deny_permissions ?? 0))
      if (!state[ov.role_id]) state[ov.role_id] = {}
      for (const perm of editablePermissions.value) {
        if (allowMap[perm.key]) state[ov.role_id][perm.key] = 'allow'
        else if (denyMap[perm.key]) state[ov.role_id][perm.key] = 'deny'
      }
    }

    initialPermState.value = JSON.parse(JSON.stringify(state))
    workingPermState.value = JSON.parse(JSON.stringify(state))
    // Auto-select @everyone (or the first role) so the editor pane isn't blank.
    if (!selectedRoleId.value || !serverRoles.value.some(r => r.id === selectedRoleId.value)) {
      const everyone = serverRoles.value.find(r => r.is_default) || serverRoles.value[0]
      selectedRoleId.value = everyone?.id ?? null
    }
  } catch (err) {
    debug.error('Failed to load channel permissions:', err)
    useToast().error(t('channel.edit.errors.loadPermissions'))
  } finally {
    rolesLoading.value = false
  }
}

async function savePermissions() {
  if (!props.channel || savingPermissions.value || !permissionsDirty.value) return
  savingPermissions.value = true
  const toast = useToast()
  try {
    for (const role of serverRoles.value) {
      const before = initialPermState.value[role.id] ?? {}
      const after = workingPermState.value[role.id] ?? {}
      // Skip roles whose state didn't change.
      if (JSON.stringify(before) === JSON.stringify(after)) continue

      const allow: Partial<Record<Permission, boolean>> = {}
      const deny: Partial<Record<Permission, boolean>> = {}
      for (const perm of editablePermissions.value) {
        const s = after[perm.key] ?? 'inherit'
        if (s === 'allow') allow[perm.key] = true
        else if (s === 'deny') deny[perm.key] = true
      }

      const ok = await roleService.setChannelOverride(
        props.channel.id,
        'role',
        role.id,
        allow,
        deny,
        editablePermissions.value.map(p => p.key),
      )
      if (!ok) throw new Error(t('channel.edit.errors.saveOverride', { role: role.name }))
    }

    initialPermState.value = JSON.parse(JSON.stringify(workingPermState.value))
    toast.success(t('channel.edit.permissionsSaved'))
  } catch (err: any) {
    debug.error('Failed to save channel permissions:', err)
    toast.error(err?.message || t('channel.edit.errors.savePermissions'))
  } finally {
    savingPermissions.value = false
  }
}

// Load permissions when the Permissions tab is first opened (lazy)
watch([() => props.show, activeTab, () => props.channel?.id], ([visible, tab]) => {
  if (visible && tab === 'permissions' && serverRoles.value.length === 0) {
    void loadPermissions()
  }
})

watch(() => props.show, (visible) => {
  if (!visible) {
    activeTab.value = 'general'
    serverRoles.value = []
    initialPermState.value = {}
    workingPermState.value = {}
    selectedRoleId.value = null
  }
})
</script>

<style scoped>
.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal-container {
  background: var(--background-secondary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  width: 100%;
  max-width: 480px;
  max-height: calc(90 * var(--app-vh));
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

@media (prefers-reduced-motion: no-preference) {
  .modal-overlay {
    animation: fadeIn 0.15s ease-out;
  }

  .modal-container {
    animation: slideUp 0.15s ease-out;
  }
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.modal-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  color: var(--text-secondary);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.modal-close:hover {
  background: var(--background-quinary);
  color: var(--text-secondary);
}

.modal-body {
  padding: 24px;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}

.modal-body:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.form-group {
  margin-bottom: 20px;
}

.form-group:last-child {
  margin-bottom: 0;
}

.form-group label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.form-input {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 12px;
  color: var(--text-secondary);
  font-size: 1rem;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.form-textarea {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 12px;
  color: var(--text-secondary);
  font-size: 1rem;
  resize: vertical;
  min-height: 80px;
  font-family: inherit;
  transition: border-color 0.15s ease;
}

.form-textarea:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.character-count {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-align: right;
  margin-top: 4px;
}

.channel-type-display {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  color: var(--text-secondary);
}

.channel-type-icon {
  display: flex;
  align-items: center;
  color: var(--text-muted);
}

.form-hint {
  font-size: 0.75rem;
  color: var(--text-muted);
  margin-top: 4px;
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
  min-width: 44px;
  text-align: right;
  font-size: 0.85rem;
  font-weight: 600;
  color: var(--text-link);
}

.slowmode-value.off {
  color: var(--text-muted);
  font-weight: 500;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
  background: var(--background-secondary);
  flex-shrink: 0;
}

.btn {
  padding: 10px 20px;
  border: none;
  border-radius: 4px;
  font-size: 0.875rem;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled,
.btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--background-quinary);
  color: var(--text-secondary);
}

.btn-primary {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled):not([aria-disabled='true']) {
  background: var(--harmony-primary-fill-hover);
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(16px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .modal-container {
    margin: 20px;
    max-width: none;
  }
  
  .modal-header {
    padding: 16px 20px;
  }
  
  .modal-body {
    padding: 20px;
  }
  
  .modal-footer {
    padding: 12px 20px;
    flex-direction: column-reverse;
  }
  
  .btn {
    width: 100%;
    justify-content: center;
  }
}

/* =========================================================================
   Tabs
   ======================================================================= */
.modal-tabs {
  display: flex;
  gap: 4px;
  padding: 0 24px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.modal-tab {
  background: none;
  border: none;
  padding: 10px 14px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-secondary);
  cursor: pointer;
  border-bottom: 2px solid transparent;
  transition: color 0.15s, border-color 0.15s;
}

.modal-tab:hover {
  color: var(--text-primary);
}

.modal-tab.active {
  color: var(--text-link);
  border-bottom-color: var(--harmony-primary);
}

/* Wider modal so the rail + editor layout breathes */
.modal-container {
  max-width: 760px;
}

/* =========================================================================
   Permissions tab - Discord-style rail + editor layout
   ======================================================================= */
.private-card {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  background: var(--background-secondary);
}

.private-head {
  display: flex;
  align-items: center;
  gap: 12px;
}

.private-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.private-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
  min-width: 0;
}

.private-title {
  font-weight: 600;
  color: var(--text-primary);
}

.private-desc {
  font-size: 12px;
  color: var(--text-secondary);
}

.private-roles {
  display: flex;
  flex-direction: column;
  gap: 8px;
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

.perm-rail-label {
  margin: 0;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
  padding: 0 8px 8px;
}

.role-color-dot {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
