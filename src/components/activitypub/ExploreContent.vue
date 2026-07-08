<template>
  <div class="explore-content">
    <!-- Explore Controls -->
    <div class="explore-controls">
      <div class="filter-group">
        <select v-if="currentView !== 'instances'" v-model="selectedContentType" class="filter-select">
          <option value="all">{{ $t('activitypub.allContent') }}</option>
          <option value="posts">{{ $t('activitypub.postsOnly') }}</option>
          <option value="media">{{ $t('activitypub.withMedia') }}</option>
          <option value="users">{{ $t('activitypub.users') }}</option>
        </select>
        
        <select v-if="currentView === 'instances'" v-model="instanceStatusFilter" class="filter-select">
          <option value="all">{{ $t('activitypub.allStatuses', 'All Statuses') }}</option>
          <option value="online">{{ $t('activitypub.online') }}</option>
          <option value="slow">{{ $t('activitypub.slow') }}</option>
          <option value="idle">{{ $t('activitypub.lastSeenLongAgo', 'Idle') }}</option>
        </select>

        <select v-if="currentView === 'instances'" v-model="instanceSoftwareFilter" class="filter-select">
          <option value="all">{{ $t('activitypub.allSoftware', 'All Software') }}</option>
          <option v-for="sw in availableSoftware" :key="sw" :value="sw">{{ sw }}</option>
        </select>

        <select v-if="currentView !== 'instances'" v-model="selectedInstance" class="filter-select">
          <option value="all">{{ $t('activitypub.allInstances') }}</option>
          <option value="local">{{ $t('activitypub.thisInstance') }}</option>
          <option v-for="instance in knownInstances" :key="instance.domain" :value="instance.domain">
            {{ instance.domain }}
          </option>
        </select>
        
        <select
          v-if="currentView !== 'instances' && selectedContentType !== 'users'"
          v-model="selectedTimeRange"
          class="filter-select"
        >
          <option value="1h">{{ $t('activitypub.lastHour') }}</option>
          <option value="6h">{{ $t('activitypub.last6Hours') }}</option>
          <option value="24h">{{ $t('activitypub.last24Hours') }}</option>
          <option value="7d">{{ $t('activitypub.lastWeek') }}</option>
          <option value="30d">{{ $t('activitypub.lastMonth') }}</option>
        </select>
        
        <button @click="refreshContent" class="refresh-btn" :disabled="isLoading">
          <Icon name="refresh-cw" :size="16" :class="{ spinning: isLoading }" />
          {{ $t('activitypub.refresh') }}
        </button>
      </div>

      <!-- Instance Search (only visible on instances tab) -->
      <div v-if="currentView === 'instances'" class="search-group">
        <input 
          v-model="instanceSearchTerm" 
          @input="searchInstances(instanceSearchTerm)"
          type="text" 
          :placeholder="$t('activitypub.searchInstances')" 
          class="search-input"
        />
        <Icon name="search" class="search-icon" />
      </div>
    </div>

    <!-- Content Display -->
    <div class="explore-content-area">
      <!-- Loading State -->
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="24" :thickness="3" />
        <p class="loading-state-label">{{ $t('activitypub.loadingExploreContent') }}</p>
      </div>

      <!-- Trending Content -->
      <div v-else-if="currentView === 'trending'" class="trending-content">
        <!-- Getting Started Hero (when all sections empty) -->
        <div v-if="allEmpty" class="trending-hero">
          <h2 class="hero-title">{{ $t('activitypub.trendingGettingStarted') }}</h2>
          <p class="hero-desc">{{ $t('activitypub.trendingGettingStartedDesc') }}</p>
          <ul class="hero-tips">
            <li>{{ $t('activitypub.trendingHeroTip1') }}</li>
            <li>{{ $t('activitypub.trendingHeroTip2') }}</li>
            <li>{{ $t('activitypub.trendingHeroTip3') }}</li>
          </ul>
          <div class="hero-actions">
            <button class="hero-btn hero-btn-primary" @click="openComposer">
              {{ $t('activitypub.createFirstPost') }}
            </button>
            <button class="hero-btn hero-btn-secondary" @click="navigateToInstances">
              {{ $t('activitypub.browseInstances') }}
            </button>
          </div>
        </div>

        <!-- Individual Sections (when any has content or when showing empty with hints) -->
        <div class="trending-sections">
          <!-- Trending Posts -->
          <div v-if="showTrendingPosts" class="section trending-section trending-posts">
            <h3 class="section-title">
              <Icon name="trending-up" />
              {{ $t('activitypub.trendingPosts') }}
            </h3>
            <div v-if="visibleTrendingPosts.length > 0" data-timeline class="posts-list">
              <MonyPost
                v-for="trendingPost in visibleTrendingPosts"
                :key="trendingPost.post?.id || trendingPost.id"
                :post="trendingPost.post || trendingPost"
                @reply="$emit('reply-to-post', $event)"
                @favorite="$emit('favorite-post', $event)"
                @reblog="$emit('reblog-post', $event)"
                @bookmark="$emit('bookmark-post', $event)"
                @delete="$emit('delete-post', $event)"
                @show-user-profile="$emit('show-user-profile', $event)"
                @show-conversation="$emit('show-conversation', $event as any)"
              />
            </div>
            <div v-else class="empty-state section-empty-state">
              <Icon name="trending-up" :size="40" class="empty-icon" />
              <p class="empty-title">{{ $t('activitypub.noTrendingPosts') }}</p>
              <p class="empty-subtitle">{{ $t('activitypub.noTrendingPostsHint') }}</p>
            </div>
          </div>

          <!-- Trending Hashtags -->
          <div v-if="showTrendingHashtags" class="section trending-section trending-hashtags">
            <h3 class="section-title">
              <Icon name="hash" />
              {{ $t('activitypub.trendingHashtags') }}
            </h3>
            <div v-if="trendingHashtags.length > 0" class="hashtag-grid">
              <div 
                v-for="hashtag in trendingHashtags" 
                :key="hashtag.tag"
                @click="loadHashtagPosts(hashtag.tag)"
                class="hashtag-item"
              >
                <div class="hashtag-info">
                  <span class="hashtag-name">#{{ hashtag.tag }}</span>
                  <span class="hashtag-count">{{ formatNumber(hashtag.daily_uses) }} {{ $t('activitypub.postsCount') }}</span>
                </div>
                <div class="hashtag-trend">
                  <Icon :name="getTrendIcon(hashtag.trend)" :class="`trend-${hashtag.trend}`" />
                  <span class="trend-change">{{ hashtag.change_percent > 0 ? '+' : '' }}{{ hashtag.change_percent }}%</span>
                </div>
              </div>
            </div>
            <div v-else class="empty-state section-empty-state" style="display: flex; flex-direction: column; align-items: center; gap: 2px; padding: 16px 0;">
              <Icon name="hash" :size="40" class="empty-icon" style="margin-bottom: 12px;" />
              <p class="empty-title" style="margin-bottom: 2px;">{{ $t('activitypub.noTrendingHashtags') }}</p>
              <p class="empty-subtitle" style="margin-bottom: 10px; color: var(--text-secondary, #b5bac1); text-align: center;">{{ $t('activitypub.noTrendingHashtagsHint') }}</p>
              <button class="btn btn-primary" style="margin-top: 6px;" @click="openComposer">
                {{ $t('activitypub.createFirstPost') }}
              </button>
            </div>
          </div>

          <!-- Suggested Users -->
          <div v-if="showSuggestedUsers" class="section trending-section suggested-users">
            <h3 class="section-title">
              <Icon name="user-plus" />
              {{ $t('activitypub.suggestedUsers') }}
            </h3>
            <div v-if="visibleSuggestedUsers.length > 0" class="users-grid">
              <ProfileCard 
                v-for="user in visibleSuggestedUsers"
                :key="user.user?.id || user.id"
                :user="user.user || user"
                :show-more-actions="true"
                :is-compact="true"
                instance-badge-variant="inline"
                @click="$emit('show-user-profile', user.user || user)"
              />
            </div>
            <div v-else class="empty-state section-empty-state">
              <Icon name="users" :size="40" class="empty-icon" />
              <p class="empty-title">{{ $t('activitypub.noSuggestedUsers') }}</p>
              <p class="empty-subtitle">{{ $t('activitypub.noSuggestedUsersHint') }}</p>
            </div>
          </div>
        </div>
      </div>

      <!-- Instance Browser -->
      <div v-else-if="currentView === 'instances'" class="instances-content">
        <div class="section instances-browser">
          <h3 class="section-title">
            <Icon name="server" />
            {{ $t('activitypub.federatedInstances') }}
          </h3>
          <div v-if="filteredInstances.length > 0" class="instances-grid">
            <article
              v-for="instance in filteredInstances"
              :key="instance.domain"
              class="instance-card"
              :class="{ 'has-banner': getInstanceBanner(instance) }"
              @click="showInstanceDetails(instance)"
            >
              <!-- Banner background -->
              <div
                v-if="getInstanceBanner(instance)"
                class="instance-card-banner"
                :style="{ backgroundImage: `url(${getInstanceBanner(instance)})` }"
              >
                <div class="instance-card-banner-overlay"></div>
              </div>

              <div class="instance-card-header">
                <div class="instance-card-icon">
                  <img
                    v-if="getInstanceIcon(instance)"
                    :src="getInstanceIcon(instance)!"
                    :alt="instance.domain"
                    class="instance-icon-img"
                    @error="handleIconError(getInstanceIcon(instance)!)"
                  />
                  <span v-else class="instance-platform-emoji">{{ getPlatformEmoji(instance.software) }}</span>
                </div>
                <div class="instance-card-meta">
                  <h4 class="instance-card-domain">{{ instance.domain }}</h4>
                  <span class="instance-card-software">{{ instance.software || 'Unknown' }}{{ instance.version ? ` ${instance.version}` : '' }}</span>
                </div>
                <span class="instance-status-pill" :class="getInstanceStatusClass(instance)">
                  <span class="status-dot"></span>
                  {{ getInstanceStatusText(instance) }}
                </span>
              </div>

              <p class="instance-card-desc">
                {{ stripHtml(instance.description) || $t('activitypub.noDescriptionAvailable') }}
              </p>

              <div class="instance-card-stats">
                <span class="instance-stat">
                  <Icon name="users" :size="14" />
                  {{ formatNumber(instance.user_count || 0) }} {{ $t('activitypub.usersCount') }}
                </span>
                <span class="instance-stat">
                  <Icon name="message-circle" :size="14" />
                  {{ formatNumber(instance.status_count || 0) }} {{ $t('activitypub.postsCount') }}
                </span>
                <span class="instance-stat">
                  <Icon name="globe" :size="14" />
                  {{ formatNumber(instance.connection_count || 0) }}
                </span>
              </div>

              <div class="instance-card-footer">
                <span class="instance-last-seen">{{ $t('activitypub.lastSeen') }} {{ getTimeAgo(instance?.last_seen_at) }}</span>
                <div class="instance-card-actions">
                  <button type="button" @click.stop="visitInstance(instance)" class="instance-btn">
                    <Icon name="external-link" :size="14" />
                    {{ $t('activitypub.visit') }}
                  </button>
                  <button type="button" @click.stop="viewInstancePosts(instance)" class="instance-btn instance-btn-alt">
                    <Icon name="eye" :size="14" />
                    {{ $t('activitypub.viewPosts') }}
                  </button>
                </div>
              </div>
            </article>
          </div>
          <div v-else class="empty-state">
            <Icon name="server" />
            <p>{{ $t('activitypub.noInstancesFound') }}</p>
          </div>
        </div>
      </div>
    </div>

    <!-- Load More Button -->
    <div v-if="hasMoreContent && !isLoading" class="load-more-section">
      <button @click="loadMore" :disabled="isLoadingMore" class="load-more-btn">
        <Icon v-if="isLoadingMore" name="loader" class="spinning" />
        <Icon v-else name="chevron-down" />
        {{ isLoadingMore ? $t('activitypub.loading') : $t('activitypub.loadMore') }}
      </button>
    </div>

    <!-- Instance Detail Modal -->
    <InstanceDetailModal
      v-if="showInstanceModal"
      :instance="selectedInstanceDetails"
      @close="showInstanceModal = false"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, watch } from 'vue';
