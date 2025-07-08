<!-- MonyPost Component - Individual post display -->
<!-- Professional, engaging UI for ActivityPub posts -->
<template>
  <article class="mony-post" :class="{ 'is-reply': post.in_reply_to }">
    <!-- Reblog Header (if this is a reblog) -->
    <div v-if="post.reblog" class="reblog-header">
      <Icon name="reblog" class="reblog-icon" />
      <router-link 
        :to="`/u/${post.reblog_author?.handle}`" 
        class="reblog-author"
      >
        {{ post.reblog_author?.display_name || post.reblog_author?.username }}
      </router-link>
      <span class="reblog-text">reblogged</span>
    </div>

    <!-- Main Post Content -->
    <div class="post-content">
      <!-- Author Info -->
      <div class="post-header">
        <router-link 
          :to="`/u/${author.handle}`" 
          class="author-info"
        >
          <Avatar 
            :src="author.avatar_url"
            :alt="author.display_name || author.username"
            size="md"
            :interactive="true"
          />
          <div class="author-details">
            <div class="author-name">
              {{ author.display_name || author.username }}
            </div>
            <div class="author-handle">
              {{ author.handle }}
            </div>
          </div>
        </router-link>
        
        <div class="post-meta">
          <time 
            :datetime="post.created_at" 
            :title="formatFullDate(post.created_at)"
            class="post-time"
          >
            {{ formatRelativeTime(post.created_at) }}
          </time>
          
          <!-- Visibility Indicator -->
          <div class="visibility-indicator" :title="visibilityTitle">
            <Icon :name="visibilityIcon" />
          </div>
          
          <!-- Instance Badge (for federated posts) -->
          <div v-if="!author.is_local" class="instance-badge" :title="`From ${author.domain}`">
            <Icon name="federation" />
          </div>
        </div>
      </div>

      <!-- Reply Context (if this is a reply) -->
      <div v-if="post.in_reply_to" class="reply-context">
        <Icon name="reply" />
        <span>Replying to</span>
        <button 
          class="reply-target"
          @click="showReplyTarget"
        >
          conversation
        </button>
      </div>

      <!-- Content Warning -->
      <div v-if="post.content_warning" class="content-warning">
        <div class="cw-header">
          <Icon name="warning" />
          <span>{{ post.content_warning }}</span>
        </div>
        <button 
          class="cw-toggle"
          @click="showSensitiveContent = !showSensitiveContent"
        >
          {{ showSensitiveContent ? 'Hide' : 'Show' }} content
        </button>
      </div>

      <!-- Post Body -->
      <div 
        v-show="!post.content_warning || showSensitiveContent"
        class="post-body"
        :class="{ 'is-sensitive': post.is_sensitive }"
      >
        <!-- Text Content -->
        <div class="post-text">
          <MonyContent :content="post.content" />
        </div>

        <!-- Media Attachments -->
        <MonyMediaGallery 
          v-if="post.media_attachments?.length > 0"
          :attachments="post.media_attachments"
          :sensitive="post.is_sensitive"
        />
      </div>

      <!-- Interaction Stats -->
      <div class="interaction-stats">
        <div class="stat-item" v-if="post.replies_count > 0">
          <Icon name="message-circle" />
          <span>{{ formatCount(post.replies_count) }}</span>
        </div>
        <div class="stat-item" v-if="post.reblogs_count > 0">
          <Icon name="reblog" />
          <span>{{ formatCount(post.reblogs_count) }}</span>
        </div>
        <div class="stat-item" v-if="post.favorites_count > 0">
          <Icon name="heart" />
          <span>{{ formatCount(post.favorites_count) }}</span>
        </div>
      </div>

      <!-- Action Buttons -->
      <div class="post-actions">
        <button 
          class="action-button reply-button"
          @click="onReply"
          :title="'Reply to ' + author.display_name"
        >
          <Icon name="message-circle" />
          <span v-if="post.replies_count > 0">{{ formatCount(post.replies_count) }}</span>
        </button>

        <button 
          class="action-button reblog-button"
          :class="{ active: post.is_reblogged }"
          @click="onReblog"
          :title="post.is_reblogged ? 'Undo reblog' : 'Reblog'"
        >
          <Icon name="reblog" />
          <span v-if="post.reblogs_count > 0">{{ formatCount(post.reblogs_count) }}</span>
        </button>

        <button 
          class="action-button favorite-button"
          :class="{ active: post.is_favorited }"
          @click="onFavorite"
          :title="post.is_favorited ? 'Unfavorite' : 'Favorite'"
        >
          <Icon :name="post.is_favorited ? 'heart-filled' : 'heart'" />
          <span v-if="post.favorites_count > 0">{{ formatCount(post.favorites_count) }}</span>
        </button>

        <button 
          class="action-button bookmark-button"
          :class="{ active: post.is_bookmarked }"
          @click="onBookmark"
          :title="post.is_bookmarked ? 'Remove bookmark' : 'Bookmark'"
        >
          <Icon :name="post.is_bookmarked ? 'bookmark-filled' : 'bookmark'" />
        </button>

        <div class="action-menu">
          <button class="action-button menu-button" @click="showMenu = !showMenu">
            <Icon name="more-horizontal" />
          </button>
          
          <div v-if="showMenu" class="action-dropdown" v-click-outside="closeMenu">
            <button 
              class="dropdown-item"
              @click="copyLink"
            >
              <Icon name="link" />
              <span>Copy link</span>
            </button>
            
            <button 
              v-if="canEdit"
              class="dropdown-item"
              @click="onEdit"
            >
              <Icon name="edit" />
              <span>Edit</span>
            </button>
            
            <button 
              v-if="canDelete"
              class="dropdown-item danger"
              @click="onDelete"
            >
              <Icon name="trash" />
              <span>Delete</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { useAuthStore } from '@/stores/auth';
