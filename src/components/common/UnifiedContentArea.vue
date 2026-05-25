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

      <!-- Explore View -->
      <ExploreContent
        v-if="viewType === ViewType.EXPLORE"
        :current-view="(currentView || 'trending') as any"
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
          :empty-action="viewType === ViewType.BOOKMARKS ? $t('activitypub.browseTimeline') : undefined"
          @load-more="$emit('load-more-special-data')"
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

        <!-- Timeline Posts -->
        <PostsContainer
          :posts="posts"
          :register-scroll="handleRegisterScroll"
          :is-loading="isLoadingFeed"
          :has-more="hasMorePosts"
          :loading-message="getTimelineLoadingMessage()"
          :empty-title="getTimelineEmptyTitle()"
          :empty-message="getTimelineEmptyMessage()"
          :empty-action="currentView === 'home' ? $t('activitypub.explorePublicTimeline') : undefined"
          @load-more="$emit('load-more-posts')"
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
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import ChatComponent from '@/components/ChatComponent.vue'
import Composer from '@/components/activitypub/Composer.vue'
import ExploreContent from '@/components/activitypub/ExploreContent.vue'
import PostDetailDisplay from './PostDetailDisplay.vue'
import PostsContainer from './PostsContainer.vue'
import ViewHeader from './ViewHeader.vue'
import type { Message, TimelinePost, FederatedUser } from '@/types'
import { ViewMode, ViewType } from '@/types/viewTypes'
import { usePostInteractions } from '@/composables/usePostInteractions'

const router = useRouter()

const composerHidden = ref(false)
const timelineScrollEl = ref<HTMLElement | null>(null)
let lastScrollY = 0
let scrollTicking = false

const isMobileDevice = () => window.innerWidth <= 768

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
  if (!isMobileDevice()) {
    composerHidden.value = false
    return
  }
  const el = timelineScrollEl.value
  if (!el) return
  if (scrollTicking) return
  scrollTicking = true
  requestAnimationFrame(() => {
    const currentY = el.scrollTop
    const delta = currentY - lastScrollY
    if (delta > 12 && currentY > 80) {
      composerHidden.value = true
    } else if (delta < -6) {
      composerHidden.value = false
    }
    lastScrollY = currentY
    scrollTicking = false
  })
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
  'show-all-threads': []
  
  // Essential ActivityPub events (interactions now handled by composable)
  'post-created': [post: TimelinePost]
  'switch-feed': [feedType: 'home' | 'local' | 'public']
  'load-more-posts': []
  'load-more-special-data': []
  'clear-all-bookmarks': []
  'back-to-timeline': []
  
  // Post interaction events
  'reply-to-post': [post: any]
  'favorite-post': [postId: string]
  'reblog-post': [postId: string]
  'bookmark-post': [postId: string]
  'delete-post': [postId: string]
  'show-user-profile': [user: any]

  // Visibility (used by MentionsView to clear notifications for posts the
  // user actually scrolls past — see PostsContainer.posts-visible)
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

// Use the post interactions composable for all post-related actions
const postInteractions = usePostInteractions()
const { t } = useI18n()

// Helper functions for timeline states
const getTimelineLoadingMessage = () => {
  switch (props.currentView) {
    case 'home': return t('common.loading') + '...'
    case 'local': return t('common.loading') + '...'
    case 'public': return t('common.loading') + '...'
    default: return t('common.loading') + '...'
  }
}

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
    case 'explore': return 'Nothing to explore yet'
    case 'bookmarks': return 'No bookmarks yet'
    case 'lists': return 'No lists yet'
    case 'mentions': return 'No mentions yet'
    default: return 'Nothing here yet'
  }
}

const getSpecialViewEmptyMessage = (viewType: any) => {
  const typeStr = typeof viewType === 'string' ? viewType : viewType?.toLowerCase?.() || ''
  switch (typeStr) {
    case 'explore': return 'Check back later for trending content and discover new instances.'
    case 'bookmarks': return 'Posts you bookmark will appear here for easy access later.'
    case 'lists': return 'Create lists to organize users and topics you follow.'
    case 'mentions': return 'Posts where someone @mentions you will appear here - even from people you don\'t follow.'
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
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

.composer-section {
  padding: var(--space-4);
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

@media (max-width: 768px) {
  .composer-section {
    padding: var(--space-1);
  }
}
</style>