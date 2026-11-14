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
        data-testid="category-edit-dialog"
      >
        <div class="modal-header">
          <h2 :id="titleId" class="modal-title">{{ t('category.edit.title') }}</h2>
          <button type="button" class="modal-close" :aria-label="t('common.close')" :title="t('common.close')" @click="requestClose">
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
          <div v-if="activeTab === 'general'" class="form-group">
            <label for="category-name">{{ t('category.edit.name') }}</label>
            <input
              id="category-name"
              v-model="editedName"
              type="text"
              class="form-input"
              @input="onNameInput"
              @keydown.enter="saveChanges"
              ref="nameInput"
            />
            <div class="character-count" aria-hidden="true">{{ nameLength(editedName) }}/{{ NAME_MAX_LENGTH }}</div>
          </div>

          <template v-else-if="category">
            <p v-if="permissionsLoading" class="privacy-status" role="status">{{ t('category.edit.loadingPermissions') }}</p>
            <template v-else>
              <p v-if="permissionsFailed" class="privacy-status privacy-status--error" role="alert" data-testid="category-privacy-error">
                {{ t('category.edit.permissionsFailed') }}
              </p>
              <div class="privacy-card">
                <CategoryPrivacyFields
                  v-model="privacy"
                  :server-id="category.server_id"
                  :disabled="permissionsFailed || !everyoneRoleId"
                />
              </div>
              <PermissionRoleEditor
                v-if="!permissionsFailed"
                v-model:selected-role-id="selectedRoleId"
                :roles="roles"
                :groups="CATEGORY_PERMISSION_GROUPS"
                :state="roleState"
                :dirty-role-ids="dirtyRoleIds"
                :loading="false"
                :legend="t('category.edit.overrideLegend')"
                @set="setRolePermission"
                @reset="resetRole"
              />
            </template>
          </template>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" @click="requestClose">
            {{ t('common.cancel') }}
          </button>
          <button
            type="button"
            class="btn btn-primary"
            data-testid="category-edit-save"
            @click="saveChanges"
            :disabled="!isValidName || isLoading || permissionsLoading"
          >
            <span v-if="isLoading" class="loading-spinner" aria-hidden="true"></span>
            {{ isLoading ? t('category.edit.saving') : t('category.edit.save') }}
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
import { useDialog } from '@/composables/useDialog'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useRovingTabindex } from '@/composables/useRovingTabindex'
import { uid } from '@/utils/a11y/focus'
import CategoryPrivacyFields from '@/components/CategoryPrivacyFields.vue'
import PermissionRoleEditor, { type RolePermissionState } from '@/components/PermissionRoleEditor.vue'
import type { TriState } from '@/components/ChannelPermissionTriState.vue'
import { CATEGORY_PERMISSION_GROUPS } from '@/services/channelPermissionGroups'
import {
  applyPrivacy,
  getCategoryOverrides,
  overrideState,
  privacyFromOverrides,
  sameTemplate,
  targetMasks,
  withOverrideState,
  withTargetFrom,
  type CategoryOverride,
  type CategoryPrivacy,
} from '@/services/categoryPermissions'
import { roleService, PERMISSION_BITS, type Permission, type ServerRole } from '@/services/RoleService'
import type { Category } from '@/types'
import { NAME_MAX_LENGTH, categoryNameProblem, clipName, finalizeCategoryName, nameLength } from '@/utils/channelName'

interface Props {
  show: boolean
  category: Category | null
}

