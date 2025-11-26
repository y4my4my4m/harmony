<!-- PostView - Professional post view with configurable context (minimal, thread, ancestors, descendants) -->
<!-- Replaces both PostDetailView and ConversationThreadView with a single, flexible component -->
<template>
  <div class="post-view">
    <!-- Header with back navigation and context info -->
    <div class="post-header">
      <button @click="goBack" class="back-btn" title="Go back">
        <Icon name="arrow-left" />
      </button>
      
      <div class="header-info">
        <h1 class="header-title">
          {{ contextType === 'thread' ? 'Conversation' : 'Post' }}
        </h1>
        <p v-if="threadInfo && contextType !== 'minimal'" class="header-meta">
          {{ threadInfo.totalPosts }} post{{ threadInfo.totalPosts !== 1 ? 's' : '' }}
          <span v-if="threadInfo.participantCount > 1">
            · {{ threadInfo.participantCount }} participant{{ threadInfo.participantCount !== 1 ? 's' : '' }}
          </span>
        </p>
      </div>
      
      <div class="header-actions">
        <!-- Context switch buttons -->
        <div class="context-switcher" v-if="contextType !== 'minimal'">
          <button 
            @click="switchContext('minimal')"
            :class="{ active: props.contextType === 'minimal' }"
            class="context-btn"
            title="Show just this post"
          >
            <Icon name="eye" />
          </button>
          <button 
            @click="switchContext('thread')"
            :class="{ active: props.contextType === 'thread' }"
            class="context-btn"
            title="Show full conversation"
          >
            <Icon name="message-square" />
          </button>
        </div>
        
        <button @click="sharePost" class="action-btn" title="Share">
          <Icon name="share" />
        </button>
        <button @click="openActions" class="action-btn" title="More actions">
          <Icon name="more-horizontal" />
        </button>
      </div>
    </div>

    <!-- Main content -->
    <div class="post-content" ref="postContainer">
      <!-- Loading state -->
      <div v-if="isLoading" class="loading-state">
        <div class="loading-spinner"></div>
        <p>Loading{{ contextType === 'thread' ? ' conversation' : '' }}...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>{{ contextType === 'thread' ? 'Conversation' : 'Post' }} not found</h3>
        <p>{{ error }}</p>
        <button @click="goBack" class="back-home-btn">
          Go back to timeline
        </button>
      </div>

      <!-- Post with context -->
      <div v-else-if="postWithContext" class="post-container">
        <!-- Ancestors (posts this is replying to) -->
        <div v-if="showAncestors && ancestors.length > 0" class="ancestors-section">
          <div class="section-header">
            <Icon name="arrow-up" />
            <span>Earlier in thread</span>
          </div>
          
          <div class="ancestors-list">
            <article
              v-for="ancestor in ancestors"
              :key="ancestor.id"
              :class="{ 
                'thread-post': true,
                'ancestor-post': true,
                'highlighted-post': ancestor.id === highlightedPostId 
              }"
              :ref="el => ancestor.id === highlightedPostId && setPostRef(ancestor.id, el)"
            >
              <MonyPost
                :post="ancestor"
                :is-in-thread="true"
                :hide-reply-context="true"
                @reply="handleReply"
                @delete="handleDelete"
                @user-click="handleUserClick"
              />
            </article>
          </div>
        </div>

        <!-- Main post (always shown) -->
        <article 
          v-if="mainPost"
          class="main-post"
          :class="{ 
            'highlighted-post': mainPost.id === highlightedPostId,
            'is-root-post': contextType === 'thread',
            'has-ancestors': showAncestors && ancestors.length > 0,
            'has-descendants': showDescendants && descendants.length > 0
          }"
          :ref="el => mainPost && mainPost.id === highlightedPostId && setPostRef(mainPost.id, el as HTMLElement)"
        >
          <MonyPost
            :post="mainPost"
            @reply="handleReply"
            @delete="handleDelete"
            @user-click="handleUserClick"
            @show-conversation="() => switchContext('thread')"
          />
        </article>

        <!-- Reply composer (if replying) -->
        <div v-if="showReplyComposer" class="reply-composer">
          <Composer
            mode="inline"
            type="reply"
            :reply-to-post="replyToPost!"
            @posted="handleReplyCreated"
            @close="showReplyComposer = false"
          />
        </div>

        <!-- Descendants (replies to this post) -->
        <div v-if="showDescendants && descendants.length > 0" class="descendants-section" :class="{ 'inline-replies': shouldShowInlineReplies }">
          <!-- Thread connector from main post -->
          <div class="thread-connector descendants-connector"></div>
          
          <!-- Only show header if more than 5 replies (Twitter-style) -->
          <div v-if="!shouldShowInlineReplies" class="section-header">
            <Icon name="arrow-down" />
            <span>Replies ({{ descendants.length }})</span>
          </div>

          <!-- For minimal/ancestors context: simple linear replies -->
          <div v-if="contextType !== 'thread'" class="simple-replies">
            <article
              v-for="reply in descendants.slice(0, 3)"
              :key="reply.id"
              :class="{ 
                'reply-post': true,
                'highlighted-post': reply.id === highlightedPostId 
              }"
              :ref="el => reply.id === highlightedPostId && setPostRef(reply.id, el)"
            >
              <MonyPost
                :post="reply"
                :is-in-thread="true"
                :hide-reply-context="true"
                @reply="handleReply"
                @favorite="handleFavorite"
                @reblog="handleReblog"
                @bookmark="handleBookmark"
                @delete="handleDelete"
                @user-click="handleUserClick"
                @show-conversation="() => switchContext('thread')"
              />
            </article>
            
            <!-- Show more button -->
            <button 
              v-if="descendants.length > 3"
              @click="switchContext('thread')"
              class="show-more-btn"
            >
              Show {{ descendants.length - 3 }} more replies
            </button>
          </div>

          <!-- For full thread context: simple list of replies -->
          <div v-else class="thread-replies">
            <article
              v-for="reply in descendants"
              :key="reply.id"
              :class="{ 
                'reply-post': true,
                'highlighted-post': reply.id === highlightedPostId 
              }"
            >
              <MonyPost
                :post="reply"
                :is-in-thread="true"
                :hide-reply-context="true"
                @reply="handleReply"
                @delete="handleDelete"
                @user-click="handleUserClick"
                @show-conversation="() => switchContext('thread')"
              />
            </article>
          </div>
        </div>

        <!-- Empty state for no replies in thread context -->
        <div v-else-if="contextType === 'thread' && !isLoading && mainPost" class="empty-replies">
          <Icon name="message-circle" :size="32" />
          <p>No replies yet. Be the first to reply!</p>
          <button @click="() => mainPost && handleReply(mainPost)" class="reply-cta-btn">
            Reply to this conversation
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { activityPubService } from '@/services/activityPubService';
import { useToast } from 'vue-toastification';
import Icon from '@/components/common/Icon.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import Composer from '@/components/activitypub/Composer.vue';

