<template>
  <div class="call-chat-elsewhere" data-testid="call-chat-elsewhere">
    <Icon name="message-square" :size="28" class="call-chat-elsewhere__icon" aria-hidden="true" />
    <p class="call-chat-elsewhere__text">{{ t('voice.callChat.elsewhereText') }}</p>
    <button type="button" class="call-chat-elsewhere__action" @click="setCallChatOpen(false)">
      {{ t('voice.callChat.elsewhereAction') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { setCallChatOpen } from './callChat'

const { t } = useT()
</script>

<style scoped>
.call-chat-elsewhere {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 24px;
  text-align: center;
  background: var(--background-primary);
  color: var(--text-secondary);
}

.call-chat-elsewhere__icon {
  color: var(--text-muted);
}

.call-chat-elsewhere__text {
  margin: 0;
  max-width: 320px;
  font-size: var(--font-size-sm);
}

.call-chat-elsewhere__action {
  padding: 8px 16px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.call-chat-elsewhere__action:hover {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
}
</style>
