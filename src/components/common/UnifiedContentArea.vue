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
        :channelName="channelName"
        :dmUsername="dmUsername"
        :loadMoreMessages="() => $emit('load-more-messages')"
        @update:isAtBottom="$emit('update:is-at-bottom', $event)" 
        @showAllThreads="$emit('show-all-threads')"
      />
    </div>
    
    <!-- ActivityPub Mode Content -->
    <div v-else-if="mode === ViewMode.ACTIVITYPUB" class="content-section social-content">

      <!-- Special Views (Bookmarks, Lists, etc.) -->
      <div v-if="viewType !== ViewType.TIMELINE" class="special-view">
        <ViewHeader
          :view-type="viewType"
          :data-count="specialViewData?.length || 0"
          @clear-all="$emit('clear-all-bookmarks')"
        />

        <PostsContainer
          :posts="specialViewData || []"
          :is-loading="isLoadingFeed"
          :has-more="hasMoreSpecialData"
          :error="loadError"
          :loading-message="t('common.loading')"
          :empty-title="getEmptyStateTitle(viewType)"
          :empty-message="getSpecialViewEmptyMessage(viewType)"
          :empty-icon="getViewIcon(viewType)"
          :empty-action="viewType === ViewType.BOOKMARKS ? $t('activitypub.browseTimeline') : undefined"
          @load-more="$emit('load-more-special-data')"
          @retry="$emit('refresh-timeline')"
          @empty-action="$emit('switch-feed', 'home')"
          @posts-visible="$emit('posts-visible', $event)"
        />
      </div>
      
      <!-- Timeline View -->
      <div v-else class="content-timeline" data-testid="timeline-feed">
        <!-- Composer (if home timeline) -->
        <div 
          v-if="currentView === 'home'" 
          class="composer-section"
          :class="{ 'composer-hidden': composerHidden }"
        >
          <Composer 
            mode="inline"
            type="post"
            @posted="$emit('post-created', $event)"
          />
        </div>

        <div class="timeline-list">
          <button
            v-if="pendingCount > 0"
            type="button"
            class="new-posts-pill"
            @click="handleShowPending"
          >
            <Icon name="arrow-up" :size="16" />
            {{ t('activitypub.newPostsCount', { count: pendingCount }, pendingCount) }}
          </button>

          <PostsContainer
            :posts="posts"
            :register-scroll="handleRegisterScroll"
            :is-loading="isLoadingFeed"
            :has-more="hasMorePosts"
            :error="loadError"
            :loading-message="t('common.loading')"
            :empty-title="getTimelineEmptyTitle()"
            :empty-message="getTimelineEmptyMessage()"
            :empty-action="currentView === 'home' ? $t('activitypub.browseFederatedTimeline') : undefined"
            @load-more="$emit('load-more-posts')"
            @retry="$emit('refresh-timeline')"
            @empty-action="$emit('switch-feed', 'public')"
            @reply="$emit('reply-to-post', $event)"
            @favorite="$emit('favorite-post', $event)"
            @reblog="$emit('reblog-post', $event)"
            @bookmark="$emit('bookmark-post', $event)"
            @delete="$emit('delete-post', $event)"
            @edit="handleEditPost"
            @user-click="$emit('show-user-profile', $event)"
            @hashtag-click="handleHashtagClick"
            @show-conversation="handleShowConversation"
          />
        </div>

        <!-- Edit Composer Modal -->
        <Composer
          v-if="editingPost"
          mode="modal"
          type="edit"
          :edit-post="editingPost"
          :is-open="!!editingPost"
          @close="editingPost = null"
          @edited="editingPost = null"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import ChatComponent from '@/components/ChatComponent.vue'
import Icon from '@/components/common/Icon.vue'
import Composer from '@/components/activitypub/Composer.vue'
import PostsContainer from './PostsContainer.vue'
import ViewHeader from './ViewHeader.vue'
import type { Message, TimelinePost, FederatedUser } from '@/types'
import { ViewMode, ViewType } from '@/types/viewTypes'

const router = useRouter()

const composerHidden = ref(false)
const timelineScrollEl = ref<HTMLElement | null>(null)
let lastScrollY = 0
let scrollTicking = false