import { useRouter } from 'vue-router';
import { debug } from '@/utils/debug'
import { useI18n } from 'vue-i18n';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { activityPubService } from '@/services/activityPubService';
import { trendingService } from '@/services/TrendingService';
import { adminService } from '@/services/AdminService';
import MonyPost from './MonyPost.vue';
import InstanceDetailModal from './InstanceDetailModal.vue';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import type { TimelinePost, FederatedUser } from '@/types';
import ProfileCard from '@/components/common/ProfileCard.vue';

// Router
const router = useRouter();

useI18n();

interface Props {
  currentView: 'trending' | 'instances';
}

const props = defineProps<Props>();

defineEmits<{
  'switch-feed': [feedType: string];
  'refresh-timeline': [];
  'show-user-profile': [user: FederatedUser];
  'follow-user': [userId: string];
  'unfollow-user': [userId: string];
  'reply-to-post': [post: TimelinePost];
  'favorite-post': [postId: string];
  'reblog-post': [postId: string];
  'bookmark-post': [postId: string];
  'delete-post': [postId: string];
  'show-conversation': [post: TimelinePost];
}>();

const activityPubStore = useActivityPubStore();

// Loading states
const isLoading = ref(false);
const isLoadingMore = ref(false);

const selectedContentType = ref('all');
const selectedInstance = ref('all');
const selectedTimeRange = ref('24h');
const instanceSearchTerm = ref('');
const instanceStatusFilter = ref('all');
const instanceSoftwareFilter = ref('all');