import { formatDistanceToNow, format } from 'date-fns';
import type { TimelinePost } from '@/types';

// Components
import MonyContent from './MonyContent.vue';
import MonyMediaGallery from './MonyMediaGallery.vue';
import Icon from '@/components/common/Icon.vue';
import Avatar from '../common/Avatar.vue';

// Props
interface Props {
  post: TimelinePost;
}

const props = defineProps<Props>();

// Emits
const emit = defineEmits<{
  favorite: [postId: string];
  reblog: [postId: string];
  bookmark: [postId: string];
  reply: [post: TimelinePost];
  delete: [postId: string];
  edit: [postId: string];
  click: [post: TimelinePost];
}>();

// Store
const authStore = useAuthStore();

// Local state
const showSensitiveContent = ref(false);
const showMenu = ref(false);

// Computed
const author = computed(() => {
  return props.post.reblog?.author || props.post.author;
});

const actualPost = computed(() => {
  return props.post.reblog || props.post;
});

const canEdit = computed(() => {
  return authStore.session?.user?.id === actualPost.value.author_id;
});

const canDelete = computed(() => {
  return authStore.session?.user?.id === actualPost.value.author_id;
});

const visibilityIcon = computed(() => {
  switch (actualPost.value.visibility) {
    case 'public': return 'globe';
    case 'unlisted': return 'unlock';
    case 'followers': return 'users';
    case 'direct': return 'mail';
    default: return 'globe';
  }
});

const visibilityTitle = computed(() => {
  switch (actualPost.value.visibility) {
    case 'public': return 'Public - visible to everyone';
    case 'unlisted': return 'Unlisted - not shown in public timelines';
    case 'followers': return 'Followers only';
    case 'direct': return 'Direct message';
    default: return 'Public';
  }
});

// Methods
const formatRelativeTime = (dateString: string) => {
  try {
    return formatDistanceToNow(new Date(dateString), { addSuffix: true });
  } catch {
    return 'Unknown time';
  }
};

const formatFullDate = (dateString: string) => {
  try {
    return format(new Date(dateString), 'PPP p');
  } catch {
    return 'Invalid date';
  }
};

const formatCount = (count: number) => {
  if (count < 1000) return count.toString();
  if (count < 10000) return (count / 1000).toFixed(1) + 'K';
  if (count < 1000000) return Math.floor(count / 1000) + 'K';
  return (count / 1000000).toFixed(1) + 'M';
};

const onReply = () => {
  emit('reply', props.post);
};

const onReblog = () => {
  emit('reblog', actualPost.value.id);
};

const onFavorite = () => {
  emit('favorite', actualPost.value.id);
};

const onBookmark = () => {
  emit('bookmark', actualPost.value.id);
};

const onEdit = () => {
  emit('edit', actualPost.value.id);
  closeMenu();
};

const onDelete = () => {
  emit('delete', actualPost.value.id);
  closeMenu();
};

const showReplyTarget = () => {
  // Navigate to the reply target or show context
  // This could open a thread view or highlight the parent post
};

const copyLink = async () => {
  try {
    const url = actualPost.value.url || `${window.location.origin}/posts/${actualPost.value.id}`;
    await navigator.clipboard.writeText(url);
    // You could show a toast here
  } catch (error) {
    console.error('Failed to copy link:', error);
  }
  closeMenu();
};

const closeMenu = () => {
  showMenu.value = false;
};

// Click outside directive
const vClickOutside = {
  mounted(el: HTMLElement, binding: any) {
    el._clickOutsideHandler = (event: Event) => {
      if (!(el === event.target || el.contains(event.target as Node))) {
        binding.value();
      }
    };
    document.addEventListener('click', el._clickOutsideHandler);
  },
  unmounted(el: HTMLElement) {
    document.removeEventListener('click', el._clickOutsideHandler);
  }
};
</script>

