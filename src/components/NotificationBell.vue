<template>
  <div class="notification-bell-container">
    <!-- Notification Bell Button -->
    <button
      class="notification-bell"
      data-testid="notification-bell"
      :class="{ 
        'has-unread': hasUnread,
        'is-open': isOpen,
        'dnd-active': isDndActive
      }"
      @click="togglePanel"
      :aria-label="`Notifications${unreadCount > 0 ? ` (${unreadCount} unread)` : ''}`"
      :aria-expanded="isOpen"
    >
      <div class="bell-icon-wrapper">
        <span class="icon-wrap icon icon-bell icon-md">
          <svg class="bell-icon icon-md" width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
          </svg>
        </span>
      </div>

      <Transition name="badge-bounce" appear>
        <div v-if="unreadCount > 0" class="notification-badge">
          <span class="badge-text">{{ unreadCount > 99 ? '99+' : unreadCount }}</span>
        </div>
      </Transition>
      
      <!-- Do Not Disturb Indicator -->
      <Transition name="dnd-fade" appear>
        <div v-if="isDndActive" class="dnd-indicator">
          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8 0-1.85.63-3.55 1.69-4.9L16.9 18.31C15.55 19.37 13.85 20 12 20zm6.31-3.1L7.1 5.69C8.45 4.63 10.15 4 12 4c4.42 0 8 3.58 8 8 0 1.85-.63 3.55-1.69 4.9z"/>
          </svg>
        </div>
      </Transition>
    </button>

    <Teleport to="body">
      <Transition name="panel-slide" appear>
        <div v-if="isOpen" class="notification-panel" data-testid="notification-panel" @click.stop>
        <div class="panel-header">
          <div class="header-content">
            <div class="header-title-section">
              <h3 class="panel-title">Notifications</h3>
              <div v-if="unreadCount > 0" class="unread-indicator">
                {{ unreadCount }} new
              </div>
            </div>
            
            <div class="header-actions">
              <!-- Mark All Read Button -->
              <Transition name="button-fade">
                <button 
                  v-if="unreadCount > 0" 
                  @click="markAllAsRead"
                  class="action-button mark-all-read"
                  data-testid="notification-mark-read"
                  :disabled="isMarkingAllAsRead"
                  :aria-label="'Mark all notifications as read'"
                >
                  <Icon v-if="!isMarkingAllAsRead" name="check" :size="16" />
                  <div v-else class="loading-spinner"></div>
                  <span>Mark all read</span>
                </button>
              </Transition>

              <!-- Clear All Button (mass delete) -->
              <Transition name="button-fade">
                <button
                  v-if="notifications.length > 0"
                  @click="clearAllNotifications"
                  class="action-button clear-all"
                  data-testid="notification-clear-all"
                  :disabled="isClearingAll"
                  :aria-label="'Clear all notifications'"
                  title="Clear all notifications"
                >
                  <Icon v-if="!isClearingAll" name="trash" :size="16" />
                  <div v-else class="loading-spinner"></div>
                  <span>Clear all</span>
                </button>
              </Transition>

              <!-- Settings Button -->
              <button @click="openSettings" class="action-button settings-btn" aria-label="Notification settings">
                <Icon name="settings" :size="16" />
              </button>
              
              <!-- Close Button -->
              <button @click="closePanel" class="action-button close-btn" aria-label="Close notifications">
                <Icon name="x" :size="16" />
              </button>
            </div>
          </div>
        </div>
        
        <!-- Panel Content -->
        <div class="panel-content">
          
          <!-- Notifications List -->
          <div class="notifications-list">
            <!-- Quick Filter Tabs -->
            <div class="notification-filters">
              <button 
                v-for="filter in notificationFilters"
                :key="filter.key"
                @click="activeFilter = filter.key"
                class="filter-tab"
                :class="{ active: activeFilter === filter.key }"
              >
                <Icon
                  :name="filter.icon"
                  class="filter-icon"
                  :class="{ 'filter-icon-unread': filter.key === 'unread' }"
                  :size="14"
                />
                <span class="filter-label">{{ filter.label }}</span>
                <span v-if="filter.count > 0" class="filter-count">{{ filter.count }}</span>
              </button>
            </div>
            
          <!-- Loading State -->
          <div v-if="isLoading" class="notification-state loading-state">
            <div class="state-animation">
              <LoadingSpinner :size="32" />
            </div>
            <h4 class="state-title">Loading notifications...</h4>
            <p class="state-description">Fetching your latest updates</p>
          </div>
          
          <!-- Empty State -->
          <div v-else-if="notifications.length === 0" class="notification-state empty-state">
            <div class="state-animation">
              <div class="empty-bell">
                <svg width="64" height="64" viewBox="0 0 24 24" fill="currentColor" opacity="0.3">
                  <path d="M12 22c1.1 0 2-.9 2-2h-4c0 1.1.9 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z"/>
                </svg>
              </div>
            </div>
            <h4 class="state-title">You're all caught up</h4>
            <p class="state-description">No new notifications. When you get mentions, messages, or other updates, they'll show up here.</p>
          </div>
            <!-- Notification Items -->
            <TransitionGroup name="notification-list" tag="div" class="notifications-container" data-testid="notification-list">
              <NotificationItem
                v-for="notification in notifications"
                :key="notification.id"
                :notification="notification"
                @click="handleNotificationClick"
                @mark-read="handleMarkReadToggle"
                @dismiss="dismissNotification"
                class="notification-item-wrapper"
              />
            </TransitionGroup>
            
            <!-- Load More Button -->
            <div v-if="hasMoreNotifications" class="load-more-section">
              <button @click="loadMoreNotifications" class="load-more-btn" :disabled="isLoadingMore">
                <span v-if="!isLoadingMore">Load more notifications</span>
                <span v-else class="loading-text">
                  <div class="loading-dots">
                    <span></span><span></span><span></span>
                  </div>
                  Loading...
                </span>
              </button>
            </div>
          </div>
        </div>
      </div>
      </Transition>
    </Teleport>
    
    <Teleport to="body">
      <Transition name="backdrop-fade">
        <div v-if="isOpen" class="notification-backdrop" @click="closePanel"></div>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useNotificationStore } from '@/stores/useNotification'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import { useLayoutState } from '@/composables/useLayoutState'
