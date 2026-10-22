<!--
  XPostFrame - an X post's video played in X's own embedded post, where the browser cannot
  play X's file through the instance's redirect (Chromium and Gecko send video.twimg.com the
  page's Referer on later byte ranges; federation-backend routes/embedMedia.ts).

  Shows the video's still, a play button and its length. Nothing loads from X before the
  click; then X's embed page (platform.twitter.com/embed/Tweet.html) is framed and fetches the
  post and its video itself, from X's origin. It plays without an X account (Chrome 155,
  Firefox 146, WebKit 26; 2026-10-22). The frame takes the height X's page reports in its
  twttr.private.resize message. A frame whose page sends no twttr.embed message within
  ANSWER_MS (a content blocker, strict tracking protection) gets the post's link beneath it.
-->
<template>
  <div class="xpf" :class="{ 'xpf--loaded': loaded }" data-testid="x-post-frame">
    <iframe
      v-if="loaded && frameSrc"
      ref="frame"
      :src="frameSrc"
      :title="label || t('embeds.playInX')"
      class="xpf__frame"
      :style="{ height: `${height}px` }"
      allow="autoplay; encrypted-media; fullscreen; picture-in-picture"
      allowfullscreen
      sandbox="allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
      referrerpolicy="strict-origin-when-cross-origin"
      data-testid="x-post-frame-iframe"
    ></iframe>
    <button
      v-else
      type="button"
      class="xpf__start"
      :aria-label="label ? `${t('embeds.playInX')}: ${label}` : t('embeds.playInX')"
      :disabled="!frameSrc"
      data-testid="x-post-frame-start"
      @click.stop="start"
    >
      <img v-if="poster" :src="poster" alt="" class="xpf__poster" draggable="false" />
      <span class="xpf__play" aria-hidden="true"><Icon name="play" :size="26" /></span>
      <span v-if="durationText" class="xpf__duration" aria-hidden="true">{{ durationText }}</span>
    </button>
    <a
      v-if="loaded && stalled && postHref"
      :href="postHref"
      target="_blank"
      rel="noopener noreferrer"
      class="xpf__fallback"
      data-testid="x-post-frame-fallback"
    >{{ t('embeds.playOnSite', { site: 'X' }) }}</a>
  </div>
</template>

<script lang="ts">
const X_EMBED_PAGE = 'https://platform.twitter.com/embed/Tweet.html';
/** Milliseconds X's page has to post its first message before the post's link is shown. */
const ANSWER_MS = 10_000;

/** X's embed page of post `id`, in the app's theme and language. */
export function xPostEmbedUrl(id: string, opts: { theme?: 'light' | 'dark'; lang?: string } = {}): string {
  const url = new URL(X_EMBED_PAGE);
  url.searchParams.set('id', id);
  url.searchParams.set('dnt', 'true');
  url.searchParams.set('theme', opts.theme ?? 'dark');
  if (opts.lang && /^[a-z]{2}(-[A-Za-z]{2})?$/.test(opts.lang)) url.searchParams.set('lang', opts.lang.slice(0, 2));
  return url.href;
}

/** The status id of an x.com or twitter.com post link. */
export function xPostId(postUrl: string | undefined): string | undefined {
  if (!postUrl) return undefined;
  try {
    const url = new URL(postUrl);
    if (!/^(?:www\.|mobile\.)?(?:x|twitter)\.com$/.test(url.hostname)) return undefined;
    return url.pathname.match(/^\/(?:[A-Za-z0-9_]{1,15}|i)\/status(?:es)?\/(\d{1,20})(?:\/|$)/)?.[1];
  } catch {
    return undefined;
  }
}
</script>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import Icon from '@/components/common/Icon.vue';
import { useT } from '@/composables/useT';

const props = withDefaults(defineProps<{
  /** X's embed page; anything else is not framed. */
  src: string;
  poster?: string;
  /** Seconds. */
  duration?: number;
  /** Accessible name: the video's description or the post's author. */
  label?: string;
  /** Loads the frame at once: the click that asked for it happened elsewhere. */
  autoload?: boolean;
  /** The click emits `start` and loads nothing here: the parent frames the post elsewhere. */
  external?: boolean;
}>(), { poster: undefined, duration: undefined, label: undefined, autoload: false, external: false });

const emit = defineEmits<{ start: [] }>();

const { t } = useT();
const loaded = ref(props.autoload);
const frame = ref<HTMLIFrameElement | null>(null);
/** X's page reports its own height; this is the height until it does. */
const height = ref(560);

const frameSrc = computed(() => {
  try {
    const url = new URL(props.src);
    return url.origin + url.pathname === X_EMBED_PAGE && /^\d{1,20}$/.test(url.searchParams.get('id') ?? '') ? url.href : '';
  } catch {
    return '';
  }
});

const postHref = computed(() => {
  const id = frameSrc.value ? new URL(frameSrc.value).searchParams.get('id') : null;
  return id ? `https://x.com/i/status/${id}` : '';
});

const answered = ref(false);
const stalled = ref(false);
let answerTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => loaded.value && !!frameSrc.value,
  (framed) => {
    clearTimeout(answerTimer);
    if (framed && !answered.value) answerTimer = setTimeout(() => { stalled.value = !answered.value; }, ANSWER_MS);
  },
  { immediate: true },
);

const durationText = computed(() => {
  const s = Math.round(props.duration ?? 0);
  if (!(s > 0)) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
});

function start() {
  if (props.external) emit('start');
  else loaded.value = true;
}

function onMessage(event: MessageEvent) {
  if (event.origin !== 'https://platform.twitter.com' || !frame.value || event.source !== frame.value.contentWindow) return;
  let data: unknown = event.data;
  if (typeof data === 'string') {
    try {
      data = JSON.parse(data);
    } catch {
      return;
    }
  }
  const call = (data as { 'twttr.embed'?: { method?: string; params?: Array<{ height?: unknown }> } } | null)?.['twttr.embed'];
  if (!call) return;
  answered.value = true;
  stalled.value = false;
  const reported = Number(call?.method === 'twttr.private.resize' ? call.params?.[0]?.height : NaN);
  if (Number.isFinite(reported) && reported > 0) height.value = Math.min(Math.max(Math.ceil(reported), 120), 2000);
}

onMounted(() => window.addEventListener('message', onMessage));
onBeforeUnmount(() => {
  window.removeEventListener('message', onMessage);
  clearTimeout(answerTimer);
});
</script>

<style scoped>
.xpf {
  position: relative;
  width: 100%;
  min-width: 0;
}

.xpf__frame {
  display: block;
  width: 100%;
  max-width: 550px;
  border: 0;
  border-radius: 12px;
  color-scheme: normal;
}

.xpf__fallback {
  display: inline-block;
  margin-top: 6px;
  color: var(--text-link, #0ea5e9);
  font-size: 0.875rem;
}

.xpf__start {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-height: 120px;
  padding: 0;
  border: 0;
  background: #000;
  color: #fff;
  cursor: pointer;
}

.xpf__start:focus-visible {
  outline: 2px solid var(--border-focus, #0ea5e9);
  outline-offset: -2px;
}

.xpf__poster {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.xpf__play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.6);
  transform: translate(-50%, -50%);
}

.xpf__duration {
  position: absolute;
  left: 8px;
  bottom: 8px;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.7);
  font-size: 0.75rem;
  font-variant-numeric: tabular-nums;
}
</style>