// Data states
const trendingHashtags = ref<any[]>([]);
const trendingPosts = ref<any[]>([]);
const suggestedUsers = ref<any[]>([]);
const knownInstances = ref<any[]>([]);
const selectedInstanceDetails = ref<any | null>(null);
const showInstanceModal = ref(false);

// Pagination
const hasMoreContent = ref(false);
const currentCursor = ref<string | null>(null);

const availableSoftware = computed(() => {
  const set = new Set<string>();
  for (const inst of knownInstances.value) {
    if (inst.software) set.add(inst.software);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
});

const filteredInstances = computed(() => {
  if (!knownInstances.value) return [];

  let filtered = knownInstances.value;

  if (instanceSearchTerm.value.trim()) {
    const term = instanceSearchTerm.value.trim().toLowerCase();
    filtered = filtered.filter(i =>
      i.domain?.toLowerCase().includes(term) ||
      i.software?.toLowerCase().includes(term) ||
      i.description?.toLowerCase().includes(term)
    );
  }

  if (instanceStatusFilter.value !== 'all') {
    filtered = filtered.filter(i => {
      const status = getInstanceStatus(i);
      if (instanceStatusFilter.value === 'idle') return status === 'unknown';
      return status === instanceStatusFilter.value;
    });
  }

  if (instanceSoftwareFilter.value !== 'all') {
    filtered = filtered.filter(i =>
      i.software?.toLowerCase() === instanceSoftwareFilter.value.toLowerCase()
    );
  }

  return filtered;
});

// Hide muted/blocked users from trending. Trending is fetched via a direct
// PostgREST query that doesn't know about the viewer's mutes, so filter here
// (mirrors the timeline behaviour) using the store's muted/blocked sets.
const authorIdOf = (entry: any): string | undefined => {
  const post = entry?.post || entry;
  return post?.author_id || post?.author?.id;
};
const userIdOf = (entry: any): string | undefined => {
  const user = entry?.user || entry;
  return user?.id;
};
const isHiddenUser = (id: string | undefined): boolean => {
  if (!id) return false;
  return activityPubStore.mutedUsers.has(id) || activityPubStore.blockedUsers.has(id);
};

const visibleTrendingPosts = computed(() =>
  trendingPosts.value.filter(p => !isHiddenUser(authorIdOf(p)))
);
const visibleSuggestedUsers = computed(() =>
  suggestedUsers.value.filter(u => !isHiddenUser(userIdOf(u)))
);

const allEmpty = computed(() =>
  trendingHashtags.value.length === 0 &&
  visibleTrendingPosts.value.length === 0 &&
  visibleSuggestedUsers.value.length === 0
);

const openComposer = () => {
  activityPubStore.openComposer();
};

const navigateToInstances = () => {
  router.push({ name: 'SocialInstances' });
};

// eslint-disable-next-line unused-imports/no-unused-vars
const currentTabData = computed(() => {
  switch (props.currentView) {
    case 'trending':
      return {
        posts: trendingPosts.value,
        hashtags: trendingHashtags.value,
        users: suggestedUsers.value
      };
    case 'instances':
      return {
        instances: filteredInstances.value
      };
    default:
      return {};
  }
});

const trendingFilters = () => {
  // "local" is a pseudo-instance meaning "this instance only". Express it via
  // is_local scoping (includeFederated:false) rather than a domain match, since
  // local rows can have a NULL domain and would be missed by author.domain = X.
  const sel = selectedInstance.value;
  const isLocalOnly = sel === 'local';
  return {
    contentType: selectedContentType.value as 'all' | 'posts' | 'media' | 'users',
    timeRange: selectedTimeRange.value as '1h' | '6h' | '24h' | '7d' | '30d',
    instance: (sel === 'all' || sel === 'local') ? undefined : sel,
    includeLocal: true,
    includeFederated: !isLocalOnly,
  };
};

const showTrendingPosts = computed(() => {
  const type = selectedContentType.value;
  return type === 'all' || type === 'posts' || type === 'media';
});

const showTrendingHashtags = computed(() => {
  const type = selectedContentType.value;
  // Hashtags are post-discovery aids; show them with the post views, not for
  // the media-uploads view or the users view.
  return type === 'all' || type === 'posts';
});

const showSuggestedUsers = computed(() => {
  const type = selectedContentType.value;
  return type === 'all' || type === 'users';
});

const hoursForTimeRange = (timeRange: string): number => {
  switch (timeRange) {
    case '1h': return 1;
    case '6h': return 6;
    case '24h': return 24;
    case '7d': return 24 * 7;
    case '30d': return 24 * 30;
    default: return 24;
  }
};

const filterTrendingPostsByInstance = (posts: any[], instance?: string) => {
  if (!instance) return posts;
  return posts.filter((item) => {
    const post = item.post ?? item;
    const domain = post.author?.domain
      ?? (post.ap_id ? (() => { try { return new URL(post.ap_id).hostname; } catch { return null; } })() : null);
    return domain === instance;
  });
};

const loadTrendingContent = async () => {
  try {
    isLoading.value = true;
    const filters = trendingFilters();
    const contentType = filters.contentType;

    const [hashtags, posts, users] = await Promise.all([
      showTrendingHashtags.value
        ? trendingService.getTrendingHashtags({
            limit: 10,
            hours: hoursForTimeRange(filters.timeRange),
          })
        : Promise.resolve([]),
      showTrendingPosts.value
        ? trendingService.getTrendingPosts({
            limit: 20,
            timeRange: filters.timeRange,
            instance: filters.instance,
            mediaFilter: contentType === 'media' ? 'media' : contentType === 'posts' ? 'text' : 'all',
            includeLocal: filters.includeLocal,
            includeFederated: filters.includeFederated,
          })
        : Promise.resolve([]),
      showSuggestedUsers.value
        ? trendingService.getTrendingUsers({
            limit: 6,
            instance: filters.instance,
            includeLocal: filters.includeLocal,
            includeFederated: filters.includeFederated,
          })
        : Promise.resolve([]),
    ]);

    trendingHashtags.value = hashtags;
    trendingPosts.value = filterTrendingPostsByInstance(posts, filters.instance);
    suggestedUsers.value = users;
  } catch (error) {
    debug.error('Failed to load trending content:', error);
  } finally {
    isLoading.value = false;
  }
};

const loadInstances = async () => {
  try {
    isLoading.value = true;

    const instances = await activityPubService.getDiscoverableInstances({
      limit: 50,
      filter: 'active'
    });

    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to load instances:', error);
    try {
      const adminInstances = await adminService.getFederatedInstances({
        limit: 50,
        filter: 'all'
      });
      knownInstances.value = adminInstances.instances || [];
    } catch (adminError) {
      debug.error('Failed to load instances from admin service:', adminError);
    }
  } finally {
    isLoading.value = false;
  }

  enrichMissingInstanceMetadata();
};

const enrichMissingInstanceMetadata = async () => {
  const toEnrich = knownInstances.value.filter(
    inst => !inst.metadata?.icon_url && !inst.metadata?.banner_url
  );
  if (!toEnrich.length) return;

  const BATCH = 5;
  for (let i = 0; i < toEnrich.length; i += BATCH) {
    const batch = toEnrich.slice(i, i + BATCH);
    const results = await Promise.allSettled(
      batch.map(inst => adminService.enrichInstanceMetadata(inst))
    );

    for (let j = 0; j < batch.length; j++) {
      const result = results[j];
      if (result.status === 'fulfilled' && result.value) {
        const inst = batch[j];
        const idx = knownInstances.value.findIndex(k => k.id === inst.id);
        if (idx !== -1) {
          knownInstances.value[idx] = {
            ...knownInstances.value[idx],
            metadata: {
              ...(knownInstances.value[idx].metadata || {}),
              ...result.value,
            },
          };
        }
      }
    }
  }
};

const loadHashtagPosts = (hashtag: string) => {
  // Navigate to hashtag view
  router.push({ name: 'HashtagView', params: { tag: hashtag } });
};

const showInstanceDetails = async (instance: any) => {
  try {
    selectedInstanceDetails.value = instance;
    
    const stats = await activityPubService.getInstanceStats(instance.domain);
    if (stats) {
      selectedInstanceDetails.value = { ...instance, ...stats };
    }
    
    showInstanceModal.value = true;
  } catch (error) {
    debug.error('Failed to load instance details:', error);
    selectedInstanceDetails.value = instance;
    showInstanceModal.value = true;
  }
};

const visitInstance = (instance: any) => {
  window.open(`https://${instance.domain}`, '_blank');
};

const viewInstancePosts = (instance: any) => {
  window.open(`https://${instance.domain}/public`, '_blank');
};

const searchInstances = async (searchTerm: string) => {
  if (!searchTerm.trim()) {
    await loadInstances();
    return;
  }
  
  try {
    const instances = await activityPubService.getDiscoverableInstances({
      limit: 20,
      filter: 'active',
      search: searchTerm.trim()
    });
    
    knownInstances.value = instances;
  } catch (error) {
    debug.error('Failed to search instances:', error);
  }
};

const getInstanceStatus = (instance: any): 'online' | 'slow' | 'offline' | 'unknown' => {
  if (instance.status && ['online', 'slow', 'offline', 'unknown'].includes(instance.status)) {
    return instance.status;
  }
  if (!instance.last_seen_at) return 'unknown';
  const hours = (Date.now() - new Date(instance.last_seen_at).getTime()) / (1000 * 60 * 60);
  if (hours < 24) return 'online';
  if (hours < 24 * 7) return 'slow';
  return 'unknown';
};

const getInstanceStatusClass = (instance: any) => {
  const status = getInstanceStatus(instance);
  return [`status-${status}`];
};

const getInstanceStatusText = (instance: any) => {
  const { t } = useI18n();
  const status = getInstanceStatus(instance);
  switch (status) {
    case 'online':
      return t('activitypub.online');
    case 'slow':
      return t('activitypub.slow');
    case 'offline':
      return t('activitypub.offline');
    default:
      return t('activitypub.lastSeenLongAgo', 'Idle');
  }
};

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

const getPlatformEmoji = (software?: string): string => {
  if (!software) return '\uD83C\uDF10';
  const key = software.toLowerCase().replace(/[^a-z]/g, '');
  for (const [platform, emoji] of Object.entries(PLATFORM_EMOJI)) {
    if (key.includes(platform)) return emoji;
  }
  return '\uD83C\uDF10';
};

const failedIconUrls = ref(new Set<string>());

const getInstanceIcon = (instance: any): string | null => {
  const url = instance.metadata?.icon_url || null;
  if (url && failedIconUrls.value.has(url)) return null;
  return url;
};

const getInstanceBanner = (instance: any): string | null => {
  return instance.metadata?.banner_url || null;
};

const handleIconError = (url: string) => {
  failedIconUrls.value.add(url);
};

const stripHtml = (raw: string): string => {
  if (!raw) return '';
  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');
  return doc.body.textContent || '';
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

const getTimeAgo = (dateString: string | null | undefined): string => {
  const { t } = useI18n();
  if (!dateString) return t('activitypub.unknown');
  const now = new Date();
  const date = new Date(dateString);
  const diffInHours = Math.floor((now.getTime() - date.getTime()) / (1000 * 60 * 60));
  
  if (diffInHours < 1) return t('activitypub.justNow');
  if (diffInHours < 24) return t('activitypub.hoursAgo', { hours: diffInHours });
  
  const diffInDays = Math.floor(diffInHours / 24);
  if (diffInDays < 30) return t('activitypub.daysAgo', { days: diffInDays });
  
  const diffInMonths = Math.floor(diffInDays / 30);
  return t('activitypub.monthsAgo', { months: diffInMonths });
};

const getTrendIcon = (trend: string) => {
  switch (trend) {
    case 'up': return 'trending-up';
    case 'down': return 'trending-down';
    default: return 'minus';
  }
};

const loadMore = async () => {
  if (isLoadingMore.value || !hasMoreContent.value) return;
  
  try {
    isLoadingMore.value = true;
    
    if (props.currentView === 'trending') {
      const morePosts = await activityPubService.getTrendingPosts({
        limit: 10,
        timeframe: 'daily'
      });
      
      trendingPosts.value.push(...morePosts);
    }
    
  } catch (error) {
    debug.error('Failed to load more content:', error);
  } finally {
    isLoadingMore.value = false;
  }
};

const refreshContent = async () => {
  currentCursor.value = null;
  
  if (props.currentView === 'trending') {
    await loadTrendingContent();
  } else if (props.currentView === 'instances') {
    await loadInstances();
  }
};

watch(() => props.currentView, async (newTab) => {
  if (newTab === 'trending') {
    await loadTrendingContent();
  } else if (newTab === 'instances') {
    await loadInstances();
  }
}, { immediate: true });

// Always load the instance list so the "Filter by instance" dropdown is
// populated regardless of which trending tab the user is on. The
// instances tab itself still calls `loadInstances()` directly so this is
// a no-op extra fetch when the user lands on that tab - small payload,
// no UX impact.
watch(() => props.currentView, (newTab) => {
  if (newTab !== 'instances' && knownInstances.value.length === 0) {
    void loadInstances();
  }
}, { immediate: true });

watch([selectedContentType, selectedInstance, selectedTimeRange], async () => {
  await refreshContent();
});

defineExpose({ refreshContent });
</script>

<style scoped>
.explore-content {
  height: 100%;
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
}

.explore-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
  padding: 0 16px;
}

.tab-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-weight: 600;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  transition: all 0.2s ease;
}

