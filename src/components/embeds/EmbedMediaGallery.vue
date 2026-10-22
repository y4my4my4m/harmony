<!--
  EmbedMediaGallery - the photos, videos and GIFs of a post preview (X, Instagram, Bluesky).

  One item shows at its own aspect; two to four share a grid; past four, the fourth tile
  names how many more there are. Photos open the media viewer. Videos play in place in
  Harmony's player, whose expand control opens the viewer at the same position. GIFs loop
  muted in place and open the viewer on click. Every item steps through the viewer.

  A video with an HLS alternative plays it where HLS is native (WebKit), the file elsewhere.
  A video the browser cannot play (an HLS playlist outside WebKit) or that fails to load
  (an expired or refused file) shows its still, linked to the post.

  An X video outside WebKit, where the instance relays no X video, shows its still, a play
  button and its length; the click puts X's embedded post (XPostFrame) in place of the
  gallery, and the viewer shows the same click-to-load frame. X GIFs play through the
  redirect everywhere: a GIF file comes in one request.
-->
<template>
  <XPostFrame
    v-if="xFrameOpen"
    :src="xEmbedSrc"
    :label="label"
    autoload
    data-testid="embed-media-x-frame"
  />
  <div
    v-else
    ref="root"
    class="emg"
    :class="[`emg--${Math.min(shown.length, 4)}`, { 'emg--compact': compact }]"
    :style="singleStyle"
    data-testid="embed-media-gallery"
  >
    <div
      v-for="(item, i) in shown"
      :key="`${i}-${item.url}`"
      class="emg__tile"
      :class="`emg__tile--${kinds[i]}`"
      :data-media-type="item.type"
    >
      <!-- Photo, or the last tile of a post with more: opens the viewer. -->
      <button
        v-if="kinds[i] === 'image' || kinds[i] === 'more'"
        type="button"
        class="emg__open"
        :aria-label="openLabel(i)"
        @click="openViewer(i)"
      >
        <img
          v-if="!failed[i] && stillOf(item)"
          :src="stillOf(item)"
          :alt="item.alt || ''"
          class="emg__media"
          loading="lazy"
          draggable="false"
          @load="loaded"
          @error="markFailed(i)"
        />
        <span v-else class="emg__missing" aria-hidden="true"><Icon name="image" :size="22" /></span>
        <span v-if="kinds[i] === 'more'" class="emg__more" aria-hidden="true">+{{ hidden }}</span>
      </button>

      <!-- GIF: loops muted in place, opens the viewer. -->
      <button
        v-else-if="kinds[i] === 'gif'"
        type="button"
        class="emg__open"
        :aria-label="openLabel(i)"
        @click="openViewer(i)"
      >
        <video
          :src="sourceOf(item)"
          :poster="item.poster"
          class="emg__media"
          :autoplay="!reducedMotion"
          loop
          muted
          playsinline
          disablepictureinpicture
          preload="metadata"
          aria-hidden="true"
          @loadedmetadata="loaded"
          @error="markFailed(i)"
        ></video>
        <span class="emg__badge" aria-hidden="true">GIF</span>
      </button>

      <!-- Video: Harmony's player in place. -->
      <template v-else-if="kinds[i] === 'video'">
        <video
          :src="sourceOf(item)"
          :poster="item.poster"
          class="emg__media"
          :controls="nativeVideoControls"
          playsinline
          preload="metadata"
          :aria-label="item.alt || t('activitypub.video')"
          @loadedmetadata="loaded"
          @error="markFailed(i)"
        ></video>
        <VideoControls
          v-if="!nativeVideoControls"
          :label="item.alt || label || t('activitypub.video')"
          expandable
          @expand="openViewer(i, $event)"
        />
      </template>

      <!-- An X video this browser plays in X's embedded post: its still, until the click. -->
      <XPostFrame
        v-else-if="kinds[i] === 'xframe'"
        :src="xEmbedSrc"
        :poster="item.poster"
        :duration="item.duration"
        :label="item.alt || label"
        external
        @start="xFrameOpen = true"
      />

      <!-- A video that cannot play here: its still, linked to the post. -->
      <a
        v-else
        class="emg__open emg__open--link"
        :href="safeHref(postUrl)"
        target="_blank"
        rel="noopener noreferrer"
        :aria-label="t('embeds.playOnSite', { site: siteName || postHost })"
      >
        <img v-if="item.poster" :src="item.poster" alt="" class="emg__media" loading="lazy" @load="loaded" />
        <span class="emg__play" aria-hidden="true"><Icon name="play" :size="22" /></span>
      </a>
    </div>
  </div>
