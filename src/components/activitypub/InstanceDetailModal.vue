<template>
  <BaseModal :show="true" :show-header="false" overlay-class="instance-detail-modal" @close="$emit('close')">
    <div class="instance-detail-layout">
      <!-- Banner -->
      <div
        v-if="instanceBanner"
        class="instance-modal-banner"
        :style="{ backgroundImage: `url(${instanceBanner})` }"
      >
        <div class="instance-modal-banner-overlay"></div>
      </div>

      <header class="instance-modal-header" :class="{ 'has-banner': !!instanceBanner }">
        <div class="instance-header-main">
          <div class="instance-icon-wrap">
            <img
              v-if="instanceIcon && !iconFailed"
              :src="instanceIcon"
              :alt="instance.domain"
              class="instance-icon-img"
              @error="iconFailed = true"
            />
            <span v-else class="instance-platform-emoji">{{ platformEmoji }}</span>
          </div>
          <div class="instance-title-block">
            <h2 class="instance-domain">{{ instance.domain }}</h2>
            <p class="instance-software">
              {{ instance.software || 'Unknown' }}{{ instance.version ? ` ${instance.version}` : '' }}
            </p>
          </div>
          <div class="instance-badges">
            <div v-if="instance.is_trusted" class="instance-badge trusted">
              <Icon name="star" :size="14" />
              Trusted
            </div>
            <div v-if="instance.is_blocked" class="instance-badge blocked">
              <Icon name="shield-off" :size="14" />
              Blocked
            </div>
          </div>
        </div>
        <button @click="$emit('close')" class="close-btn" aria-label="Close">
          <Icon name="x" :size="18" />
        </button>
      </header>

      <div class="instance-modal-body">
        <!-- Instance Stats -->
        <section class="modal-section">
          <h3 class="section-heading">Instance Statistics</h3>
          <div class="stats-grid">
            <div class="stat-card">
              <Icon name="users" :size="22" class="stat-icon" />
              <div class="stat-content">
                <div class="stat-value">{{ formatNumber(instance.user_count) }}</div>
                <div class="stat-label">Users</div>
              </div>
            </div>
            <div class="stat-card">
              <Icon name="message-square" :size="22" class="stat-icon" />
              <div class="stat-content">
                <div class="stat-value">{{ formatNumber(instance.status_count) }}</div>
                <div class="stat-label">Posts</div>
              </div>
            </div>
            <div class="stat-card">
              <Icon name="activity" :size="22" class="stat-icon" />
              <div class="stat-content">
                <div class="stat-value">{{ formatTimeAgo(instance.last_seen_at) }}</div>
                <div class="stat-label">Last Seen</div>
              </div>
            </div>
            <div class="stat-card">
              <Icon name="link" :size="22" class="stat-icon" />
              <div class="stat-content">
                <div class="stat-value">{{ instance.connection_count || 0 }}</div>
                <div class="stat-label">Connections</div>
              </div>
            </div>
          </div>
        </section>

        <!-- About This Instance -->
        <section class="modal-section">
          <h3 class="section-heading">About This Instance</h3>
          <div class="info-rows">
            <div class="info-row">
              <span class="info-label">Description:</span>
              <span class="info-value" v-html="sanitizedDescription"></span>
            </div>
            <div v-if="instance.admin_contact" class="info-row">
              <span class="info-label">Admin Contact:</span>
              <span class="info-value">{{ instance.admin_contact }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">Instance Type:</span>
              <span class="info-value">{{ instanceTypeLabel }}</span>
            </div>
            <div class="info-row">
              <span class="info-label">First Discovered:</span>
              <span class="info-value">{{ formatDate(instance?.created_at) }}</span>
            </div>
          </div>
        </section>

        <!-- Federation Status -->
        <section class="modal-section">
          <h3 class="section-heading">Federation Status</h3>
          <div class="fed-status-list">
            <div class="fed-row">
              <div class="fed-indicator" :class="instance.is_blocked ? 'danger' : 'success'">
                <Icon :name="instance.is_blocked ? 'shield-off' : 'shield-check'" :size="16" />
              </div>
              <span class="fed-label">{{ instance.is_blocked ? 'Blocked' : 'Federation Enabled' }}</span>
            </div>
            <div class="fed-row">
              <div class="fed-indicator" :class="instance.is_trusted ? 'success' : 'muted'">
                <Icon :name="instance.is_trusted ? 'star' : 'shield'" :size="16" />
              </div>
              <span class="fed-label">{{ instance.is_trusted ? 'Trusted Instance' : 'Standard Instance' }}</span>
            </div>
            <div class="fed-row">
              <div class="fed-indicator" :class="activityStatus.class">
                <Icon :name="activityStatus.icon" :size="16" />
              </div>
              <span class="fed-label">{{ activityStatus.text }}</span>
            </div>
          </div>
        </section>

        <!-- Recent Posts -->
        <section class="modal-section">
          <h3 class="section-heading">Recent Posts</h3>

          <div v-if="isLoadingPosts" class="empty-placeholder">
            <Icon name="loader" :size="20" class="spinning" />
            <span>Loading posts...</span>
          </div>

          <div v-else-if="recentPosts.length > 0" class="recent-posts">
            <div
              v-for="post in recentPosts"
              :key="post.id"
              class="post-card"
              @click="viewPost(post)"
            >
              <div class="post-author-row">
                <Avatar :src="post.author?.avatar_url" size="sm" :alt="post.author?.display_name" />
                <span class="post-author-name">
                  <DisplayName
                    v-if="post.author?.id"
                    :userId="post.author.id"
                    :fallback="post.author?.display_name || post.author?.username || 'Unknown'"
                  />
                  <template v-else>{{ post.author?.display_name || post.author?.username || 'Unknown' }}</template>
                  <template v-if="post.author?.username">
                    <span class="post-author-handle">{{ post.author.domain && post.author.domain !== currentDomain ? `@${post.author.username}@${post.author.domain}` : `@${post.author.username}` }}</span>
                  </template>
                </span>
              </div>
              <div class="post-text">{{ getPostText(post.content) }}</div>
              <div class="post-meta">
                <span class="post-time">{{ formatTimeAgo(post.created_at) }}</span>
                <div class="post-counts">
                  <span><Icon name="heart" :size="13" /> {{ post.favorites_count || 0 }}</span>
                  <span><Icon name="repeat" :size="13" /> {{ post.reblogs_count || 0 }}</span>
                </div>
              </div>
            </div>
          </div>

          <div v-else class="empty-placeholder">
            <Icon name="message-square" :size="20" />
            <span>No recent posts from this instance</span>
          </div>
        </section>
      </div>

      <footer class="instance-modal-footer">
        <button @click="openInNewTab" class="footer-btn secondary">
          <Icon name="external-link" :size="15" />
          Visit Instance
        </button>
        <button @click="copyInstanceUrl" class="footer-btn secondary">
          <Icon name="copy" :size="15" />
          {{ urlCopied ? 'Copied!' : 'Copy URL' }}
        </button>
        <button @click="viewAllPosts" class="footer-btn primary">
          <Icon name="eye" :size="15" />
          View All Posts
        </button>
      </footer>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import { useRouter } from 'vue-router';
import DOMPurify from 'dompurify';
import { debug } from '@/utils/debug'
import type { FederatedInstance, TimelinePost } from '@/types';
import BaseModal from '@/components/common/BaseModal.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '@/components/common/Avatar.vue';
import DisplayName from '@/components/DisplayName.vue';

const router = useRouter();
const currentDomain = import.meta.env.VITE_DOMAIN as string;

interface Props {
  instance: FederatedInstance;
}

const props = defineProps<Props>();

defineEmits<{
  close: [];
  'view-posts': [instance: FederatedInstance];
}>();

const recentPosts = ref<TimelinePost[]>([]);
const isLoadingPosts = ref(false);
const urlCopied = ref(false);
const iconFailed = ref(false);

const PLATFORM_EMOJI: Record<string, string> = {
  mastodon: '\uD83D\uDC18',
  misskey: '\u2B50',
  pleroma: '\uD83D\uDD35',
  akkoma: '\uD83D\uDD35',
  gotosocial: '\uD83D\uDC3F\uFE0F',
  pixelfed: '\uD83D\uDCF7',
  lemmy: '\uD83D\uDC2D',
  harmony: '\uD83D\uDC3B\u200D\u2744\uFE0F',
  peertube: '\uD83C\uDFAC',
  funkwhale: '\uD83C\uDFB5',
  writefreely: '\u270D\uFE0F',
  bookwyrm: '\uD83D\uDCDA',
};

const instanceIcon = computed(() => props.instance.metadata?.icon_url || null);
const instanceBanner = computed(() => props.instance.metadata?.banner_url || null);

const INSTANCE_DESCRIPTION_ALLOWED_TAGS = ['br', 'b', 'i', 'em', 'strong', 'a', 'p', 'span', 'ul', 'ol', 'li'];
const INSTANCE_DESCRIPTION_ALLOWED_ATTRS = ['href', 'rel', 'target'];

function sanitizeHtml(raw: string): string {
  if (!raw) return 'No description available';
  // Hand off to DOMPurify with a narrow allowlist. The previous hand-rolled
  // walker inlined attribute values into a template string without escaping
  // (` ${attr.name}="${attr.value}"`), so a federated server could break
  // out of any attribute by including an unescaped `"` in e.g. a
  // `title` value. DOMPurify handles attribute escaping internally.
  return DOMPurify.sanitize(raw, {
    ALLOWED_TAGS: INSTANCE_DESCRIPTION_ALLOWED_TAGS,
    ALLOWED_ATTR: INSTANCE_DESCRIPTION_ALLOWED_ATTRS,
    ALLOW_DATA_ATTR: false,
    ADD_ATTR: ['target', 'rel'],
    // Restrict href schemes - DOMPurify's default allows quite a few
    // (tel:, mailto:, callto:, sms:, etc). For instance descriptions we
    // only want http(s) links since this is shown in an admin / discovery
    // context.
    ALLOWED_URI_REGEXP: /^https?:/i,
  });
}

const sanitizedDescription = computed(() => sanitizeHtml(props.instance.description || ''));
const platformEmoji = computed(() => {
  const sw = props.instance.software?.toLowerCase()?.replace(/[^a-z]/g, '') || '';
  for (const [platform, emoji] of Object.entries(PLATFORM_EMOJI)) {
    if (sw.includes(platform)) return emoji;
  }
  return '\uD83C\uDF10';
});

const activityStatus = computed(() => {
  if (!props.instance.last_seen_at) {
    return { text: 'No activity recorded', icon: 'help-circle', class: 'muted' };
  }
  const hours = (Date.now() - new Date(props.instance.last_seen_at).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return { text: 'Active today', icon: 'wifi', class: 'success' };
  if (hours < 24 * 7) return { text: 'Active this week', icon: 'wifi', class: 'warning' };
  return { text: `Last active ${formatTimeAgo(props.instance.last_seen_at)}`, icon: 'clock', class: 'muted' };
});

const instanceTypeLabel = computed(() => {
  const sw = props.instance.software?.toLowerCase();
  if (!sw) return 'ActivityPub Instance';
  const labels: Record<string, string> = {
    mastodon: 'Mastodon Instance',
    pleroma: 'Pleroma Instance',
    misskey: 'Misskey Instance',
    peertube: 'PeerTube Instance',
    pixelfed: 'PixelFed Instance',
    harmony: 'Harmony Instance',
  };
  return labels[sw] || `${props.instance.software} Instance`;
});

const formatNumber = (num: number): string => {
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1) + 'M';
  if (num >= 1_000) return (num / 1_000).toFixed(1) + 'K';
  return String(num ?? 0);
};

const formatTimeAgo = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'Unknown';
  const ms = Date.now() - new Date(timestamp).getTime();
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  const years = Math.floor(months / 12);
  return `${years}y ago`;
};

