<template>
  <div class="unified-content-area">
    <!-- Chat Mode Content -->
    <div v-if="mode === 'chat'" class="content-section chat-content">
      <ChatComponent
        :messages="chatMessages"
        :isLoading="isLoading"
        :isDM="isDM"
        @loadMoreMessages="$emit('load-more-messages')" 
        @update:isAtBottom="$emit('update:is-at-bottom', $event)" 
        @sendMessage="$emit('send-message', $event)"
      />
    </div>
    
    <!-- ActivityPub Mode Content -->
    <div v-else-if="mode === 'activitypub'" class="content-section activitypub-content">
      <!-- Profile View -->
      <ProfileDisplay 
        v-if="viewType === 'profile'"
        :user="profileUser"
        :posts="[]"
        :loading="false"
        @follow="$emit('follow-user', $event)"
        @unfollow="$emit('unfollow-user', $event)"
        @reply-to-post="$emit('reply-to-post', $event)"
        @favorite-post="$emit('favorite-post', $event)"
        @reblog-post="$emit('reblog-post', $event)"
        @delete-post="$emit('delete-post', $event)"
        @show-user-profile="$emit('show-user-profile', $event)"
        @load-more-posts="$emit('load-more-posts')"
      />
      
      <!-- Post Detail View -->
      <div v-else-if="viewType === 'post'" class="post-detail-content">
        <PostDetailDisplay
          :post-id="postId || ''"
          @reply="$emit('reply-to-post', $event)"
          @favorite="$emit('favorite-post', $event)"
          @reblog="$emit('reblog-post', $event)"
          @bookmark="$emit('bookmark-post', $event)"
          @delete="$emit('delete-post', $event)"
          @user-click="$emit('show-user-profile', $event)"
          @back="$emit('back-to-timeline')"
        />
      </div>
      
      <!-- Explore View -->
      <div v-else-if="viewType === 'explore'" class="explore-view-content">
        <ExploreContent
          :current-explore-tab="currentExploreTab"
          @switch-feed="$emit('switch-feed', $event)"
          @refresh-timeline="$emit('refresh-timeline')"
          @show-user-profile="$emit('show-user-profile', $event)"
          @follow-user="$emit('follow-user', $event)"
          @unfollow-user="$emit('unfollow-user', $event)"
          @reply-to-post="$emit('reply-to-post', $event)"
          @favorite-post="$emit('favorite-post', $event)"
          @reblog-post="$emit('reblog-post', $event)"
          @bookmark-post="$emit('bookmark-post', $event)"
          @delete-post="$emit('delete-post', $event)"
        />
      </div>
      
      <!-- Special Views (Bookmarks, Lists, etc.) -->
      <div v-else-if="viewType !== 'timeline'" class="special-view-content">
        <div class="special-view-header">
          <div class="header-content">
            <h1 class="page-title">
              <Icon :name="getViewIcon(viewType)" />
              {{ getViewTitle(viewType) }}
            </h1>
            <p class="page-subtitle">{{ getViewSubtitle(viewType) }}</p>
          </div>
          
          <!-- Clear All Button (for bookmarks) -->
          <button 
            v-if="viewType === 'bookmarks' && specialViewData && specialViewData.length > 0"
            @click="$emit('clear-all-bookmarks')"
            class="clear-all-btn"
          >
            <Icon name="trash" />
            Clear All
          </button>
        </div>

        <div class="timeline-feed">
          <!-- Loading State -->
          <div v-if="isLoadingFeed && (!specialViewData || specialViewData.length === 0)" class="loading-state">
            <div class="loading-spinner"></div>
            <p>Loading your {{ viewType }}...</p>
          </div>

          <!-- Empty State -->
          <div v-else-if="!isLoadingFeed && (!specialViewData || specialViewData.length === 0)" class="empty-state">
            <Icon :name="getViewIcon(viewType)" :size="48" />
            <h3>{{ getEmptyStateTitle(viewType) }}</h3>
            <p>{{ getSpecialViewEmptyMessage(viewType) }}</p>
            <button 
              v-if="viewType === 'bookmarks'"
              @click="$emit('switch-feed', 'home')" 
              class="explore-btn"
            >
              Browse Timeline
            </button>
          </div>

          <!-- Posts -->
          <div v-else class="posts-container">
            <MonyPost
              v-for="post in specialViewData"
              :key="post.id"
              :post="post"
              @reply="$emit('reply-to-post', $event)"
              @favorite="$emit('favorite-post', $event)"
              @reblog="$emit('reblog-post', $event)"
              @bookmark="$emit('bookmark-post', $event)"
              @delete="$emit('delete-post', $event)"
              @user-click="$emit('show-user-profile', $event)"
            />

            <!-- Load More -->
            <div v-if="hasMoreSpecialData" class="load-more-container">
              <button
                @click="$emit('load-more-special-data')"
                :disabled="isLoadingFeed"
                class="load-more-btn"
              >
                <Icon v-if="isLoadingFeed" name="loader" class="spinning" />
                <span>{{ isLoadingFeed ? 'Loading...' : 'Load More' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
      
      <!-- Timeline View -->
      <div v-else class="mony-content">
        <!-- New Post Composer (Inline) -->
        <div v-if="currentFeed === 'home'" class="inline-composer">
          <MonyComposerInline @post-created="$emit('post-created', $event)" />
        </div>



        <!-- Timeline Feed -->
        <div class="timeline-feed">
          <!-- Loading State -->
          <div v-if="isLoadingFeed && posts.length === 0" class="loading-state">
            <div class="loading-spinner"></div>
            <p>Loading the timeline...</p>
          </div>

          <!-- Empty State -->
          <div v-else-if="!isLoadingFeed && posts.length === 0" class="empty-state">
            <Icon name="users" :size="48" />
            <h3>Welcome to Social!</h3>
            <p>{{ getEmptyStateMessage() }}</p>
            <button 
              v-if="currentFeed === 'home'" 
              @click="$emit('switch-feed', 'public')" 
              class="explore-btn"
            >
              Explore Public Timeline
            </button>
          </div>

          <!-- Posts -->
          <div v-else class="posts-container">
            <MonyPost
              v-for="post in posts"
              :key="post.id"
              :post="post"
              @reply="$emit('reply-to-post', $event)"
              @favorite="$emit('favorite-post', $event)"
              @reblog="$emit('reblog-post', $event)"
              @delete="$emit('delete-post', $event)"
              @user-click="$emit('show-user-profile', $event)"
            />

            <!-- Load More -->
            <div v-if="hasMorePosts" class="load-more-container">
              <button
                @click="$emit('load-more-posts')"
                :disabled="isLoadingFeed"
                class="load-more-btn"
              >
                <Icon v-if="isLoadingFeed" name="loader" class="spinning" />
                <span>{{ isLoadingFeed ? 'Loading...' : 'Load More' }}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ChatComponent from '@/components/ChatComponent.vue';
import MonyComposerInline from '@/components/activitypub/MonyComposerInline.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import ExploreContent from '@/components/activitypub/ExploreContent.vue';
import ProfileDisplay from './ProfileDisplay.vue';
import PostDetailDisplay from './PostDetailDisplay.vue';
import Icon from '@/components/common/Icon.vue';
import type { Message, TimelinePost, FederatedUser } from '@/types';
import { ref } from 'vue';
import { useActivityPubStore } from '@/stores/useActivityPub';
import activityPubService from '@/services/activityPubService';

interface Props {
  mode: 'chat' | 'activitypub';
  
  // Chat mode props
  chatMessages?: Message[];
  isLoading?: boolean;
  isDM?: boolean;
  
  // ActivityPub mode props
  viewType?: 'timeline' | 'profile' | 'bookmarks' | 'lists' | 'notifications' | 'post' | 'explore';
  currentFeed?: 'home' | 'local' | 'public';
  currentExploreTab?: 'trending' | 'instances';
  posts?: TimelinePost[];
  isLoadingFeed?: boolean;
  hasMorePosts?: boolean;
  
  // Special view props (profile, bookmarks, etc.)
  profileUser?: FederatedUser | null;
  profileHandle?: string;
  specialViewData?: TimelinePost[]; // Generic data for bookmarks, lists, etc.
  hasMoreSpecialData?: boolean;
  
  // Post detail props
  postId?: string;
}

const props = withDefaults(defineProps<Props>(), {
  chatMessages: () => [],
  isLoading: false,
  isDM: false,
  viewType: 'timeline',
  currentFeed: 'home',
  currentExploreTab: 'trending',
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false,
  profileUser: null,
  profileHandle: undefined,
  specialViewData: () => [],
  hasMoreSpecialData: false
});

defineEmits<{
  // Chat mode events
  'load-more-messages': [];
  'update:is-at-bottom': [value: boolean];
  'send-message': [message: any];
  
  // ActivityPub mode events
  'refresh-timeline': [];
  'post-created': [post: TimelinePost];
  'switch-feed': [feedType: 'home' | 'local' | 'public'];
  'reply-to-post': [post: TimelinePost];
  'favorite-post': [postId: string];
  'reblog-post': [postId: string];
  'bookmark-post': [postId: string];
  'delete-post': [postId: string];
  'show-user-profile': [user: any];
  'load-more-posts': [];
  
  // Profile mode events
  'follow-user': [userId: string];
  'unfollow-user': [userId: string];
  
  // Special view events
  'clear-all-bookmarks': [];
  'load-more-special-data': [];
  
  // Post detail events
  'back-to-timeline': [];
}>();

const feedTabs = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'local', label: 'Local', icon: 'users' },
  { id: 'public', label: 'Federated', icon: 'globe' }
];

