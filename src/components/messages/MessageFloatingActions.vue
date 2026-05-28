<template>
  <Teleport to="body">
    <div
      class="message-actions message-actions-floating"
      :style="style"
    >
      <template v-if="message.is_system">
        <div class="action-btn" data-testid="msg-action-react" @click="emit('react', message, $event)"><ReactionIcon/></div>
        <div class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDelete" @click="emit('delete', message.id, $event)"><DeleteIcon/></div>
        <div class="action-btn" data-testid="msg-action-more" @click="emit('context-menu', message, $event)"><MoreIcon/></div>
      </template>
      <template v-else>
        <div class="action-btn" data-testid="msg-action-react" @click="emit('react', message, $event)"><ReactionIcon/></div>
        <div class="action-btn" data-testid="msg-action-reply" @click="emit('reply', message)"><ReplyIcon/></div>
        <div class="action-btn thread-btn" data-testid="msg-action-thread" v-if="!hideThreadActions" @click="emit('thread', message)" title="Create Thread"><ThreadIcon/></div>
        <div class="action-btn" data-testid="msg-action-edit" v-if="canEdit" @click="emit('edit', message)"><EditIcon/></div>
        <div class="action-btn" data-testid="msg-action-delete" :class="{ 'delete-danger': isShiftHeld }" v-if="canDelete" @click="emit('delete', message.id, $event)"><DeleteIcon/></div>
        <div class="action-btn" data-testid="msg-action-more" @click="emit('context-menu', message, $event)"><MoreIcon/></div>
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
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  backdrop-filter: blur(8px);
  z-index: 1;
}

.thread-btn {
  color: var(--harmony-primary);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
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

.action-btn.delete-danger {
  color: var(--error) !important;
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
