<template>
  <div class="provider-embed" :class="[`provider-${payload.provider}`, { 'is-collapsed': collapsed }]">
    <div class="provider-embed__header">
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
          <MonyPost :post="harmonyPost" />
        </div>
        <div v-else class="provider-embed__skeleton">
          <span v-if="harmonyError">{{ harmonyError }}</span>
          <span v-else>Loading Harmony post…</span>
        </div>
      </template>
      <div v-else-if="youtubeEmbedUrl" class="provider-embed__media provider-embed__media--video" ref="youtubeContainer">
        <iframe
          ref="youtubeIframe"
          :src="youtubeEmbedUrl"
          frameborder="0"
          allowfullscreen
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
          loading="lazy"
        ></iframe>
      </div>
      <div v-else-if="spotifyEmbedUrl" class="provider-embed__media provider-embed__media--spotify">
        <iframe
          :src="spotifyEmbedUrl"
          frameborder="0"
          allow="autoplay; clipboard-write; encrypted-media; fullscreen; picture-in-picture"
          loading="lazy"
        ></iframe>
      </div>
      <LinkEmbedCard v-else :payload="payload" />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, nextTick, onUnmounted } from 'vue';
import type { EmbedPayload, TimelinePost } from '@/types';
import { parseEmbedUrl, buildYouTubeEmbedUrl, buildSpotifyEmbedUrl } from '@/utils/embedDetection';
import { useFloatingVideo } from '@/composables/useFloatingVideo';
import MonyPost from '@/components/activitypub/MonyPost.vue';
import LinkEmbedCard from './LinkEmbedCard.vue';

const props = defineProps<{
  payload: EmbedPayload;
  messageId?: string;
}>();

const collapsed = ref(false);
const harmonyPost = ref<TimelinePost | null>(null);
const harmonyError = ref<string | null>(null);
const youtubeContainer = ref<HTMLElement | null>(null);
const youtubeIframe = ref<HTMLIFrameElement | null>(null);
const isPlaying = ref(false);

const { registerVideo } = useFloatingVideo();

const isHarmony = computed(() => props.payload.provider === 'harmony-post');
const providerLabel = computed(() => {
  switch (props.payload.provider) {
    case 'harmony-post':
      return 'Harmony Post';
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
  
  // Add enablejsapi=1 to enable YouTube Player API
  const url = buildYouTubeEmbedUrl(parsed);
  return url + (url.includes('?') ? '&' : '?') + 'enablejsapi=1';
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
  
  // Register video for floating (if messageId is provided)
  if (props.messageId) {
    const originalParent = youtubeContainer.value.parentElement as HTMLElement;
    if (originalParent) {
      registerVideo(youtubeContainer.value, originalParent, props.messageId, 'youtube');
    }
  }
}

function handleYouTubeMessage(event: MessageEvent) {
  // Only handle messages from YouTube
  if (!event.data || typeof event.data !== 'string') return;
  
  try {
    const data = JSON.parse(event.data);
    
    // Check if message is from our iframe
    if (event.source !== youtubeIframe.value?.contentWindow) return;
    
    if (data.event === 'onStateChange') {
      // YouTube player states: -1 (unstarted), 0 (ended), 1 (playing), 2 (paused), 3 (buffering), 5 (cued)
      const isVideoPlaying = data.info === 1;
      isPlaying.value = isVideoPlaying;
      
      // Update data attribute for floating video system
      if (youtubeContainer.value) {
        youtubeContainer.value.dataset.isPlaying = String(isVideoPlaying);
      }
    }
  } catch (error) {
    // Not a JSON message, ignore
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
        return;
      }
    }
    
    // Load post with author if not in feeds
    const post = await store.loadPostWithAuthor(props.payload.harmony.postId);
    if (!post) {
      harmonyError.value = 'Post unavailable';
    }
    harmonyPost.value = post;
  } catch (error) {
    console.warn('Failed to hydrate Harmony post:', error);
    harmonyError.value = 'Unable to load Harmony post';
  }
}

function toggleCollapse() {
  collapsed.value = !collapsed.value;
}

function openLink() {
  window.open(props.payload.url, '_blank', 'noopener,noreferrer');
}
</script>

