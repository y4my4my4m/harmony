<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="closeModal">
      <div class="modal-container" @click.stop>
        <div class="modal-header">
          <h2 class="modal-title">Edit Category</h2>
          <button class="modal-close" @click="closeModal">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body">
          <div class="form-group">
            <label for="category-name">Category Name</label>
            <input
              id="category-name"
              v-model="editedName"
              type="text"
              class="form-input"
              placeholder="Enter category name"
              maxlength="100"
              @keydown.enter="saveChanges"
              @keydown.escape="closeModal"
              ref="nameInput"
            />
            <div class="character-count">{{ editedName.length }}/100</div>
          </div>
        </div>
        
        <div class="modal-footer">
          <button class="btn btn-secondary" @click="closeModal">
            Cancel
          </button>
          <button 
            class="btn btn-primary" 
            @click="saveChanges"
            :disabled="!isValidName || isLoading"
          >
            <span v-if="isLoading" class="loading-spinner"></span>
            {{ isLoading ? 'Saving...' : 'Save Changes' }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'
import { useToast } from 'vue-toastification'
import { debug } from '@/utils/debug'
import { useServerChannelStore } from '@/stores/useServerChannel'
import type { Category } from '@/types'

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

const serverChannelStore = useServerChannelStore()

const editedName = ref('')
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

const isValidName = computed(() => {
  return editedName.value.trim().length > 0 && editedName.value.trim().length <= 100
})

const closeModal = () => {
  emit('close')
}

const saveChanges = async () => {
  if (!props.category || !isValidName.value || isLoading.value) return
  
  const trimmedName = editedName.value.trim()
  
  // Check if anything actually changed
  if (trimmedName === props.category.name) {
    closeModal()
    return
  }
  
  isLoading.value = true
  
  try {
    await serverChannelStore.updateCategory({
      id: props.category.id,
      name: trimmedName
    })
    
    // Emit updated event with the updated category data
    const updatedCategory = { 
      ...props.category, 
      name: trimmedName
    }
    emit('updated', updatedCategory)
    closeModal()
  } catch (error: any) {
    debug.error('Failed to update category:', error)
    const toast = useToast()
    toast.error(error?.message || 'Failed to update category. Please try again.')
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

// Focus input when modal opens
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    nextTick(() => {
      nameInput.value?.focus()
      nameInput.value?.select()
    })
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
  animation: fadeIn 0.15s ease-out;
}

.modal-container {
  background: var(--background-secondary);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  width: 100%;
  max-width: 480px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.15s ease-out;
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
  background: var(--h-black-lighter);
  color: var(--text-secondary);
}

.modal-body {
  padding: 24px;
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
  background: var(--h-black-lighter);
  border: 1px solid var(--h-black-lighter);
  border-radius: 4px;
  padding: 12px;
  color: var(--text-secondary);
  font-size: 1rem;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: #0EA5E9;
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
  background: var(--h-black-lighter);
  color: var(--text-secondary);
}

.btn-primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: #0284C7;
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
