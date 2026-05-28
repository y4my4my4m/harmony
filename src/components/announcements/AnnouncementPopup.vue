<template>
  <Teleport to="body">
    <div v-if="announcements.length > 0" class="announcement-overlay" data-testid="announcement-overlay" @click.self="dismiss">
      <div class="announcement-popup">
        <div class="popup-header">
          <div class="header-title">
            <span class="header-icon">📢</span>
            <h2>{{ $t('announcements.title', 'Announcements') }}</h2>
            <span class="unread-badge" v-if="announcements.length > 1">{{ announcements.length }}</span>
          </div>
          <button @click="dismiss" class="close-btn">
            <svg width="20" height="20" viewBox="0 0 24 24">
              <path fill="currentColor" d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>

        <div class="popup-body">
          <div
            v-for="announcement in announcements"
            :key="announcement.id"
            class="announcement-card"
            :class="{ pinned: announcement.is_pinned }"
          >
            <div class="card-header">
              <span class="announcement-icon">{{ getIconEmoji(announcement.icon) }}</span>
              <h3 class="announcement-title">{{ announcement.title }}</h3>
              <span v-if="announcement.is_pinned" class="pin-badge">Pinned</span>
            </div>
            <div class="announcement-content" v-html="sanitizeContent(announcement.content)"></div>
            <img
              v-if="announcement.image_url"
              :src="announcement.image_url"
              class="announcement-image"
              alt="Announcement image"
            />
            <div class="card-footer">
              <span class="announcement-date">{{ formatDate(announcement.created_at) }}</span>
              <span v-if="announcement.author_id || announcement.author_display_name" class="announcement-author">
                - <DisplayName
                  v-if="announcement.author_id"
                  :user-id="announcement.author_id"
                  :fallback="announcement.author_display_name"
                />
                <template v-else>{{ announcement.author_display_name }}</template>
              </span>
              <button @click="markRead(announcement.id)" class="mark-read-btn" data-testid="announcement-mark-read">
                {{ $t('announcements.markRead', 'Mark as read') }}
              </button>
            </div>
          </div>
        </div>

        <div class="popup-footer">
          <button
            v-if="announcements.length > 1"
            @click="markAllRead"
            class="mark-all-btn"
            data-testid="announcement-mark-all-read"
          >
            {{ $t('announcements.markAllRead', 'Mark all as read') }}
          </button>
          <button
            type="button"
            class="view-past-btn"
            data-testid="announcement-view-past"
            @click="viewPastAnnouncements"
          >
            {{ $t('announcements.viewPast', 'View past announcements') }}
          </button>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { ref, onMounted } from 'vue'
import { useRouter } from 'vue-router'
import DOMPurify from 'dompurify'
import { announcementService, type Announcement } from '@/services/AnnouncementService'
import { userDataService } from '@/services/userDataService'
import DisplayName from '@/components/DisplayName.vue'

const router = useRouter()

const announcements = ref<Announcement[]>([])

const sanitizeContent = (html: string): string => {
  return DOMPurify.sanitize(html || '', {
    ALLOWED_TAGS: ['p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'del', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6'],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'class', 'title'],
  })
}

const getIconEmoji = (icon: string): string => {
  const icons: Record<string, string> = {
    info: 'ℹ️',
    warning: '⚠️',
    celebration: '🎉',
    maintenance: '🔧',
    update: '🆕',
    security: '🔒'
  }
  return icons[icon] || 'ℹ️'
}

const formatDate = (dateStr: string): string => {
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric'
  })
}

const markRead = async (id: string) => {
  await announcementService.markAsRead(id)
  announcements.value = announcements.value.filter(a => a.id !== id)
}

const markAllRead = async () => {
  const ids = announcements.value.map(a => a.id)
  await announcementService.markAllAsRead(ids)
  announcements.value = []
}

const dismiss = () => {
  announcements.value = []
}

