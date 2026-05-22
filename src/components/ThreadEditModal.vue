<template>
  <Teleport to="body">
    <div v-if="show" class="modal-overlay" @click="closeModal">
      <div class="modal-container" @click.stop>
        <div class="modal-header">
          <h2 class="modal-title">Edit Thread</h2>
          <button class="modal-close" @click="closeModal">
            <svg width="24" height="24" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19,6.41L17.59,5L12,10.59L6.41,5L5,6.41L10.59,12L5,17.59L6.41,19L12,13.41L17.59,19L19,17.59L13.41,12L19,6.41Z"/>
            </svg>
          </button>
        </div>
        
        <div class="modal-body">
          <div class="form-group">
            <label for="thread-name">Thread Name</label>
            <input
              id="thread-name"
              v-model="editedName"
              type="text"
              class="form-input"
              placeholder="Enter thread name"
              maxlength="100"
              @keydown.enter="saveChanges"
              @keydown.escape="closeModal"
              ref="nameInput"
            />
            <div class="character-count">{{ editedName.length }}/100</div>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                v-model="editedLocked"
                class="checkbox-input"
              />
              <span>Lock thread (prevent new messages)</span>
            </label>
          </div>

          <div class="form-group">
            <label class="checkbox-label">
              <input
                type="checkbox"
                v-model="editedArchived"
                class="checkbox-input"
              />
              <span>Archive thread</span>
            </label>
          </div>

          <div v-if="editedArchived" class="archive-note">
            Archived threads can still be viewed but won't appear in the active list.
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
import { debug } from '@/utils/debug'
import { threadService } from '@/services/ThreadService'
import type { Thread } from '@/types'

interface Props {
  show: boolean
  thread: Thread | null
}

interface Emits {
  (e: 'close'): void
  (e: 'updated', thread: Thread): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const editedName = ref('')
const editedLocked = ref(false)
const editedArchived = ref(false)
const isLoading = ref(false)
const nameInput = ref<HTMLInputElement>()

const isValidName = computed(() => {
  return editedName.value.trim().length > 0 && editedName.value.trim().length <= 100
})

const closeModal = () => {
  emit('close')
}

const saveChanges = async () => {
  if (!props.thread || !isValidName.value || isLoading.value) return
  
  const trimmedName = editedName.value.trim()
  
  // Check if anything actually changed
  const hasChanges = 
    trimmedName !== props.thread.name ||
    editedLocked.value !== (props.thread.locked ?? false) ||
    editedArchived.value !== (props.thread.archived ?? false)
  
  if (!hasChanges) {
    closeModal()
    return
  }
  
  isLoading.value = true
  
  try {
    const updatedThread = await threadService.updateThread(props.thread.id, {
      name: trimmedName,
      locked: editedLocked.value,
      archived: editedArchived.value
    })
    
    if (updatedThread) {
      emit('updated', updatedThread)
      closeModal()
    }
  } catch (error) {
    debug.error('Failed to update thread:', error)
  } finally {
    isLoading.value = false
  }
}

// Watch for thread changes to reset form
watch(() => props.thread, (newThread) => {
  if (newThread) {
    editedName.value = newThread.name || ''
    editedLocked.value = newThread.locked ?? false
    editedArchived.value = newThread.archived ?? false
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
  padding: 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}

.modal-title {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
}

.modal-close {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
  transition: background 0.15s ease, color 0.15s ease;
}

.modal-close:hover {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.modal-body {
  padding: 16px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  color: #b9bbbe;
  margin-bottom: 8px;
}

.form-input {
  width: 100%;
  padding: 10px;
  font-size: 16px;
  color: #dcddde;
  background: #202225;
  border: 1px solid #040405;
  border-radius: 3px;
  outline: none;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  border-color: #38BDF8;
}

.character-count {
  font-size: 11px;
  color: var(--text-muted);
  text-align: right;
  margin-top: 4px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  font-size: 14px;
  color: #dcddde;
  text-transform: none;
  font-weight: normal;
}

.checkbox-input {
  width: 18px;
  height: 18px;
  cursor: pointer;
  accent-color: #38BDF8;
}

.archive-note {
  font-size: 13px;
  color: var(--text-muted);
  padding: 8px 12px;
  background: rgba(255, 255, 255, 0.02);
  border-radius: 4px;
  margin-top: 8px;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px;
  background: var(--background-tertiary);
}

.btn {
  padding: 10px 16px;
  font-size: 14px;
  font-weight: 500;
  border-radius: 3px;
  border: none;
  cursor: pointer;
  transition: background 0.15s ease, opacity 0.15s ease;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-secondary {
  background: transparent;
  color: var(--text-primary);
}

.btn-secondary:hover:not(:disabled) {
  text-decoration: underline;
}

.btn-primary {
  background: #38BDF8;
  color: var(--text-primary);
}

.btn-primary:hover:not(:disabled) {
  background: #677bc4;
}

.loading-spinner {
  display: inline-block;
  width: 14px;
  height: 14px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.6s linear infinite;
  margin-right: 8px;
}

@keyframes fadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes slideUp {
  from { transform: translateY(20px); opacity: 0; }
  to { transform: translateY(0); opacity: 1; }
}

@keyframes spin {
  to { transform: rotate(360deg); }
}
</style>

