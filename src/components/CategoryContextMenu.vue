<template>
  <ChatMenu
    v-if="isVisible && category && canManageCategory"
    :x="position.x"
    :y="position.y"
    :label="category.name"
    :trigger="trigger"
    class="context-menu"
    @close="emit('close')"
  >
    <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="createChannel">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M20,14H14V20H10V14H4V10H10V4H14V10H20V14Z"/>
      </svg>
      <span>{{ t('channel.create') }}</span>
    </button>

    <div class="chat-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="chat-menu-item context-menu-item" data-action="move-up" :disabled="!canMoveUp" @click="move(-1)">
      <span>{{ t('serverRail.menu.moveUp') }}</span>
      <span class="chat-menu-trail" aria-hidden="true">Alt+↑</span>
    </button>
    <button type="button" role="menuitem" class="chat-menu-item context-menu-item" data-action="move-down" :disabled="!canMoveDown" @click="move(1)">
      <span>{{ t('serverRail.menu.moveDown') }}</span>
      <span class="chat-menu-trail" aria-hidden="true">Alt+↓</span>
    </button>

    <div class="chat-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="chat-menu-item context-menu-item" @click="editCategory">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>{{ t('chatNav.menu.editCategory') }}</span>
    </button>

    <button type="button" role="menuitem" class="chat-menu-item context-menu-item danger" @click="deleteCategory">
      <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>{{ t('chatNav.menu.deleteCategory') }}</span>
    </button>
  </ChatMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import ChatMenu from '@/components/chat/ChatMenu.vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import type { Category } from '@/types'

interface Props {
  isVisible: boolean
  position: { x: number; y: number }
  category: Category | null
  /** Element focus returns to on close: the category header. */
  trigger?: HTMLElement | null
  canMoveUp?: boolean
  canMoveDown?: boolean
}

interface Emits {
  (e: 'close'): void
  (e: 'create-channel', category: Category): void
  (e: 'edit-category', category: Category): void
  (e: 'delete-category', category: Category): void
  (e: 'move', category: Category, delta: -1 | 1): void
}

const props = withDefaults(defineProps<Props>(), {
  trigger: null,
  canMoveUp: false,
  canMoveDown: false,
})
const emit = defineEmits<Emits>()

const { t } = useI18n()
const { canManageChannels } = useServerPermissions()

const canManageCategory = computed(() => canManageChannels.value && !!props.category)

const createChannel = () => {
  if (props.category) emit('create-channel', props.category)
  emit('close')
}

const move = (delta: -1 | 1) => {
  const category = props.category
  emit('close')
  if (category) emit('move', category, delta)
}

const editCategory = () => {
  if (props.category) emit('edit-category', props.category)
  emit('close')
}

const deleteCategory = () => {
  if (props.category) emit('delete-category', props.category)
  emit('close')
}
</script>