</template>

<script lang="ts">
const HLS_TYPE = 'application/vnd.apple.mpegurl';

/**
 * HLS plays natively: WebKit. Chromium answers canPlayType 'maybe' for HLS and Chrome 155
 * fails the playlist (error 4); Firefox answers ''.
 */
function nativeHls(): boolean {
  if (typeof document === 'undefined' || typeof navigator === 'undefined') return false;
  if (/Chrom(e|ium)\/\d/.test(navigator.userAgent)) return false;
  return document.createElement('video').canPlayType(HLS_TYPE) !== '';
}
</script>

<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import type { EmbedMediaItem } from '@/types';
import Icon from '@/components/common/Icon.vue';
import VideoControls from '@/components/common/VideoControls.vue';
import { useLightbox, type LightboxMedia } from '@/composables/useLightbox';
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference';
import { useT } from '@/composables/useT';
import { safeHref } from '@/utils/sanitize';
import XPostFrame, { xPostEmbedUrl, xPostId } from './XPostFrame.vue';
import { isWebKitEngine, useXVideoRelay } from '@/composables/useXVideoRelay';

const props = withDefaults(defineProps<{
  items: EmbedMediaItem[];
  /** The post the media belongs to: where a video that cannot play here links. */
  postUrl: string;
  /** The platform, named on that link. */
  siteName?: string;
  /** Accessible name of the player, e.g. the post's author. */
  label?: string;
  /** Smaller tiles, inside a quoted post. */
  compact?: boolean;
  /** The post's platform; X videos may play in X's embedded post. */
  platform?: string;
}>(), { compact: false, siteName: undefined, label: undefined, platform: undefined });

const emit = defineEmits<{ load: [] }>();

const { t, locale } = useT();
const nativeVideoControls = useNativeVideoControls();
const { open: openLightbox } = useLightbox();
const root = ref<HTMLElement | null>(null);
const failed = reactive<Record<number, boolean>>({});

const MAX_TILES = 4;
const shown = computed(() => props.items.slice(0, MAX_TILES));
const hidden = computed(() => Math.max(0, props.items.length - MAX_TILES));

const reducedMotion = typeof document !== 'undefined'
  && (document.documentElement.dataset.reduceMotion === 'true'
    || (typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches));

const hlsNative = nativeHls();

/** An HLS-only video plays where HLS is native. */
function playable(item: EmbedMediaItem): boolean {
  return !item.mime || hlsNative;
}

/** The file a video element plays: the HLS alternative where HLS is native, else the file. */
function sourceOf(item: EmbedMediaItem): string {
  return item.hls && hlsNative ? item.hls : item.url;
}

const tweetId = computed(() => (props.platform === 'x' ? xPostId(props.postUrl) : undefined));
const hasXVideo = computed(() => !!tweetId.value && props.items.some((m) => m.type === 'video'));
// Asked only for an X video outside WebKit, where the answer matters.
const relaysXVideo = hasXVideo.value && !isWebKitEngine() ? useXVideoRelay() : ref(false);
const xFramed = computed(() => hasXVideo.value && !isWebKitEngine() && !relaysXVideo.value);
const xFrameOpen = ref(false);
const xEmbedSrc = computed(() => {
  if (!tweetId.value) return '';
  const theme = typeof document !== 'undefined' && document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  return xPostEmbedUrl(tweetId.value, { theme, lang: locale.value });
});

function tileKind(item: EmbedMediaItem, i: number): 'image' | 'gif' | 'video' | 'xframe' | 'link' | 'more' {
  if (hidden.value > 0 && i === MAX_TILES - 1) return 'more';
  if (item.type === 'image') return 'image';
  if (item.type === 'video' && xFramed.value) return 'xframe';
  if (failed[i] || !playable(item)) return 'link';
  return item.type === 'gif' ? 'gif' : 'video';
}

