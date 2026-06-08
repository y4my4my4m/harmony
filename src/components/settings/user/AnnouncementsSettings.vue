<template>
  <div class="announcements-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.announcements.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.announcements.description') }}
      </p>
    </div>

    <!-- Top action row: filters + mark-all-read -->
    <div class="action-row">
      <div class="filter-tabs" role="tablist" :aria-label="$t('settings.announcements.title')">
        <button
          v-for="tab in filterTabs"
          :key="tab.key"
          role="tab"
          :aria-selected="activeFilter === tab.key"
          class="filter-tab"
          :class="{ active: activeFilter === tab.key }"
          @click="activeFilter = tab.key"
        >
          <span class="filter-label">{{ tab.label }}</span>
          <span v-if="tab.count > 0" class="filter-count">{{ tab.count }}</span>
        </button>
      </div>

      <button
        v-if="unreadIds.size > 0"
        class="btn btn-secondary mark-all-btn"
        :disabled="isMarkingAll"
        @click="handleMarkAllRead"
      >
        <span v-if="!isMarkingAll">{{ $t('announcements.markAllRead') }}</span>
        <span v-else>...</span>
      </button>
    </div>

    <!-- Loading state -->
    <div v-if="isLoading" class="state-card">
      <LoadingSpinner :size="28" />
      <p>{{ $t('settings.announcements.loading') }}</p>
    </div>

    <!-- Error state -->
    <div v-else-if="loadError" class="state-card state-error">
      <p>{{ $t('settings.announcements.loadError') }}</p>
      <button class="btn btn-secondary" @click="loadAnnouncements">
        {{ $t('common.retry') }}
      </button>
    </div>

    <!-- Empty state -->
    <div v-else-if="filteredAnnouncements.length === 0" class="state-card state-empty">
      <div class="state-icon">📢</div>
      <p>{{ emptyMessage }}</p>
    </div>

    <!-- Announcement cards -->
    <div v-else class="announcement-list">
      <article
        v-for="announcement in filteredAnnouncements"
        :key="announcement.id"
        class="announcement-card"
        :class="{
          pinned: announcement.is_pinned,
          unread: unreadIds.has(announcement.id),
          inactive: !announcement.is_active,
          expired: isExpired(announcement),
        }"
      >
        <div class="card-header">
          <span class="announcement-icon" :title="announcement.icon">
            {{ getIconEmoji(announcement.icon) }}
          </span>
          <h3 class="announcement-title">{{ announcement.title }}</h3>
          <div class="badges">
            <span v-if="unreadIds.has(announcement.id)" class="badge badge-unread">
              {{ $t('settings.announcements.badges.unread') }}
            </span>
            <span v-if="announcement.is_pinned" class="badge badge-pinned">
              {{ $t('settings.announcements.badges.pinned') }}
            </span>
            <span v-if="!announcement.is_active" class="badge badge-inactive">
              {{ $t('settings.announcements.badges.inactive') }}
            </span>
            <span v-else-if="isExpired(announcement)" class="badge badge-expired">
              {{ $t('settings.announcements.badges.expired') }}
            </span>
            <span v-else-if="isScheduled(announcement)" class="badge badge-scheduled">
              {{ $t('settings.announcements.badges.scheduled') }}
            </span>
          </div>
        </div>

        <div
          class="announcement-content"
          v-html="sanitizeContent(announcement.content)"
        ></div>

        <img
          v-if="announcement.image_url"
          :src="announcement.image_url"
          class="announcement-image"
          alt=""
          loading="lazy"
        />

        <div class="card-footer">
          <span class="meta-date" :title="absoluteDate(announcement.created_at)">
            {{ formatDate(announcement.created_at) }}
          </span>
          <span
            v-if="announcement.author_id || announcement.author_display_name"
            class="meta-author"
          >
            ·
            <DisplayName
              v-if="announcement.author_id"
              :user-id="announcement.author_id"
              :fallback="announcement.author_display_name"
            />
            <template v-else>{{ announcement.author_display_name }}</template>
          </span>
          <span
            v-if="announcement.ends_at"
            class="meta-ends"
            :title="absoluteDate(announcement.ends_at)"
          >
            · {{ $t('settings.announcements.endsAt', { date: formatDate(announcement.ends_at) }) }}
          </span>

          <button
            v-if="unreadIds.has(announcement.id)"
            class="btn btn-subtle mark-read-inline"
            :disabled="markingIds.has(announcement.id)"
            @click="handleMarkRead(announcement.id)"
          >
            {{ $t('announcements.markRead') }}
          </button>
        </div>
      </article>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { useI18n } from 'vue-i18n'
import DOMPurify from 'dompurify'
import { announcementService, type Announcement } from '@/services/AnnouncementService'
import { useAnnouncementUnreadCount } from '@/composables/useAnnouncementUnreadCount'
import { userDataService } from '@/services/userDataService'
import { debug } from '@/utils/debug'
import DisplayName from '@/components/DisplayName.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'

