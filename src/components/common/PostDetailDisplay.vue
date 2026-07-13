<template>
  <div class="post-detail-display">
    <!-- Header with back navigation -->
    <div class="detail-header">
      <button @click="$emit('back')" class="back-btn" title="Go back">
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
        <LoadingSpinner :size="32" />
        <p>Loading post...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>Post not found</h3>
        <p>{{ error }}</p>
        <button @click="$emit('back')" class="back-home-btn">
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
            @reply="$emit('reply', $event)"
            @favorite="$emit('favorite', $event)"
            @reblog="$emit('reblog', $event)"
            @bookmark="$emit('bookmark', $event)"
            @delete="$emit('delete', $event)"
            @user-click="$emit('user-click', $event)"
          />
        </article>

        <!-- Reply composer (if replying) -->
        <!-- Bind the unwrapped post so reblog wrappers route the reply to the
             original author (the Composer also unwraps defensively, but doing
             it here keeps `replyTargetForComposer` available for any future
             markup that needs the same value). -->
        <div v-if="showReplyComposer && post" class="reply-composer">
          <Composer
            mode="inline"
            type="reply"
            :reply-to-post="replyTargetForComposer"
            @posted="handleReplyCreated"
            @close="showReplyComposer = false"
          />
        </div>

        <!-- Replies section -->
        <div v-if="replies.length > 0 || isLoadingReplies" class="replies-section" :class="{ 'inline-replies': shouldShowInline }">
          <!-- Only show header if more than 5 replies (Twitter-style) -->
          <h3 v-if="!shouldShowInline" class="replies-title">
            Replies ({{ totalReplies }})
          </h3>

          <!-- Loading replies -->
          <div v-if="isLoadingReplies" class="loading-replies">
            <LoadingSpinner :size="20" />
            <span>Loading replies...</span>
          </div>

          <!-- Reply thread -->
          <div v-else class="reply-thread">
            <MonyPost
              v-for="reply in replies"
              :key="reply.id"
              :post="reply"
              :is-reply="true"
              :is-in-thread="true"
              :hide-reply-context="true"
              @reply="$emit('reply', $event)"
              @favorite="$emit('favorite', $event)"
              @reblog="$emit('reblog', $event)"
              @bookmark="$emit('bookmark', $event)"
              @delete="$emit('delete', $event)"
              @user-click="$emit('user-click', $event)"
            />

            <!-- Load more replies (only show if > 5 total and we haven't loaded them all) -->
            <button
              v-if="hasMoreReplies"
              @click="loadMoreReplies"
              :disabled="isLoadingMoreReplies"
              class="load-more-btn"
            >
              <Icon v-if="isLoadingMoreReplies" name="loader" class="spinning" />
              <span>{{ isLoadingMoreReplies ? 'Loading...' : `Load more replies (${totalReplies - replies.length} remaining)` }}</span>
            </button>
          </div>
        </div>

        <!-- Empty replies state -->
        <div v-else-if="!isLoadingReplies && totalReplies === 0" class="empty-replies">
          <Icon name="message-circle" :size="32" />
          <p>No replies yet. Be the first to reply!</p>
          <button @click="showReplyComposer = true" class="reply-cta-btn">
            Reply to this mony
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, watch, computed } from 'vue';
import { debug } from '@/utils/debug'
import { services } from '@/services';
import { activityPubService } from '@/services/activityPubService';
import { getOriginalPost } from '@/utils/postReblog';
import type { TimelinePost } from '@/types';

import MonyPost from '@/components/activitypub/MonyPost.vue';
import Composer from '@/components/activitypub/Composer.vue';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';

interface Props {
  postId: string;
}

const props = defineProps<Props>();

defineEmits<{
  reply: [post: TimelinePost];
  favorite: [postId: string];
  reblog: [postId: string];
  bookmark: [postId: string];
  delete: [postId: string];
  'user-click': [user: any];
  back: [];
}>();


const post = ref<TimelinePost | null>(null);
const replies = ref<TimelinePost[]>([]);
const isLoading = ref(true);
const isLoadingReplies = ref(false);
const isLoadingMoreReplies = ref(false);
const hasMoreReplies = ref(false);
const showReplyComposer = ref(false);
const error = ref<string | null>(null);
const totalReplies = ref(0);

// Twitter-style: show inline (without header) if 5 or fewer replies
const INLINE_REPLY_THRESHOLD = 5;

// Should show replies inline (without "Replies" header)
const shouldShowInline = computed(() => {
  return totalReplies.value <= INLINE_REPLY_THRESHOLD;
});

// Unwrap reblogs so the inline composer addresses the original author and
// threads under the original note (Mastodon/Pleroma/Misskey behavior).
// Quote posts pass through unchanged via the shared helper.
const replyTargetForComposer = computed<TimelinePost | undefined>(() =>
  post.value ? getOriginalPost(post.value) : undefined,
);

const loadPost = async () => {
  isLoading.value = true;
  error.value = null;

  try {
    debug.log('Loading post via service layer:', props.postId);
    
    const loadedPost = await services.posts.loadPost(props.postId);
    
    if (!loadedPost) {
      throw new Error('Post not found');
    }
    
    post.value = loadedPost;
    totalReplies.value = post.value.replies_count || 0;
    
    debug.log('Post loaded successfully via service layer');
    await loadReplies();
  } catch (err) {
    debug.error('Failed to load post via service layer:', err);
    error.value = 'Failed to load post. It might have been deleted or you might not have permission to view it.';
  } finally {
    isLoading.value = false;
  }
};