.tab-btn:hover {
  color: var(--text-primary);
  background: var(--background-hover);
}

.tab-btn.active {
  color: var(--harmony-primary);
  border-bottom-color: var(--harmony-primary);
}

.explore-controls {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-secondary);
}

.filter-group {
  display: flex;
  gap: 12px;
}

.filter-select,
.search-input {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-size: 14px;
}

.refresh-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 14px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-primary);
  color: var(--text-primary);
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: border-color 0.2s ease, background 0.2s ease, color 0.2s ease;
}

.refresh-btn:hover:not(:disabled) {
  border-color: var(--harmony-primary-alpha);
  background: var(--harmony-primary-light);
  color: var(--harmony-primary);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.explore-content-area {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.federated-post {
  position: relative;
}

.users-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: 1rem;
  align-items: start;
}

@media (max-width: 1200px) {
  .users-grid {
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 0.75rem;
  }
}

@media (max-width: 900px) {
  .users-grid {
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.5rem;
  }
}

@media (max-width: 768px) {
  .users-grid {
    grid-template-columns: 1fr;
    gap: 0.75rem;
  }
}

.instance-badge {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 500;
}

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-5, 20px);
  padding: var(--space-16, 64px) var(--space-4, 16px);
  min-height: 280px;
  text-align: center;
  color: var(--text-secondary);
}

