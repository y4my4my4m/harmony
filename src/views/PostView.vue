<!-- Post view with configurable context: minimal, thread, ancestors, descendants. -->
<!-- Supersedes PostDetailView and ConversationThreadView. -->
<template>
  <div class="post-view">
    <ViewHeader :title="t('activitypub.post')" :subtitle="headerSubtitle">
      <template #actions>
        <a
          v-if="isViewingRemotePost && originalInstanceUrl"
          :href="safeHref(originalInstanceUrl)"
          target="_blank"
          rel="noopener noreferrer"
          class="action-btn"
          :aria-label="t('activitypub.viewOnDomain', { domain: originalInstanceDomain || '' })"
          :title="t('activitypub.viewOnDomain', { domain: originalInstanceDomain || '' })"
        >
          <Icon name="external-link" :size="18" />
        </a>
        <button
          type="button"
          class="action-btn"
          :aria-label="t('activitypub.share')"
          :title="t('activitypub.share')"
          @click="sharePost"
        >
          <Icon name="share" :size="18" />
        </button>
        <div class="more-actions-wrapper">
          <button
            type="button"
            class="action-btn"
            :aria-label="t('activitypub.moreOptions')"
            :title="t('activitypub.moreOptions')"
            aria-haspopup="menu"
            :aria-expanded="showActionsMenu"
            @click="showActionsMenu = !showActionsMenu"
          >
            <Icon name="more-horizontal" :size="18" />
          </button>
          <div v-if="showActionsMenu" class="actions-dropdown" role="menu">
            <button @click="copyPostLink" class="dropdown-item">
              <Icon name="link" :size="16" />
              <span>Copy link</span>
            </button>
            <a
              v-if="isViewingRemotePost && originalInstanceUrl"
              :href="safeHref(originalInstanceUrl)"
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
              v-if="isViewingRemotePost && repliesView?.kind !== 'fetching'"
              @click="handleFetchReplies"
              class="dropdown-item"
            >
              <Icon name="message-circle" :size="16" />
              <span>{{ t('activitypub.refreshReplies') }}</span>
            </button>
            <button v-if="isOwnPost" @click="handleDeletePost" class="dropdown-item danger">
              <Icon name="trash" :size="16" />
              <span>Delete post</span>
            </button>
          </div>
        </div>
      </template>
    </ViewHeader>

    <div class="post-content" ref="postContainer">
      <div v-if="isLoading" class="loading-state">
        <LoadingSpinner :size="32" />
        <p>Loading...</p>
      </div>

      <div v-else-if="error" class="error-state">
        <Icon name="alert-circle" :size="48" />
        <h3>Post not found</h3>
        <p>{{ error }}</p>
        <a
          v-if="remoteOriginalUrl"
          :href="safeHref(remoteOriginalUrl)"
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

      <div v-else-if="postWithContext" class="post-container">
        <!-- Thread order: ancestors, main, the reply crawl's row, descendants. -->
        <template v-for="(post, index) in allPostsInOrder" :key="post.id">
          <article
            class="thread-post"
            :class="{
              'highlighted-post': post.id === highlightedPostId,
              'is-main-post': post.id === mainPost?.id,
              'thread-continues': index < ancestors.length,
              'thread-continued': index > 0 && index <= ancestors.length
            }"
            :ref="el => post.id === highlightedPostId && setPostRef(post.id, el)"
          >
            <MonyPost
              :post="post"
              :is-in-thread="true"
              :hide-reply-context="true"
              :detailed="post.id === mainPost?.id"
              @reply="handleReply"
              @reply-created="handleInlineReplyCreated"
              @replies-refreshed="handleRepliesRefreshed"
              @favorite="handleFavorite"
              @reblog="handleReblog"
              @bookmark="handleBookmark"
              @delete="handleDelete"
              @edit="handleEdit"
              @user-click="handleUserClick"
            />
          </article>
          <RemoteRepliesStatus
            v-if="post.id === mainPost?.id && repliesView"
            :view="repliesView"
            :domain="originalInstanceDomain || ''"
            :original-url="originalInstanceUrl"
            @retry="handleRetryReplies"
          />
        </template>

        <div v-if="showReplyComposer" class="reply-composer">
          <Composer
            mode="inline"
            type="reply"
            :reply-to-post="replyToPost!"
            @posted="handleReplyCreated"
            @close="showReplyComposer = false"
          />
        </div>

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
import { safeHref } from '@/utils/sanitize';
import { ref, computed, onMounted, nextTick, watch } from 'vue';
import { debug } from '@/utils/debug'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { useRouter, useRoute } from 'vue-router';
import { useActivityPubStore } from '@/stores/useActivityPub';
import { usePostReactionsStore } from '@/stores/postReactions';
import { activityPubService, type RemoteRepliesResult } from '@/services/activityPubService';
import {
  forcedRepliesRefreshWait, noteForcedRepliesRefresh, repliesFetchDue, repliesFetchNotice,
} from '@/utils/remoteReplies';
import { useRemoteRepliesFetch } from '@/composables/useRemoteRepliesFetch';
import { useToast } from 'vue-toastification';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ViewHeader from '@/components/common/ViewHeader.vue';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import Composer from '@/components/activitypub/Composer.vue';
import RemoteRepliesStatus from '@/components/activitypub/RemoteRepliesStatus.vue';
import { getOriginalPost, getOriginalPostId, getOriginalApId, isReblogPost } from '@/utils/postReblog';