import NotificationItem from './NotificationItem.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { Notification } from '@/types'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const router = useRouter()
const { closeMobileSidebars } = useLayoutState()

// Reactive state
const isOpen = ref(false)
const isMarkingAllAsRead = ref(false)
const isClearingAll = ref(false)
const isLoadingMore = ref(false)
const hasMoreNotifications = ref(false)

// Computed properties
const notifications = computed(() => notificationStore.filteredNotifications)
const unreadCount = computed(() => notificationStore.unreadCount)
const hasUnread = computed(() => unreadCount.value > 0)
const isDndActive = computed(() => notificationStore.isDndActive)
const isLoading = computed(() => notificationStore.isLoading)
const notificationFilters = computed(() => notificationStore.notificationFilters)
const activeFilter = computed({
  get: () => notificationStore.currentFilter,
  set: (value) => notificationStore.setFilter(value)
})

// Suppress the document click listener for the same pointer event that
// opened the panel. With SDR-001 the decorative mask can make the click
// target the `.icon-button` wrapper instead of `.notification-bell-container`,
// which would otherwise open then instantly close.
let suppressOutsideClose = false

// Methods
const togglePanel = async () => {
  const opening = !isOpen.value
  isOpen.value = !isOpen.value
  if (opening) {
    suppressOutsideClose = true
    queueMicrotask(() => {
      suppressOutsideClose = false
    })
  }
  if (isOpen.value) {
    closeMobileSidebars()
    document.body.style.overflow = 'hidden'
    
    if (authStore.session?.user?.id && notifications.value.length === 0) {
      debug.log('Loading full notification list on panel open...')
      await notificationStore.loadFullNotificationList(authStore.session.user.id)
    }
  } else {
    document.body.style.overflow = ''
  }
}