import type { 
  TimelinePost, 
  PostWithContext, 
  PostContextType 
} from '@/types';

// Props
interface Props {
  postId: string;
  contextType?: PostContextType;
  highlightReply?: string;
  timestamp?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  contextType: 'minimal',
  highlightReply: undefined,
  timestamp: null
});

// Composables
const router = useRouter();
const route = useRoute();
const activityPub = useActivityPubStore();
const toast = useToast();

// Reactive state
const isLoading = ref(true);
const error = ref<string | null>(null);
const postWithContext = ref<PostWithContext | null>(null);
const showReplyComposer = ref(false);
const replyToPost = ref<TimelinePost | null>(null);
const replyingToPostId = ref<string | null>(null);
const postContainer = ref<HTMLElement>();
const postRefs = ref<Record<string, HTMLElement>>({});
const maxThreadDepth = ref(10);

// Computed properties
const mainPost = computed(() => postWithContext.value?.mainPost);
const ancestors = computed(() => postWithContext.value?.ancestors || []);
const descendants = computed(() => postWithContext.value?.descendants || []);
const threadInfo = computed(() => postWithContext.value?.threadInfo);
const highlightedPostId = computed(() => props.highlightReply || postWithContext.value?.highlightedPost);

// Context display logic
const showAncestors = computed(() => 
  ['thread', 'ancestors'].includes(props.contextType) && ancestors.value.length > 0
);