import type { 
  TimelinePost, 
  PostWithContext, 
  PostContextType 
} from '@/types';
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { usePostInteractions } from '@/composables/usePostInteractions'
import { runtimeConfig } from '@/services/runtimeConfig'

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

const { confirm } = useConfirmDialog()
const { toggleFavorite, toggleReblog, toggleBookmark } = usePostInteractions()
const { t } = useI18n()

const router = useRouter();
const route = useRoute();
const activityPub = useActivityPubStore();
const postReactionsStore = usePostReactionsStore();
const toast = useToast();

// Set from props.postId, the route param, or remote handle resolution.
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

// Alias referenced by the error-state template.
const remoteOriginalUrl = originalInstanceUrl;

const isLoading = ref(true);
const isFetchingReactions = ref(false);
const { view: repliesView, run: runRepliesFetch, reset: resetRepliesFetch } = useRemoteRepliesFetch();
// AP id of the post repliesView describes.
let repliesViewApId: string | null = null;
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

const mainPost = computed(() => postWithContext.value?.mainPost);
const ancestors = computed(() => postWithContext.value?.ancestors || []);
const descendants = computed(() => postWithContext.value?.descendants || []);
const threadInfo = computed(() => postWithContext.value?.threadInfo);
const highlightedPostId = computed(() => props.highlightReply || postWithContext.value?.highlightedPost);

const headerSubtitle = computed(() => {
  const parts: string[] = [];
  if (isViewingRemotePost.value && originalInstanceDomain.value) {
    parts.push(t('activitypub.fromDomain', { domain: originalInstanceDomain.value }));
  }
  const info = threadInfo.value;
  if (info && info.totalPosts > 1) {
    parts.push(t('activitypub.postsCountLabel', { count: info.totalPosts }, info.totalPosts));
  }
  if (info && info.participantCount > 1) {
    parts.push(t('activitypub.participantsCount', { count: info.participantCount }, info.participantCount));
  }
  return parts.join(' · ') || undefined;
});

// Chronological: ancestors, main, descendants.
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

// Maps a remote reference (@user@domain + noteId) to the local post UUID.
const resolveRemotePost = async (handle: string, noteId: string): Promise<string | null> => {
  const { postResolverService } = await import('@/services/PostResolverService');
  const post = await postResolverService.resolveByHandle(handle, noteId);
  return post?.id || null;
};

