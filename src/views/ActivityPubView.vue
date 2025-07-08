<!-- ActivityPub Main View - The Monyverse -->
<!-- Professional federated social media interface -->
<template>
  <div class="monyverse-layout">
    <!-- Header Navigation -->
    <div class="monyverse-header">
      <div class="header-content">
        <div class="brand-section">
          <router-link to="/monyverse" class="brand-link">
            <img src="/harmony_text3.png" alt="Harmony" class="brand-logo" />
            <span class="monyverse-label">Monyverse</span>
          </router-link>
        </div>

        <!-- Timeline Navigation -->
        <nav class="timeline-nav">
          <button
            v-for="tab in timelineTabs"
            :key="tab.id"
            @click="switchTimeline(tab.id)"
            :class="['timeline-tab', { active: currentTimeline === tab.id }]"
          >
            <Icon :name="tab.icon" />
            <span>{{ tab.label }}</span>
          </button>
        </nav>

        <!-- User Actions -->
        <div class="user-actions">
          <button
            @click="openSearch"
            class="action-btn search-btn"
            title="Search users and posts"
          >
            <Icon name="search" />
          </button>
          
          <button
            @click="openComposer"
            class="action-btn compose-btn"
            title="Create a new Mony"
          >
            <Icon name="edit" />
            <span class="hidden md:inline">Mony</span>
          </button>

          <router-link to="/settings" class="action-btn settings-btn" title="Settings">
            <Icon name="settings" />
          </router-link>
        </div>
      </div>
    </div>

    <!-- Main Content Area -->
    <div class="monyverse-main">
      <!-- Left Sidebar - Navigation & User Info -->
      <aside class="left-sidebar">
        <div class="user-profile-card">
          <img 
            :src="currentUser?.avatar_url || '/default_avatar.png'" 
            :alt="currentUser?.display_name"
            class="user-avatar"
          />
          <div class="user-info">
            <h3 class="user-name">{{ currentUser?.display_name || currentUser?.username }}</h3>
            <p class="user-handle">{{ currentUserHandle }}</p>
          </div>
        </div>

        <!-- Navigation Links -->
        <nav class="sidebar-nav">
          <router-link 
            v-for="navItem in navigationItems"
            :key="navItem.id"
            :to="navItem.path"
            :class="['nav-item', { active: $route.path === navItem.path }]"
          >
            <Icon :name="navItem.icon" />
            <span>{{ navItem.label }}</span>
          </router-link>
        </nav>

        <!-- Quick Stats -->
        <div class="quick-stats">
          <div class="stat-item">
            <span class="stat-value">{{ followingCount }}</span>
            <span class="stat-label">Following</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ followersCount }}</span>
            <span class="stat-label">Followers</span>
          </div>
        </div>

        <!-- Back to Chat -->
        <router-link to="/chat" class="back-to-chat-btn">
          <Icon name="message-circle" />
          <span>Back to Chat</span>
        </router-link>
      </aside>

      <!-- Center Content - Timeline -->
      <main class="timeline-content">
        <!-- Timeline Header -->
        <div class="timeline-header">
          <h2 class="timeline-title">{{ currentTimelineTitle }}</h2>
          <button
            v-if="currentTimeline === 'home'"
            @click="refreshTimeline"
            :disabled="isLoadingFeed"
            class="refresh-btn"
            title="Refresh timeline"
          >
            <Icon name="refresh-cw" :class="{ spinning: isLoadingFeed }" />
          </button>
        </div>

        <!-- New Post Composer (Inline) -->
        <div v-if="currentTimeline === 'home'" class="inline-composer">
          <MonyComposerInline @post-created="handlePostCreated" />
        </div>

        <!-- Timeline Feed -->
        <div class="timeline-feed">
          <!-- Loading State -->
          <div v-if="isLoadingFeed && posts.length === 0" class="loading-state">
            <div class="loading-spinner"></div>
            <p>Loading the Monyverse...</p>
          </div>

          <!-- Empty State -->
          <div v-else-if="!isLoadingFeed && posts.length === 0" class="empty-state">
            <Icon name="users" size="48" />
            <h3>Welcome to the Monyverse!</h3>
            <p>{{ getEmptyStateMessage() }}</p>
            <button v-if="currentTimeline === 'home'" @click="switchTimeline('public')" class="explore-btn">
              Explore Public Timeline
            </button>
          </div>

          <!-- Posts -->
          <div v-else class="posts-container">
            <MonyPost
              v-for="post in posts"
              :key="post.id"
              :post="post"
              @reply="replyToPost"
              @favorite="handleFavorite"
              @reblog="handleReblog"
              @delete="handleDeletePost"
              @user-click="showUserProfile"
            />

            <!-- Load More -->
            <div v-if="hasMorePosts" class="load-more-container">
              <button
                @click="loadMorePosts"
                :disabled="isLoadingFeed"
                class="load-more-btn"
              >
                <Icon v-if="isLoadingFeed" name="loader" class="spinning" />
                <span>{{ isLoadingFeed ? 'Loading...' : 'Load More' }}</span>
              </button>
            </div>
          </div>
        </div>
      </main>

      <!-- Right Sidebar - Trending & Suggestions -->
      <aside class="right-sidebar">
        <!-- Trending Section -->
        <div class="sidebar-section">
          <h3 class="section-title">Trending in the Monyverse</h3>
          <div class="trending-list">
            <div 
              v-for="trend in trendingTopics"
              :key="trend.tag"
              class="trending-item"
            >
              <span class="trending-tag">#{{ trend.tag }}</span>
              <span class="trending-count">{{ formatNumber(trend.count) }} monies</span>
            </div>
          </div>
        </div>

        <!-- Suggested Users -->
        <div class="sidebar-section">
          <h3 class="section-title">Suggested Follows</h3>
          <div class="suggested-users">
            <UserCard
              v-for="user in suggestedUsers"
              :key="user.id"
              :user="user"
              :show-follow-btn="true"
              @follow="handleFollow"
              @unfollow="handleUnfollow"
            />
          </div>
        </div>

        <!-- Instance Info -->
        <div class="sidebar-section">
          <h3 class="section-title">Instance Info</h3>
          <div class="instance-info">
            <p class="instance-domain">{{ instanceDomain }}</p>
            <p class="instance-users">{{ instanceUserCount }} users</p>
            <p class="instance-posts">{{ instancePostCount }} monies</p>
          </div>
        </div>
      </aside>
    </div>

    <!-- Modals and Overlays -->
    <MonyComposer
      :is-open="activityPubStore.isComposerOpen"
      :composer-state="activityPubStore.composerState"
      :is-posting="activityPubStore.isPosting"
      @close="activityPubStore.closeComposer"
      @submit="handleComposerSubmit"
      @update-content="updateComposerContent"
      @update-visibility="updateComposerVisibility"
    />

    <UserSearchModal
      v-if="showSearchModal"
      @close="closeSearch"
      @user-selected="showUserProfile"
    />

    <UserProfileModal
      v-if="selectedUser"
      :user="selectedUser"
      @close="closeUserProfile"
      @follow="handleFollow"
      @unfollow="handleUnfollow"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/activitypub';