const showDescendants = computed(() => 
  ['thread', 'descendants', 'minimal'].includes(props.contextType) && descendants.value.length > 0
);

// Twitter-style: show inline (without header) if 5 or fewer replies
const INLINE_REPLY_THRESHOLD = 5;
const shouldShowInlineReplies = computed(() => descendants.value.length <= INLINE_REPLY_THRESHOLD);

// Methods
const loadPostWithContext = async () => {
  try {
    isLoading.value = true;
    error.value = null;
    
    // Get postId from props or route params as fallback
    const postId = props.postId || route.params.postId as string;
    
    if (!postId) {
      throw new Error('No postId provided in props or route params');
    }
    
    const result = await activityPub.getPostWithContext(postId, {
      context: props.contextType,
      highlightReply: props.highlightReply,
      maxDepth: maxThreadDepth.value,
      includeInteractions: true
    });

    postWithContext.value = result;
    
    // Scroll to highlighted post after content loads
    if (props.highlightReply) {
      await nextTick();
      scrollToPost(props.highlightReply);
    } else if (props.timestamp) {
      // Handle timestamp-based deep linking
      await nextTick();
      scrollToTimestamp(props.timestamp);
    }
    
  } catch (err) {
    debug.error('❌ Failed to load post with context:', err);
    error.value = err instanceof Error ? err.message : 'Failed to load post';
    toast.error('Failed to load post');
  } finally {
    isLoading.value = false;
  }
};

const switchContext = async (newContext: PostContextType) => {
  // Update URL without full navigation
  const query = { ...route.query };
  if (newContext === 'minimal') {
    delete query.context;
  } else {
    query.context = newContext;
  }
  
  await router.replace({ 
    name: route.name!, 
    params: route.params,
    query 
  });
  
  // Reload with new context
  await loadPostWithContext();
};

const handleReply = (post: TimelinePost) => {
  replyToPost.value = post;
  replyingToPostId.value = post.id;
  showReplyComposer.value = true;
};

const handleReplyCreated = async () => {
  showReplyComposer.value = false;
  replyToPost.value = null;
  replyingToPostId.value = null;
  
  // Reload to show the new reply
  await loadPostWithContext();
  
  toast.success('Reply posted!');
};

const handleDelete = async (postId: string) => {
  if (!confirm('Are you sure you want to delete this post?')) return;
  
  try {
    await activityPubService.deletePost(postId);
    toast.success('Post deleted');
    goBack();
  } catch (err) {
    debug.error('❌ Failed to delete post:', err);
    toast.error('Failed to delete post');
  }
};

const handleFavorite = async (postId: string) => {
  try {
    await activityPubService.toggleFavorite(postId);
    // Reload to show updated state
    await loadPostWithContext();
  } catch (err) {
    debug.error('❌ Failed to favorite post:', err);
    toast.error('Failed to favorite post');
  }
};

const handleReblog = async (postId: string) => {
  try {
    await activityPubService.toggleReblog(postId);
    // Reload to show updated state
    await loadPostWithContext();
    toast.success('Post reblogged!');
  } catch (err) {
    debug.error('❌ Failed to reblog post:', err);
    toast.error('Failed to reblog post');
  }
};

