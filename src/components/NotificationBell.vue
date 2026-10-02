<template>
  <div class="notification-bell-container">
    <button
      ref="bellRef"
      type="button"
      class="notification-bell"
      data-testid="notification-bell"
      :class="{ 'has-unread': unreadCount > 0, 'is-open': isOpen, 'dnd-active': isSilenced }"
      :aria-label="unreadCount > 0 ? t('inbox.bellLabelUnread', { count: unreadCount }) : t('inbox.bellLabel')"
      :aria-expanded="isOpen"
      aria-haspopup="dialog"
      :title="t('inbox.bellLabel')"
      @click="toggle"
    >
      <Icon name="bell" :size="20" class="bell-icon" />
      <span v-if="unreadCount > 0" class="notification-badge" aria-hidden="true">
        <span class="badge-text">{{ badge }}</span>
      </span>
      <span v-else-if="isSilenced" class="dnd-indicator" aria-hidden="true" />
    </button>

    <Teleport to="body">
      <div v-if="isOpen" class="notification-backdrop" @click="close()" />
      <Transition name="inbox">
        <section
          v-if="isOpen"
          ref="panelRef"
          class="notification-panel"
          data-testid="notification-panel"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="titleId"
          :style="panelStyle"
          @keydown="onPanelKeydown"
        >
          <header class="inbox-header">
            <div class="inbox-title-row">
              <h2 :id="titleId" class="inbox-title">{{ t('inbox.title') }}</h2>
              <span v-if="unreadCount > 0" class="new-pill">{{ t('inbox.newCount', { count: badge }) }}</span>
            </div>
            <div class="inbox-actions">
              <button
                type="button"
                class="icon-btn"
                data-testid="notification-mark-read"
                :disabled="unreadCount === 0 || busy === 'read'"
                :aria-label="t('inbox.markAllRead')"
                :title="t('inbox.markAllRead')"
                @click="markAllRead"
              >
                <Icon name="check-circle" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn"
                data-testid="notification-clear-all"
                :disabled="allNotifications.length === 0 || busy === 'clear'"
                :aria-label="t('inbox.clearAll')"
                :title="t('inbox.clearAll')"
                @click="clearAll"
              >
                <Icon name="trash-2" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn"
                :aria-label="t('inbox.settings')"
                :title="t('inbox.settings')"
                @click="openSettings"
              >
                <Icon name="settings" :size="16" />
              </button>
              <button
                type="button"
                class="icon-btn close-btn"
                :aria-label="t('inbox.close')"
                :title="t('inbox.close')"
                @click="close()"
              >
                <Icon name="x" :size="18" />
              </button>
            </div>
          </header>

          <div class="inbox-toolbar">
            <div class="inbox-tabs" role="tablist" :aria-label="t('inbox.tabsLabel')" @keydown="onTabKeydown">
              <button
                v-for="tab in INBOX_TABS"
                :key="tab"
                :ref="el => setTabRef(tab, el)"
                type="button"
                role="tab"
                class="inbox-tab"
                :class="{ active: activeTab === tab }"
                :aria-selected="activeTab === tab"
                :aria-controls="listId"
                :aria-label="tabCounts[tab] > 0 ? t('inbox.tabLabelUnread', { tab: t(`inbox.tabs.${tab}`), count: tabCounts[tab] }) : t(`inbox.tabs.${tab}`)"
                :tabindex="activeTab === tab ? 0 : -1"
                @click="activeTab = tab"
              >
                <span>{{ t(`inbox.tabs.${tab}`) }}</span>
                <span v-if="tabCounts[tab] > 0" class="tab-count">{{ badgeTextOf(tabCounts[tab]) }}</span>
              </button>
            </div>
            <button
              type="button"
              class="unread-toggle"
              :class="{ active: unreadOnly }"
              :aria-pressed="unreadOnly"
              @click="unreadOnly = !unreadOnly"
            >
              {{ t('inbox.unreadOnly') }}
            </button>
          </div>

          <p v-if="panelSilenced" class="silenced-note">
            <Icon name="bell-off" :size="14" />
            <span>{{ t('inbox.silenced') }}</span>
          </p>

          <div
            :id="listId"
            ref="scrollRef"
            class="inbox-scroll"
            role="tabpanel"
            data-testid="notification-list"
            :aria-busy="showSkeleton"
            @keydown="onListKeydown"
          >
            <ul v-if="showSkeleton" class="skeleton-list" :aria-label="t('inbox.loading')">
              <li v-for="i in 5" :key="i" class="skeleton-row">
                <span class="sk sk-avatar" />
                <span class="sk-lines">
                  <span class="sk sk-line" />
                  <span class="sk sk-line short" />
                </span>
              </li>
            </ul>

            <EmptyState
              v-else-if="showError"
              size="sm"
              tone="error"
              icon="alert-circle"
              :title="t('inbox.error')"
              :action-label="t('inbox.retry')"
              @action="retry"
            />

            <EmptyState
              v-else-if="groups.length === 0"
              size="sm"
              :icon="emptyIcon"
              :title="emptyTitle"
              :description="emptyHint"
            />

            <template v-else>
              <section v-for="group in groups" :key="group.key" class="day-group" :aria-label="group.label">
                <h3 class="day-label">{{ group.label }}</h3>
                <ul class="day-list" role="list">
                  <NotificationItem
                    v-for="notification in group.items"
                    :key="notification.id"
                    :notification="notification"
                    :now="now"
                    @open="openNotification"
                    @toggle-read="toggleRead"
                    @remove="remove"
                  />
                </ul>
              </section>

              <div v-if="canLoadMore" ref="sentinelRef" class="load-more">
                <button type="button" class="state-btn" :disabled="loadingMore" @click="loadMore">
                  {{ loadingMore ? t('inbox.loading') : t('inbox.loadMore') }}
                </button>
              </div>
            </template>
          </div>
        </section>
      </Transition>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch, onBeforeUnmount, type ComponentPublicInstance } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { debug } from '@/utils/debug'
