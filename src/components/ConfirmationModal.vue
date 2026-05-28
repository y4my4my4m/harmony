<template>
  <UnifiedConfirmationModal
    :model-value="show"
    @update:model-value="$emit('update:modelValue', $event)"
    :title="title"
    :message="message"
    :secondary-message="secondaryMessage"
    :confirm-button-text="confirmButtonText"
    :require-confirmation="requireConfirmation"
    :confirmation-text="confirmationText"
    :danger-action="true"
    @confirm="$emit('confirm')"
    @cancel="$emit('close')"
  />
</template>

<script setup lang="ts">
import UnifiedConfirmationModal from './shared/UnifiedConfirmationModal.vue'

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
  (e: 'update:modelValue', value: boolean): void
}

withDefaults(defineProps<Props>(), {
  confirmButtonText: 'Delete',
  requireConfirmation: false,
  confirmationText: 'DELETE'
})

defineEmits<Emits>()
</script>

<!-- No custom styles needed - using unified components -->