const currentTimelineTitle = computed(() => {
  const tab = feedTabs.find(t => t.id === props.currentFeed);
  return tab ? `${tab.label} Timeline` : 'Timeline';
});

const getEmptyStateMessage = () => {
  switch (props.currentFeed) {
    case 'home':
      return 'Follow some users to see their posts in your timeline.';
    case 'public':
      return 'No public posts yet. Be the first to share something!';
    case 'local':
      return 'No local posts yet from this instance.';
    default:
      return 'No posts found.';
  }
};

// Helper functions for special views
const getViewIcon = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'compass';
    case 'bookmarks':
      return 'bookmark';
    case 'lists':
      return 'list';
    case 'notifications':
      return 'bell';
    case 'profile':
      return 'user';
    default:
      return 'home';
  }
};

const getViewTitle = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Explore';
    case 'bookmarks':
      return 'Bookmarks';
    case 'lists':
      return 'Lists';
    case 'notifications':
      return 'Notifications';
    case 'profile':
      return 'Profile';
    default:
      return 'Timeline';
  }
};

const getViewSubtitle = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Discover trending content and new instances';
    case 'bookmarks':
      return 'Posts you\'ve saved for later';
    case 'lists':
      return 'Curated lists of users and topics';
    case 'notifications':
      return 'Stay updated with your activity';
    case 'profile':
      return 'Your profile and posts';
    default:
      return 'Your timeline';
  }
};

