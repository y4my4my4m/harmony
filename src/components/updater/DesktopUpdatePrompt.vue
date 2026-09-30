<template>
  <UnifiedModal
    :model-value="state.promptOpen"
    :title="t('updater.readyTitle')"
    size="sm"
    @update:model-value="onModelValue"
  >
    <template #icon>
      <svg viewBox="0 0 24 24" class="update-prompt-icon" aria-hidden="true">
        <path fill="currentColor" d="M5,20H19V18H5M19,9H15V3H9V9H5L12,16L19,9Z" />
      </svg>
    </template>

    <p class="update-prompt-body">
      {{ t('updater.readyBody', { version: state.availableVersion ?? '' }) }}
    </p>

    <template #footer>
      <div class="update-prompt-actions">
        <UnifiedButton variant="ghost" :text="t('updater.later')" @click="closeUpdatePrompt" />
        <UnifiedButton
          variant="success"
          :text="t('updater.restartToUpdate')"
          :loading="state.phase === 'installing'"
          @click="restart"
        />
      </div>
    </template>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import { useDesktopUpdater } from '@/composables/useDesktopUpdater'
import { claimReadyAnnouncement } from '@/services/desktopUpdater'

const { t } = useI18n()
const toast = useToast()
const { state, installAndRestart, openUpdatePrompt, closeUpdatePrompt } = useDesktopUpdater()

function onModelValue(open: boolean) {
  if (!open) closeUpdatePrompt()
}

async function restart() {
  try {
    await installAndRestart()
  } catch (error) {
    toast.error(t('updater.installFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}

watch(
  () => state.phase,
  (phase) => {
    const version = state.availableVersion
    if (phase !== 'ready' || !version || !claimReadyAnnouncement(version)) return
    toast.success(t('updater.readyToast', { version }), {
      timeout: 10000,
      onClick: openUpdatePrompt,
    })
  },
  { immediate: true },
)
</script>

<style scoped>
.update-prompt-icon {
  width: 24px;
  height: 24px;
  color: var(--success);
}

.update-prompt-body {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.5;
  color: var(--text-secondary);
}

.update-prompt-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-2);
}
</style>
