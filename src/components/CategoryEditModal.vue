<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="closeModal">
      <div
        ref="dialogEl"
        class="modal-container"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="titleId"
        tabindex="-1"
        data-testid="category-edit-dialog"
        @click.stop
      >
        <div class="modal-header">
          <h2 :id="titleId" class="modal-title">{{ t('category.edit.title') }}</h2>
          <button type="button" class="modal-close" :aria-label="t('common.close')" :title="t('common.close')" @click="closeModal">
            <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>

        <div class="modal-body">
          <div class="form-group">
            <label for="category-name">{{ t('category.edit.name') }}</label>
            <input
              id="category-name"
              v-model="editedName"
              type="text"
              class="form-input"
              maxlength="100"
              @keydown.enter="saveChanges"
              ref="nameInput"
            />
            <div class="character-count" aria-hidden="true">{{ editedName.length }}/100</div>
          </div>

          <div v-if="category" class="form-group">
            <p v-if="permissionsLoading" class="privacy-status" role="status">{{ t('category.edit.loadingPermissions') }}</p>
            <template v-else>
              <p v-if="permissionsFailed" class="privacy-status privacy-status--error" role="alert" data-testid="category-privacy-error">
                {{ t('category.edit.permissionsFailed') }}
              </p>
              <CategoryPrivacyFields
                v-model="privacy"
                :server-id="category.server_id"
                :disabled="permissionsFailed"
              />
            </template>
          </div>
        </div>

        <div class="modal-footer">
          <button type="button" class="btn btn-secondary" @click="closeModal">
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
import CategoryPrivacyFields from '@/components/CategoryPrivacyFields.vue'
import { getCategoryOverrides, privacyFromOverrides, type CategoryPrivacy } from '@/services/categoryPermissions'
import { roleService } from '@/services/RoleService'
import type { Category } from '@/types'
import { categoryNameProblem, finalizeCategoryName } from '@/utils/channelName'

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
const serverChannelStore = useServerChannelStore()

const dialogEl = ref<HTMLElement | null>(null)
const editedName = ref('')
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

const NO_PRIVACY: CategoryPrivacy = { isPrivate: false, roleIds: [], userIds: [] }
const privacy = ref<CategoryPrivacy>({ ...NO_PRIVACY })
const savedPrivacy = ref<CategoryPrivacy>({ ...NO_PRIVACY })
const permissionsLoading = ref(false)
const permissionsFailed = ref(false)
let privacyLoadSeq = 0

// The rule Create Category applies: spaces and case kept, whitespace collapsed, 2-100 characters.
const isValidName = computed(() => categoryNameProblem(finalizeCategoryName(editedName.value)) === null)

const samePrivacy = (a: CategoryPrivacy, b: CategoryPrivacy) =>
  a.isPrivate === b.isPrivate
  && (!a.isPrivate || (
    [...a.roleIds].sort().join() === [...b.roleIds].sort().join()
    && [...a.userIds].sort().join() === [...b.userIds].sort().join()))

const closeModal = () => {
  emit('close')
}

const { titleId } = useDialog({
  open: () => props.show,
  element: dialogEl,
  onClose: closeModal,
})

// Only the latest load lands; an earlier one may answer after it.
async function loadPrivacy(category: Category) {
  const seq = ++privacyLoadSeq
  permissionsLoading.value = true
  permissionsFailed.value = false
  try {
    const [rows, roles] = await Promise.all([
      getCategoryOverrides(category.id),
      roleService.getRolesForServer(category.server_id),
    ])
    if (seq !== privacyLoadSeq) return
    const everyone = roles.find(r => r.is_default)?.id ?? null
    savedPrivacy.value = privacyFromOverrides(rows, everyone)
    privacy.value = { ...savedPrivacy.value }
  } catch (error) {
    if (seq !== privacyLoadSeq) return
    debug.error('Failed to load category permissions:', error)
    savedPrivacy.value = { ...NO_PRIVACY }
    privacy.value = { ...NO_PRIVACY }
    permissionsFailed.value = true
  } finally {
    if (seq === privacyLoadSeq) permissionsLoading.value = false
  }
}

const saveChanges = async () => {
  if (!props.category || !isValidName.value || isLoading.value || permissionsLoading.value) return

  const trimmedName = finalizeCategoryName(editedName.value)
  const nameChanged = trimmedName !== props.category.name
  const privacyChanged = !permissionsFailed.value && !samePrivacy(privacy.value, savedPrivacy.value)

  if (!nameChanged && !privacyChanged) {
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
    if (privacyChanged) {
      const synced = await serverChannelStore.setCategoryPrivacy(props.category.id, props.category.server_id, privacy.value)
      savedPrivacy.value = { ...privacy.value }
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

// Watch for category changes to reset form
watch(() => props.category, (newCategory) => {
  if (newCategory) {
    editedName.value = newCategory.name || ''
  }
}, { immediate: true })

// Reopening starts from the saved name and the category's current permissions.
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    if (props.category) {
      editedName.value = props.category.name || ''
      void loadPrivacy(props.category)
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
  max-width: 480px;
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
  padding: 24px 24px 0;
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
  min-height: 0;
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
  padding: 12px 24px;
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
    padding: 20px 20px 0;
  }
  
  .modal-body {
    padding: 20px;
  }
  
  .modal-footer {
    padding: 0 20px 20px;
    flex-direction: column-reverse;
  }
  
  .btn {
    width: 100%;
    justify-content: center;
  }
}
</style>