import { useAuthStore } from '@/stores/auth';
import { useProfileStore } from '@/stores/useProfile';
import type { TimelinePost, FederatedUser, Post } from '@/types';

// Components
import MonyComposer from '@/components/activitypub/MonyComposer.vue';
import MonyComposerInline from '@/components/activitypub/MonyComposerInline.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import UserCard from '@/components/activitypub/UserCard.vue';
import UserSearchModal from '@/components/activitypub/UserSearchModal.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface Props {
  timeline?: 'home' | 'public' | 'local';
}

const props = withDefaults(defineProps<Props>(), {
  timeline: 'home'
});

// Stores
const activityPubStore = useActivityPubStore();
const authStore = useAuthStore();
const profileStore = useProfileStore();
const route = useRoute();
const router = useRouter();

// State
const currentTimeline = ref<'home' | 'public' | 'local'>(props.timeline);
const showSearchModal = ref(false);
const selectedUser = ref<FederatedUser | null>(null);
const followingCount = ref(0);
const followersCount = ref(0);
const trendingTopics = ref([
  { tag: 'monyverse', count: 1234 },
  { tag: 'harmony', count: 567 },
  { tag: 'federation', count: 234 }
]);
const suggestedUsers = ref<FederatedUser[]>([]);
const instanceUserCount = ref(0);
const instancePostCount = ref(0);

