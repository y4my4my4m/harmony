<!-- Full-window preview of Drive files, stepping through the files of the view. -->
<template>
  <Teleport to="body">
    <div
      v-show="!lightbox.item.value"
      ref="root"
      class="drive-preview"
      role="dialog"
      aria-modal="true"
      :aria-label="name"
      tabindex="-1"
      data-testid="drive-preview"
      @keydown="onKeydown"
      @click.self="emit('close')"
    >
      <header class="drive-preview__bar">
        <span class="drive-preview__name">{{ name }}</span>
        <span class="drive-preview__count">{{ index + 1 }} / {{ files.length }}</span>
        <button
          v-if="(file.kind === 'image' || file.kind === 'video') && src"
          type="button"
          class="drive-preview__btn"
          :aria-label="t('drive.preview.fullScreen')"
          :title="t('drive.preview.fullScreen')"
          data-testid="drive-preview-lightbox"
          @click="openLightbox"
        >
          <Icon name="maximize" :size="18" />
        </button>
        <button type="button" class="drive-preview__btn" :aria-label="t('drive.actions.download')" @click="emit('download', file)">
          <Icon name="download" :size="18" />
        </button>
        <button type="button" class="drive-preview__btn" :aria-label="t('common.close')" @click="emit('close')">
          <Icon name="x" :size="20" />
        </button>
      </header>

      <button v-if="index > 0" type="button" class="drive-preview__nav drive-preview__nav--prev" :aria-label="t('drive.preview.previous')" @click="step(-1)">
        <Icon name="chevron-left" :size="26" />
      </button>
      <div class="drive-preview__stage" @click.self="emit('close')">
        <Transition name="drive-preview-fade" mode="out-in">
          <div :key="file.id" class="drive-preview__content">
            <img v-if="file.kind === 'image' && src" :src="src" :alt="name" class="drive-preview__image" @click="openLightbox" />
            <div v-else-if="file.kind === 'video' && src" class="drive-preview__video">
              <video ref="videoEl" :src="src" autoplay playsinline :controls="nativeControls" class="drive-preview__media" />
              <VideoControls v-if="!nativeControls" :label="name" />
            </div>
            <div v-else-if="file.kind === 'audio' && src" class="drive-preview__audio">
              <Icon name="music" :size="48" />
              <audio :src="src" controls autoplay />
            </div>
            <iframe v-else-if="isPdf && src" :src="src" class="drive-preview__pdf" :title="name" />
            <div v-else class="drive-preview__none">
              <Icon name="file" :size="48" />
              <p>{{ t('drive.preview.none') }}</p>
              <button type="button" class="drive-btn drive-btn--primary" @click="emit('download', file)">
                <Icon name="download" :size="15" />{{ t('drive.actions.download') }}
              </button>
            </div>
          </div>
        </Transition>
      </div>
      <button v-if="index < files.length - 1" type="button" class="drive-preview__nav drive-preview__nav--next" :aria-label="t('drive.preview.next')" @click="step(1)">
        <Icon name="chevron-right" :size="26" />
      </button>
    </div>
    <!-- MediaLightbox stacks below this dialog; the dialog hides while it is open. The
         preview's video is the viewer's origin: it pauses and takes the position back. -->
    <MediaLightbox
      v-if="lightbox.item.value"
      :visible="true"
      :imgs="[lightbox.item.value]"
      :origin="file.kind === 'video' ? videoEl : null"
      @hide="closeLightbox"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import MediaLightbox from '@/components/common/MediaLightbox.vue'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import { driveFileDisplayName, type DriveFile } from '@/services/drive/driveService'
import { driveMediaSource } from './driveFormat'
import { useDriveLightbox } from './useDriveLightbox'

const props = defineProps<{ files: DriveFile[]; startId: string }>()
const emit = defineEmits<{ close: []; download: [file: DriveFile] }>()

const { t } = useT()
const nativeControls = useNativeVideoControls()
const root = ref<HTMLElement | null>(null)
const videoEl = ref<HTMLVideoElement | null>(null)
const index = ref(Math.max(0, props.files.findIndex((f) => f.id === props.startId)))