import { useNotificationStore } from '@/stores/useNotification'
import { useAuthStore } from '@/stores/auth'
import { useLayoutState } from '@/composables/useLayoutState'
import { INBOX_TABS, badgeText, groupByDay, inTab, unreadByTab, type InboxTab } from '@/utils/notificationInbox'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import NotificationItem from './NotificationItem.vue'
import type { Notification } from '@/types'

const notificationStore = useNotificationStore()
const authStore = useAuthStore()
const router = useRouter()
const { t, locale } = useI18n()
const { closeMobileSidebars } = useLayoutState()

const uid = Math.random().toString(36).slice(2, 8)
const titleId = `inbox-title-${uid}`
const listId = `inbox-list-${uid}`

const MOBILE_QUERY = '(max-width: 768px)'
const PANEL_WIDTH = 400
const PANEL_MAX_HEIGHT = 640
const GAP = 8

const bellRef = ref<HTMLButtonElement | null>(null)
const panelRef = ref<HTMLElement | null>(null)
const scrollRef = ref<HTMLElement | null>(null)
const sentinelRef = ref<HTMLElement | null>(null)
const tabRefs = new Map<InboxTab, HTMLButtonElement>()

const isOpen = ref(false)
const activeTab = ref<InboxTab>('all')
const unreadOnly = ref(false)
const busy = ref<'read' | 'clear' | null>(null)
const loadingMore = ref(false)
const now = ref(new Date())
const panelStyle = ref<Record<string, string>>({})

let clock: ReturnType<typeof setInterval> | null = null
let observer: IntersectionObserver | null = null

const allNotifications = computed(() => notificationStore.notifications)
const unreadCount = computed(() => notificationStore.unreadCount)
const badge = computed(() => badgeText(unreadCount.value))
const badgeTextOf = badgeText
const tabCounts = computed(() => unreadByTab(allNotifications.value))

const isSilenced = computed(() => notificationStore.isDndActive)
// Also covers Busy status, which is read on open and on each clock tick.
const panelSilenced = ref(false)

const filtered = computed(() =>
  allNotifications.value.filter(n => inTab(activeTab.value, n.type) && (!unreadOnly.value || !n.is_read))
)

const groups = computed(() =>
  groupByDay(filtered.value, { today: t('time.today'), yesterday: t('time.yesterday') }, now.value, locale.value)
)

const showSkeleton = computed(() => notificationStore.isLoading && filtered.value.length === 0)
const showError = computed(() => !!notificationStore.loadError && filtered.value.length === 0)
const canLoadMore = computed(() => notificationStore.fullListLoaded && notificationStore.hasMore && !unreadOnly.value)

