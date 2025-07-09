<!-- PostDetailView - Detailed view of a single Monyverse post -->
<template>
  <div class="post-detail-view">
    <!-- Header with back navigation -->
    <div class="detail-header">
      <button @click="goBack" class="back-btn" title="Go back">
        <Icon name="arrow-left" />
      </button>
      <h1 class="detail-title">Mony</h1>
      <div class="header-actions">
        <button @click="sharePost" class="action-btn" title="Share">
          <Icon name="share" />
        </button>
        <button @click="openActions" class="action-btn" title="More actions">
          <Icon name="more-horizontal" />
        </button>
      </div>
    </div>

    <!-- Main content -->
    <div class="detail-content">
      <!-- Loading state -->
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading post...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>Post not found</h3>
        <p>{{ error }}</p>
        <button @click="goBack" class="back-home-btn">
          Go back to timeline
        </button>
      </div>

      <!-- Post content -->
      <div v-else-if="post" class="post-container">
        <!-- Main post -->
        <article class="main-post">
          <MonyPost
            :post="post"
            :is-detail-view="true"
            @reply="handleReply"
            @favorite="handleFavorite"
            @reblog="handleReblog"
            @delete="handleDelete"
            @user-click="handleUserClick"
          />
        </article>

        <!-- Reply composer (if replying) -->
        <div v-if="showReplyComposer" class="reply-composer">
          <MonyComposerInline
            :reply-to="post"
            @post-created="handleReplyCreated"
            @cancel="showReplyComposer = false"
          />
        </div>

        <!-- Replies section -->
        <div v-if="replies.length > 0 || isLoadingReplies" class="replies-section">
          <h3 class="replies-title">
            Replies ({{ totalReplies }})
          </h3>

          <!-- Loading replies -->
          <div v-if="isLoadingReplies" class="loading-replies">
            <div class="loading-spinner small"></div>
            <span>Loading replies...</span>
          </div>

          <!-- Reply thread -->
          <div v-else class="reply-thread">
            <MonyPost
              v-for="reply in replies"
              :key="reply.id"
              :post="reply"
              :is-reply="true"
              @reply="handleReply"
              @favorite="handleFavorite"
              @reblog="handleReblog"
              @delete="handleDelete"
              @user-click="handleUserClick"
            />

            <!-- Load more replies -->
            <button
              v-if="hasMoreReplies"
              @click="loadMoreReplies"
              :disabled="isLoadingMoreReplies"
              class="load-more-btn"
            >
              <Icon v-if="isLoadingMoreReplies" name="loader" class="spinning" />
              <span>{{ isLoadingMoreReplies ? 'Loading...' : 'Load more replies' }}</span>
            </button>
          </div>
        </div>

        <!-- Empty replies state -->
        <div v-else-if="!isLoadingReplies" class="empty-replies">
          <Icon name="message-circle" :size="32" />
          <p>No replies yet. Be the first to reply!</p>
          <button @click="showReplyComposer = true" class="reply-cta-btn">
            Reply to this mony
          </button>
        </div>
      </div>
    </div>

    <!-- Related posts sidebar (desktop) -->
    <aside v-if="relatedPosts.length > 0" class="related-sidebar">
      <h3 class="sidebar-title">Related</h3>
      <div class="related-posts">
        <div
          v-for="relatedPost in relatedPosts"
          :key="relatedPost.id"
          class="related-item"
          @click="navigateToPost(relatedPost.id)"
        >
          <img
            :src="relatedPost.author.avatar_url || '/default_avatar.png'"
            :alt="relatedPost.author.display_name"
            class="related-avatar"
          />
          <div class="related-content">
            <div class="related-author">{{ relatedPost.author.display_name }}</div>
            <div class="related-text">{{ truncateText(relatedPost.content, 80) }}</div>
          </div>
        </div>
      </div>
    </aside>

    <!-- User profile modal -->
    <UserProfileModal
      v-if="selectedUser"
      :user="selectedUser"
      @close="selectedUser = null"
      @follow="handleFollow"
      @unfollow="handleUnfollow"
    />
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import type { TimelinePost, FederatedUser } from '@/types';

// Components
import MonyPost from '@/components/activitypub/MonyPost.vue';
import MonyComposerInline from '@/components/activitypub/MonyComposerInline.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface Props {
  postId: string;
}

const props = defineProps<Props>();

// Stores and router
const activityPubStore = useActivityPubStore();
const route = useRoute();
const router = useRouter();

// State
const post = ref<TimelinePost | null>(null);
const replies = ref<TimelinePost[]>([]);
const relatedPosts = ref<TimelinePost[]>([]);
const selectedUser = ref<FederatedUser | null>(null);
const isLoading = ref(true);
const isLoadingReplies = ref(false);
const isLoadingMoreReplies = ref(false);
const hasMoreReplies = ref(false);
const showReplyComposer = ref(false);
const error = ref<string | null>(null);
const totalReplies = ref(0);