// Configuration
const timelineTabs = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'local', label: 'Local', icon: 'users' },
  { id: 'public', label: 'Federated', icon: 'globe' }
];

const navigationItems = [
  { id: 'profile', label: 'Profile', path: '/u/' + authStore.session?.user?.id, icon: 'user' },
  { id: 'notifications', label: 'Notifications', path: '/monyverse/notifications', icon: 'bell' },
  { id: 'bookmarks', label: 'Bookmarks', path: '/monyverse/bookmarks', icon: 'bookmark' },
  { id: 'lists', label: 'Lists', path: '/monyverse/lists', icon: 'list' },
  { id: 'settings', label: 'Settings', path: '/settings', icon: 'settings' }
];

// Computed
const currentUser = computed(() => profileStore.profile);
const instanceDomain = computed(() => 'harmony.com'); // TODO: Get from config

const currentUserHandle = computed(() => {
  if (!currentUser.value) return '';
  const domain = currentUser.value.domain || 'harmony.com';
  return domain === 'harmony.com' 
    ? `@${currentUser.value.username}`
    : `@${currentUser.value.username}@${domain}`;
});

const currentTimelineTitle = computed(() => {
  const tab = timelineTabs.find(t => t.id === currentTimeline.value);
  return tab ? tab.label : 'Timeline';
});

const posts = computed(() => activityPubStore.getTimelinePosts(currentTimeline.value));
const isLoadingFeed = computed(() => activityPubStore.isLoadingFeed);
const hasMorePosts = computed(() => {
  switch (currentTimeline.value) {
    case 'home':
      return activityPubStore.homeFeed.has_more;
    case 'public':
      return activityPubStore.publicFeed.has_more;
    case 'local':
      return activityPubStore.localFeed.has_more;
    default:
      return false;
  }
});

// Methods
const switchTimeline = async (timeline: 'home' | 'public' | 'local') => {
  currentTimeline.value = timeline;
  await router.push(`/monyverse/${timeline}`);
  await loadTimeline();
};

const loadTimeline = async () => {
  switch (currentTimeline.value) {
    case 'home':
      await activityPubStore.loadHomeFeed();
      break;
    case 'public':
      await activityPubStore.loadPublicFeed();
      break;
    case 'local':
      // TODO: Implement local timeline
      break;
  }
};

const loadMorePosts = async () => {
  const currentFeed = posts.value;
  const lastPost = currentFeed[currentFeed.length - 1];
  
  switch (currentTimeline.value) {
    case 'home':
      await activityPubStore.loadHomeFeed(lastPost?.id);
      break;
    case 'public':
      await activityPubStore.loadPublicFeed(lastPost?.id);
      break;
    case 'local':
      // TODO: Implement local timeline pagination
      break;
  }
};

const refreshTimeline = async () => {
  await loadTimeline();
};

const openComposer = () => {
  activityPubStore.openComposer();
};

const handleComposerSubmit = async () => {
  try {
    await activityPubStore.createPost({
      content: activityPubStore.composerState.content,
      visibility: activityPubStore.composerState.visibility,
      content_warning: activityPubStore.composerState.content_warning,
      in_reply_to: activityPubStore.composerState.in_reply_to,
      media_attachments: activityPubStore.composerState.media_attachments,
      is_sensitive: activityPubStore.composerState.is_sensitive
    });
  } catch (error) {
    console.error('Failed to create post:', error);
  }
};

const updateComposerContent = (content: string) => {
  activityPubStore.updateComposer({ content });
};

const updateComposerVisibility = (visibility: Post['visibility']) => {
  activityPubStore.updateComposer({ visibility });
};

const handlePostCreated = (post: TimelinePost) => {
  // Post is automatically added by the store
  console.log('New post created:', post.id);
};

const replyToPost = (post: TimelinePost) => {
  activityPubStore.openComposer({
    in_reply_to: post.id,
    content: `@${post.author.handle} `
  });
};