const file = computed(() => props.files[index.value])
const name = computed(() => driveFileDisplayName(file.value, t('drive.file.unnamed')))
const src = computed(() => driveMediaSource(file.value))
const isPdf = computed(() => file.value.mime_type === 'application/pdf')

const lightbox = useDriveLightbox()

function openLightbox(): void {
  lightbox.open(file.value, name.value)
}

function closeLightbox(): void {
  lightbox.close()
  void nextTick(() => root.value?.focus())
}

function step(delta: number): void {
  index.value = Math.min(props.files.length - 1, Math.max(0, index.value + delta))
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.target as HTMLElement).closest('video, .hv, audio, iframe')) return
  if (event.key === 'Escape') { event.preventDefault(); emit('close') }
  else if (event.key === 'ArrowLeft') { event.preventDefault(); step(-1) }
  else if (event.key === 'ArrowRight') { event.preventDefault(); step(1) }
}

onMounted(() => root.value?.focus())
</script>

<style scoped>
.drive-preview {
  position: fixed;
  inset: 0;
  z-index: 10050;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgb(6 8 12 / 0.9);
  backdrop-filter: blur(10px);
  outline: none;
  animation: drive-preview-in 0.16s ease-out;
}

.drive-preview__bar {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  background: linear-gradient(rgb(0 0 0 / 0.55), transparent);
  color: #fff;
}

.drive-preview__name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  font-weight: var(--font-weight-semibold);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-preview__count {
  font-size: var(--font-size-sm);
  opacity: 0.7;
  font-variant-numeric: tabular-nums;
}

.drive-preview__btn,
.drive-preview__nav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  background: rgb(255 255 255 / 0.08);
  border: none;
  border-radius: var(--radius-full);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.12s ease;
}

.drive-preview__btn:hover,
.drive-preview__nav:hover {
  background: rgb(255 255 255 / 0.18);
}

.drive-preview__nav {
  position: absolute;
  top: 50%;
  width: 44px;
  height: 44px;
  transform: translateY(-50%);
}

.drive-preview__nav--prev { left: var(--space-4); }
.drive-preview__nav--next { right: var(--space-4); }

.drive-preview__stage {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  padding: 64px 80px 32px;
}

.drive-preview__content {
  display: flex;
  align-items: center;
  justify-content: center;
  max-width: 100%;
  max-height: 100%;
}

.drive-preview__image {
  max-width: 100%;
  max-height: calc(100 * var(--app-vh) - 110px);
  object-fit: contain;
  border-radius: var(--radius-sm);
  box-shadow: 0 20px 60px rgb(0 0 0 / 0.5);
  cursor: zoom-in;
}

.drive-preview__video {
  position: relative;
  width: min(1200px, 100%);
  aspect-ratio: 16 / 9;
  max-height: calc(100 * var(--app-vh) - 110px);
  background: #000;
  border-radius: var(--radius-md);
  overflow: hidden;
}

.drive-preview__media {
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.drive-preview__audio,
.drive-preview__none {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  color: rgb(255 255 255 / 0.85);
}

.drive-preview__none p {
  margin: 0;
}

.drive-preview__pdf {
  width: min(960px, 100%);
  height: calc(100 * var(--app-vh) - 110px);
  background: #fff;
  border: none;
  border-radius: var(--radius-sm);
}

.drive-preview-fade-enter-active,
.drive-preview-fade-leave-active {
  transition: opacity 0.12s ease, transform 0.12s ease;
}

.drive-preview-fade-enter-from,
.drive-preview-fade-leave-to {
  opacity: 0;
  transform: scale(0.985);
}

@keyframes drive-preview-in {
  from { opacity: 0; }
  to { opacity: 1; }
}

@media (max-width: 720px) {
  .drive-preview__stage { padding: 56px 8px 16px; }
  .drive-preview__nav { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .drive-preview,
  .drive-preview-fade-enter-active,
  .drive-preview-fade-leave-active { animation: none; transition: none; }
}
</style>