.loading-state-label {
  margin: 0;
  font-size: var(--font-size-sm, 0.875rem);
  line-height: var(--line-height-relaxed, 1.5);
  color: var(--text-secondary);
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 16px 0 8px;
  color: var(--text-primary);
}

/* Hero when all sections empty */
.trending-hero {
  max-width: 560px;
  margin: 32px auto 48px;
  padding: 40px 32px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  text-align: center;
}

.hero-title {
  font-size: 22px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 12px;
}

.hero-desc {
  font-size: 15px;
  color: var(--text-secondary);
  line-height: 1.5;
  margin: 0 0 24px;
}

.hero-tips {
  text-align: left;
  margin: 0 0 28px;
  padding: 0 0 0 20px;
  color: var(--text-secondary);
  font-size: 14px;
  line-height: 1.7;
}

.hero-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  justify-content: center;
}

.hero-btn {
  padding: 10px 20px;
  border-radius: 8px;
  font-weight: 600;
  font-size: 14px;
  cursor: pointer;
  transition: background 0.2s ease;
  border: none;
}

.hero-btn-primary {
  background: var(--harmony-primary);
  color: var(--text-primary);
}

.hero-btn-primary:hover {
  background: var(--harmony-primary-hover, #0284C7);
}

.hero-btn-secondary {
  background: var(--background-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.hero-btn-secondary:hover {
  background: var(--background-hover);
}

.trending-sections {
  display: flex;
  flex-direction: column;
  gap: 24px;
  max-width: 800px;
  margin: 0 auto;
}

.trending-section {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
}

.section-title {
  border-left: 3px solid var(--harmony-primary);
  padding-left: 12px;
}

.trending-posts .mony-post {
  background: var(--background-quaternary);
}

.section-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 18px;
  font-weight: 700;
  margin: 0 0 16px;
  color: var(--text-primary);
}

.trending-hashtags {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.hashtag-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
  margin-bottom: 8px;
}

.hashtag-info {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: 1;
}

.hashtag-name {
  font-weight: 600;
  color: var(--harmony-primary);
  cursor: pointer;
  transition: color 0.2s ease;
}

.hashtag-name:hover {
  color: var(--harmony-primary-hover);
}

.hashtag-count {
  font-size: 14px;
  color: var(--text-secondary);
}

.hashtag-trend {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 14px;
  font-weight: 600;
}

.trend-up { color: #10b981; }
.trend-down { color: #ef4444; }
.trend-neutral { color: var(--text-secondary); }

.suggested-users {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.user-suggestion {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--background-primary);
  border-radius: 8px;
  border: 1px solid var(--border-color);
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
}

.user-name {
  font-weight: 600;
  color: var(--text-primary);
}

.user-handle {
  font-size: 14px;
  color: var(--text-secondary);
}

.user-stats {
  font-size: 12px;
  color: var(--text-secondary);
  margin-top: 4px;
}

.follow-btn {
  padding: 6px 16px;
  background: var(--harmony-primary);
  border: none;
  border-radius: 16px;
  color: var(--text-primary);
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s ease;
  flex-shrink: 0;
}

.follow-btn:hover {
  background: var(--harmony-primary-hover, #0284C7);
}

.instance-browser {
  max-width: 1000px;
  margin: 0 auto;
}

.instance-controls {
  display: flex;
  gap: 12px;
  margin-bottom: 24px;
}

.instances-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(300px, 1fr));
  gap: 20px;
}

.instance-card {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 20px;
  cursor: pointer;
  transition: border-color 0.2s ease, box-shadow 0.2s ease, transform 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 14px;
  position: relative;
  overflow: hidden;
}

.instance-card.has-banner {
  padding-top: 80px;
}

.instance-card-banner {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  height: 80px;
  background-size: cover;
  background-position: center;
  z-index: 0;
}

.instance-card-banner-overlay {
  position: absolute;
  inset: 0;
  height: calc(100% + 1px); /* workaround chrome rendering bug */
  background: linear-gradient(
    to bottom,
    rgba(0, 0, 0, 0.15) 0%,
    var(--background-secondary) 100%
  );
}

.instance-card:hover {
  border-color: var(--harmony-primary);
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.12);
  transform: translateY(-1px);
}

.instance-card-header {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  position: relative;
  z-index: 1;
}

.instance-card-icon {
  width: 44px;
  height: 44px;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--background-tertiary);
  border-radius: 10px;
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  overflow: hidden;
}

.instance-icon-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  border-radius: 9px;
}

