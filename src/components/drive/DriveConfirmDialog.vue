<template>
  <UnifiedConfirmationModal
    :model-value="true"
    :title="title"
    :message="message"
    :confirm-button-text="confirmLabel"
    :danger-action="danger"
    @confirm="emit('confirm')"
    @cancel="emit('cancel')"
    @update:model-value="(open) => !open && emit('cancel')"
  />
</template>

<script setup lang="ts">
import UnifiedConfirmationModal from '@/components/shared/UnifiedConfirmationModal.vue'

withDefaults(defineProps<{ title: string; message: string; confirmLabel: string; danger?: boolean }>(), { danger: false })
const emit = defineEmits<{ confirm: []; cancel: [] }>()
</script>
