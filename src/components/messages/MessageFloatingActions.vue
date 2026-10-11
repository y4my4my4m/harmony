<template>
  <Teleport to="body">
    <div
      class="message-actions message-actions-floating"
      role="group"
      :aria-label="t('messageA11y.actions.label')"
      :style="style"
    >
      <template v-if="message.is_system">
        <button type="button" class="action-btn" data-testid="msg-action-react" :aria-label="t('message.react')" aria-haspopup="dialog" @click="emit('react', message, $event)"><ReactionIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDelete" :aria-label="t('message.deleteMessage')" @click="emit('delete', message.id, $event)"><DeleteIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-more" :aria-label="t('message.moreActions')" aria-haspopup="menu" @click="emit('context-menu', message, $event)"><MoreIcon/></button>
      </template>
      <template v-else>
        <button type="button" class="action-btn" data-testid="msg-action-react" :aria-label="t('message.react')" aria-haspopup="dialog" @click="emit('react', message, $event)"><ReactionIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-reply" :aria-label="t('message.reply')" @click="emit('reply', message)"><ReplyIcon/></button>
        <button type="button" class="action-btn thread-btn" data-testid="msg-action-thread" v-if="!hideThreadActions" :aria-label="t('messageA11y.actions.thread')" @click="emit('thread', message)"><ThreadIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-edit" v-if="canEdit" :aria-label="t('message.editMessage')" @click="emit('edit', message)"><EditIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDelete" :aria-label="t('message.deleteMessage')" @click="emit('delete', message.id, $event)"><DeleteIcon/></button>
        <button type="button" class="action-btn" data-testid="msg-action-more" :aria-label="t('message.moreActions')" aria-haspopup="menu" @click="emit('context-menu', message, $event)"><MoreIcon/></button>
      </template>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import type { Message } from '@/types';
import ReactionIcon from '@/components/icons/Reaction.vue';
import ReplyIcon from '@/components/icons/Reply.vue';
import ThreadIcon from '@/components/icons/Thread.vue';
import EditIcon from '@/components/icons/Edit.vue';
import DeleteIcon from '@/components/icons/Delete.vue';
import MoreIcon from '@/components/icons/More.vue';
import { useT } from '@/composables/useT';

interface Props {
  message: Message;
  style: Record<string, string>;
  hideThreadActions?: boolean;
  isShiftHeld?: boolean;
  canEdit: boolean;
  canDelete: boolean;
}

withDefaults(defineProps<Props>(), {
  hideThreadActions: false,
  isShiftHeld: false,
});

const { t } = useT();

const emit = defineEmits<{
  (e: 'react', message: Message, event: MouseEvent): void;
  (e: 'reply', message: Message): void;
  (e: 'thread', message: Message): void;
  (e: 'edit', message: Message): void;
  (e: 'delete', messageId: string, event: MouseEvent): void;
  (e: 'context-menu', message: Message, event: MouseEvent): void;
}>();
</script>

<style scoped>
.message-actions {
  position: absolute;
  top: -16px;
  right: 0;
  display: flex;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-floating);
  box-shadow: var(--shadow-medium);
  z-index: 1;
}

.thread-btn {
  color: var(--text-link);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  color: var(--text-secondary);
  transition: all 0.15s ease-out;
  border-radius: 4px;
  margin: 2px;
}

.action-btn:hover {
  background-color: var(--harmony-primary-alpha);
  color: var(--text-primary);
}

.action-btn:active {
  background-color: var(--background-tertiary-alpha);
  transform: scale(0.95);
}

.action-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.action-btn.delete-danger {
  color: var(--text-danger) !important;
  background-color: color-mix(in srgb, var(--error) 50%, transparent) !important;
}

.action-btn.delete-danger:hover {
  background-color: color-mix(in srgb, var(--error-hover) 50%, transparent) !important;
  color: var(--error-hover) !important;
}

.message-actions-floating {
  position: fixed !important;
  top: auto !important;
  right: auto !important;
  z-index: 1000;
}
</style>