const handleBookmark = async (postId: string) => {
  try {
    await activityPubService.toggleBookmark(postId);
    // Reload to show updated state
    await loadPostWithContext();
    toast.success('Post bookmarked!');
  } catch (err) {
    debug.error('❌ Failed to bookmark post:', err);
    toast.error('Failed to bookmark post');
  }
};

const handleUserClick = (userId: string) => {
  // Navigate to user profile
  router.push(`/social/profile/${userId}`);
};

const sharePost = async () => {
  if (!mainPost.value) return;
  
  const url = `${window.location.origin}/posts/${props.postId}`;
  const firstTextContent = mainPost.value.content.find(c => c.type === 'text');
  const previewText = firstTextContent?.type === 'text' ? firstTextContent.text : 'Check out this post';
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: 'Harmony Post',
        text: previewText.substring(0, 100) + '...',
        url
      });
    } catch (err) {
      // User cancelled sharing
    }
  } else {
    // Fallback: copy to clipboard
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied to clipboard');
    } catch (err) {
      toast.error('Failed to copy link');
    }
  }
};

const openActions = () => {
  // TODO: Implement post actions menu
  toast.info('Actions menu coming soon');
};

const goBack = () => {
  if (window.history.length > 1) {
    router.back();
  } else {
    router.push('/social/home');
  }
};

const setPostRef = (postId: string, el: any) => {
  if (el) {
    // Handle both Element and Component instance refs
    const element = el instanceof HTMLElement ? el : el.$el;
    if (element instanceof HTMLElement) {
      postRefs.value[postId] = element;
    }
  }
};

const scrollToPost = (postId: string) => {
  const element = postRefs.value[postId];
  if (element) {
    element.scrollIntoView({ 
      behavior: 'smooth', 
      block: 'center' 
    });
    
    // Add temporary highlight
    element.classList.add('scroll-highlighted');
    setTimeout(() => {
      element.classList.remove('scroll-highlighted');
    }, 2000);
  }
};

const scrollToTimestamp = (timestamp: number) => {
  // Find post closest to timestamp and scroll to it
  const posts = [mainPost.value, ...ancestors.value, ...descendants.value]
    .filter(Boolean) as TimelinePost[];
  
  const targetPost = posts.reduce((closest, post) => {
    const postTime = new Date(post.created_at).getTime();
    const closestTime = new Date(closest.created_at).getTime();
    
    return Math.abs(postTime - timestamp) < Math.abs(closestTime - timestamp) 
      ? post : closest;
  });
  
  if (targetPost) {
    scrollToPost(targetPost.id);
  }
};

// Watchers
watch(() => props.postId, loadPostWithContext);
watch(() => props.contextType, loadPostWithContext);
watch(() => props.highlightReply, loadPostWithContext);

// Lifecycle
onMounted(loadPostWithContext);
</script>

<style scoped>
.post-view {
  display: flex;
  flex-direction: column;
  height: 100vh;
}

.post-header {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 1rem 1.5rem;
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  position: sticky;
  top: 0;
  z-index: 10;
}

.back-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border: none;
  border-radius: 50%;
  background: var(--color-bg-tertiary);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-btn:hover {
  background: var(--color-bg-hover);
  transform: translateX(-2px);
}

.header-info {
  flex: 1;
}

.header-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0 0 0.25rem 0;
  color: var(--color-text-primary);
}

.header-meta {
  font-size: 0.875rem;
  color: var(--color-text-secondary);
  margin: 0;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}

.context-switcher {
  display: flex;
  gap: 0.25rem;
  margin-right: 0.5rem;
}

