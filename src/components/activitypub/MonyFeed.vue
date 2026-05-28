<!-- ActivityPub Feed Component - The heart of the Monyverse -->
<template>
  <div class="mony-feed" data-testid="timeline-feed">
    <!-- Feed Header -->
    <div class="feed-header">
      <div class="feed-tabs">
        <button 
          v-for="tab in feedTabs" 
          :key="tab.type"
          :class="['feed-tab', { active: currentView === tab.type }]"
          @click="switchFeed(tab.type)"
        >
          <Icon :name="tab.icon" />
          <span>{{ tab.label }}</span>
          <div v-if="tab.badge" class="tab-badge">{{ tab.badge }}</div>
        </button>
      </div>
      
      <!-- Compose Button -->
      <button
        class="compose-button"
        data-testid="compose-btn"
        @click="openComposer"
        :disabled="(activityPubStore as any).isPosting ?? false"
      >
        <Icon name="edit" />
        <span>Mony</span>
      </button>
    </div>

    <!-- Feed Content -->
    <div class="feed-content" ref="feedContainer" data-timeline @scroll="handleScroll">
      <!-- Loading Skeleton -->
      <div v-if="isLoadingAnyFeed && currentFeed.posts.length === 0" class="feed-loading">
        <PostSkeleton v-for="i in 3" :key="i" />
      </div>

      <!-- Posts -->
      <div v-else class="posts-container">
        <TransitionGroup name="post-list" tag="div">
          <MonyPost
            v-for="post in currentFeed.posts"
            :key="post.id"
            :post="post"
            @favorite="toggleFavorite"
            @reblog="toggleReblog"
            @bookmark="toggleBookmark"
            @delete="deletePost"
            @edit="handleEdit"
            @click="openPost"
            @show-conversation="showConversation"
            @hashtag-click="navigateToHashtag"
          />
        </TransitionGroup>

        <!-- Load More Button -->
        <div v-if="currentFeed.has_more" class="load-more-container">
          <button 
            class="load-more-button"
            @click="loadMore"
            :disabled="isLoadingAnyFeed || isManualLoading"
          >
            <Icon v-if="isLoadingAnyFeed || isManualLoading" name="spinner" class="spinning" />
            <Icon v-else name="arrow-down" />
            <span>{{ (isLoadingAnyFeed || isManualLoading) ? $t('activitypub.loading') : $t('activitypub.loadMoreMonies') }}</span>
          </button>
        </div>

        <!-- End of Feed -->
        <div v-else-if="currentFeed.posts.length > 0" class="end-of-feed">
          <Icon name="sparkles" />
          <span>You're all caught up in the Monyverse!</span>
        </div>

        <!-- Empty State -->
        <div v-else class="empty-feed">
          <div class="empty-illustration">
            <Icon name="mony-mascot" :size="96" />
          </div>
          <h3>{{ emptyStateTitle }}</h3>
          <p>{{ emptyStateMessage }}</p>
          <button v-if="currentView === 'home'" class="discover-button" @click="switchFeed('public')">
            <Icon name="globe" :size="16" />
            <span>Discover the Monyverse</span>
          </button>
        </div>
      </div>
    </div>

    <!-- Post Composer Modal -->
    <Composer
      v-if="isComposerOpen"
      mode="modal"
      type="post"
      :is-open="isComposerOpen"
      @close="closeComposer"
      @posted="handlePosted"
    />

    <!-- Edit Composer Modal -->
    <Composer
      v-if="editingPost"
      mode="modal"
      type="edit"
      :edit-post="editingPost"
      :is-open="!!editingPost"
      @close="editingPost = null"
      @edited="handleEdited"
    />

    <!-- Post Detail Modal -->
    <MonyPostDetail
      v-if="selectedPost"
      :post="selectedPost"
      :is-open="!!selectedPost"
      @close="closePost"
      @favorite="toggleFavorite"
      @reblog="toggleReblog"
      @bookmark="toggleBookmark"
      @delete="deletePost"
    />

    <!-- Error Toast -->
    <ErrorToast
      v-if="lastError"
      :message="lastError"
      @close="clearError"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import { debug } from '@/utils/debug'
