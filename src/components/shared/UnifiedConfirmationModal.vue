<template>
  <UnifiedModal
    :model-value="modelValue"
    :title="title"
    :subtitle="subtitle"
    size="sm"
    :persistent="requireConfirmation && !isConfirmed"
    @close="handleClose"
    @update:model-value="$emit('update:modelValue', $event)"
  >
    <template #icon>
      <svg viewBox="0 0 24 24" class="warning-icon">
        <path d="M1,21H23L12,2M12,6L19.53,19H4.47M11,10V14H13V10M11,16V18H13V16" fill="currentColor"/>
      </svg>
    </template>

    <div class="confirmation-content">
      <!-- Warning message -->
      <div class="message-section">
        <p class="message-primary">{{ message }}</p>
        <p v-if="secondaryMessage" class="message-secondary">{{ secondaryMessage }}</p>
      </div>

      <!-- Confirmation input -->
      <div v-if="requireConfirmation" class="confirmation-section">
        <UnifiedInput
          v-model="confirmationInput"
          :label="confirmationLabel"
          :placeholder="confirmationText"
          :error-message="showConfirmationError ? 'Please type the exact text to confirm' : undefined"
          autofocus
          @keydown.enter="handleConfirm"
          @keydown.escape="handleClose"
        />
      </div>
    </div>

    <template #footer>
      <div class="modal-actions">
        <UnifiedButton
          variant="ghost"
          text="Cancel"
          :disabled="isLoading"
          @click="handleClose"
        />
        <UnifiedButton
          :variant="dangerAction ? 'danger' : 'primary'"
          :text="confirmButtonText"
          :disabled="requireConfirmation && !isConfirmed"
          :loading="isLoading"
          @click="handleConfirm"
        />
      </div>
    </template>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue'
import UnifiedModal from './UnifiedModal.vue'
import UnifiedButton from './UnifiedButton.vue'
import UnifiedInput from './UnifiedInput.vue'

interface Props {
  modelValue: boolean
  title: string
  message: string
  secondaryMessage?: string
  confirmButtonText?: string
  subtitle?: string
  requireConfirmation?: boolean
  confirmationText?: string
  dangerAction?: boolean
}

interface Emits {
  (e: 'update:modelValue', value: boolean): void
  (e: 'confirm'): void
  (e: 'cancel'): void
}

const props = withDefaults(defineProps<Props>(), {
  confirmButtonText: 'Confirm',
  requireConfirmation: false,
  confirmationText: 'DELETE',
  dangerAction: false
})

const emit = defineEmits<Emits>()

const confirmationInput = ref('')
const isLoading = ref(false)
const showConfirmationError = ref(false)

const confirmationLabel = computed(() => {
  return `Type "${props.confirmationText}" to confirm`
})

const isConfirmed = computed(() => {
  if (!props.requireConfirmation) return true
  return confirmationInput.value === props.confirmationText
})

const handleClose = () => {
  if (isLoading.value) return
  
  confirmationInput.value = ''
  showConfirmationError.value = false
  emit('update:modelValue', false)
  emit('cancel')
}

const handleConfirm = async () => {
  if (!isConfirmed.value) {
    showConfirmationError.value = true
    return
  }
  
  if (isLoading.value) return
  
  isLoading.value = true
  showConfirmationError.value = false
  
  try {
    emit('confirm')
  } finally {
    // Keep loading state - parent should handle closing
  }
}

watch(() => props.modelValue, (isOpen) => {
  if (isOpen) {
    confirmationInput.value = ''
    isLoading.value = false
    showConfirmationError.value = false
  }
})
</script>

<style scoped>
.warning-icon {
  color: var(--warning);
}

.confirmation-content {
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
}

.message-section {
  text-align: center;
}

.message-primary {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 var(--space-3) 0;
  line-height: var(--line-height-normal);
}

.message-secondary {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
  line-height: var(--line-height-relaxed);
}

.confirmation-section {
  margin-top: var(--space-4);
}

.modal-actions {
  display: flex;
  gap: var(--space-3);
  justify-content: flex-end;
}

/* Mobile responsive */
@media (max-width: 768px) {
  .modal-actions {
    flex-direction: column-reverse;
    gap: var(--space-2);
  }
  
  .modal-actions .btn {
    width: 100%;
    justify-content: center;
  }
}
</style>