.instance-platform-emoji {
  font-size: 22px;
  line-height: 1;
}

.instance-card-meta {
  flex: 1;
  min-width: 0;
}

.instance-card-domain {
  font-size: 1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 2px;
  letter-spacing: -0.01em;
}

.instance-card-software {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.instance-status-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  border-radius: 20px;
  font-size: 0.75rem;
  font-weight: 500;
  flex-shrink: 0;
}

.instance-status-pill .status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
}

.instance-status-pill.status-online {
  background: rgba(16, 185, 129, 0.14);
  color: #10b981;
}

.instance-status-pill.status-online .status-dot {
  background: #10b981;
  animation: status-pulse 2s ease-in-out infinite;
}

.instance-status-pill.status-slow {
  background: rgba(245, 158, 11, 0.14);
  color: #f59e0b;
}

.instance-status-pill.status-slow .status-dot {
  background: #f59e0b;
}

.instance-status-pill.status-offline {
  background: rgba(239, 68, 68, 0.14);
  color: #ef4444;
}

.instance-status-pill.status-offline .status-dot {
  background: #ef4444;
}

.instance-status-pill.status-unknown {
  background: rgba(156, 163, 175, 0.14);
  color: #9ca3af;
}

.instance-status-pill.status-unknown .status-dot {
  background: #9ca3af;
}

