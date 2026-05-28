<template>
  <!-- Server Invite Card - special handling without header/collapse -->
  <ServerInviteCard 
    v-if="isServerInvite && inviteCode"
    :invite-code="inviteCode"
    :invite-url="payload.url"
  />
  
  <!-- Regular embed with header/collapse -->
  <div v-else class="provider-embed" ref="embedWrapper" :class="[`provider-${payload.provider}`, { 'is-collapsed': collapsed }]">
    <div class="provider-embed__header" v-if="payload.provider !== 'harmony-post' && payload.provider !== 'fediverse-post'">
      <div class="provider-embed__label">
        {{ providerLabel }}
      </div>
      <div class="provider-embed__actions">
        <button class="embed-action" type="button" @click="openLink">
          Open
        </button>
        <button class="embed-action" type="button" @click="toggleCollapse">
          {{ collapsed ? 'Show' : 'Hide' }}
        </button>
      </div>
    </div>
    <div v-if="!collapsed" class="provider-embed__content">
      <template v-if="isHarmony">
        <div v-if="harmonyPost" class="provider-embed__post">
          <MonyPost :post="harmonyPost" :embedded="true" @open-lightbox="$emit('open-lightbox', $event)" />
        </div>
        <div v-else class="provider-embed__skeleton">
          <span v-if="harmonyError">{{ harmonyError }}</span>
          <span v-else>Loading Harmony post…</span>
        </div>
      </template>
      <template v-else-if="isFediverse">
        <template v-if="payload.fediverse">
          <div v-if="fediversePost" class="provider-embed__post provider-embed__fediverse-wrap">
            <MonyPost :post="fediversePost" :embedded="true" @open-lightbox="$emit('open-lightbox', $event)" @refresh="handleEmbedLoad" />
            <div v-if="fediverseSourceUrl" class="fedi-source-link">
              <span class="fedi-source-badge" :title="fediversePlatformLabel">
                <span class="fedi-badge-icon">{{ fediversePlatformIcon }}</span>
                <span class="fedi-badge-label">{{ fediversePlatformLabel }}</span>
              </span>
              <a :href="fediverseSourceUrl" target="_blank" rel="noopener noreferrer" class="fedi-source-link__right">
                View on {{ fediverseSourceDomain }}
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                  <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
                </svg>
              </a>
            </div>
          </div>
          <div v-else-if="fediverseError" class="provider-embed__skeleton">
            <span>{{ fediverseError }}</span>
          </div>
          <div v-else class="provider-embed__skeleton">
            <span>Loading fediverse post…</span>
          </div>
        </template>
        <LinkEmbedCard v-else :payload="payload" @load="handleEmbedLoad" />
      </template>
      <div v-else-if="youtubeEmbedUrl" class="provider-embed__media provider-embed__media--video" ref="youtubeContainer">
        <iframe
          ref="youtubeIframe"
          :id="`youtube-player-${messageId}`"
          :src="youtubeEmbedUrl"
          frameborder="0"
          allowfullscreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          loading="lazy"
          @load="handleEmbedLoad"
        ></iframe>
      </div>
      <div v-else-if="spotifyEmbedUrl" class="provider-embed__media provider-embed__media--spotify">
        <iframe
          :src="spotifyEmbedUrl"
          frameborder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
          @load="handleEmbedLoad"
        ></iframe>
      </div>
      <LinkEmbedCard v-else :payload="payload" @load="handleEmbedLoad" />
    </div>
  </div>
</template>

<script lang="ts">
import type { TimelinePost } from '@/types';

// Module-level cache so re-mounts (virtual scroller) don't re-fetch.
//
// Previously this Map grew without bound for the life of the tab, accumulating
// every distinct fediverse post URL ever embedded. Now bounded with simple
// LRU eviction + a 15-minute soft TTL so stale embeds eventually refresh
// (helpful for posts that get edited remotely).
const FEDIVERSE_CACHE_MAX = 500;
const FEDIVERSE_CACHE_TTL_MS = 15 * 60 * 1000;

interface CachedFediversePost {
  post: TimelinePost;
  expiresAt: number;
}

const fediversePostCacheStore = new Map<string, CachedFediversePost>();