defineProps<{
  loading?: boolean
}>()

const { t } = useI18n()
const { refresh: refreshUnreadCount, decrement: decrementUnreadCount, reset: resetUnreadCount } =
  useAnnouncementUnreadCount()

type FilterKey = 'all' | 'unread' | 'pinned'

const announcements = ref<Announcement[]>([])
const unreadIds = ref<Set<string>>(new Set())
const activeFilter = ref<FilterKey>('unread')
const isLoading = ref(false)
const loadError = ref(false)
const isMarkingAll = ref(false)
const markingIds = ref<Set<string>>(new Set())

const sanitizeContent = (html: string): string =>
  DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: [
      'p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'del', 'pre', 'code',
      'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    ],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'class', 'title'],
  })

const ICON_MAP: Record<string, string> = {
  info: 'ℹ️',
  warning: '⚠️',
  celebration: '🎉',
  maintenance: '🔧',
  update: '🆕',
  security: '🔒',
}

const getIconEmoji = (icon: string): string => ICON_MAP[icon] || 'ℹ️'

const formatDate = (dateStr: string): string =>
  new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric',
  })

const absoluteDate = (dateStr: string): string =>
  new Date(dateStr).toLocaleString()

const isExpired = (a: Announcement): boolean => {
  if (!a.ends_at) return false
  return new Date(a.ends_at).getTime() < Date.now()
}

const isScheduled = (a: Announcement): boolean => {
  if (!a.starts_at) return false
  return new Date(a.starts_at).getTime() > Date.now()
}

const sortedAnnouncements = computed<Announcement[]>(() => {
  // Stable, opinionated order: unread first, then pinned, then most recent.
  // We deliberately use a single sort with a composite comparator rather
  // than multiple passes so the order is deterministic across renders.
  return [...announcements.value].sort((a, b) => {
    const aUnread = unreadIds.value.has(a.id) ? 1 : 0
    const bUnread = unreadIds.value.has(b.id) ? 1 : 0
    if (aUnread !== bUnread) return bUnread - aUnread
    if (a.is_pinned !== b.is_pinned) return a.is_pinned ? -1 : 1
    return new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  })
})

const filteredAnnouncements = computed<Announcement[]>(() => {
  switch (activeFilter.value) {
    case 'unread':
      return sortedAnnouncements.value.filter(a => unreadIds.value.has(a.id))
    case 'pinned':
      return sortedAnnouncements.value.filter(a => a.is_pinned)
    case 'all':
    default:
      return sortedAnnouncements.value
  }
})

const filterTabs = computed(() => [
  { key: 'unread' as FilterKey, label: t('settings.announcements.filters.unread'), count: unreadIds.value.size },
  { key: 'all' as FilterKey, label: t('settings.announcements.filters.all'), count: announcements.value.length },
  {
    key: 'pinned' as FilterKey,
    label: t('settings.announcements.filters.pinned'),
    count: announcements.value.filter(a => a.is_pinned).length,
  },
])

const emptyMessage = computed(() => {
  switch (activeFilter.value) {
    case 'unread':
      return t('settings.announcements.empty.unread')
    case 'pinned':
      return t('settings.announcements.empty.pinned')
    case 'all':
    default:
      return t('settings.announcements.empty.all')
  }
})

async function loadAnnouncements(): Promise<void> {
  isLoading.value = true
  loadError.value = false
  try {
    // Fire both reads in parallel. `getAllAnnouncements` returns the full
    // archive (active + inactive + expired) which is what the user picked
    // in scope (`all_ever`); `getUnreadAnnouncements` is what powers the
    // unread set used for sorting, filtering, and the "Unread" badges.
    const [all, unread] = await Promise.all([
      announcementService.getAllAnnouncements(),
      announcementService.getUnreadAnnouncements(),
    ])
    announcements.value = all
    unreadIds.value = new Set(unread.map(u => u.id))

    // Keep the shared unread count in sync with what we just fetched so
    // the Settings sidebar badge and any open popup link reflect reality.
    await refreshUnreadCount()

    // Prime the user cache so DisplayName can resolve author identities
    // (and their custom emojis) without flickering when the list paints.
    for (const a of all) {
      if (a.author_id) {
        userDataService.fetchUserProfile(a.author_id).catch(() => {})
      }
    }
  } catch (err) {
    debug.error('Failed to load announcements:', err)
    loadError.value = true
  } finally {
    isLoading.value = false
  }
}

async function handleMarkRead(id: string): Promise<void> {
  if (!unreadIds.value.has(id)) return
  if (markingIds.value.has(id)) return
  markingIds.value.add(id)
  // Optimistic: drop from unread set + decrement the shared count up front
  // so the UI updates instantly. If the request fails we revert.
  unreadIds.value.delete(id)
  unreadIds.value = new Set(unreadIds.value)
  decrementUnreadCount(1)
  const ok = await announcementService.markAsRead(id)
  if (!ok) {
    unreadIds.value.add(id)
    unreadIds.value = new Set(unreadIds.value)
    await refreshUnreadCount()
  }
  markingIds.value.delete(id)
}