const kinds = computed(() => shown.value.map((item, i) => tileKind(item, i)));

/** What a photo tile shows: the photo, or a video's still. */
function stillOf(item: EmbedMediaItem): string | undefined {
  return item.type === 'image' ? item.url : item.poster;
}

const postHost = computed(() => {
  try {
    return new URL(props.postUrl).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
});

// A single item keeps its own shape: portrait videos stand narrow instead of filling the width.
const singleStyle = computed(() => {
  if (shown.value.length !== 1) return undefined;
  const { width, height } = shown.value[0];
  return width && height ? { '--emg-ratio': `${width} / ${height}`, '--emg-ratio-n': String(width / height) } : undefined;
});

/** "Open media 2 of 5", then the item's description when it has one. */
function openLabel(i: number): string {
  const label = t('embeds.openMedia', { index: i + 1, total: props.items.length });
  const alt = shown.value[i]?.alt;
  return alt ? `${label}: ${alt}` : label;
}

let announced = false;
function loaded() {
  if (announced) return;
  announced = true;
  emit('load');
}

function markFailed(i: number) {
  failed[i] = true;
  loaded();
}

function toViewer(item: EmbedMediaItem, i: number): LightboxMedia {
  if (item.type === 'image') return { url: item.url, type: 'image', alt: item.alt };
  if (item.type === 'video' && xFramed.value) return { url: xEmbedSrc.value, type: 'embed', poster: item.poster, alt: item.alt };
  if (failed[i] || !playable(item)) return { url: item.poster || '', type: 'image', alt: item.alt };
  return { url: sourceOf(item), type: 'video', poster: item.poster, alt: item.alt, loop: item.type === 'gif' };
}

/** Opens the viewer at item `i` of all items; `origin` is the video played in place. */
function openViewer(i: number, origin?: HTMLVideoElement) {
  root.value?.querySelectorAll<HTMLVideoElement>('video').forEach((v) => {
    if (v !== origin && !v.loop) v.pause();
  });
  const list = props.items.map(toViewer);
  // Items without a source (a failed video without a still) drop out; the index follows.
  const start = list.slice(0, i).filter((m) => m.url).length;
  openLightbox(list.filter((m) => m.url), start, { origin: origin ?? null });
}

onMounted(() => {
  if (!props.items.length) loaded();
});
</script>

<style scoped>
.emg {
  --emg-max-height: 420px;
  --emg-gap: 2px;
  display: grid;
  gap: var(--emg-gap);
  overflow: hidden;
  border-radius: 10px;
  background: var(--background-tertiary, #0d0f14);
}

.emg--compact {
  --emg-max-height: 220px;
  border-radius: 8px;
}

.emg--1 {
  width: min(100%, calc(var(--emg-max-height) * var(--emg-ratio-n, 1.7778)));
  aspect-ratio: var(--emg-ratio, 16 / 9);
  max-height: var(--emg-max-height);
}

.emg--2 {
  grid-template-columns: 1fr 1fr;
  aspect-ratio: 16 / 9;
}

.emg--3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 16 / 9;
}

.emg--3 .emg__tile:first-child {
  grid-row: 1 / 3;
}

.emg--4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 16 / 9;
}

.emg__tile {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #000;
}

.emg__tile > .xpf {
  height: 100%;
}

.emg__open {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: 0;
  background: none;
  color: inherit;
  cursor: zoom-in;
}

.emg__open--link {
  cursor: pointer;
}

.emg__open:focus-visible {
  outline: 2px solid var(--border-focus, #0ea5e9);
  outline-offset: -2px;
}

.emg__media {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.emg--1 .emg__media {
  object-fit: contain;
}

.emg__badge {
  position: absolute;
  left: 6px;
  bottom: 6px;
  padding: 1px 5px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.65);
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  letter-spacing: 0.04em;
  pointer-events: none;
}

.emg__play {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
  background: rgba(0, 0, 0, 0.25);
  pointer-events: none;
}

.emg__missing {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-secondary, #9ca3af);
  background: var(--background-secondary, #1a1d24);
}

.emg__more {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 1.4rem;
  font-weight: 700;
  pointer-events: none;
}
</style>