const formatDate = (timestamp: string | null | undefined): string => {
  if (!timestamp) return 'Unknown';
  return new Date(timestamp).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });
};

const getPostText = (content: any): string => {
  if (Array.isArray(content)) {
    const textPart = content.find((p: any) => p.type === 'text');
    const raw = textPart ? textPart.text : '';
    return raw.length > 140 ? raw.substring(0, 140) + '...' : raw;
  }
  if (typeof content === 'string') {
    const stripped = content.replace(/<[^>]+>/g, '');
    return stripped.length > 140 ? stripped.substring(0, 140) + '...' : stripped;
  }
  return '';
};

const loadRecentPosts = async () => {
  isLoadingPosts.value = true;
  try {
    const { activityPubService } = await import('@/services/activityPubService');
    const result = await activityPubService.getInstanceActivity(props.instance.domain, { limit: 3 });
    recentPosts.value = result.posts?.length ? result.posts : [];
  } catch (error) {
    debug.error('Failed to load recent posts:', error);
    recentPosts.value = [];
  } finally {
    isLoadingPosts.value = false;
  }
};

const viewPost = (post: TimelinePost) => {
  router.push({ name: 'PostDetail', params: { postId: post.id } });
};

const viewAllPosts = () => {
  window.open(`https://${props.instance.domain}/public`, '_blank');
};