const emptyIcon = computed(() => (activeTab.value === 'mentions' ? 'at-sign' : activeTab.value === 'social' ? 'globe' : 'inbox'))
const emptyTitle = computed(() => (unreadOnly.value ? t('inbox.empty.unread') : t(`inbox.empty.${activeTab.value}`)))
const emptyHint = computed(() => (unreadOnly.value ? t('inbox.empty.unreadHint') : t(`inbox.empty.${activeTab.value}Hint`)))

function setTabRef(tab: InboxTab, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLButtonElement) tabRefs.set(tab, el)
  else tabRefs.delete(tab)
}

function isMobile(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.(MOBILE_QUERY).matches
}

// Anchors the popover to the bell: above it when the bell sits in the lower half
// of the viewport (the profile bar), below it otherwise.
function positionPanel() {
  if (isMobile() || !bellRef.value) {
    panelStyle.value = {}
    return
  }
  const rect = bellRef.value.getBoundingClientRect()
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = Math.min(PANEL_WIDTH, vw - GAP * 2)
  const left = Math.min(Math.max(rect.left, GAP), vw - width - GAP)
  const above = rect.top > vh / 2
  const available = (above ? rect.top : vh - rect.bottom) - GAP * 2
  const style: Record<string, string> = {
    left: `${left}px`,
    width: `${width}px`,
    // Fixed, not max: switching tabs or loading never resizes the panel.
    height: `${Math.max(240, Math.min(PANEL_MAX_HEIGHT, available))}px`,
    transformOrigin: above ? 'bottom left' : 'top left',
  }
  if (above) style.bottom = `${vh - rect.top + GAP}px`
  else style.top = `${rect.bottom + GAP}px`
  panelStyle.value = style
}

async function open() {
  isOpen.value = true
  closeMobileSidebars()
  now.value = new Date()
  panelSilenced.value = notificationStore.isSilenced()
  positionPanel()
  if (isMobile()) document.body.style.overflow = 'hidden'
  window.addEventListener('resize', positionPanel)
  clock = setInterval(() => {
    now.value = new Date()
    panelSilenced.value = notificationStore.isSilenced()
  }, 60_000)

  await nextTick()
  tabRefs.get(activeTab.value)?.focus()

  const userId = authStore.session?.user?.id
  if (userId && !notificationStore.fullListLoaded) {
    await notificationStore.loadFullNotificationList(userId)
  }
}

function close(returnFocus = true) {
  if (!isOpen.value) return
  isOpen.value = false
  document.body.style.overflow = ''
  window.removeEventListener('resize', positionPanel)
  if (clock) clearInterval(clock)
  clock = null
  if (returnFocus) nextTick(() => bellRef.value?.focus())
}

function toggle() {
  if (isOpen.value) close()
  else void open()
}

async function retry() {
  const userId = authStore.session?.user?.id
  if (userId) await notificationStore.loadFullNotificationList(userId, true)
}

async function loadMore() {
  const userId = authStore.session?.user?.id
  if (!userId || loadingMore.value) return
  loadingMore.value = true
  try {
    await notificationStore.loadMoreNotifications(userId)
  } catch (error) {
    debug.error('Failed to load more notifications:', error)
  } finally {
    loadingMore.value = false
  }
}

async function markAllRead() {
  busy.value = 'read'
  try {
    await notificationStore.markAllAsRead()
  } finally {
    busy.value = null
  }
}

async function clearAll() {
  if (!window.confirm(t('inbox.clearConfirm'))) return
  busy.value = 'clear'
  try {
    await notificationStore.clearAllNotifications()
  } finally {
    busy.value = null
  }
}

function openSettings() {
  close(false)
  router.push({ name: 'UserSettings', params: { section: 'notifications' } })
}

function openNotification(notification: Notification) {
  notificationStore.handleNotificationClick(notification)
  close(false)
  closeMobileSidebars()
}

async function toggleRead(id: string) {
  const notification = notificationStore.notifications.find(n => n.id === id)
  try {
    if (notification?.is_read) await notificationStore.markAsUnread(id)
    else await notificationStore.markAsRead(id)
  } catch (error) {
    debug.error('Failed to toggle read state:', error)
  }
}

