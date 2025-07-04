<template>
  <div class="notification-bell" @click="togglePanel" :class="{ 'has-unread': hasUnread }">
    <div class="bell-icon">
      <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
        <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
      </svg>
      
      <!-- Unread badge -->
      <div v-if="unreadCount > 0" class="notification-badge">
        {{ unreadCount > 99 ? '99+' : unreadCount }}
      </div>
      
      <!-- Do not disturb indicator -->
      <div v-if="isDndActive" class="dnd-indicator">
        <svg width="8" height="8" viewBox="0 0 24 24" fill="currentColor">
          <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 15h2v2h-2v-2zm0-8h2v6h-2V9z"/>
        </svg>
      </div>
    </div>
    
    <!-- Notification panel -->
    <Transition name="notification-panel">
      <div v-if="isOpen" class="notification-panel" @click.stop>
        <div class="panel-header">
          <h3>Notifications</h3>
          <div class="header-actions">
            <button 
              v-if="unreadCount > 0" 
              @click="markAllAsRead" 
              class="mark-all-read-btn"
              :disabled="isMarkingAllAsRead"
            >
              Mark all as read
            </button>
            <button @click="openSettings" class="settings-btn">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.82,11.69,4.82,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.43-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
              </svg>
            </button>
          </div>
        </div>
        
        <div class="panel-content">
          <!-- Loading state -->
          <div v-if="isLoading" class="notification-loading">
            <div class="loading-spinner"></div>
            <p>Loading notifications...</p>
          </div>
          
          <!-- Empty state -->
          <div v-else-if="notifications.length === 0" class="notification-empty">
            <div class="empty-icon">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
                <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
              </svg>
            </div>
            <h4>No notifications yet</h4>
            <p>When you get mentions, messages, or other updates, they'll show up here.</p>
          </div>
          
          <!-- Notifications list -->
          <div v-else class="notifications-list">
            <NotificationItem
              v-for="notification in sortedNotifications"
              :key="notification.id"
              :notification="notification"
              @click="handleNotificationClick"
              @mark-read="markAsRead"
            />
          </div>
        </div>
      </div>
    </Transition>
    
    <!-- Backdrop -->
    <div v-if="isOpen" class="notification-backdrop" @click="closePanel"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { useNotificationStore } from '@/stores/useNotification'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import NotificationItem from './NotificationItem.vue'
import type { Notification } from '@/types'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const router = useRouter()

const isOpen = ref(false)
const isMarkingAllAsRead = ref(false)

// Computed properties
const notifications = computed(() => notificationStore.notifications)
const unreadCount = computed(() => notificationStore.unreadCount)
const hasUnread = computed(() => unreadCount.value > 0)
const isDndActive = computed(() => notificationStore.isDndActive)
const isLoading = computed(() => notificationStore.isLoading)

const sortedNotifications = computed(() => {
  return [...notifications.value].sort((a, b) => {
    // Show unread first, then sort by creation date
    if (a.is_read !== b.is_read) {
      return a.is_read ? 1 : -1
    }
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
})

// Methods
const togglePanel = () => {
  isOpen.value = !isOpen.value
}

const closePanel = () => {
  isOpen.value = false
}

const markAllAsRead = async () => {
  if (!authStore.session?.user?.id || isMarkingAllAsRead.value) return
  
  try {
    isMarkingAllAsRead.value = true
    await notificationStore.markAllAsRead(authStore.session.user.id)
  } catch (error) {
    console.error('Failed to mark all notifications as read:', error)
  } finally {
    isMarkingAllAsRead.value = false
  }
}

const markAsRead = async (notificationId: string) => {
  await notificationStore.markAsRead(notificationId)
}

const handleNotificationClick = (notification: Notification) => {
  markAsRead(notification.id)
  notificationStore.handleNotificationClick(notification)
  closePanel()
}

const openSettings = () => {
  closePanel()
  router.push({ name: 'UserSettings', params: { section: 'notifications' } })
}

// Click outside handler
const handleClickOutside = (event: Event) => {
  const target = event.target as HTMLElement
  if (!target.closest('.notification-bell')) {
    closePanel()
  }
}

// Initialize notifications when user is logged in
onMounted(() => {
  if (authStore.session?.user?.id) {
    notificationStore.initialize(authStore.session.user.id)
  }
  
  document.addEventListener('click', handleClickOutside)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
})
</script>

<style scoped>
.notification-bell {
  position: relative;
  cursor: pointer;
  user-select: none;
}

.bell-icon {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  color: #b9bbbe;
  transition: all 0.2s ease;
}

.bell-icon:hover {
  color: #dcddde;
  background-color: rgba(79, 84, 92, 0.16);
}

.notification-bell.has-unread .bell-icon {
  color: #ffffff;
}

.notification-badge {
  position: absolute;
  top: -2px;
  right: -2px;
  background: #f04747;
  color: #ffffff;
  font-size: 10px;
  font-weight: 600;
  padding: 2px 6px;
  border-radius: 10px;
  min-width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 2px var(--h-chat-dark);
}

.dnd-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  background: #faa61a;
  color: #ffffff;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 2px var(--h-chat-dark);
}

.notification-panel {
  position: absolute;
  top: calc(100% + 8px);
  right: 0;
  width: 400px;
  max-height: 600px;
  background: var(--h-chat);
  border: 1px solid var(--h-chat-light);
  border-radius: 8px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.24);
  z-index: 1000;
  overflow: hidden;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--h-chat-light);
  background: var(--h-chat-darker);
}

.panel-header h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: #ffffff;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.mark-all-read-btn {
  background: transparent;
  border: 1px solid var(--h-brand);
  color: var(--h-brand);
  padding: 6px 12px;
  border-radius: 4px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.mark-all-read-btn:hover:not(:disabled) {
  background: var(--h-brand);
  color: #ffffff;
}

.mark-all-read-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-btn {
  background: transparent;
  border: none;
  color: #b9bbbe;
  padding: 8px;
  border-radius: 4px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  align-items: center;
  justify-content: center;
}

.settings-btn:hover {
  color: #dcddde;
  background: rgba(79, 84, 92, 0.16);
}

.panel-content {
  max-height: 500px;
  overflow-y: auto;
}

.notification-loading {
  padding: 40px 20px;
  text-align: center;
  color: #b9bbbe;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid var(--h-chat-light);
  border-top: 3px solid var(--h-brand);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 16px;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

.notification-empty {
  padding: 40px 20px;
  text-align: center;
  color: #b9bbbe;
}

.empty-icon {
  margin-bottom: 16px;
}

.notification-empty h4 {
  margin: 0 0 8px 0;
  font-size: 16px;
  color: #ffffff;
}

.notification-empty p {
  margin: 0;
  font-size: 14px;
  line-height: 1.4;
}

.notifications-list {
  padding: 8px 0;
}

.notification-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: transparent;
}

/* Transitions */
.notification-panel-enter-active,
.notification-panel-leave-active {
  transition: all 0.2s ease;
}

.notification-panel-enter-from,
.notification-panel-leave-to {
  opacity: 0;
  transform: translateY(-8px) scale(0.95);
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-panel {
    width: 320px;
    max-height: 80vh;
  }
}

@media (max-width: 480px) {
  .notification-panel {
    width: calc(100vw - 32px);
    right: -16px;
  }
}
</style>