const copyInstanceUrl = async () => {
  try {
    await navigator.clipboard.writeText(`https://${props.instance.domain}`);
    urlCopied.value = true;
    setTimeout(() => { urlCopied.value = false; }, 2000);
  } catch (error) {
    debug.error('Failed to copy URL:', error);
  }
};

const openInNewTab = () => {
  window.open(`https://${props.instance.domain}`, '_blank');
};

onMounted(() => {
  loadRecentPosts();
});
</script>

<!-- Unscoped: overrides BaseModal's Teleported children (scoped+Teleport can't be crossed with :deep) -->
<style>
.instance-detail-modal .modal-container {
  max-width: 560px;
  width: 92vw;
  border: none;
  border-radius: 10px;
  overflow: hidden;
}

.instance-detail-modal .modal-content {
  padding: 0;
  overflow: hidden;
  max-height: min(85vh, 720px);
  display: flex;
  flex-direction: column;
}
</style>

<style scoped>
.instance-detail-layout {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* ── Banner ───────────────────────────── */
.instance-modal-banner {
  width: 100%;
  height: 100px;
  background-size: cover;
  background-position: center;
  position: relative;
  flex-shrink: 0;
}

.instance-modal-banner-overlay {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    to bottom,
    transparent 30%,
    var(--background-quinary) 100%
  );
}

