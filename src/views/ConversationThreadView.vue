<!-- ConversationThreadView - Professional conversation threading like Twitter/X, Misskey, Mastodon -->
<template>
  <div class="conversation-thread-view">
    <!-- Header with back navigation -->
    <div class="thread-header">
      <button @click="goBack" class="back-btn" title="Go back">
        <Icon name="arrow-left" />
      </button>
      <div class="thread-info">
        <h1 class="thread-title">Conversation</h1>
        <p v-if="conversationContext" class="thread-meta">
          {{ conversationContext.total_posts }} post{{ conversationContext.total_posts !== 1 ? 's' : '' }} 
          · {{ conversationContext.participant_count }} participant{{ conversationContext.participant_count !== 1 ? 's' : '' }}
        </p>
      </div>
      <div class="header-actions">
        <button @click="shareConversation" class="action-btn" title="Share conversation">
          <Icon name="share" />
        </button>
        <button @click="openActions" class="action-btn" title="More actions">
          <Icon name="more-horizontal" />
        </button>
      </div>
    </div>

    <!-- Main content -->
    <div class="thread-content" ref="threadContainer">
      <!-- Loading state -->
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading conversation...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>Conversation not found</h3>
        <p>{{ error }}</p>
        <button @click="goBack" class="back-home-btn">
          Go back
        </button>
      </div>

      <!-- Conversation thread -->
      <div v-else-if="conversationThread && transformedRootPost" class="conversation-container">
        <!-- Root post (highlighted) -->
         
        <article 
          class="root-post"
          :class="{ 'highlighted-post': conversationThread && isHighlighted(conversationThread.root_post.id) }"
          :ref="el => conversationThread && setPostRef(conversationThread.root_post.id, el)"
        >
          <MonyPost
            :post="transformedRootPost"
            :is-detail-view="true"
            :is-root-post="true"
            @reply="handleReply"
            @favorite="handleFavorite"
            @reblog="handleReblog"
            @bookmark="handleBookmark"
            @delete="handleDelete"
            @user-click="handleUserClick"
            @show-conversation="() => {}" 
          />
        </article>

        <!-- Thread line connector for root post -->
        <div v-if="threadReplies.length > 0" class="thread-connector root-connector"></div>


        <!-- Threaded replies -->
        <div v-if="threadReplies.length > 0" class="replies-section">
          <ThreadedPost
            v-for="reply in threadReplies"
            :key="reply.id"
            :post="reply"
            :thread-depth="1"
            :max-depth="10"
            :highlighted-post-id="highlightPostId || undefined"
            :replying-to-post-id="replyingToPostId || undefined"
            :show-reply-composer="showReplyComposer"
            @reply="handleReply"
            @favorite="handleFavorite"
            @reblog="handleReblog"
            @bookmark="handleBookmark"
            @delete="handleDelete"
            @user-click="handleUserClick"
            @post-created="handleReplyCreated"
            @cancel-reply="showReplyComposer = false"
            @ref="(postId, el) => setPostRef(postId, el)"
          />
        </div>

        <!-- Empty replies state -->
        <div v-else-if="!isLoading" class="empty-replies">
          <Icon name="message-circle" :size="32" />
          <p>No replies yet. Be the first to reply!</p>
          <button @click="() => handleReply(transformedRootPost)" class="reply-cta-btn">
            Reply to this conversation
          </button>
        </div>
      </div>
    </div>

    <!-- User profile modal -->
    <UserProfileModal
      v-if="selectedUser"
      :user="selectedUser"
      :show="!!selectedUser"
      @close="selectedUser = null"
      @follow="handleFollow"
      @unfollow="handleUnfollow"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, nextTick, watch } from 'vue';
import { useRoute, useRouter } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { supabase } from '@/supabase';
import ConversationService from '@/services/ConversationService';
import type { ActivityPubPost, ConversationThread, FederatedUser } from '@/types';
import { getAvatarUrl } from '@/utils/avatarUtils';

// Components
import MonyPost from '@/components/activitypub/MonyPost.vue';
import ThreadedPost from '@/components/activitypub/ThreadedPost.vue';
import InlineReplyComposer from '@/components/activitypub/InlineReplyComposer.vue';
import UserProfileModal from '@/components/UserProfileModal.vue';
import Icon from '@/components/common/Icon.vue';
import { useAuthStore } from '@/stores/auth';

// Props
interface Props {
  postId: string;
  highlightPostId?: string;
  fromPostId?: string;
  contextTimestamp?: number;
}

const props = defineProps<Props>();

// Stores and router
const activityPubStore = useActivityPubStore();
const route = useRoute();
const router = useRouter();

// State
const conversationThread = ref<ConversationThread | null>(null);
const conversationContext = ref<any>(null);
const selectedUser = ref<FederatedUser | null>(null);
const isLoading = ref(true);
const showReplyComposer = ref(false);
const replyingToPostId = ref<string | null>(null);
const error = ref<string | null>(null);
const threadContainer = ref<HTMLElement>();
const authStore = useAuthStore();

