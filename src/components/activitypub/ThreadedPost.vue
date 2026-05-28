<!-- ThreadedPost - Hierarchical post component for conversation threading -->
<template>
  <div 
    class="threaded-post"
    :class="{ 
      'highlighted-post': isHighlighted,
      'deep-thread': threadDepth > 3
    }"
    :style="{ '--thread-depth': threadDepth }"
    :ref="el => $emit('ref', post.id, el as unknown as HTMLElement)"
  >
    <!-- Thread line connector -->
    <div v-if="threadDepth > 0" class="thread-line"></div>

    <!-- Post content -->
    <article class="post-content">
      <MonyPost
        :post="post as any"
        :is-reply="true"
        :thread-depth="threadDepth"
        @reply="(handleReply as any)"
        @favorite="$emit('favorite', post.id)"
        @reblog="$emit('reblog', post.id)"
        @bookmark="$emit('bookmark', post.id)"
        @delete="$emit('delete', post.id)"
        @user-click="$emit('user-click', $event)"
        @show-conversation="() => {}"
      />
    </article>

    <!-- Nested replies -->
    <div v-if="post.replies && post.replies.length > 0 && threadDepth < maxDepth" class="nested-replies">
      <ThreadedPost
        v-for="reply in post.replies"
        :key="reply.id"
        :post="reply"
        :thread-depth="threadDepth + 1"
        :max-depth="maxDepth"
        :highlighted-post-id="highlightedPostId"
        :replying-to-post-id="replyingToPostId"
        :show-reply-composer="showReplyComposer"
        @reply="$emit('reply', $event)"
        @favorite="$emit('favorite', $event)"
        @reblog="$emit('reblog', $event)"
        @bookmark="$emit('bookmark', $event)"
        @delete="$emit('delete', $event)"
        @user-click="$emit('user-click', $event)"
        @post-created="$emit('post-created', $event)"
        @cancel-reply="$emit('cancel-reply')"
        @ref="(postId, el) => $emit('ref', postId, el)"
      />
    </div>

    <!-- "Show more replies" button for deeply nested threads -->
    <div 
      v-if="post.replies && post.replies.length > 0 && threadDepth >= maxDepth" 
      class="show-more-replies"
    >
      <button @click="expandThread" class="expand-thread-btn">
        <Icon name="corner-down-right" />
        <span>Show {{ post.replies.length }} more repl{{ post.replies.length === 1 ? 'y' : 'ies' }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { debug } from '@/utils/debug'
import type { ActivityPubPost } from '@/types';

// Components
import MonyPost from './MonyPost.vue';
import Icon from '@/components/common/Icon.vue';

// Props
interface Props {
  post: ActivityPubPost;
  threadDepth: number;
  maxDepth: number;
  highlightedPostId?: string;
  replyingToPostId?: string;
  showReplyComposer: boolean;
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  reply: [post: ActivityPubPost];
  favorite: [postId: string];
  reblog: [postId: string];
  bookmark: [postId: string];
  delete: [postId: string];
  'user-click': [user: any];
  'post-created': [post: ActivityPubPost];
  'cancel-reply': [];
  ref: [postId: string, el: HTMLElement];
}>();

// Computed
const isHighlighted = computed(() => {
  return props.post.id === props.highlightedPostId;
});

// Methods
const handleReply = (post: ActivityPubPost) => {
  emit('reply', post);
};

const handleReplyCreated = (newReply: ActivityPubPost) => {
  // Bubble up to parent; parent owns the replies array and re-renders.
  emit('post-created', newReply);
};

const expandThread = () => {
  // TODO: Navigate to a dedicated expanded thread view
  // For now, we could emit an event or navigate to the conversation root
  debug.log(`Expanding thread for post: ${props.post.id}`);
};
</script>

<style scoped>
.threaded-post {
  position: relative;
  margin-left: calc(var(--thread-depth) * 1.5rem);
  margin-bottom: 0.5rem;
}

.thread-line {
  position: absolute;
  left: -0.75rem;
  top: 0;
  bottom: 0;
  width: 1px;
  background: linear-gradient(
    to bottom,
    transparent 0%,
    #80848e 50%,
    transparent 100%
  );
  opacity: 0.3;
}

.post-content {
  transition: all 0.3s ease;
  position: relative;
  border-radius: 12px;
}


.deep-thread {
  margin-left: calc(3 * 1.5rem); /* Cap indentation at 3 levels */
}

.deep-thread .thread-line {
  background: linear-gradient(
    135deg,
    transparent 0%,
    #0EA5E9 50%,
    transparent 100%
  );
}

.nested-reply-composer {
  margin-top: 1rem;
  margin-left: 1rem;
  background: var(--h-chat, #313338);
  border-radius: 8px;
  padding: 0.75rem;
  border-left: 3px solid var(--h-brand, #0EA5E9);
}

.nested-replies {
  margin-top: 0.5rem;
}

.show-more-replies {
  margin-top: 1rem;
  margin-left: 1rem;
}

.expand-thread-btn {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  background: none;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: #80848e;
  cursor: pointer;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  transition: all 0.2s;
  width: 100%;
}

.expand-thread-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  border-color: rgba(255, 255, 255, 0.2);
  color: var(--text-primary);
}

/* Thread depth styling adjustments */
.threaded-post:nth-child(odd) .thread-line {
  background: linear-gradient(
    to bottom,
    #80848e 0%,
    rgba(14, 165, 233, 0.5) 50%,
    transparent 100%
  );
}

/* Hover effects for thread navigation */
.threaded-post:hover .thread-line {
  opacity: 0.6;
  background: linear-gradient(
    to bottom,
    var(--h-brand, #0EA5E9) 0%,
    var(--h-brand, #0EA5E9) 50%,
    transparent 100%
  );
}

/* Mobile responsiveness */
@media (max-width: 768px) {
  .threaded-post {
    margin-left: calc(min(var(--thread-depth), 2) * 1rem);
  }
  
  .deep-thread {
    margin-left: calc(2 * 1rem);
  }
  
  .post-content {
    padding: 0.75rem;
  }
  
  .nested-reply-composer {
    margin-left: 0.5rem;
    padding: 0.5rem;
  }
}

/* Accessibility improvements */
.threaded-post:focus-within .post-content {
  outline: 2px solid var(--h-brand, #0EA5E9);
  outline-offset: 2px;
}

/* Animation for new replies */
@keyframes slideInReply {
  from {
    opacity: 0;
    transform: translateY(-10px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.threaded-post.new-reply {
  animation: slideInReply 0.3s ease-out;
}
</style> 