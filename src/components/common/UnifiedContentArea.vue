<template>
  <div class="view-renderer">
    <!-- Chat Mode Content -->
    <div v-if="mode === ViewMode.CHAT" class="content-section">
      <ChatComponent
        :messages="chatMessages"
        :isLoading="isLoading"
        :isDM="isDM"
        :channelId="channelId"
        :conversationId="conversationId"
        :loadMoreMessages="() => $emit('load-more-messages')"
        @update:isAtBottom="$emit('update:is-at-bottom', $event)" 
        @sendMessage="(messageParts, replyId) => $emit('send-message', messageParts, replyId)"
      />
    </div>
    
    <!-- ActivityPub Mode Content -->
    <div v-else-if="mode === ViewMode.ACTIVITYPUB" class="content-section social-content">

      <!-- Explore View -->
      <ExploreContent
        v-if="viewType === ViewType.EXPLORE"
        :current-view="currentView || 'trending'"
      />
      
      <!-- Special Views (Bookmarks, Lists, etc.) -->
      <div v-else-if="viewType !== ViewType.TIMELINE" class="special-view">
        <ViewHeader
          :view-type="viewType"
          :data-count="specialViewData?.length || 0"
          @clear-all="$emit('clear-all-bookmarks')"
        />

        <PostsContainer
          :posts="specialViewData || []"
          :is-loading="isLoadingFeed"
          :has-more="hasMoreSpecialData"
          :loading-message="`Loading your ${viewType}...`"
          :empty-title="getEmptyStateTitle(viewType)"
          :empty-message="getSpecialViewEmptyMessage(viewType)"
          :empty-icon="getViewIcon(viewType)"
          :empty-action="viewType === ViewType.BOOKMARKS ? 'Browse Timeline' : undefined"
          @load-more="$emit('load-more-special-data')"
          @empty-action="$emit('switch-feed', 'home')"
        />
      </div>
      
      <!-- Timeline View -->
      <div v-else class="content-timeline">
        <!-- Composer (if home timeline) -->
        <div v-if="currentView === 'home'" class="composer-section">
          <Composer 
            mode="inline"
            type="post"
            @posted="$emit('post-created', $event)"
          />
        </div>

        <!-- Timeline Posts -->
        <PostsContainer
          :posts="posts"
          :is-loading="isLoadingFeed"
          :has-more="hasMorePosts"
          :loading-message="getTimelineLoadingMessage()"
          :empty-title="getTimelineEmptyTitle()"
          :empty-message="getTimelineEmptyMessage()"
          :empty-action="currentView === 'home' ? 'Explore Public Timeline' : undefined"
          @load-more="$emit('load-more-posts')"
          @empty-action="$emit('switch-feed', 'public')"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import ChatComponent from '@/components/ChatComponent.vue'
import Composer from '@/components/activitypub/Composer.vue'
import ExploreContent from '@/components/activitypub/ExploreContent.vue'
import PostDetailDisplay from './PostDetailDisplay.vue'
import PostsContainer from './PostsContainer.vue'
import ViewHeader from './ViewHeader.vue'
import type { Message, TimelinePost, FederatedUser } from '@/types'
import { ViewMode, ViewType } from '@/types/viewTypes'
import { usePostInteractions } from '@/composables/usePostInteractions'

interface Props {
  mode: ViewMode;
  
  // Chat mode props
  chatMessages?: Message[];
  isLoading?: boolean;
  isDM?: boolean;
  channelId?: string;
  conversationId?: string;
  
  // ActivityPub mode props
  viewType?: ViewType;
  currentView?: string; // Can be timeline feeds or explore views
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
  viewType: ViewType.TIMELINE,
  currentView: 'home',
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
  'load-more-messages': []
  'update:is-at-bottom': [value: boolean]
  'send-message': [messageParts: any, replyId?: string]
  
  // Essential ActivityPub events (interactions now handled by composable)
  'post-created': [post: TimelinePost]
  'switch-feed': [feedType: 'home' | 'local' | 'public']
  'load-more-posts': []
  'load-more-special-data': []
  'clear-all-bookmarks': []
  'back-to-timeline': []
}>()

// Use the post interactions composable for all post-related actions
const postInteractions = usePostInteractions()

// Helper functions for timeline states
const getTimelineLoadingMessage = () => {
  switch (props.currentView) {
    case 'home': return 'Loading your timeline...'
    case 'local': return 'Loading local timeline...'
    case 'public': return 'Loading public timeline...'
    default: return 'Loading timeline...'
  }
}

const getTimelineEmptyTitle = () => {
  switch (props.currentView) {
    case 'home': return 'Welcome to Social!'
    case 'local': return 'Local Timeline Empty'
    case 'public': return 'Public Timeline Empty'
    default: return 'No posts yet'
  }
}

const getTimelineEmptyMessage = () => {
  switch (props.currentView) {
    case 'home': return 'Follow some users to see their posts in your timeline.'
    case 'local': return 'No local posts yet from this instance.'
    case 'public': return 'No public posts yet. Be the first to share something!'
    default: return 'No posts found.'
  }
}

// Helper functions for special views
const getViewIcon = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || 'home'
  switch (typeStr) {
    case 'explore': return 'compass'
    case 'bookmarks': return 'bookmark'
    case 'lists': return 'list'
    case 'notifications': return 'bell'
    case 'profile': return 'user'
    default: return 'home'
  }
}

const getEmptyStateTitle = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || ''
  switch (typeStr) {
    case 'explore': return 'Nothing to explore yet'
    case 'bookmarks': return 'No bookmarks yet'
    case 'lists': return 'No lists yet'
    case 'notifications': return 'No notifications yet'
    default: return 'Nothing here yet'
  }
}

const getSpecialViewEmptyMessage = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || ''
  switch (typeStr) {
    case 'explore': return 'Check back later for trending content and discover new instances.'
    case 'bookmarks': return 'Posts you bookmark will appear here for easy access later.'
    case 'lists': return 'Create lists to organize users and topics you follow.'
    case 'notifications': return 'When someone interacts with your posts, you\'ll see it here.'
    default: return 'Content will appear here when available.'
  }
}
</script>

<style scoped>
.view-renderer {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0; /* Important for flex child with overflow */
  background: var(--background-primary);
  height: calc(100% - 4px);
}

.content-section {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0; /* Important for flex child with overflow */
}

.social-content {
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.content-timeline {
  display: flex;
  flex-direction: column;
  height: 100%;
}

.composer-section {
  padding: var(--space-4);
  position: relative;
}

.special-view {
  height: 100%;
  overflow-y: auto;
  background: var(--background-primary);
}

@media (max-width: 768px) {
  .composer-section {
    padding: var(--space-1);
  }
}
</style>