// Post refs for scrolling
const postRefs = ref<Map<string, HTMLElement>>(new Map());

// Cache for transformed posts to prevent avatar flashing
const transformedPostsCache = ref<Map<string, any>>(new Map());

// Transform raw ActivityPub post to TimelinePost format
const transformActivityPubPost = (post: any): any => {
  if (!post) return null;
  
  // Check cache first to prevent re-transformation
  if (transformedPostsCache.value.has(post.id)) {
    return transformedPostsCache.value.get(post.id);
  }
  
  // Parse domain safely
  let domain = 'har.mony.lol';
  let isLocal = true;
  
  if (post.actor_uri) {
    try {
      const url = new URL(post.actor_uri);
      domain = url.hostname;
      isLocal = domain === 'har.mony.lol';
    } catch (e) {
      console.warn('Invalid actor_uri:', post.actor_uri);
    }
  }
  
  // Construct avatar URL properly based on user type
  let avatarUrl = '/default_avatar.png';
  
  if (post.actor_icon && post.actor_icon !== 'default_avatar.png') {
    if (isLocal) {
      // For local users, use getAvatarUrl utility which handles Supabase storage paths
      avatarUrl = getAvatarUrl(post.actor_icon);
    } else {
      // For remote users, the actor_icon should be a full URL already
      avatarUrl = post.actor_icon.startsWith('http') ? post.actor_icon : `/storage/${post.actor_icon}`;
    }
  }
  
  const transformed = {
    ...post,
    author: {
      id: post.author_id || post.actor_uri,
      username: post.actor_preferred_username || post.actor_name,
      display_name: post.actor_name || post.actor_preferred_username,
      avatar_url: avatarUrl,
      domain,
      bio: '',
      is_local: isLocal,
      verified: false,
      followers_count: 0,
      following_count: 0,
      posts_count: 0,
      created_at: post.created_at,
      updated_at: post.updated_at,
      handle: isLocal 
        ? `@${post.actor_preferred_username || post.actor_name}` 
        : `@${post.actor_preferred_username || post.actor_name}@${domain}`
    },
    // Map ActivityPub fields to expected format
    favorites_count: post.likes_count || 0,
    reblogs_count: post.shares_count || 0,
    replies_count: post.replies_count || 0,
    is_favorited: false,
    is_reblogged: false,
    is_bookmarked: false
  };
  
  // Cache the transformed post
  transformedPostsCache.value.set(post.id, transformed);
  
  return transformed;
};

// Computed
const highlightPostId = computed(() => {
  return props.highlightPostId || ConversationService.getRouteContext(route).highlightPostId;
});

const transformedRootPost = computed(() => {
  if (!conversationThread.value?.root_post) return null;
  return transformActivityPubPost(conversationThread.value.root_post);
});

const threadReplies = computed(() => {
  if (!conversationThread.value) return [];
  return conversationThread.value.posts
    .filter(p => p.id !== conversationThread.value!.root_post.id)
    .map(post => transformActivityPubPost(post));
});

// Methods
const setPostRef = (postId: string, el: any) => {
  if (el) {
    postRefs.value.set(postId, el);
  }
};

const isHighlighted = (postId: string) => {
  return postId === highlightPostId.value;
};

const loadConversation = async () => {
  isLoading.value = true;
  error.value = null;
  
  // Clear cache for fresh data
  transformedPostsCache.value.clear();

  try {
    // Try to get postId from props, fallback to route params
    const postId = props.postId || route.params.postId;
    if (!postId) {
      throw new Error('Post ID is required to load conversation');
    }
    console.log(`🔍 Loading conversation thread for post: ${postId} for ${ authStore.session?.user.id}`);
    
    // Load the conversation thread and context
    const [thread, context] = await Promise.all([
      ConversationService.getConversationThread(postId as string),
      supabase.rpc('get_activitypub_conversation_context', { in_post_id: postId })
    ]);
    
    conversationThread.value = thread;
    console.log(`✅ Loaded conversation thread with ${JSON.stringify(thread)} posts`);
    conversationContext.value = context.data?.[0] || null;
    console.log(`✅ Loaded conversation context:`, conversationContext.value);
    
    console.log(`✅ Loaded conversation with ${thread.posts.length} posts`);
    
    // Scroll to highlighted post after DOM update
    if (highlightPostId.value) {
      await nextTick();
      await scrollToHighlightedPost();
    }
    
  } catch (err) {
    console.error('❌ Failed to load conversation:', err);
    error.value = 'Failed to load conversation. It might have been deleted or you might not have permission to view it.';
  } finally {
    isLoading.value = false;
  }
};