const loadPostWithContext = async () => {
  try {
    isLoading.value = true;
    error.value = null;
    
    let postId = props.postId || route.params.postId as string;

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

    // A reblog (Announce) wrapper has no replies and is not itself a reply, so
    // the thread query walks the wrong tree. Re-query against the original
    // post id to find ancestors/descendants under the original Note.
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
    
    const allPostIds = [
      ...result.ancestors.map(p => p.id),
      result.mainPost.id,
      ...result.descendants.map(p => p.id)
    ].filter(Boolean);
    
    if (allPostIds.length > 0) {
      debug.log(`[PostView] Loading reactions for ${allPostIds.length} posts`);
      postReactionsStore.fetchMultiplePostReactions(allPostIds);
    }
    
    if (props.highlightReply) {
      await nextTick();
      scrollToPost(props.highlightReply);
    } else if (props.timestamp) {
      await nextTick();
      scrollToTimestamp(props.timestamp);
    }
    
    // Remote posts: crawl replies when due and walk the ancestor chain in the
    // background. Reactions are MonyPost's useRemotePostSync on mount.
    //
    // Target the unwrapped main post: an Announce wrapper carries no replies
    // or reactions of its own. Ancestor resolution covers federated replies
    // whose parents are absent locally; without it such threads render as a
    // single floating post.
    const mainTarget = result.mainPost ? getOriginalPost(result.mainPost) : null;
    const mainApId = mainTarget ? getOriginalApId(mainTarget) || mainTarget.ap_id || null : null;
    if (mainApId !== repliesViewApId) {
      resetRepliesFetch();
      repliesViewApId = mainApId;
    }
    if (mainTarget) {
      const isRemote = !mainTarget.is_local && !!mainApId;
      if (isRemote) {
        if (repliesFetchDue(mainTarget)) void fetchRemoteReplies(mainTarget, false);
        // The federation backend's /resolve-post imports each missing
        // ancestor, links the child via in_reply_to, and populates
        // conversation_root_id, so the local thread RPC can walk the chain.
        if (mainTarget.metadata?.in_reply_to_ap_url && !mainTarget.in_reply_to) {
          fetchRemoteAncestorsInBackground(mainTarget);
        }
      }
    }
    
  } catch (err) {
    debug.error('Failed to load post with context:', err);
    error.value = err instanceof Error ? err.message : 'Failed to load post';
    toast.error('Failed to load post');
  } finally {
    isLoading.value = false;
  }
};

/** Thread of the post `token` names, unless the view moved on meanwhile. */
const reloadThread = async (token: string | null) => {
  if (!token) return;
  const updatedResult = await activityPub.getPostWithContext(token, {
    context: props.contextType,
    highlightReply: props.highlightReply,
    maxDepth: maxThreadDepth.value,
    includeInteractions: true,
  });
  if (resolvedPostId.value === token) {
    postWithContext.value = updatedResult;
  }
};

/**
 * Crawls the replies of a remote post at its origin, the row under the main post following
 * it, and reloads the thread when the crawl may have stored replies or moved the counter.
 * Null when superseded or the view moved on.
 */
const fetchRemoteReplies = async (targetPost: TimelinePost, force: boolean): Promise<RemoteRepliesResult | null> => {
  // Snapshot of the post being fetched for. If navigation changes it
  // mid-fetch, the late context reload below is skipped; otherwise it would
  // overwrite `postWithContext.value` with stale data.
  const startToken = resolvedPostId.value;
  const targetApId = getOriginalApId(targetPost) || targetPost.ap_id;
  if (!targetApId) return null;
  const original = getOriginalPost(targetPost);
  let answer: RemoteRepliesResult | null = null;
  try {
    answer = await runRepliesFetch(
      { apId: targetApId, postId: getOriginalPostId(targetPost), repliesCount: original.replies_count },
      { force },
    );
  } catch (err) {
    debug.warn('[PostView] Failed to fetch remote replies:', err);
  }
  if (!answer || resolvedPostId.value !== startToken) return null;
  if (answer.replies_fetched_at !== undefined) original.replies_fetched_at = answer.replies_fetched_at;
  const ended = answer.status === 'done' || answer.status === 'idle';
  const changed = !answer.result || answer.result.stored > 0
    || (answer.replies_count !== undefined && answer.replies_count !== original.replies_count);
  if (ended && changed) await reloadThread(startToken);
  return answer;
};