const handleFavorite = async (postId: string) => {
  try {
    await activityPubStore.toggleFavorite(postId);
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const handleReblog = async (postId: string) => {
  // TODO: Implement reblog functionality
  console.log('Reblog post:', postId);
};

const handleDeletePost = async (postId: string) => {
  // TODO: Implement delete functionality
  console.log('Delete post:', postId);
};

const handleFollow = async (userId: string) => {
  try {
    await activityPubStore.followUser(userId);
    // Update local counts
    followingCount.value++;
  } catch (error) {
    console.error('Failed to follow user:', error);
  }
};

const handleUnfollow = async (userId: string) => {
  try {
    await activityPubStore.unfollowUser(userId);
    // Update local counts
    followingCount.value--;
  } catch (error) {
    console.error('Failed to unfollow user:', error);
  }
};

const showUserProfile = (user: FederatedUser) => {
  selectedUser.value = user;
};

const closeUserProfile = () => {
  selectedUser.value = null;
};

const openSearch = () => {
  showSearchModal.value = true;
};

const closeSearch = () => {
  showSearchModal.value = false;
};

const getEmptyStateMessage = () => {
  switch (currentTimeline.value) {
    case 'home':
      return 'Follow some users to see their monies in your timeline.';
    case 'public':
      return 'No public monies yet. Be the first to share something!';
    case 'local':
      return 'No local monies yet from this instance.';
    default:
      return 'No monies found.';
  }
};

const formatNumber = (num: number): string => {
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toString();
};

// Watch route changes
watch(() => route.params.timeline, (newTimeline) => {
  if (newTimeline && typeof newTimeline === 'string') {
    const validTimelines = ['home', 'public', 'local'];
    if (validTimelines.includes(newTimeline)) {
      currentTimeline.value = newTimeline as 'home' | 'public' | 'local';
      loadTimeline();
    }
  }
}, { immediate: true });

// Lifecycle
onMounted(async () => {
  await activityPubStore.initialize();
  await loadTimeline();
  
  // Subscribe to real-time updates
  activityPubStore.subscribeToRealtimeUpdates();
  
  // Load user stats and suggestions
  // TODO: Implement these API calls
});
</script>

<style scoped>
.monyverse-layout {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--h-chat, #313338);
  color: white;
}

/* Header */
.monyverse-header {
  background: var(--h-sidebar, #2b2d31);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  padding: 0 1rem;
  height: 64px;
  flex-shrink: 0;
}

.header-content {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 100%;
  max-width: 1200px;
  margin: 0 auto;
}

.brand-section {
  display: flex;
  align-items: center;
}

.brand-link {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
  color: white;
  font-weight: 600;
}

.brand-logo {
  height: 32px;
  width: auto;
}

.monyverse-label {
  font-size: 1.1rem;
  background: linear-gradient(135deg, #5865f2, #7289da);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.timeline-nav {
  display: flex;
  gap: 0.5rem;
}

.timeline-tab {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: none;
  border: none;
  color: #b9bbbe;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
}

.timeline-tab:hover {
  background: rgba(255, 255, 255, 0.08);
  color: white;
}

.timeline-tab.active {
  background: var(--h-brand, #5865f2);
  color: white;
}

.user-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.5rem 1rem;
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
  text-decoration: none;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  border-color: rgba(255, 255, 255, 0.3);
}

.compose-btn {
  background: var(--h-brand, #5865f2);
  border-color: var(--h-brand, #5865f2);
}

.compose-btn:hover {
  background: var(--h-brand-hover, #4752c4);
}

/* Main Content */
.monyverse-main {
  flex: 1;
  display: grid;
  grid-template-columns: 280px 1fr 320px;
  gap: 1rem;
  padding: 1rem;
  max-width: 1200px;
  margin: 0 auto;
  width: 100%;
  overflow: hidden;
}

/* Left Sidebar */
.left-sidebar {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 0.75rem;
  padding: 1.5rem;
  height: fit-content;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.user-profile-card {
  display: flex;
  align-items: center;
  gap: 1rem;
  margin-bottom: 2rem;
}

.user-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  object-fit: cover;
}

.user-info h3 {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
}

.user-handle {
  margin: 0;
  color: #b9bbbe;
  font-size: 0.875rem;
}

.sidebar-nav {
  margin-bottom: 2rem;
}

.nav-item {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.75rem;
  color: #b9bbbe;
  text-decoration: none;
  border-radius: 0.5rem;
  margin-bottom: 0.25rem;
  transition: all 0.2s;
}

.nav-item:hover,
.nav-item.active {
  background: rgba(255, 255, 255, 0.08);
  color: white;
}

.quick-stats {
  display: flex;
  gap: 1rem;
  margin-bottom: 2rem;
}

.stat-item {
  text-align: center;
}

.stat-value {
  display: block;
  font-size: 1.25rem;
  font-weight: 600;
  color: white;
}

.stat-label {
  display: block;
  font-size: 0.75rem;
  color: #b9bbbe;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.back-to-chat-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem;
  background: rgba(88, 101, 242, 0.1);
  border: 1px solid var(--h-brand, #5865f2);
  color: var(--h-brand, #5865f2);
  border-radius: 0.5rem;
  text-decoration: none;
  transition: all 0.2s;
}

.back-to-chat-btn:hover {
  background: var(--h-brand, #5865f2);
  color: white;
}

/* Timeline Content */
.timeline-content {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 0.75rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
  height: fit-content;
  max-height: calc(100vh - 128px);
  overflow-y: auto;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  position: sticky;
  top: 0;
  background: var(--h-sidebar, #2b2d31);
  z-index: 10;
}

.timeline-title {
  margin: 0;
  font-size: 1.25rem;
  font-weight: 600;
}

.refresh-btn {
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 0.5rem;
  border-radius: 0.25rem;
  transition: all 0.2s;
}

.refresh-btn:hover {
  color: white;
  background: rgba(255, 255, 255, 0.08);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.inline-composer {
  padding: 1.5rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.timeline-feed {
  padding: 1rem 0;
}

.loading-state,
.empty-state {
  text-align: center;
  padding: 3rem 1.5rem;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.1);
  border-top: 3px solid var(--h-brand, #5865f2);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 1rem;
}

.empty-state h3 {
  margin: 1rem 0 0.5rem;
  color: white;
}

.empty-state p {
  color: #b9bbbe;
  margin-bottom: 1.5rem;
}

.explore-btn {
  background: var(--h-brand, #5865f2);
  color: white;
  border: none;
  padding: 0.75rem 1.5rem;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
}

.explore-btn:hover {
  background: var(--h-brand-hover, #4752c4);
}

.posts-container {
  padding: 0 1.5rem;
}

.load-more-container {
  text-align: center;
  padding: 2rem 0;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1.5rem;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: white;
  border-radius: 0.5rem;
  cursor: pointer;
  transition: all 0.2s;
  margin: 0 auto;
}

.load-more-btn:hover {
  background: rgba(255, 255, 255, 0.12);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Right Sidebar */
.right-sidebar {
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.sidebar-section {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 0.75rem;
  padding: 1.5rem;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.section-title {
  margin: 0 0 1rem;
  font-size: 1rem;
  font-weight: 600;
  color: white;
}

.trending-item {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.75rem 0;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
}

.trending-item:last-child {
  border-bottom: none;
}

.trending-tag {
  color: var(--h-brand, #5865f2);
  font-weight: 500;
}

.trending-count {
  color: #b9bbbe;
  font-size: 0.875rem;
}

.instance-info p {
  margin: 0.5rem 0;
  color: #b9bbbe;
  font-size: 0.875rem;
}

.instance-domain {
  color: white !important;
  font-weight: 500;
}

/* Animations */
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.spinning {
  animation: spin 1s linear infinite;
}

/* Responsive Design */
@media (max-width: 1024px) {
  .monyverse-main {
    grid-template-columns: 1fr;
    gap: 0;
  }
  
  .left-sidebar,
  .right-sidebar {
    display: none;
  }
  
  .timeline-content {
    border-radius: 0;
    border-left: none;
    border-right: none;
    max-height: calc(100vh - 64px);
  }
}

@media (max-width: 768px) {
  .monyverse-header {
    padding: 0 0.5rem;
  }
  
  .header-content {
    gap: 1rem;
  }
  
  .timeline-nav .timeline-tab span {
    display: none;
  }
  
  .user-actions .action-btn span {
    display: none;
  }
  
  .monyverse-main {
    padding: 0;
  }
}
</style>