.context-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2rem;
  height: 2rem;
  border: 1px solid var(--color-border);
  border-radius: 0.375rem;
  background: var(--color-bg-secondary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.context-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.context-btn.active {
  background: var(--color-primary);
  color: white;
  border-color: var(--color-primary);
}

.action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 2.5rem;
  height: 2.5rem;
  border: none;
  border-radius: 50%;
  background: var(--color-bg-tertiary);
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.action-btn:hover {
  background: var(--color-bg-hover);
  color: var(--color-text-primary);
}

.post-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.post-container {
  display: flex;
  flex-direction: column;
  align-content: center;
}

.thread-replies {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.highlighted-post .mony-post {
  box-shadow: 0 0 16px 5px rgba(88, 101, 242, 0.25);
  border: 1px solid var(--harmony-primary, #5865f2);
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

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 2rem;
  text-align: center;
  min-height: 50vh;
}

.loading-spinner {
  width: 2rem;
  height: 2rem;
  border: 2px solid var(--color-border);
  border-top: 2px solid var(--color-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 1rem;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.error-state h3 {
  margin: 1rem 0 0.5rem 0;
  color: var(--color-text-primary);
}

.error-state p {
  color: var(--color-text-secondary);
  margin-bottom: 1.5rem;
}

.back-home-btn {
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--color-border);
  border-radius: 0.5rem;
  background: var(--color-bg-secondary);
  color: var(--color-text-primary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.back-home-btn:hover {
  background: var(--color-bg-hover);
}

.post-container {
  width: 600px;
  max-width: 600px;
  margin: 0 auto;
  padding: 1rem;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 1rem 1.5rem 0.5rem;
  color: var(--color-text-secondary);
  font-size: 0.875rem;
  font-weight: 500;
}

.ancestors-section,
.descendants-section {
  position: relative;
}

/* Inline mode: seamless flow without header (Twitter-style for ≤5 replies) */
.descendants-section.inline-replies .section-header {
  display: none;
}

.ancestors-thread,
.simple-replies,
.threaded-replies {
  position: relative;
}

.ancestor-post,
.reply-post,
.main-post {
  position: relative;
  border-bottom: 1px solid var(--color-border-subtle);
}

.main-post {
  background: var(--color-bg-primary);
}

.main-post.has-ancestors::before,
.main-post.has-descendants::after {
  content: '';
  position: absolute;
  left: 3.5rem;
  width: 2px;
  background: var(--color-border);
}

.main-post.has-ancestors::before {
  top: -1rem;
  height: 1rem;
}

.main-post.has-descendants::after {
  bottom: -1rem;
  height: 1rem;
}

.highlighted-post {
  background: var(--color-highlight-bg);
  border-left: 4px solid var(--color-primary);
}

.scroll-highlighted {
  background: var(--color-primary-bg);
  transition: background-color 0.3s ease;
}

.thread-connector {
  position: absolute;
  left: 3.5rem;
  width: 2px;
  background: var(--color-border);
  z-index: 1;
}

.thread-connector.main-connector {
  top: 100%;
  height: 1rem;
}

.thread-connector.descendants-connector {
  top: 0;
  height: 1rem;
}

.reply-composer {
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
}

.show-more-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  padding: 1rem;
  border: none;
  border-top: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
  color: var(--color-primary);
  cursor: pointer;
  transition: background-color 0.2s ease;
}

.show-more-btn:hover {
  background: var(--color-bg-hover);
}

.empty-replies {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 2rem;
  text-align: center;
  color: var(--color-text-secondary);
}

.empty-replies p {
  margin: 1rem 0 1.5rem 0;
}

.reply-cta-btn {
  padding: 0.75rem 1.5rem;
  border: 1px solid var(--color-primary);
  border-radius: 0.5rem;
  background: var(--color-primary);
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
}

.reply-cta-btn:hover {
  background: var(--color-primary-hover);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .post-header {
    padding: 0.75rem 1rem;
    gap: 0.75rem;
  }
  
  .header-title {
    font-size: 1.125rem;
  }
  
  .context-switcher {
    display: none; /* Hide on mobile to save space */
  }
  
  .section-header {
    padding: 1rem 1rem 0.5rem;
  }
  
  .main-post.has-ancestors::before,
  .main-post.has-descendants::after,
  .thread-connector {
    left: 2.5rem;
  }
}
</style>