const loadReplies = async () => {
  if (!post.value) return;

  isLoadingReplies.value = true;
  try {
    // If <= 5 total replies, load them all at once; otherwise load first batch (20)
    const limit = totalReplies.value <= INLINE_REPLY_THRESHOLD 
      ? totalReplies.value 
      : 20;
    
    const loadedReplies = await activityPubService.getPostReplies(
      post.value.id,
      { limit }
    );
    
    replies.value = loadedReplies;
    hasMoreReplies.value = loadedReplies.length < totalReplies.value;
    
    debug.log(`Loaded ${loadedReplies.length}/${totalReplies.value} replies`);
  } catch (err) {
    debug.error('Failed to load replies:', err);
  } finally {
    isLoadingReplies.value = false;
  }
};

const loadMoreReplies = async () => {
  if (!post.value) return;
  
  isLoadingMoreReplies.value = true;
  try {
    const lastReply = replies.value[replies.value.length - 1];
    const maxId = lastReply?.id;
    
    const moreReplies = await activityPubService.getPostReplies(
      post.value.id,
      { limit: 20, max_id: maxId }
    );
    
    if (moreReplies.length > 0) {
      replies.value = [...replies.value, ...moreReplies];
    }
    
    hasMoreReplies.value = replies.value.length < totalReplies.value;
    
    debug.log(`Loaded ${moreReplies.length} more replies (total: ${replies.value.length}/${totalReplies.value})`);
  } catch (err) {
    debug.error('Failed to load more replies:', err);
  } finally {
    isLoadingMoreReplies.value = false;
  }
};

const sharePost = async () => {
  if (!post.value) return;

  const url = `${window.location.origin}/social/post/${post.value.id}`;
  
  if (navigator.share) {
    try {
      await navigator.share({
        title: `Mony by ${post.value.author.display_name}`,
        text: post.value.content.map(part => part.type === 'text' ? part.text : '').join(''),
        url: url
      });
    } catch (err) {
      debug.log('Share cancelled');
    }
  } else {
    // Fallback: copy to clipboard
    await navigator.clipboard.writeText(url);
    // TODO: Show toast notification
  }
};

const openActions = () => {
  // TODO: Show actions menu
  debug.log('Open actions menu');
};

const handleReplyCreated = (newReply: TimelinePost) => {
  replies.value.unshift(newReply);
  totalReplies.value++;
  showReplyComposer.value = false;
  
  if (post.value) {
    post.value.replies_count = (post.value.replies_count || 0) + 1;
  }
};

watch(() => props.postId, (newPostId) => {
  if (newPostId) {
    loadPost();
  }
}, { immediate: true });

onMounted(() => {
  loadPost();
});
</script>

<style scoped>
.post-detail-display {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-primary);
}

.detail-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.5rem;
  background: var(--background-secondary);
  border-bottom: 1px solid var(--border-color);
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
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.back-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.detail-title {
  font-size: 1.25rem;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
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
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s;
}

.action-btn:hover {
  background: var(--background-hover);
  color: var(--text-primary);
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  text-align: center;
  color: var(--text-secondary);
  padding: 3rem 1rem;
  flex: 1;
}

.error-state h3 {
  color: var(--text-primary);
  margin: 1rem 0 0.5rem;
  font-size: 1.25rem;
}

.back-home-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.75rem 1.5rem;
  font-weight: 500;
  cursor: pointer;
  margin-top: 1rem;
  transition: background 0.2s;
}

.back-home-btn:hover {
  background: var(--harmony-primary-hover);
}

.post-container {
  max-width: 700px;
  margin: 0 auto;
  width: 100%;
}

.main-post {
  background: var(--background-secondary);
  border-radius: 12px;
  padding: 1.5rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--border-color);
}

.reply-composer {
  background: var(--background-secondary);
  border-radius: 12px;
  padding: 1rem;
  margin-bottom: 1.5rem;
  border: 1px solid var(--border-color);
}

.replies-section {
  background: var(--background-secondary);
  border-radius: 12px;
  padding: 1.5rem;
  border: 1px solid var(--border-color);
}

/* Inline mode: seamless flow without header (Twitter-style for ≤5 replies) */
.replies-section.inline-replies {
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
}

.replies-section.inline-replies .reply-thread {
  gap: 0;
}

.replies-section.inline-replies .reply-thread > :deep(.mony-post) {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 1rem;
  margin-bottom: 0.5rem;
}

.replies-title {
  font-size: 1.1rem;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid var(--border-color);
}

.loading-replies {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  color: var(--text-secondary);
  padding: 1rem;
}

.reply-thread {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.load-more-btn {
  width: 100%;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
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
  border-color: var(--border-hover);
  background: var(--background-hover);
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
  color: var(--text-secondary);
  padding: 2rem;
}

.empty-replies p {
  margin: 1rem 0;
}

.reply-cta-btn {
  background: var(--harmony-primary);
  border: none;
  border-radius: 6px;
  color: var(--text-primary);
  padding: 0.75rem 1.5rem;
  font-weight: 500;
  cursor: pointer;
  transition: background 0.2s;
}

.reply-cta-btn:hover {
  background: var(--harmony-primary-hover);
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
  
  .post-container {
    max-width: 100%;
  }
  
  .main-post,
  .reply-composer,
  .replies-section {
    padding: 1rem;
  }
}
</style> 