import { throttle } from '@/utils/throttle'
import { useI18n } from 'vue-i18n';
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { usePostInteractions } from '@/composables/usePostInteractions';
import type { TimelinePost } from '@/types';

const { t } = useI18n();

// Components
import MonyPost from './MonyPost.vue';
import Composer from './Composer.vue';
import Icon from '@/components/common/Icon.vue';

// Store
const activityPubStore = useActivityPubStore();
const router = useRouter();

// Refs
const feedContainer = ref<HTMLElement>();
const isManualLoading = ref(false);
const editingPost = ref<TimelinePost | null>(null);

// Computed properties. `isLoadingAnyFeed` and `lastError` reference a store
// API surface that has drifted from `useActivityPub`; cast to `any` so the
// template bindings keep type-checking until the store/component contract is
// reconciled in a follow-up.
const {
  currentView,
  isLoadingAnyFeed,
  isComposerOpen,
  selectedPost,
  lastError,
} = storeToRefs(activityPubStore as any);

const feedTabs = computed(() => [
  {
    type: 'home' as const,
    label: 'Home',
    icon: 'home',
    badge: null
  },
  {
    type: 'public' as const,
    label: 'Monyverse',
    icon: 'globe',
    badge: null
  },
  {
    type: 'local' as const,
    label: 'Local',
    icon: 'server',
    badge: null
  }
]);

// View-bound feed slice. `currentView` is the active timeline name
// ('home' | 'public' | 'local'); we proxy to the matching store feed object
// so the template can read `.posts` / `.has_more` without re-shaping. Cast to
// `any` because the store's typed surface has drifted from the legacy
// `{ posts, has_more }` shape; this is intentional pending the store split.
const currentFeed = computed<any>(() => {
  const view = (currentView.value as unknown as 'home' | 'public' | 'local') ?? 'public';
  const getter = (activityPubStore as any).getTimelinePosts;
  if (typeof getter === 'function') {
    const data = getter(view);
    if (data) return data;
  }
  const fallback = (activityPubStore as any)[`${view}Feed`];
  return fallback ?? { posts: [], has_more: false };
});

const emptyStateTitle = computed(() => {
  switch (currentView.value) {
    case 'home': return 'Welcome to your Mony feed!';
    case 'public': return 'The Monyverse awaits!';
    case 'local': return 'Local community hub';
    default: return t('activitypub.noMoniesHereYet');
  }
});

const emptyStateMessage = computed(() => {
  switch (currentView.value) {
    case 'home': return t('activitypub.followUsersToSeeMonies');
    case 'public': return 'Discover what\'s happening across the federated monyverse.';
    case 'local': return 'Connect with users on your local Harmony instance.';
    default: return 'Be the first to share something!';
  }
});

// Methods
const switchFeed = async (feedType: 'home' | 'public' | 'local') => {
  activityPubStore.switchView(feedType);
  
  // Note: Feed loading is now handled by parent components via route changes
  // This prevents redundant API calls from multiple sources
};

const loadMore = () => {
  // Prevent duplicate loading if already loading
  if (isLoadingAnyFeed.value || isManualLoading.value) {
    debug.log('🚫 Load more ignored - already loading');
    return;
  }

  isManualLoading.value = true;
  
  switch (currentView.value) {
    case 'home': {
      const homeLastPost = activityPubStore.homeFeed.posts[activityPubStore.homeFeed.posts.length - 1];
      debug.log('📄 Loading more home posts after:', homeLastPost?.id);
      activityPubStore.loadHomeFeed(homeLastPost?.id).finally(() => {
        isManualLoading.value = false;
      });
      break;
    }
    case 'public': {
      const publicLastPost = activityPubStore.publicFeed.posts[activityPubStore.publicFeed.posts.length - 1];
      debug.log('📄 Loading more public posts after:', publicLastPost?.id);
      activityPubStore.loadPublicFeed(publicLastPost?.id).finally(() => {
        isManualLoading.value = false;
      });
      break;
    }
    case 'local': {
      const localLastPost = activityPubStore.localFeed.posts[activityPubStore.localFeed.posts.length - 1];
      debug.log('📄 Loading more local posts after:', localLastPost?.id);
      activityPubStore.loadLocalFeed(localLastPost?.id).finally(() => {
        isManualLoading.value = false;
      });
      break;
    }
  }
};