const isMobileDevice = () => window.innerWidth <= 768

// Scroll offset (px) past which the timeline counts as scrolled and realtime
// posts queue behind the "new posts" pill.
const SCROLLED_THRESHOLD = 120
let timelineScrolled = false

function handleRegisterScroll(el: HTMLElement | null) {
  if (timelineScrollEl.value && timelineScrollEl.value !== el) {
    timelineScrollEl.value.removeEventListener('scroll', handleTimelineScroll)
  }
  timelineScrollEl.value = el
  if (el) {
    lastScrollY = el.scrollTop
    el.addEventListener('scroll', handleTimelineScroll, { passive: true })
  }
}

function handleTimelineScroll() {
  const el = timelineScrollEl.value
  if (!el) return
  if (scrollTicking) return
  scrollTicking = true
  requestAnimationFrame(() => {
    const currentY = el.scrollTop
    const scrolled = currentY > SCROLLED_THRESHOLD
    if (scrolled !== timelineScrolled) {
      timelineScrolled = scrolled
      emit('timeline-scrolled', scrolled)
    }
    if (!isMobileDevice()) {
      composerHidden.value = false
    } else {
      const delta = currentY - lastScrollY
      if (delta > 12 && currentY > 80) {
        composerHidden.value = true
      } else if (delta < -6) {
        composerHidden.value = false
      }
    }
    lastScrollY = currentY
    scrollTicking = false
  })
}

function handleShowPending() {
  const el = timelineScrollEl.value
  if (el) el.scrollTop = 0
  composerHidden.value = false
  emit('show-pending')
}

onUnmounted(() => {
  if (timelineScrollEl.value) {
    timelineScrollEl.value.removeEventListener('scroll', handleTimelineScroll)
    timelineScrollEl.value = null
  }
})

interface Props {
  // Accept both `ViewMode` enum values and matching string literals so legacy
  // call sites that pass `mode="chat"` / `mode="activitypub"` still type-check.
  mode: ViewMode | 'chat' | 'activitypub';

  // Chat mode props
  chatMessages?: Message[];
  isLoading?: boolean;
  isDM?: boolean;
  channelId?: string;
  conversationId?: string;
  channelName?: string;
  dmUsername?: string;

  // ActivityPub mode props. Same accommodation as `mode`: accept both the
  // enum and the raw string variants the routed views still emit.
  viewType?: ViewType | 'timeline' | 'explore' | 'profile' | 'post' | 'hashtag' | 'bookmarks' | 'mentions' | 'lists' | 'dm' | 'chat';
  currentView?: string; // Can be timeline feeds or explore views
  posts?: TimelinePost[];
  isLoadingFeed?: boolean;
  hasMorePosts?: boolean;

  /** First-page load failure for the shown feed. */
  loadError?: string | null;
  /** Realtime posts queued behind the "new posts" pill. */
  pendingCount?: number;

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
  hasMoreSpecialData: false,
  loadError: null,
  pendingCount: 0
});

const emit = defineEmits<{
  // Chat mode events
  'load-more-messages': []
  'update:is-at-bottom': [value: boolean]
  'show-all-threads': []
  
  // Essential ActivityPub events (interactions now handled by composable)
  'post-created': [post: TimelinePost]
  'switch-feed': [feedType: 'home' | 'local' | 'public']
  'load-more-posts': []
  'load-more-special-data': []
  'clear-all-bookmarks': []
  'back-to-timeline': []
  'refresh-timeline': []
  'timeline-scrolled': [scrolled: boolean]
  'show-pending': []
  
  // Post interaction events. See PostsContainer for why these forward
  // `post: TimelinePost` rather than a bare id - the upstream feed views
  // (TimelineView/BookmarksView/MentionsView/NotificationsView) declare
  // handlers `(post: TimelinePost) => Promise<void>` and re-emit the
  // full post, so keeping the payload as a post here avoids a TS2322
  // mismatch at every parent's `@favorite-post="..."` binding site.
  'reply-to-post': [post: any]
  'favorite-post': [post: TimelinePost]
  'reblog-post': [post: TimelinePost]
  'bookmark-post': [post: TimelinePost]
  'delete-post': [post: TimelinePost]
  'show-user-profile': [user: any]

  // MentionsView clears notifications for posts scrolled past.
  // See PostsContainer.posts-visible.
  'posts-visible': [postIds: string[]]
}>()

