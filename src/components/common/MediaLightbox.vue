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
          <template v-else-if="currentItem && isVideo(currentItem)">
            <video
              ref="videoRef"
              :src="currentSrc"
              :poster="currentPoster"
              class="media-content media-video"
              controls
              preload="auto"
              autoplay
              loop
              playsinline
              :muted="videoMuted"
            >
              Your browser does not support the video tag.
            </video>
            <button
              class="mute-toggle"
              :aria-label="videoMuted ? 'Unmute' : 'Mute'"
              @click="toggleMute"
            >
              <svg v-if="videoMuted" viewBox="0 0 24 24" fill="currentColor">
                <path d="M16.5 12c0-1.77-1.02-3.29-2.5-4.03v2.21l2.45 2.45c.03-.2.05-.41.05-.63zm2.5 0c0 .94-.2 1.82-.54 2.64l1.51 1.51C20.63 14.91 21 13.5 21 12c0-4.28-2.99-7.86-7-8.77v2.06c2.89.86 5 3.54 5 6.71zM4.27 3L3 4.27 7.73 9H3v6h4l5 5v-6.73l4.25 4.25c-.67.52-1.42.93-2.25 1.18v2.06c1.38-.31 2.63-.95 3.69-1.81L19.73 21 21 19.73l-9-9L4.27 3zM12 4L9.91 6.09 12 8.18V4z"/>
              </svg>
              <svg v-else viewBox="0 0 24 24" fill="currentColor">
                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02zM14 3.23v2.06c2.89.86 5 3.54 5 6.71s-2.11 5.85-5 6.71v2.06c4.01-.91 7-4.49 7-8.77s-2.99-7.86-7-8.77z"/>
              </svg>
            </button>
          </template>
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

function toggleMute() {
  videoMuted.value = !videoMuted.value;
  saveMutedPreference(videoMuted.value);
  if (videoRef.value) {
    videoRef.value.muted = videoMuted.value;
  }
}

export type LightboxItem = string | { src: string; type: 'video'; poster?: string; isGifv?: boolean };

interface Props {
  visible: boolean;
  imgs: LightboxItem[];
  index?: number;
}

const props = withDefaults(defineProps<Props>(), {
  index: 0
});

const emit = defineEmits<{
  hide: [];
}>();

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

function onHide() {
  emit('hide');
}

function prev() {
  if (index.value > 0) index.value--;
}

function next() {
  if (index.value < items.value.length - 1) index.value++;
}

function handleKeydown(e: KeyboardEvent) {
  if (!props.visible) return;
  if (e.key === 'Escape') onHide();
  else if (e.key === 'ArrowLeft') prev();
  else if (e.key === 'ArrowRight') next();
}

watch(
  () => props.index,
  (v) => { index.value = v; },
  { immediate: true }
);

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

.mute-toggle {
  position: absolute;
  bottom: 0.75rem;
  left: 0.75rem;
  width: 40px;
  height: 40px;
  background: rgba(0, 0, 0, 0.5);
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

.mute-toggle:hover {
  background: rgba(0, 0, 0, 0.7);
}

.mute-toggle svg {
  width: 22px;
  height: 22px;
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