const viewPastAnnouncements = () => {
  // Dismiss the popup (we don't auto-mark-read here — the archive page
  // is where the user explicitly opts in to that). Then navigate to the
  // dedicated Settings section that owns the full archive.
  dismiss()
  router.push('/settings/announcements').catch(() => {})
}

onMounted(async () => {
  // `popupOnly: true` makes the RPC respect the admin's `show_popup` flag
  // and skip any announcement that started before the current user signed
  // up — so newly-registered users don't get a wall of historical modals
  // they have no context for. The Settings archive still surfaces the
  // full set (via the default no-arg call), so nothing is hidden, only
  // de-prioritised at boot.
  announcements.value = await announcementService.getUnreadAnnouncements({
    popupOnly: true,
  })
  // Prime user cache so DisplayName can resolve custom emojis for authors
  for (const a of announcements.value) {
    if (a.author_id) {
      userDataService.fetchUserProfile(a.author_id).catch(() => {})
    }
  }
})
</script>

<style scoped>
.announcement-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.announcement-popup {
  background: var(--background-primary, #1e1f22);
  border: 1px solid var(--border-color, #2b2d31);
  border-radius: 12px;
  width: 90vw;
  max-width: 600px;
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
}

.popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 20px 24px;
  border-bottom: 1px solid var(--border-color, #2b2d31);
}

.header-title {
  display: flex;
  align-items: center;
  gap: 10px;
}

.header-icon {
  font-size: 24px;
}

.header-title h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary, #f2f3f5);
}

.unread-badge {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 700;
}

.close-btn {
  background: none;
  border: none;
  color: var(--text-secondary, #b5bac1);
  cursor: pointer;
  padding: 4px;
  border-radius: 4px;
}

.close-btn:hover {
  background: var(--background-hover, #35373c);
  color: var(--text-primary, #f2f3f5);
}

.popup-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.announcement-card {
  background: var(--background-secondary, #2b2d31);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 8px;
  padding: 16px;
}

.announcement-card.pinned {
  border-color: var(--harmony-primary, #0EA5E9);
  border-width: 2px;
}

.card-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.announcement-icon {
  font-size: 18px;
}

.announcement-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary, #f2f3f5);
  flex: 1;
}

.pin-badge {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}

.announcement-content {
  font-size: 14px;
  color: var(--text-secondary, #b5bac1);
  line-height: 1.5;
  margin-bottom: 12px;
}

.announcement-image {
  width: 100%;
  border-radius: 6px;
  margin-bottom: 12px;
  max-height: 200px;
  object-fit: cover;
}

.card-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: var(--text-muted, #949ba4);
}

.announcement-date,
.announcement-author {
  flex-shrink: 0;
}

.mark-read-btn {
  margin-left: auto;
  background: none;
  border: 1px solid var(--border-color, #3f4147);
  color: var(--text-secondary, #b5bac1);
  padding: 4px 12px;
  border-radius: 4px;
  font-size: 12px;
  cursor: pointer;
}

.mark-read-btn:hover {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
  border-color: var(--harmony-primary, #0EA5E9);
}

.popup-footer {
  padding: 16px 24px;
  border-top: 1px solid var(--border-color, #2b2d31);
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
}

.mark-all-btn {
  background: var(--harmony-primary, #0EA5E9);
  color: var(--text-primary);
  border: none;
  padding: 8px 20px;
  border-radius: 6px;
  font-weight: 600;
  cursor: pointer;
}

.mark-all-btn:hover {
  opacity: 0.9;
}

.view-past-btn {
  /* Margin-left:auto so this button always sits on the right edge of the
     footer regardless of whether the mark-all button is visible (it's only
     rendered when there are multiple unread announcements). */
  margin-left: auto;
  background: transparent;
  color: var(--text-secondary, #b5bac1);
  border: 1px solid var(--border-color, #3f4147);
  padding: 8px 16px;
  border-radius: 6px;
  font-weight: 500;
  font-size: 13px;
  cursor: pointer;
}

.view-past-btn:hover {
  background: var(--background-hover, #35373c);
  color: var(--text-primary, #f2f3f5);
}
</style>