/**
 * Walks a federated post's reply chain upward, importing missing ancestors
 * via the federation backend's /resolve-post until reaching a post that is
 * already local or has no `inReplyTo`. The endpoint links each imported
 * child→parent and stamps `conversation_root_id`, so the local thread RPC
 * picks up the full chain on the next reload.
 *
 * MAX_ANCESTOR_DEPTH bounds the number of remote fetches a pathological or
 * hostile thread can provoke.
 *
 * Bookkeeping:
 *   - `startToken` snapshots the post being walked for. A change to
 *     `resolvedPostId.value` mid-walk aborts the reload; otherwise the late
 *     `getPostWithContext` would overwrite `postWithContext.value` with
 *     thread data for the post the user already left.
 *   - `newlyImported` counts only imports reported by
 *     `resolveByApUrlWithStatus`, not cached hits. A walk over already-local
 *     ancestors changes nothing visible and needs no reload.
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
      // Abort if navigation changed during the walk.
      if (resolvedPostId.value !== startToken) {
        debug.log('[PostView] Ancestor walker abandoned: navigation changed mid-walk');
        return;
      }
      seen.add(parentApUrl);

      const { post: parent, wasImported } =
        await postResolverService.resolveByApUrlWithStatus(parentApUrl);
      if (!parent) break;
      if (wasImported) newlyImported++;

      // Continue while the ancestor is itself a reply that is missing above.
      // /resolve-post walks the chain server-side, so one call normally
      // suffices; the loop covers older backends and partial imports.
      if (parent.in_reply_to) break;
      parentApUrl = parent.metadata?.in_reply_to_ap_url;
    }

    // Reload only when something was imported (cached hits leave local thread
    // state unchanged) and the view is still on the starting post.
    if (newlyImported > 0 && resolvedPostId.value === startToken && startToken) {
      debug.log(`[PostView] Imported ${newlyImported} federated ancestor(s); reloading context`);
      const updatedResult = await activityPub.getPostWithContext(startToken, {
        context: props.contextType,
        highlightReply: props.highlightReply,
        maxDepth: maxThreadDepth.value,
        includeInteractions: true,
      });
      // Re-check after the await: navigation can occur during the RPC.
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
  // Target the original note's reactions/replies; Announce wrappers collect
  // none. Same rule as the background auto-fetch.
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
  if (!mainPost.value || repliesView.value?.kind === 'fetching') return;
  const targetApId = getOriginalApId(mainPost.value) || mainPost.value.ap_id;
  if (!targetApId) return;
  if (forcedRepliesRefreshWait(targetApId) > 0) {
    toast.info(t('activitypub.repliesFetchedRecently'));
    return;
  }
  noteForcedRepliesRefresh(targetApId);
  const answer = await fetchRemoteReplies(mainPost.value, true);
  // Outcomes the status row leaves to the thread are confirmed by a toast.
  const view = repliesView.value;
  if (!answer || !view || !['fetched', 'recent', 'finished'].includes(view.kind)) return;
  const notice = repliesFetchNotice(view, originalInstanceDomain.value || '');
  if (notice) {
    toast[notice.kind](notice.count !== undefined ? t(notice.key, notice.params, notice.count) : t(notice.key, notice.params));
  }
};

// The backend answers a retry inside its forced cooldown with the last result.
const handleRetryReplies = () => {
  if (mainPost.value) void fetchRemoteReplies(mainPost.value, true);
};

// The main post's own menu crawled its replies.
const handleRepliesRefreshed = () => {
  reloadThread(resolvedPostId.value).catch(err => {
    debug.warn('[PostView] Thread reload after a reply refresh failed:', err);
  });
};

const handleReply = (post: TimelinePost) => {
  // Unwrap reblog wrappers so the reply targets the original author, not the
  // booster.
  replyToPost.value = getOriginalPost(post);
  replyingToPostId.value = getOriginalPostId(post);
  showReplyComposer.value = true;
};

// MonyPost owns its inline reply box and emits the created reply upward.
// PostView holds the thread state and has no realtime subscription, so
// without this handler a new reply appears only after a manual reload.
const handleInlineReplyCreated = (newReply: TimelinePost, _parentId: string) => {
  if (!newReply || !postWithContext.value) return;

  // A background reload or a repeated event can deliver the same reply twice.
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
    debug.log('Inline reply appended to thread:', newReply.id);
  }

  // Reconcile with the server so counts and threading are accurate.
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
  
  // Optimistic append; the timed reload below reconciles.
  if (newReply && postWithContext.value) {
    postWithContext.value = {
      ...postWithContext.value,
      descendants: [...postWithContext.value.descendants, newReply]
    };
    
    if (postWithContext.value.mainPost) {
      postWithContext.value.mainPost.replies_count = 
        (postWithContext.value.mainPost.replies_count || 0) + 1;
    }
    
    debug.log('Reply added optimistically:', newReply.id);
  }
  
  toast.success('Reply posted');
  
  setTimeout(() => {
    loadPostWithContext().catch(err => {
      debug.warn('Background refresh failed:', err);
    });
  }, 1000);
};

const handleDelete = async (postId: string) => {
  if (!(await confirm({ title: 'Delete post', message: 'Are you sure you want to delete this post?', confirmButtonText: 'Delete', dangerAction: true }))) return;
  
  try {
    await activityPubService.deletePost(postId);
    toast.success('Post deleted');
    goBack();
  } catch (err) {
    debug.error('Failed to delete post:', err);
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
  debug.log('Post edited:', post.id);
  editingPost.value = null;
};

// Interactions route through usePostInteractions, which keeps feed state in
// sync. Calling activityPubService directly here desyncs the feeds.
const handleFavorite = async (postId: string) => {
  const result = await toggleFavorite(postId);
  if (result.success) {
    await loadPostWithContext();
  } else {
    toast.error(result.error || 'Failed to favorite post');
  }
};

const handleReblog = async (postId: string) => {
  const result = await toggleReblog(postId);
  if (result.success) {
    await loadPostWithContext();
    toast.success(result.reblogged ? t('activitypub.boostedToast') : t('activitypub.boostRemoved'));
  } else {
    toast.error(result.error || 'Failed to reblog post');
  }
};

const handleBookmark = async (postId: string) => {
  const result = await toggleBookmark(postId);
  if (result.success) {
    await loadPostWithContext();
    toast.success(result.bookmarked ? 'Post bookmarked' : 'Bookmark removed');
  } else {
    toast.error(result.error || 'Failed to bookmark post');
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
  return `${resolveHarmonyBaseUrl()}/posts/${id}`;
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
      // Share sheet dismissed.
    }
  } else {
    try {
      await navigator.clipboard.writeText(url);
      toast.success('Link copied');
    } catch (err) {
      toast.error('Failed to copy link');
    }
  }
};

const isOwnPost = computed(() => {
  if (!mainPost.value) return false;
  const currentDomain = runtimeConfig.domain as string;
  return mainPost.value.author?.is_local !== false && 
    mainPost.value.author?.domain === currentDomain;
});

const copyPostLink = async () => {
  showActionsMenu.value = false;
  const url = getPostUrl();
  try {
    await navigator.clipboard.writeText(url);
    toast.success('Link copied');
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
    
    element.classList.add('scroll-highlighted');
    setTimeout(() => {
      element.classList.remove('scroll-highlighted');
    }, 2000);
  }
};

const scrollToTimestamp = (timestamp: number) => {
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

watch(() => props.postId, loadPostWithContext);
watch(() => props.remoteNoteId, loadPostWithContext);
watch(() => props.contextType, loadPostWithContext);
watch(() => props.highlightReply, loadPostWithContext);

onMounted(loadPostWithContext);
</script>

<style scoped>
.post-view {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: var(--background-primary);
}

.action-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: none;
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  text-decoration: none;
  transition: color var(--transition-fast), background-color var(--transition-fast);
}

.action-btn:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.action-btn:focus-visible,
.dropdown-item:focus-visible,
.back-home-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
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
  min-width: 180px;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  padding: var(--space-1);
  z-index: 100;
  box-shadow: var(--shadow-large);
}

.dropdown-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 8px 12px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.dropdown-item:hover {
  background: var(--background-modifier-hover);
}

.dropdown-item.danger {
  color: var(--error);
}

.dropdown-item.danger:hover {
  background: color-mix(in srgb, var(--error) 10%, transparent);
}

/* Stable gutter, like the feed scroller: the post column sits on the timeline's axis
   whether or not the thread overflows. */