// Navigation handlers
const handleHashtagClick = (tag: string) => {
  router.push({ name: 'HashtagView', params: { tag } })
}

const handleShowConversation = (postId: string) => {
  router.push({ name: 'PostDetail', params: { postId } })
}

const editingPost = ref<TimelinePost | null>(null)

const handleEditPost = (postId: string) => {
  const post = props.posts.find(p => p.id === postId) || props.specialViewData?.find(p => p.id === postId)
  if (post) {
    editingPost.value = post
  }
}

const { t } = useI18n()

// Feed switches reuse this instance; a new feed opens at its top.
watch(() => props.currentView, () => {
  const el = timelineScrollEl.value
  if (el) el.scrollTop = 0
  timelineScrolled = false
  composerHidden.value = false
})

const getTimelineEmptyTitle = () => {
  switch (props.currentView) {
    case 'home': return t('activitypub.welcomeToSocial')
    case 'local': return t('activitypub.emptyTimeline')
    case 'public': return t('activitypub.emptyTimeline')
    default: return t('activitypub.noPostsYet')
  }
}

const getTimelineEmptyMessage = () => {
  switch (props.currentView) {
    case 'home': return t('activitypub.followUsersToSee')
    case 'local': return t('activitypub.noLocalPosts')
    case 'public': return t('activitypub.noPublicPosts')
    default: return t('activitypub.noPostsFound')
  }
}

// Helper functions for special views
const getViewIcon = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || 'home'
  switch (typeStr) {
    case 'explore': return 'compass'
    case 'bookmarks': return 'bookmark'
    case 'lists': return 'list'
    case 'mentions': return 'at-sign'
    case 'profile': return 'user'
    default: return 'home'
  }
}

const getEmptyStateTitle = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || ''
  switch (typeStr) {
    case 'bookmarks': return t('activitypub.noBookmarksYet')
    case 'mentions': return t('activitypub.noMentionsYet')
    default: return t('activitypub.nothingToSee')
  }
}

const getSpecialViewEmptyMessage = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || ''
  switch (typeStr) {
    case 'bookmarks': return t('activitypub.noBookmarksHint')
    case 'mentions': return t('activitypub.noMentionsHint')
    default: return t('activitypub.noPostsFound')
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
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.timeline-list {
  position: relative;
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}

.new-posts-pill {
  position: absolute;
  top: var(--space-3);
  left: 50%;
  transform: translateX(-50%);
  z-index: 5;
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-full);
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  box-shadow: var(--shadow-medium);
  cursor: pointer;
}

.new-posts-pill:hover {
  background: var(--harmony-primary-hover);
}

.new-posts-pill:focus-visible {
  outline: 2px solid var(--text-primary);
  outline-offset: 2px;
}

.composer-section {
  width: 100%;
  max-width: 600px;
  margin: 0 auto;
  padding: var(--space-4);
  border-bottom: 1px solid var(--border-color);
  position: relative;
  flex-shrink: 0;
  transition: transform 0.25s cubic-bezier(0.25, 0.46, 0.45, 0.94),
              opacity 0.25s ease,
              margin 0.25s ease;
  overflow: visible;
}

.composer-section.composer-hidden {
  transform: translateY(-100%);
  opacity: 0;
  margin-bottom: -200px; /* Collapse space without clipping */
  pointer-events: none;
}

.special-view {
  height: 100%;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: var(--background-primary);
}

.composer-section :deep(.composer-inline-content) {
  border: none;
  box-shadow: none;
  padding: 0;
  background: transparent;
}

@media (min-width: 769px) {
  .composer-section {
    border-left: 1px solid var(--border-color);
    border-right: 1px solid var(--border-color);
  }
}

@media (max-width: 768px) {
  .composer-section {
    padding: var(--space-3);
  }
}
</style>