/* ── Header ───────────────────────────── */
.instance-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  flex-shrink: 0;
}

.instance-modal-header.has-banner {
  margin-top: -32px;
  position: relative;
  z-index: 1;
  border-bottom: none;
  padding-bottom: 12px;
}

.instance-header-main {
  display: flex;
  align-items: center;
  gap: 14px;
  flex: 1;
  min-width: 0;
}

.instance-icon-wrap {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 46px;
  height: 46px;
  flex-shrink: 0;
  background: var(--background-tertiary);
  border-radius: 12px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.instance-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 11px;
}

.instance-platform-emoji {
  font-size: 22px;
  line-height: 1;
}

.instance-title-block {
  flex: 1;
  min-width: 0;
}

.instance-domain {
  font-size: 1.15rem;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
  letter-spacing: -0.01em;
}

.instance-software {
  font-size: 0.8rem;
  color: var(--text-secondary);
  margin: 2px 0 0;
}

.instance-badges {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
}

.instance-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 10px;
  border-radius: 6px;
  font-size: 0.75rem;
  font-weight: 600;
  letter-spacing: 0.02em;
}

.instance-badge.trusted {
  background: rgba(16, 185, 129, 0.14);
  color: #34d399;
}

.instance-badge.blocked {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
}

.close-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 34px;
  height: 34px;
  border: none;
  border-radius: 8px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.close-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

/* ── Body ─────────────────────────────── */
.instance-modal-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 20px 12px;
  scrollbar-width: thin;
  scrollbar-color: rgba(255, 255, 255, 0.2) transparent;
}