const scrollToHighlightedPost = async () => {
  if (!highlightPostId.value || !threadContainer.value) return;
  
  // Wait for the post to be rendered
  await nextTick();
  
  const targetElement = postRefs.value.get(highlightPostId.value);
  if (targetElement) {
    console.log(`📍 Scrolling to highlighted post: ${highlightPostId.value}`);
    
    // Smooth scroll to the highlighted post
    targetElement.scrollIntoView({
      behavior: 'smooth',
      block: 'center',
      inline: 'nearest'
    });
    
    // Add a temporary highlight effect
    targetElement.classList.add('scroll-highlight');
    setTimeout(() => {
      targetElement.classList.remove('scroll-highlight');
    }, 2000);
  }
};

const goBack = () => {
  if (window.history.length > 1) {
    router.go(-1);
  } else {
    router.push({ name: 'Social', params: { timeline: 'home' } });
  }
};

const shareConversation = async () => {
  if (!conversationThread.value) return;

  const url = `${window.location.origin}/social/conversation/${conversationThread.value.root_post.id}`;
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Conversation started by ${transformedRootPost.value?.author.display_name}`,
        text: typeof conversationThread.value.root_post.content === 'string' 
          ? conversationThread.value.root_post.content 
          : JSON.stringify(conversationThread.value.root_post.content),
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
  console.log('Open conversation actions menu');
};

const handleReply = (post: ActivityPubPost) => {
  replyingToPostId.value = post.id;
  showReplyComposer.value = true;
};

const handleReplyCreated = (newReply: ActivityPubPost) => {
  // Transform the new reply to match the expected format
  const transformedReply = transformActivityPubPost(newReply);
  
  // Add the transformed reply to the conversation
  if (conversationThread.value) {
    conversationThread.value.posts.push(transformedReply);
    conversationThread.value.reply_count++;
  }
  
  showReplyComposer.value = false;
  replyingToPostId.value = null;
};

const handleFavorite = async (postId: string) => {
  try {
    await activityPubStore.toggleFavorite(postId);
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
  }
};

const handleReblog = async (postId: string) => {
  try {
    await activityPubStore.toggleReblog(postId);
  } catch (error) {
    console.error('Failed to reblog:', error);
  }
};

const handleBookmark = async (postId: string) => {
  try {
    await activityPubStore.toggleBookmark(postId);
  } catch (error) {
    console.error('Failed to bookmark:', error);
  }
};

const handleDelete = async (postId: string) => {
  if (confirm('Are you sure you want to delete this post?')) {
    try {
      await activityPubStore.deletePost(postId);
      
      // Remove from conversation
      if (conversationThread.value) {
        const index = conversationThread.value.posts.findIndex(p => p.id === postId);
        if (index !== -1) {
          conversationThread.value.posts.splice(index, 1);
          conversationThread.value.reply_count--;
        }
      }
    } catch (error) {
      console.error('Failed to delete post:', error);
    }
  }
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

// Watch for prop changes
watch(() => props.postId, () => {
  loadConversation();
}, { immediate: true });

// Lifecycle
// onMounted(() => {
//   loadConversation();
// });
</script>

<style scoped>
.conversation-thread-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background: var(--h-chat, #313338);
  color: white;
}

.thread-header {
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

.thread-info {
  flex: 1;
  margin-left: 1rem;
}

.thread-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
  color: white;
}

.thread-meta {
  font-size: 0.875rem;
  color: #80848e;
  margin: 0.25rem 0 0;
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

.thread-content {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
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

.conversation-container {
  max-width: 700px;
  margin: 0 auto;
  width: 100%;
}

.root-post {
  margin-bottom: 1rem;
  transition: all 0.3s ease;
}

.highlighted-post {
  border-color: var(--h-brand, #5865f2);
  box-shadow: 0 0 16px 5px rgba(88, 101, 242, 0.9);
  border-radius: 12px;
}

.scroll-highlight {
  animation: highlight-pulse 2s ease-in-out;
}

@keyframes highlight-pulse {
  0%, 100% { 
    border-color: var(--h-brand, #5865f2);
    box-shadow: 0 0 20px rgba(88, 101, 242, 0.3);
  }
  50% { 
    border-color: var(--h-brand, #5865f2);
    box-shadow: 0 0 30px rgba(88, 101, 242, 0.5);
  }
}

.thread-connector {
  width: 2px;
  background: #80848e;
  margin: 0 auto 1rem;
  opacity: 0.3;
}

.root-connector {
  height: 24px;
}

.reply-composer {
  background: var(--h-sidebar, #2b2d31);
  border-radius: 12px;
  padding: 1rem;
  margin-bottom: 1.5rem;
}

.replies-section {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.empty-replies {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  color: #80848e;
  padding: 3rem 1rem;
}

.empty-replies h3 {
  color: white;
  margin: 1rem 0 0.5rem;
}

.reply-cta-btn {
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

.reply-cta-btn:hover {
  background: #4752c4;
}

.loading-spinner {
  width: 32px;
  height: 32px;
  border: 3px solid #80848e;
  border-top: 3px solid var(--h-brand, #5865f2);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .thread-content {
    padding: 1rem;
  }
  
  .conversation-container {
    max-width: 100%;
  }
  
  .root-post,
  .reply-composer {
    padding: 1rem;
  }
}
</style> 