async function remove(id: string) {
  const index = rowButtons().findIndex(el => el.closest('li')?.contains(document.activeElement))
  try {
    await notificationStore.deleteNotification(id)
  } catch (error) {
    debug.error('Failed to remove notification:', error)
    return
  }
  // Keeps keyboard focus in the list after the focused row disappears.
  if (index >= 0) {
    await nextTick()
    const next = rowButtons()
    next[Math.min(index, next.length - 1)]?.focus()
  }
}

function rowButtons(): HTMLElement[] {
  return Array.from(scrollRef.value?.querySelectorAll<HTMLElement>('[data-row-hit]') ?? [])
}

function focusables(): HTMLElement[] {
  return Array.from(panelRef.value?.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  ) ?? []).filter(el => el.offsetParent !== null || el === document.activeElement)
}

function onPanelKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') {
    event.stopPropagation()
    close()
    return
  }
  if (event.key !== 'Tab') return
  const items = focusables()
  if (items.length === 0) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

function onTabKeydown(event: KeyboardEvent) {
  const index = INBOX_TABS.indexOf(activeTab.value)
  let next = index
  if (event.key === 'ArrowRight') next = (index + 1) % INBOX_TABS.length
  else if (event.key === 'ArrowLeft') next = (index - 1 + INBOX_TABS.length) % INBOX_TABS.length
  else if (event.key === 'Home') next = 0
  else if (event.key === 'End') next = INBOX_TABS.length - 1
  else if (event.key === 'ArrowDown') {
    event.preventDefault()
    rowButtons()[0]?.focus()
    return
  } else return
  event.preventDefault()
  activeTab.value = INBOX_TABS[next]
  tabRefs.get(INBOX_TABS[next])?.focus()
}

function onListKeydown(event: KeyboardEvent) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
  const rows = rowButtons()
  if (rows.length === 0) return
  const current = rows.findIndex(el => el.closest('li')?.contains(document.activeElement))
  let next = current
  if (event.key === 'ArrowDown') next = current < 0 ? 0 : Math.min(current + 1, rows.length - 1)
  else if (event.key === 'ArrowUp') {
    if (current <= 0) {
      event.preventDefault()
      tabRefs.get(activeTab.value)?.focus()
      return
    }
    next = current - 1
  } else if (event.key === 'Home') next = 0
  else next = rows.length - 1
  event.preventDefault()
  rows[next].focus()
}

// Loads the next page as the end of the list scrolls into view.
watch(sentinelRef, (el) => {
  observer?.disconnect()
  observer = null
  if (!el || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((entries) => {
    if (entries.some(e => e.isIntersecting)) void loadMore()
  }, { root: scrollRef.value, rootMargin: '120px' })
  observer.observe(el)
})

watch(activeTab, () => {
  scrollRef.value?.scrollTo({ top: 0 })
})

watch(() => authStore.session?.user?.id, (id) => {
  if (!id) close(false)
})

onBeforeUnmount(() => {
  observer?.disconnect()
  close(false)
})
</script>

<style scoped>
.notification-bell-container {
  position: relative;
}

.notification-bell {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.notification-bell:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.notification-bell:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.notification-bell.has-unread {
  color: var(--text-primary);
}

.notification-bell.is-open {
  background: color-mix(in srgb, var(--harmony-primary) 15%, transparent);
  color: var(--h-brand);
}

/* Out of flow: the count never moves the bell or its neighbours. */
.notification-badge {
  position: absolute;
  top: -3px;
  right: -5px;
  min-width: 16px;
  height: 16px;
  padding: 0 4px;
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-full);
  background: var(--error);
  box-shadow: 0 0 0 2px var(--background-tertiary);
  pointer-events: none;
}

.badge-text {
  color: #fff;
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.dnd-indicator {
  position: absolute;
  right: 3px;
  bottom: 3px;
  width: 8px;
  height: 8px;
  border-radius: var(--radius-full);
  background: var(--status-busy);
  box-shadow: 0 0 0 2px var(--background-tertiary);
  pointer-events: none;
}

.notification-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: transparent;
}

.notification-panel {
  position: fixed;
  z-index: 1001;
  display: flex;
  flex-direction: column;
  width: 400px;
  max-height: 640px;
  overflow: hidden;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-modal);
  color: var(--text-primary);
}

.inbox-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-3) var(--space-2) var(--space-4);
}