const fediversePostCache = {
  get(url: string): TimelinePost | undefined {
    const hit = fediversePostCacheStore.get(url);
    if (!hit) return undefined;
    if (hit.expiresAt <= Date.now()) {
      fediversePostCacheStore.delete(url);
      return undefined;
    }
    // LRU touch.
    fediversePostCacheStore.delete(url);
    fediversePostCacheStore.set(url, hit);
    return hit.post;
  },
  set(url: string, post: TimelinePost): void {
    if (fediversePostCacheStore.size >= FEDIVERSE_CACHE_MAX && !fediversePostCacheStore.has(url)) {
      const oldest = fediversePostCacheStore.keys().next().value;
      if (oldest !== undefined) fediversePostCacheStore.delete(oldest);
    } else {
      fediversePostCacheStore.delete(url);
    }
    fediversePostCacheStore.set(url, { post, expiresAt: Date.now() + FEDIVERSE_CACHE_TTL_MS });
  },
};
</script>

<script setup lang="ts">
import { computed, onMounted, ref, nextTick, onUnmounted } from 'vue';
import { debug } from '@/utils/debug'
// `TimelinePost` is already imported in the module-scope <script lang="ts">
// block above for the cache helpers; re-importing it here is a TS duplicate.
import type { EmbedPayload } from '@/types';
import { parseEmbedUrl, buildYouTubeEmbedUrl, buildSpotifyEmbedUrl } from '@/utils/embedDetection';
import { useFloatingVideo } from '@/composables/useFloatingVideo';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import LinkEmbedCard from './LinkEmbedCard.vue';
import ServerInviteCard from './ServerInviteCard.vue';

const props = defineProps<{
  payload: EmbedPayload;
  messageId?: string;
}>();

const emit = defineEmits<{
  'embed-loaded': [];
  'open-lightbox': [url: string];
}>();

const collapsed = ref(false);
const harmonyPost = ref<TimelinePost | null>(null);
const harmonyError = ref<string | null>(null);
const fediversePost = ref<TimelinePost | null>(null);
const fediverseError = ref<string | null>(null);
const embedWrapper = ref<HTMLElement | null>(null);
const youtubeContainer = ref<HTMLElement | null>(null);
const youtubeIframe = ref<HTMLIFrameElement | null>(null);
const isPlaying = ref(false);
const embedLoaded = ref(false);

const { registerVideo, returnToOriginalPosition, getFloatingVideoMessageId } = useFloatingVideo();

// Detect server invite links (e.g., https://har.mony.lol/invite/ABC123)
const isServerInvite = computed(() => {
  if (props.payload.provider === 'harmony-invite') return true;
  
  try {
    const url = new URL(props.payload.url);
    // Match /invite/CODE pattern on any harmony instance
    const inviteMatch = url.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
    if (inviteMatch) {
      // Check if it's a known harmony instance or current origin
      const harmonyDomains = [import.meta.env.VITE_DOMAIN as string, 'har.mony.local', 'localhost'];
      const isHarmonyDomain = harmonyDomains.some(d => url.hostname.includes(d)) || 
                              url.origin === window.location.origin;
      return isHarmonyDomain;
    }
  } catch {
    // Invalid URL
  }
  return false;
});

const inviteCode = computed(() => {
  if (!isServerInvite.value) return null;
  try {
    const url = new URL(props.payload.url);
    const match = url.pathname.match(/^\/invite\/([A-Za-z0-9]+)$/);
    return match ? match[1] : null;
  } catch {
    return null;
  }
});

const isHarmony = computed(() => props.payload.provider === 'harmony-post');
const isFediverse = computed(() => props.payload.provider === 'fediverse-post');
const providerLabel = computed(() => {
  switch (props.payload.provider) {
    case 'harmony-post':
      return 'Harmony Post';
    case 'harmony-invite':
      return 'Server Invite';
    case 'fediverse-post': {
      const platform = props.payload.fediverse?.platform;
      const labels: Record<string, string> = {
        mastodon: 'Mastodon Post',
        misskey: 'Misskey Post',
        pleroma: 'Pleroma Post',
        gotosocial: 'GoToSocial Post',
        pixelfed: 'Pixelfed Post',
        harmony: 'Harmony Post',
        lemmy: 'Lemmy Post',
      };
      return labels[platform || ''] || 'Fediverse Post';
    }
    case 'youtube':
      return 'YouTube';
    case 'spotify':
      return 'Spotify';
    default:
      return 'Link Preview';
  }
});