<style scoped>
.mony-post {
  background-color: var(--background-quinary);
  border-bottom: 1px solid var(--border-color);
  transition: background-color 0.2s;
  cursor: pointer;
  border-radius: 12px;
}

.mony-post:hover {
  background-color: var(--background-quaternary);
}

.mony-post.is-reply {
  border-left: 3px solid #2563eb;
}

.reblog-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.75rem 1rem 0;
  color: #9ca3af;
  font-size: 0.875rem;
}

.reblog-icon {
  color: #10b981;
}

.reblog-author {
  color: #3b82f6;
  text-decoration: none;
  font-weight: 500;
}

.reblog-author:hover {
  text-decoration: underline;
}

.post-content {
  padding: 1rem;
}

.post-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}

.author-info {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  text-decoration: none;
  color: inherit;
  flex: 1;
}

.author-avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
}

.author-details {
  flex: 1;
  min-width: 0;
}

.author-name {
  font-weight: 600;
  color: white;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.author-handle {
  color: #9ca3af;
  font-size: 0.875rem;
  text-overflow: ellipsis;
  overflow: hidden;
  white-space: nowrap;
}

.post-meta {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  color: #9ca3af;
  font-size: 0.875rem;
  flex-shrink: 0;
}

.post-time:hover {
  text-decoration: underline;
}

.visibility-indicator {
  display: flex;
  align-items: center;
}

.instance-badge {
  display: flex;
  align-items: center;
  color: #10b981;
}

.reply-context {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
  color: #9ca3af;
  font-size: 0.875rem;
}

.reply-target {
  color: #3b82f6;
  background: none;
  border: none;
  text-decoration: underline;
  cursor: pointer;
  font-size: inherit;
}

.content-warning {
  background-color: #374151;
  border-radius: 0.5rem;
  padding: 1rem;
  margin-bottom: 1rem;
}

.cw-header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin-bottom: 0.5rem;
  color: #fbbf24;
  font-weight: 500;
}

.cw-toggle {
  background-color: #4b5563;
  color: white;
  border: none;
  padding: 0.5rem 1rem;
  border-radius: 0.25rem;
  cursor: pointer;
  font-size: 0.875rem;
}

.cw-toggle:hover {
  background-color: #6b7280;
}

.post-body {
  margin-bottom: 1rem;
}

.post-body.is-sensitive {
  filter: blur(10px);
  transition: filter 0.2s;
}

.post-text {
  color: white;
  line-height: 1.6;
  word-wrap: break-word;
  margin-bottom: 1rem;
}

.interaction-stats {
  display: flex;
  gap: 1rem;
  margin-bottom: 0.75rem;
  color: #9ca3af;
  font-size: 0.875rem;
}

.stat-item {
  display: flex;
  align-items: center;
  gap: 0.25rem;
}

.post-actions {
  display: flex;
  align-items: center;
  gap: 1rem;
  position: relative;
}

.action-button {
  display: flex;
  align-items: center;
  gap: 0.25rem;
  padding: 0.5rem;
  background: none;
  border: none;
  color: #9ca3af;
  cursor: pointer;
  border-radius: 0.25rem;
  transition: all 0.2s;
  font-size: 0.875rem;
}

.action-button:hover {
  background-color: #374151;
  color: white;
}

.reply-button:hover {
  color: #3b82f6;
  background-color: rgba(59, 130, 246, 0.1);
}

.reblog-button:hover {
  color: #10b981;
  background-color: rgba(16, 185, 129, 0.1);
}

.reblog-button.active {
  color: #10b981;
}

.favorite-button:hover {
  color: #ef4444;
  background-color: rgba(239, 68, 68, 0.1);
}

.favorite-button.active {
  color: #ef4444;
}

.bookmark-button:hover {
  color: #f59e0b;
  background-color: rgba(245, 158, 11, 0.1);
}

.bookmark-button.active {
  color: #f59e0b;
}

.action-menu {
  position: relative;
  margin-left: auto;
}

.action-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  background-color: #1f2937;
  border: 1px solid #374151;
  border-radius: 0.5rem;
  padding: 0.5rem;
  min-width: 150px;
  box-shadow: 0 10px 15px -3px rgba(0, 0, 0, 0.1);
  z-index: 10;
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  width: 100%;
  padding: 0.5rem;
  background: none;
  border: none;
  color: white;
  text-align: left;
  cursor: pointer;
  border-radius: 0.25rem;
  font-size: 0.875rem;
}

.dropdown-item:hover {
  background-color: #374151;
}

.dropdown-item.danger {
  color: #ef4444;
}

.dropdown-item.danger:hover {
  background-color: rgba(239, 68, 68, 0.1);
}

/* Mobile responsive */
@media (max-width: 768px) {
  .post-content {
    padding: 0.75rem;
  }
  
  .author-avatar {
    width: 36px;
    height: 36px;
  }
  
  .post-actions {
    gap: 0.5rem;
  }
  
  .action-button {
    padding: 0.375rem;
  }
}
</style>