const handleScroll = throttle(() => {
  if (!feedContainer.value) return;
  
  const { scrollTop, scrollHeight, clientHeight } = feedContainer.value;
  const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
  
  const getCurrentFeed = () => {
    switch (currentView.value) {
      case 'home': return activityPubStore.homeFeed;
      case 'public': return activityPubStore.publicFeed;
      case 'local': return activityPubStore.localFeed;
      default: return { has_more: false };
    }
  };
  
  const currentFeed = getCurrentFeed();
  
  if (scrollPercentage > 0.8 && currentFeed.has_more && !isLoadingAnyFeed.value && !isManualLoading.value) {
    loadMore();
  }
}, 100);

// Post interactions using composable for consistency
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions();

const deletePost = async (postId: string) => {
  if (confirm('Are you sure you want to delete this mony?')) {
    await activityPubStore.deletePost(postId);
  }
};

const handleEdit = (postId: string) => {
  const feeds = [activityPubStore.homeFeed, activityPubStore.publicFeed, activityPubStore.localFeed];
  for (const feed of feeds) {
    const post = feed.posts.find(p => p.id === postId);
    if (post) {
      editingPost.value = post;
      return;
    }
  }
};

const handleEdited = (post: any) => {
  debug.log('✅ Post edited:', post.id);
  editingPost.value = null;
};

const openPost = (post: TimelinePost) => {
  (activityPubStore as any).selectedPost = post;
};

const closePost = () => {
  (activityPubStore as any).selectedPost = null;
};

const showConversation = (postId: string) => {
  debug.log(`🎯 MonyFeed showConversation called with ID: ${postId}`);
  debug.log(`🧭 Router available:`, !!router);
  try {
    router.push({ 
      name: 'PostDetail', 
      params: { postId } 
    });
    debug.log(`✅ Navigation to PostDetail attempted`);
  } catch (error) {
    debug.error(`❌ Navigation failed:`, error);
  }
};

const navigateToHashtag = (tag: string) => {
  debug.log(`#️⃣ Navigating to hashtag: #${tag}`);
  router.push({ name: 'HashtagView', params: { tag } });
};

// Composer
const openComposer = () => {
  activityPubStore.openComposer();
};

const closeComposer = () => {
  activityPubStore.closeComposer();
};

const handlePosted = (post: any) => {
  debug.log('✅ Post created from composer:', post.id);
  // The store's realtime subscription will handle adding the post to feeds
};

// Error handling. `clearError`/`initializeRealtime`/`cleanupRealtime`
// reference a store API surface that has drifted from `useActivityPub`; cast
// via `any` so the calls keep type-checking until the contract is reconciled.
const clearError = () => {
  (activityPubStore as any).clearError?.();
};

// Lifecycle — realtime is app-scoped (see SocialLayout / auth); do not tear down on unmount.
onMounted(() => {
  void activityPubStore.ensureRealtimeSubscriptions();
});

// Auto-refresh on focus - only refresh current view if it has data
// DISABLED to prevent conflicts with manual loading
/*
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !activityPubStore.isLoadingFeed) {
    const currentFeed = currentView.value === 'home' ? activityPubStore.homeFeed :
                       currentView.value === 'local' ? activityPubStore.localFeed :
                       activityPubStore.publicFeed;
    
    // Only refresh if feed has data (not empty)
    if (currentFeed.posts.length > 0) {
      switch (currentView.value) {
        case 'home':
          activityPubStore.loadHomeFeed();
          break;
        case 'local':
          activityPubStore.loadLocalFeed();
          break;
        case 'public':
          activityPubStore.loadPublicFeed();
          break;
      }
    }
  }
});
*/
</script>