const closePanel = () => {
  isOpen.value = false
  document.body.style.overflow = ''
}

const clearAllNotifications = async () => {
  if (isClearingAll.value || notifications.value.length === 0) return

  // Soft confirmation - destructive irreversible action. Using native
  // confirm avoids dragging another modal into the panel for one rare op.
  const confirmed = window.confirm('Clear all notifications? This cannot be undone.')
  if (!confirmed) return

  try {
    isClearingAll.value = true
    await notificationStore.clearAllNotifications()
  } catch (error) {
    debug.error('Failed to clear all notifications:', error)
  } finally {
    isClearingAll.value = false
  }
}

const markAllAsRead = async () => {
  if (!authStore.session?.user?.id || isMarkingAllAsRead.value) return
  
  try {
    isMarkingAllAsRead.value = true
    await notificationStore.markAllAsRead()
  } catch (error) {
    debug.error('Failed to mark all notifications as read:', error)
    notificationStore.showToast(
      'server_update',
      "Couldn't mark notifications as read",
      'Try again.',
      3000
    )
  } finally {
    isMarkingAllAsRead.value = false
  }
}

const handleMarkReadToggle = async (notificationId: string) => {
  const notification = notificationStore.notifications.find(n => n.id === notificationId)
  if (notification?.is_read) {
    await notificationStore.markAsUnread(notificationId)
  } else {
    await notificationStore.markAsRead(notificationId)
  }
}

const dismissNotification = async (notificationId: string) => {
  try {
    await notificationStore.deleteNotification(notificationId)
  } catch (error) {
    debug.error('Failed to dismiss notification:', error)
  }
}

const handleNotificationClick = (notification: Notification) => {
  notificationStore.handleNotificationClick(notification)
  closePanel()
  closeMobileSidebars()
}

const openSettings = () => {
  closePanel()
  router.push({ name: 'UserSettings', params: { section: 'notifications' } })
}

const loadMoreNotifications = async () => {
  if (isLoadingMore.value || !authStore.session?.user?.id) return
  
  try {
    isLoadingMore.value = true
    const newNotifications = await notificationStore.fetchNotifications(
      authStore.session.user.id,
      25,
      notificationStore.loadedCount
    )
    hasMoreNotifications.value = newNotifications.length === 25
  } catch (error) {
    debug.error('Failed to load more notifications:', error)
  } finally {
    isLoadingMore.value = false
  }
}

// Click outside handler
const handleClickOutside = (event: Event) => {
  if (!isOpen.value || suppressOutsideClose) return

  const target = event.target as HTMLElement
  if (
    target.closest('.notification-bell-container') ||
    target.closest('[data-testid="notification-bell"]') ||
    target.closest('.notification-bell-slot')
  ) {
    return
  }

  closePanel()
}

// Keyboard navigation
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && isOpen.value) {
    closePanel()
  }
}

// Display only. BaseLayout owns notification initialization.
onMounted(() => {
  debug.log('NotificationBell: Mounted as reactive display component')
  
  document.addEventListener('click', handleClickOutside)
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('click', handleClickOutside)
  document.removeEventListener('keydown', handleKeydown)
  document.body.style.overflow = ''
})
</script>

<style scoped>
.notification-bell-container {
  position: relative;
  z-index: 1000;
}

.notification-bell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: transparent;
  border: none;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  color: var(--text-secondary);
  outline: none;
}

.notification-bell:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.notification-bell:focus {
  box-shadow: 0 0 0 2px var(--harmony-primary-alpha-strong);
}

.notification-bell.has-unread {
  color: var(--text-primary);
}

.notification-bell.is-open {
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--h-brand);
}

.notification-bell.dnd-active {
  filter: saturate(0.7);
}