.inbox-title-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}

.inbox-title {
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-bold);
}

.new-pill {
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: color-mix(in srgb, var(--harmony-primary) 16%, transparent);
  color: var(--h-brand);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  white-space: nowrap;
}

.inbox-actions {
  display: flex;
  gap: 2px;
}

.icon-btn {
  display: grid;
  place-items: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.icon-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}

.icon-btn:focus-visible,
.inbox-tab:focus-visible,
.unread-toggle:focus-visible,
.state-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.inbox-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: 0 var(--space-3) var(--space-2);
  border-bottom: 1px solid var(--border-primary);
}

.inbox-tabs {
  display: flex;
  gap: 2px;
}

.inbox-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.inbox-tab:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.inbox-tab.active {
  background: var(--background-modifier-active);
  color: var(--text-primary);
}

.tab-count {
  min-width: 18px;
  padding: 0 5px;
  border-radius: var(--radius-full);
  background: var(--error);
  color: #fff;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  line-height: 18px;
  text-align: center;
  font-variant-numeric: tabular-nums;
}

.unread-toggle {
  height: 26px;
  padding: 0 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  white-space: nowrap;
  cursor: pointer;
}

.unread-toggle:hover {
  color: var(--text-primary);
  border-color: var(--border-hover);
}

.unread-toggle.active {
  border-color: transparent;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  color: var(--h-brand);
}

.silenced-note {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-primary);
  background: color-mix(in srgb, var(--status-busy) 10%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
}

.inbox-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
  padding-bottom: var(--space-2);
}

.day-group + .day-group {
  margin-top: var(--space-1);
}

.day-label {
  margin: 0;
  padding: var(--space-2) var(--space-4) var(--space-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.day-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.skeleton-list {
  margin: 0;
  padding: var(--space-3) var(--space-4);
  list-style: none;
}

.skeleton-row {
  display: flex;
  gap: var(--space-3);
  align-items: center;
  height: 56px;
}

.sk {
  display: block;
  border-radius: var(--radius-base);
  background: var(--background-modifier-hover);
  animation: sk-pulse 1.4s ease-in-out infinite;
}

.sk-avatar {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  border-radius: var(--radius-full);
}

.sk-lines {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 6px;
}

.sk-line {
  height: 10px;
  width: 80%;
}

.sk-line.short {
  width: 50%;
}

@keyframes sk-pulse {
  50% { opacity: 0.5; }
}

.state-btn {
  padding: 6px 14px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.state-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.load-more {
  display: flex;
  justify-content: center;
  padding: var(--space-3) 0 var(--space-1);
}

.inbox-enter-active,
.inbox-leave-active {
  transition: opacity 140ms ease, transform 140ms ease;
}

.inbox-enter-from,
.inbox-leave-to {
  opacity: 0;
  transform: scale(0.97);
}

/* Phones: a full-screen sheet instead of a popover. */
@media (max-width: 768px) {
  .notification-backdrop {
    display: none;
  }

  /* !important: the global glass rule in design-system.css outranks scoped styles,
     and a full-screen sheet stays opaque whatever the blur setting. */
  .notification-panel {
    inset: 0;
    z-index: 10001;
    width: auto;
    max-height: none;
    border: none;
    border-radius: 0;
    padding-top: env(safe-area-inset-top);
    padding-bottom: env(safe-area-inset-bottom);
    background: var(--background-primary) !important;
    -webkit-backdrop-filter: none !important;
    backdrop-filter: none !important;
  }

  .inbox-header {
    padding: var(--space-3) var(--space-2) var(--space-2) var(--space-4);
  }

  .inbox-title {
    font-size: var(--font-size-lg);
  }

  .icon-btn {
    width: 40px;
    height: 40px;
  }

  .inbox-enter-from,
  .inbox-leave-to {
    opacity: 1;
    transform: translateY(100%);
  }

  .inbox-enter-active,
  .inbox-leave-active {
    transition: transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1);
  }
}

@media (prefers-reduced-motion: reduce) {
  .inbox-enter-active,
  .inbox-leave-active,
  .notification-bell {
    transition: none;
  }

  .sk {
    animation: none;
  }
}

@media (prefers-contrast: more) {
  .notification-panel {
    border: 2px solid currentColor;
  }
}
</style>