interface Emits {
  (e: 'close'): void
  (e: 'updated', category: Category): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { t } = useI18n()
const { confirm } = useConfirmDialog()
const serverChannelStore = useServerChannelStore()

const a11yId = uid('category-edit')
const dialogEl = ref<HTMLElement | null>(null)
const tablistEl = ref<HTMLElement | null>(null)
const editedName = ref('')
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

// The template as loaded and as edited. The Private toggle and the role editor both edit
// `template`; the save sends it whole.
const roles = ref<ServerRole[]>([])
const savedTemplate = ref<CategoryOverride[]>([])
const template = ref<CategoryOverride[]>([])
const selectedRoleId = ref<string | null>(null)
const permissionsLoading = ref(false)
const permissionsFailed = ref(false)
let permissionsLoadSeq = 0

const everyoneRoleId = computed(() => roles.value.find(r => r.is_default)?.id ?? null)

const privacy = computed<CategoryPrivacy>({
  get: () => privacyFromOverrides(template.value, everyoneRoleId.value),
  set: (value) => {
    if (everyoneRoleId.value) template.value = applyPrivacy(template.value, everyoneRoleId.value, value)
  },
})

const EDITABLE: Permission[] = CATEGORY_PERMISSION_GROUPS.flatMap(g => g.permissions.map(p => p.key))
const bitOf = (perm: Permission) => BigInt(1) << BigInt(PERMISSION_BITS[perm])
const roleTarget = (roleId: string) => ({ target_type: 'role' as const, role_id: roleId, user_id: null })

const roleState = computed<RolePermissionState>(() => {
  const state: RolePermissionState = {}
  for (const role of roles.value) {
    const entry: RolePermissionState[string] = {}
    for (const perm of EDITABLE) {
      const value = overrideState(template.value, roleTarget(role.id), bitOf(perm))
      if (value !== 'inherit') entry[perm] = value
    }
    state[role.id] = entry
  }
  return state
})

const dirtyRoleIds = computed(() => new Set(roles.value
  .filter(role => targetMasks(template.value, roleTarget(role.id)) !== targetMasks(savedTemplate.value, roleTarget(role.id)))
  .map(role => role.id)))

function setRolePermission(roleId: string, perm: Permission, value: TriState) {
  template.value = withOverrideState(template.value, roleTarget(roleId), bitOf(perm), value)
}

function resetRole(roleId: string) {
  template.value = withTargetFrom(template.value, savedTemplate.value, roleTarget(roleId))
}

const permissionsDirty = computed(() => !permissionsFailed.value && !sameTemplate(template.value, savedTemplate.value))

// The rule Create Category applies: spaces and case kept, whitespace collapsed, 2-100 characters.
const isValidName = computed(() => categoryNameProblem(finalizeCategoryName(editedName.value)) === null)
const nameDirty = computed(() => !!props.category && finalizeCategoryName(editedName.value) !== props.category.name)

// The cap counts code points, as char_length does; maxlength would count UTF-16 units.
const onNameInput = (event: Event) => {
  const input = event.target as HTMLInputElement
  const clipped = clipName(input.value)
  if (clipped === input.value) return
  input.value = clipped
  editedName.value = clipped
}

const closeModal = () => {
  emit('close')
}

// Unsaved edits ask before they are dropped.
let closePrompt: Promise<void> | null = null
function requestClose() {
  if (closePrompt) return
  if (!nameDirty.value && !permissionsDirty.value) {
    closeModal()
    return
  }
  closePrompt = (async () => {
    try {
      const discard = await confirm({
        title: t('channel.edit.discardTitle'),
        message: t('category.edit.discardMessage'),
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

type CategoryEditTab = 'general' | 'permissions'

const tabs = computed<Array<{ id: CategoryEditTab; label: string }>>(() => [
  { id: 'general', label: t('channel.edit.tabs.general') },
  { id: 'permissions', label: t('channel.permissions') },
])
const activeTab = ref<CategoryEditTab>('general')

const { onKeydown: onTabsKeydown } = useRovingTabindex(tablistEl, {
  itemSelector: '[role="tab"]',
  orientation: 'horizontal',
  onActivate: (item) => {
    activeTab.value = item.dataset.tab as CategoryEditTab
  },
})

// Only the latest load lands; an earlier one may answer after it.
async function loadPermissions(category: Category) {
  const seq = ++permissionsLoadSeq
  permissionsLoading.value = true
  permissionsFailed.value = false
  try {
    const [rows, serverRoles] = await Promise.all([
      getCategoryOverrides(category.id),
      roleService.getRolesForServer(category.server_id),
    ])
    if (seq !== permissionsLoadSeq) return
    // Highest role first, as the role manager lists them.
    roles.value = [...serverRoles].sort((a, b) => b.position - a.position)
    savedTemplate.value = rows
    template.value = rows.map(row => ({ ...row }))
    selectedRoleId.value = roles.value.find(r => r.is_default)?.id ?? roles.value[0]?.id ?? null
  } catch (error) {
    if (seq !== permissionsLoadSeq) return
    debug.error('Failed to load category permissions:', error)
    roles.value = []
    savedTemplate.value = []
    template.value = []
    selectedRoleId.value = null
    permissionsFailed.value = true
  } finally {
    if (seq === permissionsLoadSeq) permissionsLoading.value = false
  }
}

const saveChanges = async () => {
  if (!props.category || !isValidName.value || isLoading.value || permissionsLoading.value) return

  const trimmedName = finalizeCategoryName(editedName.value)
  const nameChanged = trimmedName !== props.category.name
  const templateChanged = permissionsDirty.value

  if (!nameChanged && !templateChanged) {
    closeModal()
    return
  }

  isLoading.value = true
  const toast = useToast()

  try {
    if (nameChanged) {
      await serverChannelStore.updateCategory({
        id: props.category.id,
        name: trimmedName
      })
    }
    if (templateChanged) {
      const sent = template.value.map(row => ({ ...row }))
      const synced = await serverChannelStore.setCategoryTemplate(props.category.id, sent)
      savedTemplate.value = sent
      toast.success(t('category.edit.permissionsSaved', { count: synced.length }, synced.length))
    }

    emit('updated', { ...props.category, name: trimmedName })
    closeModal()
  } catch (error: any) {
    debug.error('Failed to update category:', error)
    toast.error(error?.message || t('category.edit.failed'))
  } finally {
    isLoading.value = false
  }
}

watch(() => props.category, (newCategory) => {
  if (newCategory) {
    editedName.value = newCategory.name || ''
  }
}, { immediate: true })

// Reopening starts on General, from the saved name and the category's current permissions.
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    activeTab.value = 'general'
    if (props.category) {
      editedName.value = props.category.name || ''
      void loadPermissions(props.category)
    }
    nextTick(() => {
      nameInput.value?.focus()
      nameInput.value?.select()
    })
  }
}, { immediate: true })
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
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
  width: 100%;
  max-width: 760px;
  max-height: calc(90 * var(--app-vh));
  overflow: hidden;
  display: flex;
  flex-direction: column;
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

/* Tabs */
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
  background: var(--background-modifier-hover);
  color: var(--text-primary);
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

.privacy-card {
  padding: 12px 14px;
  margin-bottom: 14px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md, 8px);
  background: var(--background-secondary);
}

.privacy-status {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.privacy-status--error {
  margin-bottom: 8px;
  color: var(--text-danger);
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

.character-count {
  font-size: 0.75rem;
  color: var(--text-muted);
  text-align: right;
  margin-top: 4px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 24px;
  border-top: 1px solid var(--border-color);
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

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.btn-primary {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
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
    transform: translateY(20px) scale(0.95);
  }
  to {
    opacity: 1;
    transform: translateY(0) scale(1);
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

  .modal-tabs {
    padding: 0 20px;
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
</style>