const getEmptyStateTitle = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Nothing to explore yet';
    case 'bookmarks':
      return 'No bookmarks yet';
    case 'lists':
      return 'No lists yet';
    case 'notifications':
      return 'No notifications yet';
    default:
      return 'Nothing here yet';
  }
};

const getSpecialViewEmptyMessage = (viewType: string) => {
  switch (viewType) {
    case 'explore':
      return 'Check back later for trending content and discover new instances.';
    case 'bookmarks':
      return 'Posts you bookmark will appear here for easy access later.';
    case 'lists':
      return 'Create lists to organize users and topics you follow.';
    case 'notifications':
      return 'When someone interacts with your posts, you\'ll see it here.';
    default:
      return 'Content will appear here when available.';
  }
};
</script>

<style scoped>
.unified-content-area {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-primary);
}

.content-section {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 80px)
}

/* =============================================================================
   UNIFIED CONTENT AREA STYLES
   Clean, consistent styling for both chat and ActivityPub modes
   ============================================================================= */

/* Chat Mode */
.chat-content {
  height: 100%;
  overflow: hidden;
}

/* ActivityPub Mode */
.activitypub-content {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.mony-content {
  display: flex;
  flex-direction: column;
  height: 100%;
}

/* =============================================================================
   SPECIAL VIEW COMPONENTS (Bookmarks, Lists, Notifications, etc.)
   ============================================================================= */

.special-view-content {
  height: 100%;
  overflow-y: auto;
  background: var(--background-primary);
}

.special-view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 24px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.header-content {
  flex: 1;
}

.page-title {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
}

.page-subtitle {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0;
}

.clear-all-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 16px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s ease;
}

.clear-all-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
  border-color: var(--border-hover);
}

