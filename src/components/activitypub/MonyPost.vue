<!-- MonyPost Component - Individual post display -->
<!-- Professional, engaging UI for ActivityPub posts -->
<template>
  <article class="mony-post" :class="{ 'is-reply': post.in_reply_to }">
    <!-- Main Post Content -->
    <div class="post-content">
      <!-- Author Info -->
      <div class="post-header">
        <div 
          class="author-info"
          @click="handleAuthorClick"
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
              {{ authorHandle }}
            </div>
          </div>
        </div>
        
        <div class="post-meta">
          <span class="instance-domain" :class="{ 'is-local': isLocalPost }">
            {{ instanceDomain }}
          </span>
          <div>
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
          <MonyContent 
            :content="contentText" 
            @user-mention-click="handleMentionClick"
            @hashtag-click="handleHashtagClick"
          />
        </div>

        <!-- Media Attachments -->
        <div 
          v-if="post.media_attachments?.length > 0"
          class="media-gallery"
        >
          <!-- Simple media display for now -->
          <div 
            v-for="media in post.media_attachments" 
            :key="media.id"
            class="media-item"
          >
            <img 
              v-if="media.type === 'image'" 
              :src="media.url" 
              :alt="media.description || 'Media attachment'"
              class="media-image"
            />
            <video 
              v-else-if="media.type === 'video'" 
              :src="media.url" 
              controls
              class="media-video"
            >
              Your browser does not support the video tag.
            </video>
          </div>
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

        <!-- TODO: implement bookmarking -->
        <button 
          class="action-button bookmark-button"
          :class="{ active: post.interactions?.is_bookmarked }"
          @click="onBookmark"
          :title="post.interactions?.is_bookmarked ? 'Remove bookmark' : 'Bookmark'"
        >
          <Icon :name="post.interactions?.is_bookmarked ? 'bookmark-filled' : 'bookmark'" />
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
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
  'user-click': [user: any]; // For when clicking on the author
  'show-conversation': [postId: string]; // New emit for showing conversation
}>();

// Store
const authStore = useAuthStore();

// Local state
const showSensitiveContent = ref(false);
const showMenu = ref(false);

// Extend HTMLElement type for click outside handler
declare global {
  interface HTMLElement {
    _clickOutsideHandler?: (event: Event) => void;
  }
}

// Computed
const author = computed(() => {
  return props.post.author;
});

const authorHandle = computed(() => {
  const { username, domain } = props.post.author;
  return domain === 'har.mony.lol' || domain === 'harmony.com' 
    ? `@${username}` 
    : `@${username}@${domain}`;
});

const instanceDomain = computed(() => {
  const { domain } = props.post.author;
  return domain || 'har.mony.lol';
});

const isAuthorLocal = computed(() => {
  const { domain } = props.post.author;
  return domain === 'har.mony.lol' || domain === 'harmony.com';
});

const contentText = computed(() => {
  // Convert MessagePart[] to string for display
  if (Array.isArray(props.post.content)) {
    return props.post.content
      .map(part => {
        if (part.type === 'text') return part.text;
        if (part.type === 'mention') return part.mention;
        if (part.type === 'url') return part.url;
        return '';
      })
      .join('');
  }
  return typeof props.post.content === 'string' ? props.post.content : '';
});

const canEdit = computed(() => {
  return authStore.session?.user?.id === props.post.author_id;
});

const canDelete = computed(() => {
  return authStore.session?.user?.id === props.post.author_id;
});

const visibilityIcon = computed(() => {
  switch (props.post.visibility) {
    case 'public': return 'globe';
    case 'unlisted': return 'unlock';
    case 'followers': return 'users';
    case 'direct': return 'mail';
    default: return 'globe';
  }
});

const visibilityTitle = computed(() => {
  switch (props.post.visibility) {
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
  emit('reblog', props.post.id);
};

const onFavorite = () => {
  emit('favorite', props.post.id);
};

const onBookmark = () => {
  emit('bookmark', props.post.id);
};

const onEdit = () => {
  emit('edit', props.post.id);
  closeMenu();
};

const onDelete = () => {
  emit('delete', props.post.id);
  closeMenu();
};

const showReplyTarget = () => {
  if (props.post.in_reply_to) {
    // Navigate to the parent post or conversation thread
    emit('show-conversation', props.post.in_reply_to);
  }
};

const copyLink = async () => {
  try {
    const url = props.post.url || `${window.location.origin}/posts/${props.post.id}`;
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
    if (el._clickOutsideHandler) {
      document.removeEventListener('click', el._clickOutsideHandler);
    }
  }
};

const isLocalPost = computed(() => {
  return props.post.is_local || instanceDomain.value === 'har.mony.lol';
});

const handleAuthorClick = (event: Event) => {
  event.preventDefault();
  event.stopPropagation();
  emit('user-click', author.value);
};

const handleMentionClick = (handle: string) => {
  emit('user-mention-click', handle);
};

const handleHashtagClick = (tag: string) => {
  emit('hashtag-click', tag);
};
</script>

<style scoped>
.mony-post {
  background-color: var(--background-quinary);
  border-bottom: 1px solid var(--border-color);
  transition: background-color 0.2s;
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
  flex-direction: column;
  align-items: flex-end;
  justify-content: flex-end;
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
  justify-content: flex-end;
}

.instance-domain {
  display: flex;
  align-items: center;
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

.post-body.is-sensitive:hover {
  filter: blur(0px);
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