.bell-icon-wrapper {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
}

.notification-badge {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  background: var(--error);
  border-radius: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: 0 0 0 2px var(--background-tertiary);
}

.badge-text {
  color: var(--text-on-primary);
  font-size: 10px;
  font-weight: 700;
  line-height: 1;
}

.dnd-indicator {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 18px;
  height: 18px;
  background: var(--status-busy);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-on-primary);
  box-shadow: 0 0 0 3px var(--background-tertiary);
  font-size: 8px;
}

.notification-panel {
  position: fixed;
  bottom: 100px;
  left: 200px;
  width: 420px;
  max-height: calc(100vh - 120px);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  overflow: hidden;
  z-index: 1001;
}

.panel-header {
  background: var(--background-secondary);
  padding: 20px;
  border-bottom: 1px solid var(--border-primary);
  position: relative;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.header-title-section {
  flex: 1;
}

.panel-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
}

.unread-indicator {
  margin-top: 4px;
  font-size: 12px;
  color: var(--h-brand);
  font-weight: 600;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.action-button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-md);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.mark-all-read {
  background: color-mix(in srgb, var(--success) 15%, transparent);
  color: var(--success);
  border: 1px solid color-mix(in srgb, var(--success) 30%, transparent);
}

.mark-all-read:hover:not(:disabled) {
  background: color-mix(in srgb, var(--success) 25%, transparent);
}

.mark-all-read:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.clear-all {
  background: color-mix(in srgb, var(--error) 12%, transparent);
  color: var(--error);
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
}

.clear-all:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 22%, transparent);
}

.clear-all:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.settings-btn, .close-btn {
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  border: 1px solid var(--border-primary);
  padding: 8px;
  min-width: 32px;
  justify-content: center;
}

.settings-btn:hover, .close-btn:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

/* Panel content */
.panel-content {
  max-height: calc(80vh - 100px);
  overflow-y: auto;
  overflow-x: hidden;
}

/* Custom scrollbar */
.panel-content::-webkit-scrollbar {
  width: 6px;
}

.panel-content::-webkit-scrollbar-track {
  background: rgba(0, 0, 0, 0.1);
}

.panel-content::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

/* Notification states */
.notification-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-secondary);
}

.state-animation {
  margin-bottom: 20px;
  position: relative;
}

/* Empty state */
.empty-bell {
  position: relative;
  display: inline-block;
}

.state-title {
  margin: 0 0 8px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}

.state-description {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  opacity: 0.8;
}

/* Notification filters */
.notification-filters {
  display: flex;
  gap: 6px;
  padding: 8px 20px;
  border-bottom: 1px solid var(--border-primary);
  overflow-x: auto;
}

.filter-tab {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border: none;
  border-radius: var(--radius-full);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
  white-space: nowrap;
  flex-shrink: 0;
}

.filter-tab:hover {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.filter-tab.active {
  background: color-mix(in srgb, var(--harmony-primary) 20%, transparent);
  color: var(--h-brand);
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 30%, transparent);
}

.filter-icon {
  flex-shrink: 0;
  color: inherit;
}

.filter-icon-unread {
  color: var(--error);
}

.filter-count {
  background: var(--background-modifier-active);
  padding: 2px 6px;
  border-radius: 10px;
  font-size: 10px;
  font-weight: 700;
  color: var(--text-primary);
}

/* Count keeps the neutral text colour on the brand-tinted active tab. */
.filter-tab.active .filter-count {
  color: var(--text-primary);
}

/* Notifications container */
.notifications-container {
  padding: 8px 0;
}

.notification-item-wrapper {
  border-bottom: 1px solid var(--border-secondary);
}

.notification-item-wrapper:last-child {
  border-bottom: none;
}

/* Load more section */
.load-more-section {
  padding: 16px 20px;
  border-top: 1px solid var(--border-primary);
  text-align: center;
}