.instance-modal-body::-webkit-scrollbar {
  width: 6px;
}

.instance-modal-body::-webkit-scrollbar-track {
  background: transparent;
  margin: 4px 0;
}

.instance-modal-body::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.2);
  border-radius: 3px;
}

.instance-modal-body::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.3);
}

.modal-section {
  padding: 14px 0;
}

.modal-section + .modal-section {
  border-top: 1px solid var(--border-color);
}

.section-heading {
  font-size: 0.7rem;
  font-weight: 700;
  margin: 0 0 14px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ── Stats Grid ───────────────────────── */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 16px;
  background: var(--background-secondary);
  border-radius: 10px;
  border: 1px solid var(--border-color);
}

.stat-icon {
  color: var(--text-secondary);
  flex-shrink: 0;
}

.stat-value {
  font-size: 1.05rem;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 0.65rem;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  margin-top: 1px;
}

/* ── Info Rows ────────────────────────── */
.info-rows {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.info-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
}

.info-label {
  font-size: 0.8rem;
  font-weight: 600;
  color: var(--text-secondary);
}

.info-value {
  font-size: 0.875rem;
  color: var(--text-primary);
  line-height: 1.45;
}

/* ── Federation Status ────────────────── */
.fed-status-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.fed-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-radius: 8px;
  background: var(--background-secondary);
}

.fed-indicator {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 8px;
  flex-shrink: 0;
}

.fed-indicator.success {
  background: rgba(16, 185, 129, 0.14);
  color: #34d399;
}

.fed-indicator.warning {
  background: rgba(245, 158, 11, 0.14);
  color: #fbbf24;
}

.fed-indicator.danger {
  background: rgba(239, 68, 68, 0.14);
  color: #f87171;
}

.fed-indicator.muted {
  background: rgba(156, 163, 175, 0.1);
  color: var(--text-secondary);
}

.fed-label {
  font-size: 0.875rem;
  color: var(--text-primary);
  font-weight: 500;
}

/* ── Recent Posts ─────────────────────── */
.empty-placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 28px 16px;
  color: var(--text-secondary);
  font-size: 0.875rem;
}

.recent-posts {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.post-card {
  padding: 14px 16px;
  background: var(--background-secondary);
  border-radius: 10px;
  border: 1px solid var(--border-color);
  cursor: pointer;
  transition: border-color 0.15s ease;
}

.post-card:hover {
  border-color: var(--harmony-primary);
}

.post-author-row {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
}

.post-author-name {
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-primary);
  display: flex;
  align-items: baseline;
  /* gap: 6px; */
  gap: 1px;
  flex-direction: column;
  overflow: hidden;
}

.post-author-handle {
  font-size: 0.75rem;
  font-weight: 400;
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.post-text {
  font-size: 0.875rem;
  color: var(--text-primary);
  line-height: 1.45;
  margin-bottom: 10px;
}

.post-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.post-counts {
  display: flex;
  align-items: center;
  gap: 12px;
}

.post-counts span {
  display: flex;
  align-items: center;
  gap: 4px;
}

/* ── Footer ───────────────────────────── */
.instance-modal-footer {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
  padding: 12px 20px;
  border-top: 1px solid var(--border-color);
  flex-shrink: 0;
}

.footer-btn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 9px 16px;
  border-radius: 8px;
  font-size: 0.8125rem;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  border: none;
}

.footer-btn.primary {
  background: var(--harmony-primary);
  color: #fff;
}

.footer-btn.primary:hover {
  background: var(--harmony-primary-hover, #4f46e5);
}

.footer-btn.secondary {
  background: var(--background-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.footer-btn.secondary:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* ── Responsive ───────────────────────── */
@media (max-width: 540px) {
  .instance-modal-header {
    padding: 16px;
  }
  .instance-modal-body {
    padding: 0 16px 12px;
  }
  .instance-modal-footer {
    padding: 12px 16px;
    flex-wrap: wrap;
  }
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: 8px;
  }
  .stat-card {
    padding: 12px;
  }
  .footer-btn {
    flex: 1;
    justify-content: center;
  }
}
</style>
