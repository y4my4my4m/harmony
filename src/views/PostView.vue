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
        <h1 class="header-title">Post</h1>
        <p v-if="isViewingRemotePost && originalInstanceDomain" class="header-meta">
          From {{ originalInstanceDomain }}
          <span v-if="threadInfo && threadInfo.totalPosts > 1">
            · {{ threadInfo.totalPosts }} posts
          </span>
        </p>
        <p v-else-if="threadInfo" class="header-meta">
          {{ threadInfo.totalPosts }} post{{ threadInfo.totalPosts !== 1 ? 's' : '' }}
          <span v-if="threadInfo.participantCount > 1">
            · {{ threadInfo.participantCount }} participant{{ threadInfo.participantCount !== 1 ? 's' : '' }}
          </span>
        </p>
      </div>
      
      <div class="header-actions">
        <a
          v-if="isViewingRemotePost && originalInstanceUrl"
          :href="originalInstanceUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="action-btn view-original-btn"
          :title="'View on ' + (originalInstanceDomain || 'original instance')"
        >
          <Icon name="external-link" />
        </a>
        <button @click="sharePost" class="action-btn" title="Share">
          <Icon name="share" />
        </button>
        <div class="more-actions-wrapper">
          <button @click="showActionsMenu = !showActionsMenu" class="action-btn" title="More actions">
            <Icon name="more-horizontal" />
          </button>
          <div v-if="showActionsMenu" class="actions-dropdown">
            <button @click="copyPostLink" class="dropdown-item">
              <Icon name="link" :size="16" />
              <span>Copy link</span>
            </button>
            <a
              v-if="isViewingRemotePost && originalInstanceUrl"
              :href="originalInstanceUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="dropdown-item"
              @click="showActionsMenu = false"
            >
              <Icon name="external-link" :size="16" />
              <span>View on {{ originalInstanceDomain || 'original instance' }}</span>
            </a>
            <button
              v-if="isViewingRemotePost && !isFetchingReactions"
              @click="handleFetchReactions"
              class="dropdown-item"
            >
              <Icon name="heart" :size="16" />
              <span>Fetch reactions</span>
            </button>
            <button
              v-if="isViewingRemotePost && !isFetchingReplies"
              @click="handleFetchReplies"
              class="dropdown-item"
            >
              <Icon name="message-circle" :size="16" />
              <span>Fetch replies</span>
            </button>
            <button v-if="isOwnPost" @click="handleDeletePost" class="dropdown-item danger">
              <Icon name="trash" :size="16" />
              <span>Delete post</span>
            </button>
          </div>
        </div>
      </div>
    </div>

    <!-- Main content -->
    <div class="post-content" ref="postContainer">
      <!-- Loading state -->
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="32" />
        <p>Loading...</p>
      </div>

      <!-- Error state -->
      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>Post not found</h3>
        <p>{{ error }}</p>
        <a
          v-if="remoteOriginalUrl"
          :href="remoteOriginalUrl"
          target="_blank"
          rel="noopener noreferrer"
          class="back-home-btn"
          style="text-decoration: none;"
        >
          View on original instance
        </a>
        <button @click="goBack" class="back-home-btn">
          Go back to timeline
        </button>
      </div>

      <!-- Post with context - simple unified list -->
      <div v-else-if="postWithContext" class="post-container">
        <!-- All posts in thread order: ancestors -> main -> descendants -->
        <article
          v-for="post in allPostsInOrder"
          :key="post.id"
          class="thread-post"
          :class="{ 
            'highlighted-post': post.id === highlightedPostId,
            'is-main-post': post.id === mainPost?.id
          }"
          :ref="el => post.id === highlightedPostId && setPostRef(post.id, el)"
        >
          <MonyPost
            :post="post"
            :is-in-thread="true"
            :hide-reply-context="true"
            @reply="handleReply"
            @reply-created="handleInlineReplyCreated"
            @favorite="handleFavorite"
            @reblog="handleReblog"
            @bookmark="handleBookmark"
            @delete="handleDelete"
            @edit="handleEdit"
            @user-click="handleUserClick"
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

        <!-- Edit composer modal -->
        <Composer
          v-if="editingPost"
          mode="modal"
          type="edit"
          :edit-post="editingPost"
          :is-open="!!editingPost"
          @close="editingPost = null"
          @edited="handleEdited"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { debug } from '@/utils/debug'
