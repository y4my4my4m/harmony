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
      <!-- Timeline Header -->
      <div class="timeline-header">
        <h2 class="timeline-title">{{ currentTimelineTitle }}</h2>
        <button
          v-if="currentFeed === 'home'"
          @click="$emit('refresh-timeline')"
          :disabled="isLoadingFeed"
          class="refresh-btn"
          title="Refresh timeline"
        >
          <Icon name="refresh-cw" :class="{ spinning: isLoadingFeed }" />
        </button>
      </div>

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
</template>

<script setup lang="ts">
import { computed } from 'vue';
import ChatComponent from '@/components/ChatComponent.vue';
import MonyComposerInline from '@/components/activitypub/MonyComposerInline.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import Icon from '@/components/common/Icon.vue';
import type { Message, TimelinePost } from '@/types';

interface Props {
  mode: 'chat' | 'activitypub';
  
  // Chat mode props
  chatMessages?: Message[];
  isLoading?: boolean;
  isDM?: boolean;
  
  // ActivityPub mode props
  currentFeed?: 'home' | 'local' | 'public';
  posts?: TimelinePost[];
  isLoadingFeed?: boolean;
  hasMorePosts?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  chatMessages: () => [],
  isLoading: false,
  isDM: false,
  currentFeed: 'home',
  posts: () => [],
  isLoadingFeed: false,
  hasMorePosts: false
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
  'delete-post': [postId: string];
  'show-user-profile': [user: any];
  'load-more-posts': [];
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
  height: 100%;
}

/* Chat Mode Styles */
.chat-content {
  /* Inherits from ChatComponent styles */
}

/* ActivityPub Mode Styles */
.activitypub-content {
  overflow: hidden;
}

.timeline-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.timeline-title {
  font-size: 20px;
  font-weight: 700;
  margin: 0;
  color: var(--text-primary);
}

.refresh-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: none;
  border: none;
  border-radius: 50%;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s ease;
}

.refresh-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.refresh-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.inline-composer {
  border-bottom: 1px solid var(--border-color);
  background: var(--background-primary);
  position: sticky;
  top: 72px;
  z-index: 9;
}

.timeline-feed {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 20px;
}

.loading-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  color: var(--text-secondary);
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 2px solid var(--border-color);
  border-top: 2px solid var(--brand-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 16px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 60px 20px;
  text-align: center;
  color: var(--text-secondary);
}

.empty-state h3 {
  font-size: 20px;
  font-weight: 600;
  margin: 16px 0 8px 0;
  color: var(--text-primary);
}

.empty-state p {
  font-size: 14px;
  margin: 0 0 20px 0;
  max-width: 300px;
  line-height: 1.4;
}

.explore-btn {
  padding: 10px 20px;
  background: var(--brand-primary);
  color: white;
  border: none;
  border-radius: 6px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
}

.explore-btn:hover {
  background: var(--brand-primary-hover);
}

.posts-container {
  display: flex;
  flex-direction: column;
}

.load-more-container {
  display: flex;
  justify-content: center;
  padding: 20px;
}

.load-more-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 20px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  font-size: 14px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
}

.load-more-btn:hover {
  background: var(--background-hover);
  border-color: var(--border-hover);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Responsive design */
@media (max-width: 768px) {
  .timeline-header {
    padding: 12px 16px;
  }
  
  .timeline-title {
    font-size: 18px;
  }
  
  .empty-state {
    padding: 40px 16px;
  }
  
  .loading-state {
    padding: 40px 16px;
  }
}
</style>