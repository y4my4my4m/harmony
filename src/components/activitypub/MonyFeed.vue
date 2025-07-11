<!-- ActivityPub Feed Component - The heart of the Monyverse -->
<template>
  <div class="mony-feed">
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
        @click="openComposer"
        :disabled="isPosting"
      >
        <Icon name="edit" />
        <span>Mony</span>
      </button>
    </div>

    <!-- Feed Content -->
    <div class="feed-content" ref="feedContainer" @scroll="handleScroll">
      <!-- Loading Skeleton -->
      <div v-if="isLoadingAnyFeed && currentView.posts.length === 0" class="feed-loading">
        <PostSkeleton v-for="i in 3" :key="i" />
      </div>

      <!-- Posts -->
      <div v-else class="posts-container">
        <TransitionGroup name="post-list" tag="div">
          <MonyPost
            v-for="post in currentView.posts"
            :key="post.id"
            :post="post"
            @favorite="toggleFavorite"
            @reblog="toggleReblog"
            @bookmark="toggleBookmark"
            @reply="replyToPost"
            @delete="deletePost"
            @click="openPost"
            @show-conversation="showConversation"
          />
        </TransitionGroup>

        <!-- Load More Button -->
        <div v-if="currentView.has_more" class="load-more-container">
          <button 
            class="load-more-button"
            @click="loadMore"
            :disabled="isLoadingAnyFeed"
          >
            <Icon v-if="isLoadingAnyFeed" name="spinner" class="spinning" />
            <Icon v-else name="arrow-down" />
            <span>{{ isLoadingAnyFeed ? 'Loading...' : 'Load More Monies' }}</span>
          </button>
        </div>

        <!-- End of Feed -->
        <div v-else-if="currentView.posts.length > 0" class="end-of-feed">
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
    <MonyComposer
      v-if="isComposerOpen"
      :is-open="isComposerOpen"
      :composer-state="composerState"
      :is-posting="isPosting"
      @close="closeComposer"
      @submit="createPost"
      @update-content="updateComposerContent"
      @update-visibility="updateComposerVisibility"
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
import { storeToRefs } from 'pinia';
import { useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import type { Post, TimelinePost } from '@/types';

// Components (to be created)
import MonyPost from './MonyPost.vue';
import MonyComposer from './MonyComposer.vue';
import Icon from '@/components/common/Icon.vue';

// Store
const activityPubStore = useActivityPubStore();
const router = useRouter();

// Refs
const feedContainer = ref<HTMLElement>();

// Computed properties
const {
  currentView,
  isLoadingAnyFeed,
  isComposerOpen,
  composerState,
  isPosting,
  selectedPost,
  lastError
} = storeToRefs(activityPubStore);

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

const emptyStateTitle = computed(() => {
  switch (currentView.value) {
    case 'home': return 'Welcome to your Mony feed!';
    case 'public': return 'The Monyverse awaits!';
    case 'local': return 'Local community hub';
    default: return 'No monies here yet';
  }
});

const emptyStateMessage = computed(() => {
  switch (currentView.value) {
    case 'home': return 'Follow some users to see their monies in your timeline, or create your first mony!';
    case 'public': return 'Discover what\'s happening across the federated monyverse.';
    case 'local': return 'Connect with users on your local Harmony instance.';
    default: return 'Be the first to share something!';
  }
});

// Methods
const switchFeed = async (feedType: 'home' | 'public' | 'local') => {
  activityPubStore.switchView(feedType);
  
  // Load feed if not already loaded
  switch (feedType) {
    case 'home':
      if (activityPubStore.homeFeed.posts.length === 0) {
        await activityPubStore.loadHomeFeed();
      }
      break;
    case 'public':
      if (activityPubStore.publicFeed.posts.length === 0) {
        await activityPubStore.loadPublicFeed();
      }
      break;
    case 'local':
      if (activityPubStore.localFeed.posts.length === 0) {
        await activityPubStore.loadLocalFeed();
      }
      break;
  }
};

const loadMore = () => {
  switch (currentView.value) {
    case 'home': {
      const homeLastPost = activityPubStore.homeFeed.posts[activityPubStore.homeFeed.posts.length - 1];
      activityPubStore.loadHomeFeed(homeLastPost?.id);
      break;
    }
    case 'public': {
      const publicLastPost = activityPubStore.publicFeed.posts[activityPubStore.publicFeed.posts.length - 1];
      activityPubStore.loadPublicFeed(publicLastPost?.id);
      break;
    }
    case 'local': {
      const localLastPost = activityPubStore.localFeed.posts[activityPubStore.localFeed.posts.length - 1];
      activityPubStore.loadLocalFeed(localLastPost?.id);
      break;
    }
  }
};

const handleScroll = () => {
  if (!feedContainer.value) return;
  
  const { scrollTop, scrollHeight, clientHeight } = feedContainer.value;
  const scrollPercentage = (scrollTop + clientHeight) / scrollHeight;
  
  // Auto-load when 80% scrolled
  if (scrollPercentage > 0.8 && currentView.value.has_more && !isLoadingAnyFeed.value) {
    loadMore();
  }
};

// Post interactions
const toggleFavorite = (postId: string) => {
  activityPubStore.toggleFavorite(postId);
};

const toggleReblog = (postId: string) => {
  activityPubStore.toggleReblog(postId);
};

const toggleBookmark = (postId: string) => {
  activityPubStore.toggleBookmark(postId);
};

const replyToPost = (post: TimelinePost) => {
  activityPubStore.openComposer(post.id);
};

const deletePost = async (postId: string) => {
  if (confirm('Are you sure you want to delete this mony?')) {
    await activityPubStore.deletePost(postId);
  }
};

const openPost = (post: TimelinePost) => {
  activityPubStore.selectedPost = post;
};

const closePost = () => {
  activityPubStore.selectedPost = null;
};

const showConversation = (postId: string) => {
  console.log(`🎯 MonyFeed showConversation called with ID: ${postId}`);
  console.log(`🧭 Router available:`, !!router);
  try {
    router.push({ 
      name: 'PostDetail', 
      params: { postId } 
    });
    console.log(`✅ Navigation to PostDetail attempted`);
  } catch (error) {
    console.error(`❌ Navigation failed:`, error);
  }
};

// Composer
const openComposer = () => {
  activityPubStore.openComposer();
};

const closeComposer = () => {
  activityPubStore.closeComposer();
};

const createPost = () => {
  activityPubStore.createPost();
};

const updateComposerContent = (content: string) => {
  activityPubStore.updateComposerContent(content);
};

const updateComposerVisibility = (visibility: Post['visibility']) => {
  activityPubStore.updateComposerVisibility(visibility);
};

// Error handling
const clearError = () => {
  activityPubStore.clearError();
};

// Lifecycle
onMounted(async () => {
  // Initialize real-time subscriptions
  await activityPubStore.initializeRealtime();
  
  // Load initial home feed
  await activityPubStore.loadHomeFeed();
});

onUnmounted(() => {
  // Cleanup real-time subscriptions
  activityPubStore.cleanupRealtime();
});

// Auto-refresh on focus
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && currentView.value === 'home') {
    activityPubStore.loadHomeFeed();
  }
});
</script>

<style scoped>
.mony-feed {
  display: flex;
  flex-direction: column;
  height: 100%;
  background-color: #111827;
  color: white;
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
  color: white;
}

.feed-tab.active {
  background-color: #2563eb;
  color: white;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
}

.tab-badge {
  background-color: #ef4444;
  color: white;
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
  color: white;
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

.posts-container {
  border-top: 1px solid #374151;
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
  color: white;
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
  color: white;
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
  color: white;
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
.dark .mony-feed {
  background-color: #030712;
}

.dark .feed-header {
  background-color: #111827;
  border-color: #1f2937;
}

.dark .feed-tab {
  background-color: #1f2937;
}

.dark .feed-tab:hover {
  background-color: #374151;
}

.dark .load-more-button {
  background-color: #1f2937;
}

.dark .load-more-button:hover {
  background-color: #374151;
}
</style>
