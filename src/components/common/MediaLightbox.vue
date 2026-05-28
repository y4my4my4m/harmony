<!-- MediaLightbox - Custom image + video lightbox (no node_modules patching) -->
<template>
  <Teleport to="body">
    <Transition name="lightbox-fade">
      <div
        v-if="visible"
        class="media-lightbox-overlay"
        @click.self="onHide"
      >
        <button
          class="close-btn"
          aria-label="Close"
          @click="onHide"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 6L6 18M6 6l12 12" />
          </svg>
        </button>

        <button
          v-if="items.length > 1 && index > 0"
          class="nav-btn prev"
          aria-label="Previous"
          @click="prev"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <button
          v-if="items.length > 1 && index < items.length - 1"
          class="nav-btn next"
          aria-label="Next"
          @click="next"
        >
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>

        <div class="media-container">
          <img
            v-if="currentItem && !isVideo(currentItem)"
            :src="currentSrc"
            :alt="currentAlt"
            class="media-content media-image"
          />
          <video
            v-else-if="currentItem && isVideo(currentItem)"
            ref="videoRef"
            :src="currentSrc"
            :poster="currentPoster"
            class="media-content media-video"
            controls
            preload="auto"
            autoplay
            playsinline
            loop
            :muted="videoMuted"
            @volumechange="onVolumeChange"
            @loadedmetadata="onVideoLoadedMetadata"
          >
            Your browser does not support the video tag.
          </video>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch, onMounted, onUnmounted } from 'vue';

const STORAGE_KEY = 'harmony-media-lightbox-video-muted';

function loadMutedPreference(): boolean {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    return stored === null ? false : stored === 'true';
  } catch {
    return false;
  }
}

function saveMutedPreference(muted: boolean) {
  try {
    localStorage.setItem(STORAGE_KEY, String(muted));
  } catch { /* ignore */ }
}

const videoRef = ref<HTMLVideoElement | null>(null);
const videoMuted = ref(loadMutedPreference());

// Sync native controls mute state to stored preference
function onVolumeChange() {
  if (videoRef.value) {
    videoMuted.value = videoRef.value.muted;
    saveMutedPreference(videoMuted.value);
  }
}

export type LightboxItem = string | { src: string; type: 'video'; poster?: string; isGifv?: boolean };

interface Props {
  visible: boolean;
  imgs: LightboxItem[];
}

const props = defineProps<Props>();

const emit = defineEmits<{
  hide: [];
}>();

// `index` is exposed as a v-model so the parent can drive which item is shown;
// `defineModel` creates the prop+emit pair, so it's not in the Props interface.
const index = defineModel<number>('index', { default: 0 });

function isVideo(item: LightboxItem): boolean {
  return typeof item === 'object' && item !== null && item.type === 'video';
}

function getSrc(item: LightboxItem): string {
  return typeof item === 'string' ? item : item.src;
}

const items = computed(() => props.imgs || []);
const currentItem = computed(() => items.value[index.value]);
const currentSrc = computed(() => (currentItem.value ? getSrc(currentItem.value) : ''));
const currentAlt = computed(() => '');
const currentPoster = computed(() =>
  typeof currentItem.value === 'object' && currentItem.value?.poster
    ? currentItem.value.poster
    : undefined
);
const isGifv = computed(() =>
  typeof currentItem.value === 'object' && (currentItem.value as { isGifv?: boolean }).isGifv === true
);

// Playback position per video (src -> seconds) for resuming when switching slides or reopening
const playbackPositions = ref<Record<string, number>>({});

function savePlaybackPosition() {
  const vid = videoRef.value;
  const src = currentSrc.value;
  if (vid && src && !isGifv.value && vid.currentTime > 0 && !Number.isNaN(vid.currentTime)) {
    playbackPositions.value = { ...playbackPositions.value, [src]: vid.currentTime };
  }
}

function onVideoLoadedMetadata() {
  const vid = videoRef.value;
  const src = currentSrc.value;
  if (!vid || !src) return;
  // Restore position only for non-GIF videos
  if (!isGifv.value) {
    const pos = playbackPositions.value[src];
    if (pos != null && pos > 0) {
      vid.currentTime = Math.min(pos, vid.duration > 0 ? vid.duration : pos);
    }
  }
  vid.play().catch(() => {});
}

function onHide() {
  savePlaybackPosition();
  emit('hide');
}

function prev() {
  savePlaybackPosition();
  if (index.value > 0) index.value--;
}

function next() {
  savePlaybackPosition();
  if (index.value < items.value.length - 1) index.value++;
}

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return;
  if (e.key === 'Escape') onHide();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown);
  if (props.visible) document.body.style.overflow = 'hidden';
});

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown);
  document.body.style.overflow = '';
});

watch(
  () => props.visible,
  (v) => { document.body.style.overflow = v ? 'hidden' : ''; }
);

// Ensure video autoplays when switching to it (helps when autoplay attr doesn't fire)
watch(
  () => [props.visible, index.value] as const,
  ([visible, idx]) => {
    const item = items.value[idx];
    if (visible && item && isVideo(item)) {
      nextTick(() => {
        videoRef.value?.play().catch(() => {});
      });
    }
  },
  { flush: 'post' }
);
</script>

<style scoped>
.media-lightbox-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.95);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  padding: 2rem;
}

.close-btn {
  position: absolute;
  top: 1.5rem;
  right: 1.5rem;
  width: 44px;
  height: 44px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  z-index: 10;
}

.close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.close-btn svg {
  width: 24px;
  height: 24px;
}

.nav-btn {
  position: absolute;
  top: 50%;
  transform: translateY(-50%);
  width: 48px;
  height: 48px;
  background: rgba(255, 255, 255, 0.1);
  border: none;
  border-radius: 50%;
  color: #fff;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.2s;
  z-index: 10;
}

.nav-btn:hover {
  background: rgba(255, 255, 255, 0.2);
}

.nav-btn svg {
  width: 28px;
  height: 28px;
}

.nav-btn.prev {
  left: 1.5rem;
}

.nav-btn.next {
  right: 1.5rem;
}

.media-container {
  position: relative;
  max-width: 90vw;
  max-height: 85vh;
  display: flex;
  align-items: center;
  justify-content: center;
}

.media-content {
  max-width: 100%;
  max-height: 85vh;
  object-fit: contain;
}

.lightbox-fade-enter-active,
.lightbox-fade-leave-active {
  transition: opacity 0.2s ease;
}
.lightbox-fade-enter-from,
.lightbox-fade-leave-to {
  opacity: 0;
}

@media (max-width: 768px) {
  .nav-btn {
    width: 40px;
    height: 40px;
  }
  .nav-btn.prev { left: 0.75rem; }
  .nav-btn.next { right: 0.75rem; }
  .close-btn {
    top: 1rem;
    right: 1rem;
  }
}
</style>