// Methods
const loadPost = async () => {
  isLoading.value = true;
  error.value = null;

  try {
    // TODO: Implement actual post loading from API
    // For now, simulate loading
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // Mock post data
    post.value = {
      id: props.postId,
      content: `This is a detailed view of post ${props.postId}. Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.`,
      created_at: new Date().toISOString(),
      author: {
        id: 'user1',
        username: 'alice',
        domain: 'har.mony.lol',
        handle: '@alice',
        display_name: 'Alice Johnson',
        avatar_url: '/default_avatar.png',
        bio: 'Software developer and ActivityPub enthusiast',
        is_local: true,
        verified: false,
        followers_count: 142,
        following_count: 89,
        posts_count: 234,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      },
      visibility: 'public',
      favorites_count: 5,
      reblogs_count: 2,
      replies_count: 3,
      is_favorited: false,
      is_reblogged: false,
      media_attachments: [],
      reblog: null,
      reblog_author: null,
      in_reply_to: null,
      content_warning: null,
      is_sensitive: false
    };

    totalReplies.value = post.value.replies_count;
    await loadReplies();
    await loadRelatedPosts();
  } catch (err) {
    console.error('Failed to load post:', err);
    error.value = 'Failed to load post. It might have been deleted or you might not have permission to view it.';
  } finally {
    isLoading.value = false;
  }
};

const loadReplies = async () => {
  if (!post.value) return;

  isLoadingReplies.value = true;
  try {
    // TODO: Implement actual replies loading
    await new Promise(resolve => setTimeout(resolve, 300));
    
    // Mock replies data
    replies.value = [
      {
        id: 'reply1',
        content: 'Great post! Thanks for sharing.',
        created_at: new Date(Date.now() - 3600000).toISOString(),
        author: {
          id: 'user2',
          username: 'bob',
          domain: 'mastodon.social',
          handle: '@bob@mastodon.social',
          display_name: 'Bob Smith',
          avatar_url: '/default_avatar.png',
          bio: 'Federated social media user',
          is_local: false,
          verified: false,
          followers_count: 67,
          following_count: 123,
          posts_count: 89,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        },
        visibility: 'public',
        favorites_count: 1,
        reblogs_count: 0,
        replies_count: 0,
        is_favorited: false,
        is_reblogged: false,
        media_attachments: [],
        reblog: null,
        reblog_author: null,
        in_reply_to: post.value.id,
        content_warning: null,
        is_sensitive: false
      }
    ];
    
    hasMoreReplies.value = replies.value.length < totalReplies.value;
  } catch (err) {
    console.error('Failed to load replies:', err);
  } finally {
    isLoadingReplies.value = false;
  }
};

const loadMoreReplies = async () => {
  isLoadingMoreReplies.value = true;
  try {
    // TODO: Implement pagination
    await new Promise(resolve => setTimeout(resolve, 500));
    hasMoreReplies.value = false;
  } catch (err) {
    console.error('Failed to load more replies:', err);
  } finally {
    isLoadingMoreReplies.value = false;
  }
};

const loadRelatedPosts = async () => {
  try {
    // TODO: Load related posts based on tags, author, etc.
    relatedPosts.value = [];
  } catch (err) {
    console.error('Failed to load related posts:', err);
  }
};

const goBack = () => {
  if (window.history.length > 1) {
    router.go(-1);
  } else {
    router.push({ name: 'Monyverse' });
  }
};