/* =============================================================================
   PROFILE COMPONENTS
   ============================================================================= */

.profile-content {
  height: 100%;
  overflow-y: auto;
  background: var(--background-primary);
}

.profile-display {
  height: 100%;
}

.profile-header {
  position: relative;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
}

.profile-banner {
  height: 200px;
  background: linear-gradient(135deg, var(--brand-primary), var(--brand-secondary, #4752c4));
  position: relative;
}

.profile-info {
  padding: 0 24px 24px 24px;
  position: relative;
}

.profile-avatar-section {
  position: absolute;
  top: -50px;
  left: 24px;
}

.profile-avatar {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  border: 4px solid var(--background-primary);
  object-fit: cover;
  background: var(--background-secondary);
}

.profile-details {
  margin-top: 60px;
}

.profile-name {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px 0;
  color: var(--text-primary);
}

.profile-handle {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0 0 16px 0;
}

.profile-bio {
  font-size: 16px;
  line-height: 1.5;
  color: var(--text-primary);
  margin: 0 0 16px 0;
}

.profile-stats {
  display: flex;
  gap: 24px;
  margin-bottom: 16px;
}

.stat {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}

.stat-value {
  font-size: 18px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-label {
  font-size: 14px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.profile-actions {
  margin-top: 16px;
}

.follow-btn, .unfollow-btn {
  padding: 8px 24px;
  border-radius: 20px;
  border: none;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s ease;
}

.follow-btn {
  background: var(--brand-primary);
  color: white;
}

.follow-btn:hover {
  background: var(--brand-primary-hover, #4752c4);
}

.unfollow-btn {
  background: var(--background-tertiary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.unfollow-btn:hover {
  background: var(--background-hover);
}

.profile-tabs {
  display: flex;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.tab {
  padding: 16px 24px;
  cursor: pointer;
  border-bottom: 3px solid transparent;
  color: var(--text-secondary);
  font-weight: 600;
  transition: all 0.2s ease;
}

.tab:hover {
  color: var(--text-primary);
  background: var(--background-hover);
}

.tab.active {
  color: var(--brand-primary);
  border-bottom-color: var(--brand-primary);
}

.profile-posts {
  flex: 1;
  overflow-y: auto;
}

.empty-posts {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 300px;
  color: var(--text-secondary);
  gap: 16px;
  text-align: center;
}

.empty-posts h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}



/* =============================================================================
   TIMELINE COMPONENTS
   ============================================================================= */

.timeline-feed {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  scroll-behavior: smooth;
}

/* =============================================================================
   STATE COMPONENTS
   ============================================================================= */

.loading-state,
.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: var(--space-16) var(--space-4);
  text-align: center;
  color: var(--text-secondary);
  min-height: 400px;
}

.loading-spinner {
  width: var(--space-8);
  height: var(--space-8);
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: var(--space-4);
}

.empty-state h3 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-semibold);
  margin: var(--space-4) 0 var(--space-2) 0;
  color: var(--text-primary);
}

.empty-state p {
  font-size: var(--font-size-sm);
  margin: 0 0 var(--space-5) 0;
  max-width: 300px;
  line-height: var(--line-height-relaxed);
}

/* =============================================================================
   ACTION BUTTONS
   ============================================================================= */

.explore-btn,
.load-more-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all var(--transition-base);
  text-decoration: none;
}

.explore-btn {
  background: var(--brand-primary);
  color: white;
}

.explore-btn:hover {
  background: var(--brand-primary-hover);
  transform: translateY(-1px);
  box-shadow: var(--shadow-md);
}

.load-more-btn {
  background: var(--background-secondary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

.load-more-btn:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

/* =============================================================================
   LAYOUT CONTAINERS
   ============================================================================= */

.posts-container {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
}

.load-more-container {
  display: flex;
  justify-content: center;
  padding: var(--space-5);
}

/* =============================================================================
   ANIMATIONS
   ============================================================================= */

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* =============================================================================
   RESPONSIVE DESIGN
   ============================================================================= */

@media (max-width: 768px) {
  .timeline-feed {
    padding: var(--space-3);
  }
  
  .empty-state,
  .loading-state {
    padding: var(--space-10) var(--space-4);
    min-height: 300px;
  }
  
  .posts-container {
    max-width: 100%;
  }
}
</style>