const youtubeEmbedUrl = computed(() => {
  if (props.payload.provider !== 'youtube') return null;
  const normalized = props.payload.normalizedUrl || props.payload.url;
  const parsed = parseEmbedUrl(normalized);
  if (!parsed) return null;
  
  const url = buildYouTubeEmbedUrl(parsed);
  if (!url) return null;
  const params = new URLSearchParams();
  params.set('enablejsapi', '1');
  params.set('origin', window.location.origin);
  params.set('widget_referrer', window.location.origin);
  
  return url + (url.includes('?') ? '&' : '?') + params.toString();
});

const spotifyEmbedUrl = computed(() => {
  if (props.payload.provider !== 'spotify') return null;
  const normalized = props.payload.normalizedUrl || props.payload.url;
  const parsed = parseEmbedUrl(normalized);
  if (!parsed) return null;
  return buildSpotifyEmbedUrl(parsed);
});

onMounted(() => {
  if (isHarmony.value) {
    loadHarmonyPost();
  }
  if (isFediverse.value) {
    loadFediversePost();
  }
  // For YouTube, Spotify, and LinkEmbedCard, the load event will be handled by @load handlers
  
  // Setup YouTube Player API for floating video
  if (props.payload.provider === 'youtube') {
    nextTick(() => {
      setupYouTubePlayer();
    });
  }
});

onUnmounted(() => {
  // Cleanup YouTube message listener
  if (props.payload.provider === 'youtube') {
    window.removeEventListener('message', handleYouTubeMessage);
  }
});

function setupYouTubePlayer() {
  if (!youtubeContainer.value || !youtubeIframe.value) return;
  
  // Listen for YouTube Player API messages
  window.addEventListener('message', handleYouTubeMessage);
  
  // Subscribe to YouTube player events immediately
  sendListeningEvent();
  
  // Register the whole embed wrapper for floating so the header + video float together
  if (props.messageId) {
    const floatTarget = embedWrapper.value || youtubeContainer.value;
    if (!floatTarget) return;
    const originalParent = floatTarget.parentElement as HTMLElement;
    if (originalParent) {
      registerVideo(floatTarget as unknown as HTMLElement, originalParent, props.messageId, 'youtube');
    }
  }
}

function sendListeningEvent() {
  if (youtubeIframe.value?.contentWindow) {
    youtubeIframe.value.contentWindow.postMessage(
      JSON.stringify({
        event: 'listening',
        id: youtubeIframe.value.id || 'ytplayer'
      }),
      '*'
    );
  }
}

function updatePlayState(playing: boolean) {
  isPlaying.value = playing;
  
  if (playing && props.messageId) {
    const floatingVideoId = getFloatingVideoMessageId();
    if (floatingVideoId && floatingVideoId !== props.messageId) {
      returnToOriginalPosition();
    }
  }
  
  const floatTarget = embedWrapper.value || youtubeContainer.value;
  if (floatTarget) {
    floatTarget.dataset.isPlaying = String(playing);
  }
}

function handleYouTubeMessage(event: MessageEvent) {
  if (!event.origin.includes('youtube.com') && !event.origin.includes('youtube-nocookie.com')) return;
  if (!event.data) return;
  
  try {
    let data = event.data;
    if (typeof data === 'string') {
      data = JSON.parse(data);
    }
    
    if (event.source !== youtubeIframe.value?.contentWindow) return;
    
    // onStateChange: explicit play/pause/etc
    if (data.event === 'onStateChange') {
      const playing = data.info === 1;
      debug.log('[YouTube] State change:', { info: data.info, isPlaying: playing });
      updatePlayState(playing);
    }
    
    // infoDelivery: periodic updates with playerState
    if (data.event === 'infoDelivery' && data.info != null) {
      const playerState = data.info.playerState;
      if (playerState !== undefined) {
        const playing = playerState === 1;
        if (playing !== isPlaying.value) {
          debug.log('[YouTube] infoDelivery state:', { playerState, isPlaying: playing });
          updatePlayState(playing);
        }
      }
    }
    
    if (data.event === 'onReady') {
      debug.log('[YouTube] Player ready');
      sendListeningEvent();
    }
    
    // YouTube may send initialDelivery before onReady - subscribe immediately
    if (data.event === 'initialDelivery') {
      sendListeningEvent();
    }
  } catch (error) {
    // Not a JSON message or parse error, ignore
  }
}