<style scoped>
.mony-feed {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #111827;
  color: var(--text-primary);
}

.feed-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem;
  border-bottom: 1px solid #374151;
  background-color: #1f2937;
}

.feed-tabs {
  display: flex;
  gap: 0.5rem;
}

.feed-tab {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  border-radius: 0.5rem;
  transition: all 0.2s;
  background-color: #374151;
  color: #d1d5db;
  border: none;
  cursor: pointer;
}

.feed-tab:hover {
  background-color: #4b5563;
  color: var(--text-primary);
}

.feed-tab.active {
  background-color: #2563eb;
  color: var(--text-primary);
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

.tab-badge {
  background-color: #ef4444;
  color: var(--text-primary);
  font-size: 0.75rem;
  border-radius: 9999px;
  padding: 0.25rem 0.5rem;
  min-width: 20px;
  text-align: center;
}

.compose-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1.5rem;
  background-color: #2563eb;
  color: var(--text-primary);
  border-radius: 0.5rem;
  font-weight: 600;
  transition: all 0.2s;
  border: none;
  cursor: pointer;
}

.compose-button:hover {
  background-color: #1d4ed8;
}

.compose-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.feed-content {
  flex: 1;
  overflow-y: auto;
  scroll-behavior: smooth;
}

.feed-loading {
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.posts-container > * + * {
  border-top: 1px solid #374151;
}

.load-more-container {
  padding: 1rem;
  display: flex;
  justify-content: center;
}

.load-more-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background-color: #374151;
  color: #d1d5db;
  border-radius: 0.5rem;
  transition: all 0.2s;
  border: none;
  cursor: pointer;
}

.load-more-button:hover {
  background-color: #4b5563;
  color: var(--text-primary);
}

.load-more-button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.end-of-feed {
  padding: 2rem;
  text-align: center;
  color: #9ca3af;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.5rem;
}

.empty-feed {
  padding: 3rem;
  text-align: center;
  color: #9ca3af;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 1rem;
}

.empty-illustration {
  color: #4b5563;
  margin-bottom: 1rem;
}

.empty-feed h3 {
  font-size: 1.25rem;
  font-weight: 600;
  color: var(--text-primary);
}

.empty-feed p {
  color: #9ca3af;
  max-width: 28rem;
}

.discover-button {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background-color: #2563eb;
  color: var(--text-primary);
  border-radius: 0.5rem;
  font-weight: 600;
  transition: all 0.2s;
  margin-top: 1rem;
  border: none;
  cursor: pointer;
}

.discover-button:hover {
  background-color: #1d4ed8;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Transition animations */
.post-list-enter-active,
.post-list-leave-active {
  transition: all 0.3s ease;
}

.post-list-enter-from {
  opacity: 0;
  transform: translateY(-20px);
}

.post-list-leave-to {
  opacity: 0;
  transform: translateX(20px);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .feed-header {
    flex-direction: column;
    gap: 0.75rem;
  }
  
  .feed-tabs {
    width: 100%;
    justify-content: center;
  }
  
  .feed-tab {
    flex: 1;
    justify-content: center;
  }
  
  .compose-button {
    width: 100%;
    justify-content: center;
  }
}

/* Dark theme adjustments */
:root[data-theme-type="dark"] .mony-feed {
  background-color: var(--background-tertiary);
}

:root[data-theme-type="dark"] .feed-header {
  background-color: var(--background-secondary);
  border-color: var(--border-primary);
}

:root[data-theme-type="dark"] .feed-tab {
  background-color: var(--background-quaternary);
}

:root[data-theme-type="dark"] .feed-tab:hover {
  background-color: var(--background-quinary);
}

:root[data-theme-type="dark"] .load-more-button {
  background-color: var(--background-quaternary);
}

:root[data-theme-type="dark"] .load-more-button:hover {
  background-color: var(--background-quinary);
}
</style>
