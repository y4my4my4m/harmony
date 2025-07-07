<template>
  <div v-if="show" class="modal-overlay" @click="closeModal">
    <div class="modal-container" @click.stop>
      <div class="modal-header">
        <h2 class="modal-title">{{ title }}</h2>
      </div>
      
      <div class="modal-body">
        <div class="warning-icon">
          <svg width="48" height="48" viewBox="0 0 24 24">
            <path fill="currentColor" d="M1,21H23L12,2M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16"/>
          </svg>
        </div>
        
        <div class="warning-text">
          <p class="warning-primary">{{ message }}</p>
          <p v-if="secondaryMessage" class="warning-secondary">{{ secondaryMessage }}</p>
        </div>
        
        <div v-if="requireConfirmation" class="confirmation-section">
          <label for="confirm-input">Type <strong>{{ confirmationText }}</strong> to confirm</label>
          <input
            id="confirm-input"
            v-model="confirmationInput"
            type="text"
            class="form-input"
            :placeholder="confirmationText"
            @keydown.enter="confirmAction"
            @keydown.escape="closeModal"
            ref="confirmInput"
          />
        </div>
      </div>
      
      <div class="modal-footer">
        <button class="btn btn-secondary" @click="closeModal">
          Cancel
        </button>
        <button 
          class="btn btn-danger" 
          @click="confirmAction"
          :disabled="requireConfirmation && !isConfirmed || isLoading"
        >
          <span v-if="isLoading" class="loading-spinner"></span>
          {{ isLoading ? 'Deleting...' : confirmButtonText }}
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch, nextTick } from 'vue'

interface Props {
  show: boolean
  title: string
  message: string
  secondaryMessage?: string
  confirmButtonText?: string
  requireConfirmation?: boolean
  confirmationText?: string
}

interface Emits {
  (e: 'close'): void
  (e: 'confirm'): void
}

const props = withDefaults(defineProps<Props>(), {
  confirmButtonText: 'Delete',
  requireConfirmation: false,
  confirmationText: 'DELETE'
})

const emit = defineEmits<Emits>()

const confirmationInput = ref('')
const isLoading = ref(false)
const confirmInput = ref<HTMLInputElement>()

const isConfirmed = computed(() => {
  if (!props.requireConfirmation) return true
  return confirmationInput.value === props.confirmationText
})

const closeModal = () => {
  confirmationInput.value = ''
  isLoading.value = false
  emit('close')
}

const confirmAction = async () => {
  if (!isConfirmed.value || isLoading.value) return
  
  isLoading.value = true
  
  try {
    emit('confirm')
  } finally {
    // The parent component should handle closing the modal
    // isLoading.value = false
  }
}

// Handle modal visibility changes
watch(() => props.show, (isVisible) => {
  if (isVisible) {
    // Reset confirmation input and loading state
    confirmationInput.value = ''
    isLoading.value = false
    
    // Focus input if confirmation is required
    if (props.requireConfirmation) {
      nextTick(() => {
        confirmInput.value?.focus()
      })
    }
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
  background: #36393f;
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  width: 100%;
  max-width: 440px;
  max-height: 90vh;
  overflow: hidden;
  animation: slideUp 0.15s ease-out;
}

.modal-header {
  padding: 24px 24px 0;
}

.modal-title {
  font-size: 1.5rem;
  font-weight: 600;
  color: #ffffff;
  margin: 0;
}

.modal-body {
  padding: 24px;
  text-align: center;
}

.warning-icon {
  color: #faa61a;
  margin-bottom: 16px;
}

.warning-text {
  margin-bottom: 20px;
}

.warning-primary {
  font-size: 1rem;
  color: #dcddde;
  margin: 0 0 8px 0;
  font-weight: 500;
}

.warning-secondary {
  font-size: 0.875rem;
  color: #b9bbbe;
  margin: 0;
  line-height: 1.4;
}

.confirmation-section {
  text-align: left;
  margin-top: 20px;
}

.confirmation-section label {
  display: block;
  font-size: 0.875rem;
  font-weight: 600;
  color: #b9bbbe;
  margin-bottom: 8px;
}

.form-input {
  width: 100%;
  background: #40444b;
  border: 1px solid #40444b;
  border-radius: 4px;
  padding: 12px;
  color: #dcddde;
  font-size: 1rem;
  transition: border-color 0.15s ease;
}

.form-input:focus {
  outline: none;
  border-color: #ed4245;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 12px;
  padding: 0 24px 24px;
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
  color: #b9bbbe;
}

.btn-secondary:hover:not(:disabled) {
  background: #40444b;
  color: #dcddde;
}

.btn-danger {
  background: #ed4245;
  color: #ffffff;
}

.btn-danger:hover:not(:disabled) {
  background: #c03537;
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