async function loadHarmonyPost() {
  if (!props.payload.harmony?.postId) return;
  harmonyError.value = null;
  try {
    // Hydrate Harmony post from ActivityPub store
    const { useActivityPubStore } = await import('@/stores/useActivityPub');
    const store = useActivityPubStore();
    
    // Check if post is already in feeds
    const feeds = [store.homeFeed, store.publicFeed, store.localFeed];
    for (const feed of feeds) {
      const found = feed.posts.find((post) => post.id === props.payload.harmony!.postId);
      if (found) {
        harmonyPost.value = found;
        handleEmbedLoad();
        return;
      }
    }
    
    // Load post with author if not in feeds
    const post = await store.loadPostWithAuthor(props.payload.harmony.postId);
    if (!post) {
      harmonyError.value = 'Post unavailable';
    }
    harmonyPost.value = post;
    handleEmbedLoad();
  } catch (error) {
    debug.warn('Failed to hydrate Harmony post:', error);
    harmonyError.value = 'Unable to load Harmony post';
    // Still emit loaded event even on error so scroll doesn't wait forever
    handleEmbedLoad();
  }
}

// Fediverse embed platform helpers
const FEDI_PLATFORM_MAP: Record<string, { icon: string; label: string }> = {
  mastodon: { icon: '🐘', label: 'Mastodon' },
  misskey: { icon: '🌎', label: 'Misskey' },
  pleroma: { icon: '🔵', label: 'Pleroma' },
  gotosocial: { icon: '🐿️', label: 'GoToSocial' },
  pixelfed: { icon: '📷', label: 'Pixelfed' },
  harmony: { icon: '🐻‍❄️', label: 'Harmony' },
  lemmy: { icon: '🐭', label: 'Lemmy' },
};

const fediversePlatformLabel = computed(() => {
  const p = props.payload.fediverse?.platform || '';
  return FEDI_PLATFORM_MAP[p]?.label || 'Fediverse';
});

const fediversePlatformIcon = computed(() => {
  const p = props.payload.fediverse?.platform || '';
  return FEDI_PLATFORM_MAP[p]?.icon || '🌐';
});

const fediverseSourceUrl = computed(() => {
  return props.payload.fediverse?.postUrl || props.payload.url;
});

const fediverseSourceDomain = computed(() => {
  try {
    return new URL(fediverseSourceUrl.value).hostname;
  } catch {
    return 'source';
  }
});

async function loadFediversePost() {
  const fedi = props.payload.fediverse;
  if (!fedi) {
    fediverseError.value = 'No fediverse data';
    handleEmbedLoad();
    return;
  }

  const postUrl = fedi.postUrl;

  // Check module-level cache first (instant on virtual scroller re-mount)
  const cached = fediversePostCache.get(postUrl);
  if (cached) {
    fediversePost.value = cached;
    handleEmbedLoad();
    return;
  }

  try {
    const { useActivityPubStore } = await import('@/stores/useActivityPub');
    const store = useActivityPubStore();

    // If the backend already imported this post, load it directly by ID
    const localPostId = props.payload.localPostId;
    if (localPostId) {
      const post = await store.loadPostWithAuthor(localPostId);
      if (post) {
        fediversePostCache.set(postUrl, post);
        fediversePost.value = post;
        handleEmbedLoad();
        return;
      }
    }

    // Check in-memory feeds (free)
    const feeds = [store.homeFeed, store.publicFeed, store.localFeed];
    for (const feed of feeds) {
      const found = feed.posts.find(p => p.url === postUrl || p.ap_id === postUrl);
      if (found) {
        fediversePostCache.set(postUrl, found);
        fediversePost.value = found;
        handleEmbedLoad();
        return;
      }
    }

    // Unified resolve: DB lookup + federation import if missing
    const { postResolverService } = await import('@/services/PostResolverService');
    const resolved = await postResolverService.resolveByApUrl(postUrl);
    if (resolved) {
      fediversePostCache.set(postUrl, resolved);
      fediversePost.value = resolved;
      handleEmbedLoad();
      return;
    }

    fediverseError.value = 'Could not load this post from the remote instance';
    handleEmbedLoad();
  } catch (error) {
    debug.warn('Failed to load fediverse post:', error);
    fediverseError.value = 'Could not load this post';
    handleEmbedLoad();
  }
}

function handleEmbedLoad() {
  embedLoaded.value = true;
  emit('embed-loaded');
  if (props.payload.provider === 'youtube') {
    sendListeningEvent();
  }
}

function toggleCollapse() {
  collapsed.value = !collapsed.value;
}

function openLink() {
  window.open(props.payload.url, '_blank', 'noopener,noreferrer');
}
</script>


