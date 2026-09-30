<template>
  <Teleport to="body">
    <RecoveryKeySetupWizard
      v-if="activeModal === 'setup'"
      @close="activeModal = null"
      @complete="handleDone"
    />
    <KeyRecoveryModal
      v-if="activeModal === 'unlock'"
      @close="activeModal = null"
      @restored="handleDone"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { defineAsyncComponent, onBeforeUnmount, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import {
  ENCRYPTION_ACTION_EVENT,
  ENCRYPTION_STATE_CHANGED_EVENT,
  type EncryptionActionDetail,
} from '@/composables/useEncryptionAction'

const RecoveryKeySetupWizard = defineAsyncComponent(() => import('@/components/encryption/RecoveryKeySetupWizard.vue'))
const KeyRecoveryModal = defineAsyncComponent(() => import('@/components/encryption/KeyRecoveryModal.vue'))

const toast = useToast()
const activeModal = ref<'setup' | 'unlock' | null>(null)

function handleAction(event: Event) {
  const detail = (event as CustomEvent<EncryptionActionDetail>).detail
  if (!detail) return
  toast.error(detail.message)
  if (detail.reason === 'setup' || detail.reason === 'unlock') {
    activeModal.value = detail.reason
  }
}

function handleDone() {
  activeModal.value = null
  window.dispatchEvent(new CustomEvent(ENCRYPTION_STATE_CHANGED_EVENT))
}

onMounted(() => window.addEventListener(ENCRYPTION_ACTION_EVENT, handleAction))
onBeforeUnmount(() => window.removeEventListener(ENCRYPTION_ACTION_EVENT, handleAction))
</script>
