<template>
  <UnifiedConfirmationModal
    v-if="state.scope !== null"
    :model-value="state.open"
    :title="title"
    :message="state.reason"
    :secondary-message="audience"
    :confirm-button-text="confirmLabel"
    :danger-action="true"
    @confirm="handleConfirm"
    @cancel="handleCancel"
    @update:model-value="onModelUpdate"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue'
import {
  encryptionFallbackPromptState,
  resolveEncryptionFallbackPrompt,
} from '@/composables/useEncryptionFallbackPrompt'
import UnifiedConfirmationModal from './shared/UnifiedConfirmationModal.vue'

/**
 * Global modal that backs `useEncryptionFallbackPrompt`. Mounted once at the
 * App level. Renders only when the composable opens a prompt; otherwise it's
 * a no-op (no DOM, no listeners).
 *
 * Bug reference: replaces the previous `window.confirm` flow in
 * `ChatComponent` / `DMView`, which both looked like a native browser
 * alert and didn't compose with the rest of the UI.
 */

const state = encryptionFallbackPromptState

const title = computed(() => {
  const noun = state.value.noun
  // Capitalize first letter so the title reads like a sentence.
  const capNoun = noun.charAt(0).toUpperCase() + noun.slice(1)
  return `Send ${capNoun} Unencrypted?`
})

const audience = computed(() => state.value.audience)

const confirmLabel = computed(() => {
  if (state.value.scope === 'dm') return 'Send DM unencrypted'
  if (state.value.scope === 'thread') return 'Send reply unencrypted'
  return 'Send unencrypted'
})

const handleConfirm = () => resolveEncryptionFallbackPrompt(true)
const handleCancel = () => resolveEncryptionFallbackPrompt(false)

const onModelUpdate = (next: boolean) => {
  // UnifiedConfirmationModal emits `update:modelValue(false)` when it closes
  // via overlay click / escape. Treat that as cancel.
  if (!next) resolveEncryptionFallbackPrompt(false)
}
</script>