@keyframes status-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.5; }
}

.instance-card-desc {
  font-size: 0.875rem;
  color: var(--text-secondary);
  line-height: 1.45;
  margin: 0;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  position: relative;
  z-index: 1;
}

.instance-card-stats {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
  font-size: 0.8125rem;
  color: var(--text-secondary);
  position: relative;
  z-index: 1;
}

.instance-stat {
  display: flex;
  align-items: center;
  gap: 5px;
}

.instance-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border-color);
  margin-top: 2px;
  position: relative;
  z-index: 1;
}

.instance-last-seen {
  font-size: 0.75rem;
  color: var(--text-secondary);
}

.instance-card-actions {
  display: flex;
  gap: 8px;
}

.instance-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 6px 12px;
  font-size: 0.8125rem;
  font-weight: 500;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s, color 0.2s;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-primary);
}

.instance-btn:hover {
  background: var(--background-hover);
}

.instance-btn-alt {
  border-color: transparent;
  background: transparent;
}

.instance-btn-alt:hover {
  background: var(--background-tertiary);
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsive */
@media (max-width: 768px) {
  .explore-tabs {
    padding: 0 8px;
    overflow-x: auto;
  }
  
  .tab-btn {
    padding: 12px;
    white-space: nowrap;
  }
  
  .explore-controls {
    flex-direction: column;
    gap: 12px;
    align-items: stretch;
  }
  
  .filter-group {
    flex-wrap: wrap;
  }
  
  .instances-grid {
    grid-template-columns: 1fr;
  }
  
  .trending-sections {
    gap: 24px;
  }
  
  .instance-card-stats {
    flex-wrap: wrap;
    gap: 10px;
  }
  

  
  .tab-btn {
    padding: 0.75rem 1rem;
  }
}
</style> 