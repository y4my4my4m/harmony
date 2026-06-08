<template>
  <div 
    v-if="isVisible" 
    class="context-menu"
    :style="menuStyle"
    @click.stop
  >
    <div class="context-menu-item" @click="createChannel" v-if="canManageCategory">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20,14H14V20H10V14H4V10H10V4H14V10H20V14Z"/>
      </svg>
      <span>Create Channel</span>
    </div>
    
    <div class="context-menu-divider" v-if="canManageCategory"></div>
    
    <div class="context-menu-item" @click="editCategory" v-if="canManageCategory">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M20.71,7.04C21.1,6.65 21.1,6 20.71,5.63L18.37,3.29C18,2.9 17.35,2.9 16.96,3.29L15.12,5.12L18.87,8.87M3,17.25V21H6.75L17.81,9.93L14.06,6.18L3,17.25Z"/>
      </svg>
      <span>Edit Category</span>
    </div>
    
    <div class="context-menu-item danger" @click="deleteCategory" v-if="canManageCategory">
      <svg width="16" height="16" viewBox="0 0 24 24">
        <path fill="currentColor" d="M19,4H15.5L14.5,3H9.5L8.5,4H5V6H19M6,19A2,2 0 0,0 8,21H16A2,2 0 0,0 18,19V7H6V19Z"/>
      </svg>
      <span>Delete Category</span>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import type { Category } from '@/types'

interface Props {
  isVisible: boolean
  position: { x: number; y: number }
  category: Category | null
}

interface Emits {
  (e: 'close'): void
  (e: 'create-channel', category: Category): void
  (e: 'edit-category', category: Category): void
  (e: 'delete-category', category: Category): void
}

const props = defineProps<Props>()
const emit = defineEmits<Emits>()

const { canManageChannels } = useServerPermissions()

const canManageCategory = computed(() => {
  return canManageChannels.value && props.category
})

const menuStyle = computed(() => {
  const menuWidth = 200
  const menuHeight = canManageCategory.value ? 150 : 40
  const padding = 10

  let x = props.position.x
  let y = props.position.y

  if (typeof window !== 'undefined') {
    if (x + menuWidth > window.innerWidth - padding) {
      x = window.innerWidth - menuWidth - padding
    }
    if (y + menuHeight > window.innerHeight - padding) {
      y = window.innerHeight - menuHeight - padding
    }
  }

  return { top: y + 'px', left: x + 'px' }
})

const createChannel = () => {
  if (props.category) {
    emit('create-channel', props.category)
  }
  emit('close')
}

const editCategory = () => {
  if (props.category) {
    emit('edit-category', props.category)
  }
  emit('close')
}

const deleteCategory = () => {
  if (props.category) {
    emit('delete-category', props.category)
  }
  emit('close')
}
</script>

<style scoped>
.context-menu {
  position: fixed;
  background: var(--background-primary-alpha);
  border: 1px solid var(--border-color);
  backdrop-filter: blur(8px);
  border-radius: 6px;
  padding: 6px 0;
  min-width: 160px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
}

.context-menu-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  color: var(--text-secondary);
  cursor: pointer;
  font-size: 14px;
  transition: background-color 0.1s ease;
}

.context-menu-item:hover {
  background-color: var(--harmony-primary);
  color: var(--text-primary);
}

.context-menu-item.danger {
  color: #ed4245;
}

.context-menu-item.danger:hover {
  background-color: #ed4245;
  color: var(--text-primary);
}

.context-menu-divider {
  height: 1px;
  background: var(--border-color, var(--background-quinary));
  margin: 4px 8px;
}
</style>