.load-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px;
  border: none;
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.load-more-btn:hover:not(:disabled) {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.loading-text {
  display: flex;
  align-items: center;
  gap: 8px;
}

.loading-dots {
  display: flex;
  gap: 4px;
}

.loading-dots span {
  width: 4px;
  height: 4px;
  background: currentColor;
  border-radius: 50%;
  animation: loading-dot 1.4s ease-in-out infinite both;
}

.loading-dots span:nth-child(1) { animation-delay: -0.32s; }
.loading-dots span:nth-child(2) { animation-delay: -0.16s; }

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid transparent;
  border-top: 2px solid currentColor;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* Backdrop */
.notification-backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(4px);
  z-index: 999;
}

@media (max-width: 768px) {
  .notification-backdrop {
    z-index: 10000;
  }
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@keyframes loading-dot {
  0%, 80%, 100% { transform: scale(0.8); opacity: 0.5; }
  40% { transform: scale(1); opacity: 1; }
}

/* Transitions */
.badge-bounce-enter-active,
.badge-bounce-leave-active {
  transition: opacity var(--transition-fast), transform var(--transition-fast);
}

.badge-bounce-enter-from,
.badge-bounce-leave-to {
  opacity: 0;
  transform: scale(0.6);
}

.dnd-fade-enter-active, .dnd-fade-leave-active {
  transition: all 0.3s ease;
}

.dnd-fade-enter-from, .dnd-fade-leave-to {
  opacity: 0;
  transform: scale(0.8);
}

.panel-slide-enter-active {
  animation: panel-slide-in 0.4s cubic-bezier(0.16, 1, 0.3, 1);
}

.panel-slide-leave-active {
  animation: panel-slide-in 0.3s reverse;
}

@keyframes panel-slide-in {
  0% {
    opacity: 0;
    transform: translateY(-20px) scale(0.95);
  }
  100% {
    opacity: 1;
    transform: translateY(0) scale(1);
  }
}

.backdrop-fade-enter-active, .backdrop-fade-leave-active {
  transition: all 0.3s ease;
}

.backdrop-fade-enter-from, .backdrop-fade-leave-to {
  opacity: 0;
}

.button-fade-enter-active, .button-fade-leave-active {
  transition: all 0.2s ease;
}

.button-fade-enter-from, .button-fade-leave-to {
  opacity: 0;
  transform: scale(0.9);
}

.notification-list-enter-active {
  transition: all 0.4s ease;
}

.notification-list-leave-active {
  transition: all 0.3s ease;
}

.notification-list-enter-from {
  opacity: 0;
  transform: translateX(30px);
}

.notification-list-leave-to {
  opacity: 0;
  transform: translateX(-30px);
}

.notification-list-move {
  transition: transform 0.3s ease;
}

/* Responsive design */
@media (max-width: 768px) {
  .notification-panel {
    width: calc(100vw - 24px);
    right: 12px;
    left: 12px;
    max-height: calc(100vh - 80px);
    z-index: 10001;
  }
  
  .header-content {
    flex-direction: column;
    align-items: flex-start;
    gap: 12px;
  }
  
  .header-actions {
    width: 100%;
    justify-content: flex-end;
  }
  
  .notification-filters {
    padding: 12px 16px 8px;
  }
  
  .filter-tab {
    font-size: 11px;
    padding: 6px 10px;
  }
}

@media (max-width: 480px) {
  .panel-header {
    padding: 16px;
  }
  
  .panel-title {
    font-size: 16px;
  }
  
  .action-button {
    font-size: 11px;
    padding: 6px 8px;
  }
}

/* High contrast mode support */
@media (prefers-contrast: high) {
  .notification-bell {
    border: 2px solid currentColor;
  }
  
  .notification-panel {
    border: 2px solid currentColor;
  }
  
  .notification-badge {
    background: #ff0000;
    box-shadow: 0 0 0 2px var(--background-tertiary);
  }
}

/* Reduced motion support */
@media (prefers-reduced-motion: reduce) {
  * {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
  }
}
</style>