const sharePost = async () => {
  if (!post.value) return;

  const url = `${window.location.origin}/posts/${post.value.id}`;
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Mony by ${post.value.author.display_name}`,
        text: post.value.content,
        url: url
      });
    } catch (err) {
      console.log('Share cancelled');
    }
  } else {
    // Fallback: copy to clipboard
    await navigator.clipboard.writeText(url);
    // TODO: Show toast notification
  }
};

const openActions = () => {
  // TODO: Show actions menu
  console.log('Open actions menu');
};

const handleReply = () => {
  showReplyComposer.value = true;
};

const handleReplyCreated = (newReply: TimelinePost) => {
  replies.value.unshift(newReply);
  totalReplies.value++;
  showReplyComposer.value = false;
  
  // Update post reply count
  if (post.value) {
    post.value.replies_count++;
  }
};

const handleFavorite = async (postId: string) => {
  try {
    await activityPubStore.toggleFavorite(postId);
    
    // Update local state
    if (post.value && post.value.id === postId) {
      post.value.is_favorited = !post.value.is_favorited;
      post.value.favorites_count += post.value.is_favorited ? 1 : -1;
    }
    
    // Update reply if it was favorited
    const reply = replies.value.find(r => r.id === postId);
    if (reply) {
      reply.is_favorited = !reply.is_favorited;
      reply.favorites_count += reply.is_favorited ? 1 : -1;
    }
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const handleReblog = async (postId: string) => {
  // TODO: Implement reblog
  console.log('Reblog post:', postId);
};

const handleDelete = async (postId: string) => {
  // TODO: Implement delete with confirmation
  console.log('Delete post:', postId);
};

const handleUserClick = (user: FederatedUser) => {
  selectedUser.value = user;
};

const handleFollow = async (userId: string) => {
  try {
    await activityPubStore.followUser(userId);
  } catch (error) {
    console.error('Failed to follow user:', error);
  }
};

const handleUnfollow = async (userId: string) => {
  try {
    await activityPubStore.unfollowUser(userId);
  } catch (error) {
    console.error('Failed to unfollow user:', error);
  }
};

const navigateToPost = (postId: string) => {
  router.push({ name: 'PostDetail', params: { postId } });
};

const truncateText = (text: string, maxLength: number): string => {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength) + '...';
};

// Watch for route changes
watch(() => route.params.postId, (newPostId) => {
  if (newPostId && typeof newPostId === 'string') {
    loadPost();
  }
}, { immediate: true });

// Lifecycle
onMounted(() => {
  loadPost();
});
</script>

<style scoped>
.post-detail-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--h-chat, #313338);
  color: white;
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  background: var(--h-sidebar, #2b2d31);
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  flex-shrink: 0;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #80848e;
  cursor: pointer;
  transition: all 0.2s;
}

.back-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: white;
}

.detail-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
  color: white;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: 6px;
  color: #80848e;
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  background: rgba(255, 255, 255, 0.08);
  color: white;
}

.detail-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: #80848e;
  padding: 3rem 1rem;
  flex: 1;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid rgba(255, 255, 255, 0.08);
  border-top: 3px solid var(--h-brand, #5865f2);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

.loading-spinner.small {
  width: 20px;
  height: 20px;
  border-width: 2px;
  margin-bottom: 0;
}

.error-state h3 {
  color: white;
  margin: 1rem 0 0.5rem;
  font-size: 1.25rem;
}

.back-home-btn {
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: white;
  padding: 0.75rem 1.5rem;
  font-weight: 500;
  cursor: pointer;
  margin-top: 1rem;
  transition: background 0.2s;
}

.back-home-btn:hover {
  background: #4752c4;
}

.post-container {
  max-width: 700px;
  margin: 0 auto;
  width: 100%;
}

.main-post {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
}

.reply-composer {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 12px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.replies-section {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 12px;
  padding: 1.5rem;
}

.replies-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: white;
  margin: 0 0 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}

.loading-replies {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: #80848e;
  padding: 1rem;
}

.reply-thread {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.load-more-btn {
  width: 100%;
  background: var(--h-chat, #313338);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  color: white;
  padding: 0.75rem;
  cursor: pointer;
  transition: all 0.2s;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  margin-top: 1rem;
}

.load-more-btn:hover:not(:disabled) {
  border-color: rgba(255, 255, 255, 0.16);
  background: rgba(255, 255, 255, 0.08);
}

.load-more-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.empty-replies {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: #80848e;
  padding: 2rem;
}

.empty-replies p {
  margin: 1rem 0;
}

.reply-cta-btn {
  background: var(--h-brand, #5865f2);
  border: none;
  border-radius: 6px;
  color: white;
  padding: 0.75rem 1.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.reply-cta-btn:hover {
  background: #4752c4;
}

.related-sidebar {
  position: fixed;
  top: 0;
  right: 0;
  width: 300px;
  height: 100vh;
  background: var(--h-sidebar, #2b2d31);
  border-left: 1px solid rgba(255, 255, 255, 0.08);
  padding: 1.5rem;
  overflow-y: auto;
}

.sidebar-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: white;
  margin: 0 0 1rem;
}

.related-posts {
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.related-item {
  display: flex;
  gap: 0.75rem;
  padding: 0.75rem;
  border-radius: 8px;
  cursor: pointer;
  transition: background 0.2s;
}

.related-item:hover {
  background: rgba(255, 255, 255, 0.08);
}

.related-avatar {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.related-content {
  flex: 1;
  min-width: 0;
}

.related-author {
  font-weight: 500;
  color: white;
  margin-bottom: 0.25rem;
  font-size: 0.875rem;
}

.related-text {
  color: #80848e;
  font-size: 0.75rem;
  line-height: 1.4;
}

.spinning {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .detail-content {
    padding: 1rem;
  }
  
  .related-sidebar {
    display: none;
  }
  
  .post-container {
    max-width: 100%;
  }
  
  .main-post,
  .reply-composer,
  .replies-section {
    padding: 1rem;
  }
}

@media (min-width: 1200px) {
  .detail-content {
    margin-right: 320px;
  }
}
</style>