.post-content {
  flex: 1;
  overflow-y: auto;
  scrollbar-gutter: stable;
  padding: 0 0 40px;
}

.post-container {
  display: flex;
  flex-direction: column;
  max-width: 600px;
  min-height: 100%;
  margin: 0 auto;
}

@media (min-width: 769px) {
  .post-container {
    border-left: 1px solid var(--border-color);
    border-right: 1px solid var(--border-color);
  }
}

.thread-post {
  position: relative;
}

/* Thread connector through the avatar column (avatar: 48px, post padding: 12px top, 16px left). */
.thread-post.thread-continues::after,
.thread-post.thread-continued::before {
  content: '';
  position: absolute;
  left: calc(var(--space-4) + 24px - 1px);
  width: 2px;
  background: var(--text-muted);
  pointer-events: none;
}

.thread-post.thread-continues::after {
  top: calc(var(--space-3) + 48px + 4px);
  bottom: 0;
}

.thread-post.thread-continued::before {
  top: 0;
  height: calc(var(--space-3) - 4px);
}

.thread-post.thread-continues :deep(.mony-post) {
  border-bottom-color: transparent;
}

/* Ancestors indent their body into the text column so the connector runs clear of it. */
.thread-post.thread-continues :deep(.post-content > :not(.post-header)) {
  margin-left: calc(48px + var(--space-3));
}

.highlighted-post:not(.is-main-post) :deep(.mony-post) {
  background: var(--harmony-primary-alpha-light);
}

.loading-state,
.error-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: 3rem 2rem;
  text-align: center;
  min-height: 50vh;
  color: var(--text-secondary);
}

.error-state h3 {
  margin: var(--space-2) 0 0;
  color: var(--text-primary);
}

.error-state p {
  color: var(--text-secondary);
  margin: 0 0 var(--space-3);
}

.back-home-btn {
  padding: var(--space-2) var(--space-5);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.back-home-btn:hover {
  background: var(--background-modifier-hover);
}

.scroll-highlighted {
  background: var(--harmony-primary-alpha-light);
  transition: background-color 0.3s ease;
}

.reply-composer {
  padding: var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

@media (max-width: 768px) {
  .thread-post.thread-continues::after,
  .thread-post.thread-continued::before {
    left: calc(var(--space-3) + 24px - 1px);
  }

  .thread-post.thread-continues :deep(.post-content > :not(.post-header)) {
    margin-left: calc(48px + var(--space-2));
  }

  .action-btn {
    width: 40px;
    height: 40px;
  }
}
</style>