async function handleMarkAllRead(): Promise<void> {
  if (isMarkingAll.value) return
  const ids = Array.from(unreadIds.value)
  if (ids.length === 0) return
  isMarkingAll.value = true
  const previous = new Set(unreadIds.value)
  unreadIds.value = new Set()
  resetUnreadCount()
  const ok = await announcementService.markAllAsRead(ids)
  if (!ok) {
    unreadIds.value = previous
    await refreshUnreadCount()
  }
  isMarkingAll.value = false
}

onMounted(() => {
  void loadAnnouncements()
})
</script>

<style scoped>
.announcements-settings {
  max-width: 800px;
}

.settings-header {
  margin-bottom: 24px;
}

.settings-title {
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
  color: var(--text-secondary);
  margin: 0;
}

.action-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 12px;
  margin-bottom: 20px;
}

.filter-tabs {
  display: inline-flex;
  gap: 4px;
  padding: 4px;
  background: var(--background-secondary, var(--background-secondary, #2b2d31));
  border-radius: 999px;
  border: 1px solid var(--background-quaternary, var(--border-color, #3f4147));
}

.filter-tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: transparent;
  border: none;
  border-radius: 999px;
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}

.filter-tab:hover {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.04);
}

.filter-tab.active {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
}

.filter-count {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 18px;
  height: 18px;
  padding: 0 6px;
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.18);
  font-size: 11px;
  font-weight: 600;
}

.filter-tab:not(.active) .filter-count {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-secondary);
}

.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 6px;
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s ease, color 0.15s ease, border-color 0.15s ease;
}

.btn-secondary {
  background: transparent;
  color: var(--text-secondary);
  border-color: var(--background-quaternary, var(--border-color, #3f4147));
}

.btn-secondary:hover:not(:disabled) {
  background: var(--background-quaternary, rgba(255, 255, 255, 0.05));
  color: var(--text-primary);
}

.btn-subtle {
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid transparent;
  padding: 4px 10px;
  font-size: 12px;
}

.btn-subtle:hover:not(:disabled) {
  color: var(--text-primary);
  background: rgba(255, 255, 255, 0.06);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}

.state-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  padding: 48px 24px;
  background: var(--background-secondary, var(--background-secondary, #2b2d31));
  border: 1px solid var(--background-quaternary, var(--border-color, #3f4147));
  border-radius: 12px;
  color: var(--text-secondary);
  font-size: 14px;
  text-align: center;
}

.state-icon {
  font-size: 40px;
  opacity: 0.6;
}

.state-error p {
  color: #ed4245;
}

.announcement-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.announcement-card {
  background: var(--background-secondary, var(--background-secondary, #2b2d31));
  border: 1px solid var(--background-quaternary, var(--border-color, #3f4147));
  border-radius: 10px;
  padding: 16px 18px;
  transition: border-color 0.15s ease, opacity 0.15s ease;
}

.announcement-card.pinned {
  border-color: rgba(14, 165, 233, 0.55);
}

.announcement-card.unread {
  box-shadow: inset 3px 0 0 0 var(--harmony-primary, #0EA5E9);
}

.announcement-card.inactive,
.announcement-card.expired {
  opacity: 0.65;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.announcement-icon {
  font-size: 18px;
  flex-shrink: 0;
}

.announcement-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
}

.badges {
  display: inline-flex;
  gap: 6px;
  flex-wrap: wrap;
}

.badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 8px;
  border-radius: 4px;
}

.badge-unread {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
}

.badge-pinned {
  background: rgba(14, 165, 233, 0.18);
  color: var(--harmony-primary, #0EA5E9);
}

.badge-inactive,
.badge-expired {
  background: rgba(255, 255, 255, 0.08);
  color: var(--text-muted);
}

.badge-scheduled {
  background: rgba(245, 158, 11, 0.18);
  color: #f59e0b;
}

.announcement-content {
  font-size: 14px;
  color: var(--text-secondary);
  line-height: 1.55;
  margin-bottom: 10px;
  word-break: break-word;
}

.announcement-content :deep(a) {
  color: var(--harmony-primary, #0EA5E9);
}

.announcement-content :deep(p) {
  margin: 0 0 8px 0;
}

.announcement-content :deep(p:last-child) {
  margin-bottom: 0;
}

.announcement-image {
  display: block;
  width: 100%;
  max-height: 240px;
  object-fit: cover;
  border-radius: 6px;
  margin-bottom: 10px;
}

.card-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted, #949ba4);
}

.mark-read-inline {
  margin-left: auto;
}

.mark-all-btn {
  flex-shrink: 0;
}

@media (max-width: 600px) {
  .action-row {
    flex-direction: column;
    align-items: stretch;
  }

  .filter-tabs {
    overflow-x: auto;
    -webkit-overflow-scrolling: touch;
  }

  .mark-all-btn {
    align-self: flex-end;
  }
}
</style>