import { useRouter, useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { usePostReactionsStore } from '@/stores/postReactions';
import { activityPubService } from '@/services/activityPubService';
import { useToast } from 'vue-toastification';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import Composer from '@/components/activitypub/Composer.vue';
import { getOriginalPost, getOriginalPostId, getOriginalApId, isReblogPost } from '@/utils/postReblog';

import type { 
  TimelinePost, 
  PostWithContext, 
  PostContextType 
} from '@/types';

// Props
interface Props {
  postId?: string;
  remoteHandle?: string;
  remoteNoteId?: string;
  contextType?: PostContextType;
  highlightReply?: string;
  timestamp?: number | null;
}

const props = withDefaults(defineProps<Props>(), {
  postId: undefined,
  remoteHandle: undefined,
  remoteNoteId: undefined,
  contextType: 'thread',
  highlightReply: undefined,
  timestamp: null
});

// Composables
const router = useRouter();
const route = useRoute();
const activityPub = useActivityPubStore();
const postReactionsStore = usePostReactionsStore();
const toast = useToast();

// Resolved post ID (may come from props or remote resolution)
const resolvedPostId = ref<string | null>(null);

const isViewingRemotePost = computed(() => {
  if (!mainPost.value) return false;
  return !mainPost.value.is_local && !!mainPost.value.ap_id;
});

const originalInstanceUrl = computed(() => {
  if (mainPost.value?.url && !mainPost.value.is_local) return mainPost.value.url;
  if (mainPost.value?.ap_id && !mainPost.value.is_local) return mainPost.value.ap_id;
  if (!props.remoteHandle || !props.remoteNoteId) return null;
  const cleaned = props.remoteHandle.replace(/^@/, '');
  const atIdx = cleaned.indexOf('@');
  if (atIdx < 0) return null;
  const domain = cleaned.slice(atIdx + 1);
  return `https://${domain}/notes/${props.remoteNoteId}`;
});

const originalInstanceDomain = computed(() => {
  const url = originalInstanceUrl.value;
  if (!url) return null;
  try { return new URL(url).hostname; } catch { return null; }
});

// Keep old name for error-state template
const remoteOriginalUrl = originalInstanceUrl;

// Reactive state
const isLoading = ref(true);
const isFetchingReactions = ref(false);
const isFetchingReplies = ref(false);
const error = ref<string | null>(null);
const postWithContext = ref<PostWithContext | null>(null);
const showReplyComposer = ref(false);
const replyToPost = ref<TimelinePost | null>(null);
const replyingToPostId = ref<string | null>(null);
const editingPost = ref<TimelinePost | null>(null);
const postContainer = ref<HTMLElement>();
const postRefs = ref<Record<string, HTMLElement>>({});
const maxThreadDepth = ref(10);
const showActionsMenu = ref(false);

// Computed properties
const mainPost = computed(() => postWithContext.value?.mainPost);
const ancestors = computed(() => postWithContext.value?.ancestors || []);
const descendants = computed(() => postWithContext.value?.descendants || []);
const threadInfo = computed(() => postWithContext.value?.threadInfo);
const highlightedPostId = computed(() => props.highlightReply || postWithContext.value?.highlightedPost);

// All posts in chronological order: ancestors -> main -> descendants
const allPostsInOrder = computed(() => {
  const posts = [];
  if (ancestors.value.length > 0) {
    posts.push(...ancestors.value);
  }
  if (mainPost.value) {
    posts.push(mainPost.value);
  }
  if (descendants.value.length > 0) {
    posts.push(...descendants.value);
  }
  return posts;
});

// Resolve a remote post reference (@user@domain + noteId) to a local UUID
const resolveRemotePost = async (handle: string, noteId: string): Promise<string | null> => {
  const { postResolverService } = await import('@/services/PostResolverService');
  const post = await postResolverService.resolveByHandle(handle, noteId);
  return post?.id || null;
};

// Methods
const loadPostWithContext = async () => {
  try {
    isLoading.value = true;
    error.value = null;
    
    let postId = props.postId || route.params.postId as string;

    // Resolve remote handle+noteId if provided instead of postId
    if (!postId && props.remoteHandle && props.remoteNoteId) {
      const resolved = await resolveRemotePost(props.remoteHandle, props.remoteNoteId);
      if (!resolved) {
        throw new Error(`Post not found on this instance. It may not have been federated here yet.`);
      }
      postId = resolved;
      resolvedPostId.value = resolved;
    }
    
    if (!postId) {
      throw new Error('No postId provided in props or route params');
    }

    resolvedPostId.value = postId;
    
    let result = await activityPub.getPostWithContext(postId, {
      context: props.contextType,
      highlightReply: props.highlightReply,
      maxDepth: maxThreadDepth.value,
      includeInteractions: true
    });

    // If we navigated in via the reblog (Announce) wrapper, the SQL walked the
    // wrong tree - the wrapper has no replies and isn't itself a reply. Swap
    // to the original post id and re-query so ancestors/descendants are found
    // under the original Note.
    if (result.mainPost && isReblogPost(result.mainPost)) {
      const originalId = getOriginalPostId(result.mainPost);
      if (originalId && originalId !== postId) {
        debug.log('[PostView] Detected reblog wrapper, re-resolving to original:', originalId);
        postId = originalId;
        resolvedPostId.value = originalId;
        result = await activityPub.getPostWithContext(originalId, {
          context: props.contextType,
          highlightReply: props.highlightReply,
          maxDepth: maxThreadDepth.value,
          includeInteractions: true,
        });
      }
    }

    postWithContext.value = result;
    
    // Load reactions for all posts in the thread
    const allPostIds = [
      ...result.ancestors.map(p => p.id),
      result.mainPost.id,
      ...result.descendants.map(p => p.id)
    ].filter(Boolean);
    
    if (allPostIds.length > 0) {
      debug.log(`[PostView] Loading reactions for ${allPostIds.length} posts`);
      postReactionsStore.fetchMultiplePostReactions(allPostIds);
    }
    
    // Scroll to highlighted post after content loads
    if (props.highlightReply) {
      await nextTick();
      scrollToPost(props.highlightReply);
    } else if (props.timestamp) {
      // Handle timestamp-based deep linking
      await nextTick();
      scrollToTimestamp(props.timestamp);
    }
    
    // For remote posts, auto-fetch replies AND walk the ancestor chain in
    // the background. Reactions are handled by MonyPost's useRemotePostSync
    // composable on mount.
    //
    // Use the unwrapped main post so we hit the *original* note's collections
    // (the Announce wrapper has no replies/reactions of its own). We also kick
    // off ancestor resolution for federated replies whose parents aren't yet
    // in the local DB - without this, federated reply threads show as a
    // single floating post.
    const mainTarget = result.mainPost ? getOriginalPost(result.mainPost) : null;
    if (mainTarget) {
      const targetApId = getOriginalApId(mainTarget) || mainTarget.ap_id;
      const isRemote = !mainTarget.is_local && !!targetApId;
      if (isRemote) {
        fetchRemoteRepliesInBackground(mainTarget);
        // Walk up the ancestor chain. The federation backend's /resolve-post
        // endpoint imports each ancestor it doesn't already have, links the
        // child via in_reply_to, and populates conversation_root_id - so the
        // local thread RPC can then walk the full chain.
        if (mainTarget.metadata?.in_reply_to_ap_url && !mainTarget.in_reply_to) {
          fetchRemoteAncestorsInBackground(mainTarget);
        }
      }
    }
    
  } catch (err) {
    debug.error('❌ Failed to load post with context:', err);
    error.value = err instanceof Error ? err.message : 'Failed to load post';
    toast.error('Failed to load post');
  } finally {
    isLoading.value = false;
  }
};

const fetchRemoteRepliesInBackground = async (targetPost: TimelinePost) => {
  // Snapshot the post id we're fetching for so we can bail if the user
  // navigates away mid-fetch (otherwise the late context reload below would
  // clobber `postWithContext.value` with stale data).
  const startToken = resolvedPostId.value;
  try {
    const targetApId = getOriginalApId(targetPost) || targetPost.ap_id;
    const targetId = getOriginalPostId(targetPost);
    if (!targetApId) return;
    const result = await activityPubService.fetchRemoteReplies(targetApId, targetId);
    if (result && result.count > 0 && resolvedPostId.value === startToken) {
      const updatedResult = await activityPub.getPostWithContext(targetId, {
        context: props.contextType,
        highlightReply: props.highlightReply,
        maxDepth: maxThreadDepth.value,
        includeInteractions: true,
      });
      if (resolvedPostId.value === startToken) {
        postWithContext.value = updatedResult;
      }
    }
  } catch (err) {
    debug.warn('[PostView] Failed to fetch remote replies:', err);
  }
};

/**
 * Walk a federated post's reply chain upward, importing missing ancestors via
 * the federation backend's /resolve-post endpoint until we hit a post that's
 * already local or a post with no `inReplyTo`. The endpoint links each
 * imported child→parent and stamps `conversation_root_id`, so the local
 * thread RPC will pick up the full chain on the next reload.
 *
 * Cap at MAX_ANCESTOR_DEPTH so a malicious or pathological thread can't make
 * us issue an unbounded number of remote fetches.
 *
 * Two pieces of bookkeeping worth noting:
 *
 *   - `startToken` snapshots which post we're walking for. If the user
 *     navigates to a different post mid-walk, `resolvedPostId.value` will
 *     change and we bail out of the eventual reload - otherwise the late
 *     `getPostWithContext` would clobber `postWithContext.value` with
 *     stale-thread data for the post they already left.
 *   - `newlyImported` only increments on actual new imports (as reported by
 *     `resolveByApUrlWithStatus`), not on cached hits. A walk that touches
 *     only already-local ancestors didn't change anything visible to the
 *     user and shouldn't trigger a redundant reload.
 */
const fetchRemoteAncestorsInBackground = async (target: TimelinePost) => {
  const MAX_ANCESTOR_DEPTH = 10;
  const startToken = resolvedPostId.value;
  try {
    const { postResolverService } = await import('@/services/PostResolverService');
    let parentApUrl: string | undefined = target.metadata?.in_reply_to_ap_url;
    const seen = new Set<string>();
    let newlyImported = 0;

    for (let i = 0; i < MAX_ANCESTOR_DEPTH; i++) {
      if (!parentApUrl || seen.has(parentApUrl)) break;
      // Bail if the user navigated away during the walk.
      if (resolvedPostId.value !== startToken) {
        debug.log('[PostView] Ancestor walker abandoned: navigation changed mid-walk');
        return;
      }
      seen.add(parentApUrl);

      const { post: parent, wasImported } =
        await postResolverService.resolveByApUrlWithStatus(parentApUrl);
      if (!parent) break;
      if (wasImported) newlyImported++;

      // Continue if this ancestor is itself a reply we don't have above.
      // (Server-side /resolve-post does its own chain walk too, so usually one
      // call suffices - but we loop here to handle older versions / partial
      // imports.)
      if (parent.in_reply_to) break;
      parentApUrl = parent.metadata?.in_reply_to_ap_url;
    }

    // Only reload if we actually imported something (cached hits don't
    // change the local thread state) AND the user is still viewing the
    // same post we started with.
    if (newlyImported > 0 && resolvedPostId.value === startToken && startToken) {
      debug.log(`[PostView] Imported ${newlyImported} federated ancestor(s); reloading context`);
      const updatedResult = await activityPub.getPostWithContext(startToken, {
        context: props.contextType,
        highlightReply: props.highlightReply,
        maxDepth: maxThreadDepth.value,
        includeInteractions: true,
      });
      // Re-check the token after the awaited reload too - the user could
      // have navigated during the RPC roundtrip.
      if (resolvedPostId.value === startToken) {
        postWithContext.value = updatedResult;
      }
    }
  } catch (err) {
    debug.warn('[PostView] Failed to fetch remote ancestors:', err);
  }
};

const handleFetchReactions = async () => {
  showActionsMenu.value = false;
  if (!mainPost.value || isFetchingReactions.value) return;
  // Target the *original* note's reactions/replies (Announce wrappers don't
  // collect them) - same rule as the background auto-fetch.
  const targetApId = getOriginalApId(mainPost.value) || mainPost.value.ap_id;
  const targetId = getOriginalPostId(mainPost.value);
  if (!targetApId) return;
  isFetchingReactions.value = true;
  try {
    const result = await activityPubService.fetchRemoteReactions(targetApId, targetId);
    if (result) {
      toast.success(`Fetched ${result.count || 0} reactions`);
      await loadPostWithContext();
    } else {
      toast.error('Failed to fetch reactions');
    }
  } catch {
    toast.error('Failed to fetch reactions');
  } finally {
    isFetchingReactions.value = false;
  }
};

const handleFetchReplies = async () => {
  showActionsMenu.value = false;
  if (!mainPost.value || isFetchingReplies.value) return;
  const targetApId = getOriginalApId(mainPost.value) || mainPost.value.ap_id;
  const targetId = getOriginalPostId(mainPost.value);
  if (!targetApId) return;
  isFetchingReplies.value = true;
  try {
    const result = await activityPubService.fetchRemoteReplies(targetApId, targetId);
    if (result) {
      toast.success(`Fetched ${result.count || 0} replies`);
      await loadPostWithContext();
    } else {
      toast.error('Failed to fetch replies');
    }
  } catch {
    toast.error('Failed to fetch replies');
  } finally {
    isFetchingReplies.value = false;
  }
};

const handleReply = (post: TimelinePost) => {
  // Unwrap reblog wrappers so the reply targets the original author (the
  // booster isn't who the user wants to talk to).
  replyToPost.value = getOriginalPost(post);
  replyingToPostId.value = getOriginalPostId(post);
  showReplyComposer.value = true;
};

// Replies sent from a post's own inline composer (MonyPost handles its reply
// box internally and emits the created reply up). PostView owns the thread
// state and has no realtime subscription of its own, so without this the new
// reply wouldn't appear until a manual reload.
const handleInlineReplyCreated = (newReply: TimelinePost, _parentId: string) => {
  if (!newReply || !postWithContext.value) return;

  // Guard against duplicates (e.g. if a later background reload already
  // included it, or the same event fires twice).
  const alreadyPresent = allPostsInOrder.value.some(p => p.id === newReply.id);
  if (!alreadyPresent) {
    postWithContext.value = {
      ...postWithContext.value,
      descendants: [...postWithContext.value.descendants, newReply]
    };
    if (postWithContext.value.mainPost) {
      postWithContext.value.mainPost.replies_count =
        (postWithContext.value.mainPost.replies_count || 0) + 1;
    }
    debug.log('✅ Inline reply appended to thread:', newReply.id);
  }

  // Reconcile with the server shortly after so counts/threading are accurate.
  setTimeout(() => {
    loadPostWithContext().catch(err => {
      debug.warn('Background refresh failed:', err);
    });
  }, 1000);
};

const handleReplyCreated = async (newReply?: TimelinePost) => {
  showReplyComposer.value = false;
  replyToPost.value = null;
  replyingToPostId.value = null;
  
  // Optimistically add the new reply immediately (so user sees it right away)
  if (newReply && postWithContext.value) {
    // Add to descendants array
    postWithContext.value = {
      ...postWithContext.value,
      descendants: [...postWithContext.value.descendants, newReply]
    };
    
    // Update reply count on main post
    if (postWithContext.value.mainPost) {
      postWithContext.value.mainPost.replies_count = 
        (postWithContext.value.mainPost.replies_count || 0) + 1;
    }
    
    debug.log('✅ Reply added optimistically:', newReply.id);
  }
  
  toast.success('Reply posted!');
  
  // Reload in background to ensure consistency (catches any missed data)
  setTimeout(() => {
    loadPostWithContext().catch(err => {
      debug.warn('Background refresh failed:', err);
    });
  }, 1000);
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

const handleEdit = (postId: string) => {
  const post = allPostsInOrder.value.find(p => p.id === postId);
  if (post) {
    editingPost.value = post;
  }
};

const handleEdited = (post: any) => {
  debug.log('✅ Post edited:', post.id);
  editingPost.value = null;
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

const handleUserClick = (user: any) => {
  if (!user) return
  const handle = user.handle
    || (user.is_local === false && user.domain
      ? `@${user.username}@${user.domain}`
      : `@${user.username || user.id}`)
  router.push({ name: 'UserProfile', params: { handle } })
};

const getPostUrl = (): string => {
  const id = resolvedPostId.value || props.postId;
  return `${window.location.origin}/posts/${id}`;
};

const sharePost = async () => {
  if (!mainPost.value) return;

  const url = getPostUrl();
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

const isOwnPost = computed(() => {
  if (!mainPost.value) return false;
  const currentDomain = import.meta.env.VITE_DOMAIN as string;
  return mainPost.value.author?.is_local !== false && 
    mainPost.value.author?.domain === currentDomain;
});

const copyPostLink = async () => {
  showActionsMenu.value = false;
  const url = getPostUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied to clipboard');
  } catch {
    toast.error('Failed to copy link');
  }
};

const handleDeletePost = async () => {
  showActionsMenu.value = false;
  if (!mainPost.value) return;
  try {
    await activityPubService.deletePost(mainPost.value.id);
    toast.success('Post deleted');
    goBack();
  } catch (err) {
    debug.error('Failed to delete post:', err);
    toast.error('Failed to delete post');
  }
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
watch(() => props.remoteNoteId, loadPostWithContext);
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
  height: 100dvh;
  padding-bottom: 40px;
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
  color: var(--text-primary);
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

a.action-btn {
  text-decoration: none;
}

a.dropdown-item {
  text-decoration: none;
  color: var(--text-primary);
}

.more-actions-wrapper {
  position: relative;
}

.actions-dropdown {
  position: absolute;
  top: 100%;
  right: 0;
  margin-top: 4px;
  min-width: 160px;
  background: var(--background-secondary, #2b2d31);
  border: 1px solid var(--border-color, #3f4147);
  border-radius: 8px;
  padding: 4px;
  z-index: 100;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  border-radius: 4px;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  transition: background 0.15s;
}

.dropdown-item:hover {
  background: var(--background-tertiary, #35373c);
}

.dropdown-item.danger {
  color: #ed4245;
}

.dropdown-item.danger:hover {
  background: rgba(237, 66, 69, 0.1);
}

.post-content {
  flex: 1;
  overflow-y: auto;
  padding: 0;
}

.post-container {
  display: flex;
  flex-direction: column;
  gap: 1rem;
  padding: 1rem;
  max-width: 600px;
  margin: 0 auto;
}

.thread-post {
  position: relative;
}

.highlighted-post :deep(.mony-post) {
  box-shadow: 0 0 0 2px var(--harmony-primary, #0EA5E9);
  border-radius: 12px;
}

.scroll-highlight {
  animation: highlight-pulse 2s ease-in-out;
}

@keyframes highlight-pulse {
  0%, 100% { 
    border-color: var(--h-brand, #0EA5E9);
    box-shadow: 0 0 20px rgba(14, 165, 233, 0.3);
  }
  50% { 
    border-color: var(--h-brand, #0EA5E9);
    box-shadow: 0 0 30px rgba(14, 165, 233, 0.5);
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



.scroll-highlighted {
  background: var(--color-primary-bg);
  transition: background-color 0.3s ease;
}


.reply-composer {
  border-bottom: 1px solid var(--color-border);
  background: var(--color-bg-secondary);
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
  
  .post-container {
    padding: 0.5rem;
  }
}
</style>
