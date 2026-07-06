<!-- Discord-style attachment mosaic (fixed grid cells, object-fit: cover) -->
<template>
  <div
    class="message-media-gallery"
    :class="layoutClass"
  >
    <div
      v-for="(item, index) in items"
      :key="item.url + index"
      class="message-media-gallery__item"
      :class="{ 'is-video': item.fileType === 'video' }"
    >
      <div class="message-media-gallery__frame">
        <AttachmentRemoveButton
          v-if="canRemove"
          @click="$emit('remove-attachment', item.url)"
        />
        <div
          v-if="item.fileType === 'image' && !imageLoaded[item.url]"
          class="media-skeleton image-skeleton"
        />
        <img
          v-if="item.fileType === 'image'"
          :src="thumbnailFor(item)"
          class="content-image"
          :class="{ 'sticker-image': item.isSticker, 'ai-emoji-image': item.isAiEmoji }"
          draggable="false"
          v-show="imageLoaded[item.url]"
          @load="onImageLoad(item.url)"
          @error="onItemError(item.url)"
          @click="!item.isSticker && $emit('open-lightbox', item.url)"
        />
        <video
          v-else-if="item.fileType === 'video'"
          :src="videoFrameSrc(item.url)"
          class="content-video"
          controls
          preload="metadata"
          :data-video-index="(videoIndexBase ?? 0) + index"
          @play="$emit('video-play', $event)"
          @pause="$emit('video-pause', $event)"
          @error="onItemError(item.url)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, watch } from 'vue';
import type { MessagePart } from '@/types';
import { videoFrameSrc } from '@/utils/videoThumb';
import {
  isImageMediaUrl,
  isVideoMediaUrl,
  mediaGalleryLayoutClass,
} from '@/utils/mediaGalleryUtils';
import { stripKlipyAttributionFragment, isStickerMessageUrl, isAiEmojiMessageUrl } from '@/utils/klipyAttribution';
import { getAttachmentThumbnailUrl } from '@/utils/storageImageUtils';
import AttachmentRemoveButton from '@/components/common/AttachmentRemoveButton.vue';
import {
  isDiscordCdnUrl,
  hasExpiredBridgedAttachment,
  requestAttachmentRefresh,
} from '@/services/attachmentRefresh';

export interface GalleryMediaItem {
  url: string;
  fileType: 'image' | 'video';
  isSticker: boolean;
  isAiEmoji: boolean;
}

const props = defineProps<{
  parts: MessagePart[];
  imageLoaded: Record<string, boolean>;
  videoIndexBase?: number;
  canRemove?: boolean;
  messageId?: string;
}>();

const onItemError = (url: string) => {
  if (isDiscordCdnUrl(url)) requestAttachmentRefresh(props.messageId);
};

const maybeRefreshExpired = () => {
  if (hasExpiredBridgedAttachment(props.parts)) {
    requestAttachmentRefresh(props.messageId);
  }
};
onMounted(maybeRefreshExpired);
watch(() => props.parts, maybeRefreshExpired);

function partToGalleryItem(part: MessagePart): GalleryMediaItem | null {
  if (!part || typeof part !== 'object') return null;

  let url = '';
  let fileType: 'image' | 'video' | null = null;

  if (part.type === 'file') {
    url = stripKlipyAttributionFragment((part as { url?: string }).url || '');
    const ft = (part as { fileType?: string }).fileType;
    if (ft === 'image' || ft === 'video') {
      fileType = ft;
    } else if (isImageMediaUrl(url)) {
      fileType = 'image';
    } else if (isVideoMediaUrl(url)) {
      fileType = 'video';
    }
  } else if (part.type === 'url') {
    url = (part as { url?: string }).url || '';
    if (isImageMediaUrl(url)) fileType = 'image';
    else if (isVideoMediaUrl(url)) fileType = 'video';
  }

  if (!url || !fileType) return null;

  return {
    url,
    fileType,
    isSticker: isStickerMessageUrl(url),
    isAiEmoji: isAiEmojiMessageUrl(url),
  };
}

const items = computed(() =>
  props.parts
    .map(partToGalleryItem)
    .filter((item): item is GalleryMediaItem => item !== null),
);

const layoutClass = computed(() => mediaGalleryLayoutClass(items.value.length));

const emit = defineEmits<{
  'open-lightbox': [url: string];
  'image-loaded': [url: string];
  'video-play': [event: Event];
  'video-pause': [event: Event];
  'remove-attachment': [url: string];
}>();

function onImageLoad(url: string) {
  emit('image-loaded', url);
}

// Inline thumbnail (downscaled for local uploads); lightbox still opens item.url
// at full size. Stickers/AI emoji stay raw to preserve animation.
function thumbnailFor(item: GalleryMediaItem): string {
  if (item.isSticker || item.isAiEmoji) return item.url;
  return getAttachmentThumbnailUrl(item.url);
}
</script>

<style scoped>
/* Discord-ish caps: 400px wide mosaics, 350px tall singles, cover-crop in grids */
.message-media-gallery {
  --gallery-max-width: min(400px, 100%);
  --gallery-gap: 4px;
  --gallery-radius: 8px;
  margin: 4px 0 8px;
  width: var(--gallery-max-width);
  max-width: var(--gallery-max-width);
  gap: var(--gallery-gap);
}

.message-media-gallery__item {
  position: relative;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: var(--background-secondary, #2b2d31);
}

/* Single attachment: natural aspect ratio, capped height */
.message-media-gallery-count-1 {
  display: block;
  border-radius: var(--gallery-radius);
  overflow: hidden;
}

.message-media-gallery-count-1 .message-media-gallery__frame {
  position: relative;
}

.message-media-gallery-count-1 .content-image,
.message-media-gallery-count-1 .content-video {
  display: block;
  width: auto;
  max-width: 100%;
  max-height: min(350px, 50vh);
  object-fit: contain;
  background: #000;
  cursor: pointer;
}

/* Mosaic: fixed grid geometry - intrinsic image size never affects layout */
.message-media-gallery-count-2,
.message-media-gallery-count-3,
.message-media-gallery-count-4,
.message-media-gallery-count-5,
.message-media-gallery-count-6,
.message-media-gallery-count-7,
.message-media-gallery-count-8,
.message-media-gallery-count-9,
.message-media-gallery-count-10 {
  display: grid;
}

.message-media-gallery-count-2 .message-media-gallery__item,
.message-media-gallery-count-3 .message-media-gallery__item,
.message-media-gallery-count-4 .message-media-gallery__item,
.message-media-gallery-count-5 .message-media-gallery__item,
.message-media-gallery-count-6 .message-media-gallery__item,
.message-media-gallery-count-7 .message-media-gallery__item,
.message-media-gallery-count-8 .message-media-gallery__item,
.message-media-gallery-count-9 .message-media-gallery__item,
.message-media-gallery-count-10 .message-media-gallery__item {
  aspect-ratio: auto;
}

.message-media-gallery-count-2 .message-media-gallery__frame,
.message-media-gallery-count-3 .message-media-gallery__frame,
.message-media-gallery-count-4 .message-media-gallery__frame,
.message-media-gallery-count-5 .message-media-gallery__frame,
.message-media-gallery-count-6 .message-media-gallery__frame,
.message-media-gallery-count-7 .message-media-gallery__frame,
.message-media-gallery-count-8 .message-media-gallery__frame,
.message-media-gallery-count-9 .message-media-gallery__frame,
.message-media-gallery-count-10 .message-media-gallery__frame {
  position: absolute;
  inset: 0;
}

.message-media-gallery:not(.message-media-gallery-count-1) .content-image,
.message-media-gallery:not(.message-media-gallery-count-1) .content-video {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  object-fit: cover;
  cursor: pointer;
}

.message-media-gallery-count-2 {
  grid-template-columns: 1fr 1fr;
  aspect-ratio: 2 / 1;
  max-height: min(300px, 50vh);
}

.message-media-gallery-count-2 .message-media-gallery__item:nth-child(1) {
  border-radius: var(--gallery-radius) 0 0 var(--gallery-radius);
}

.message-media-gallery-count-2 .message-media-gallery__item:nth-child(2) {
  border-radius: 0 var(--gallery-radius) var(--gallery-radius) 0;
}

/* 3: tall left, two stacked right */
.message-media-gallery-count-3 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 4 / 3;
  max-height: min(300px, 50vh);
}

.message-media-gallery-count-3 .message-media-gallery__item:first-child {
  grid-row: 1 / 3;
  border-radius: var(--gallery-radius) 0 0 var(--gallery-radius);
}

.message-media-gallery-count-3 .message-media-gallery__item:nth-child(2) {
  border-radius: 0 var(--gallery-radius) 0 0;
}

.message-media-gallery-count-3 .message-media-gallery__item:nth-child(3) {
  border-radius: 0 0 var(--gallery-radius) 0;
}

/* 4: even 2×2 */
.message-media-gallery-count-4 {
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 1 / 1;
  max-height: min(400px, 60vh);
}

.message-media-gallery-count-4 .message-media-gallery__item:nth-child(1) {
  border-radius: var(--gallery-radius) 0 0 0;
}

.message-media-gallery-count-4 .message-media-gallery__item:nth-child(2) {
  border-radius: 0 var(--gallery-radius) 0 0;
}

.message-media-gallery-count-4 .message-media-gallery__item:nth-child(3) {
  border-radius: 0 0 0 var(--gallery-radius);
}

.message-media-gallery-count-4 .message-media-gallery__item:nth-child(4) {
  border-radius: 0 0 var(--gallery-radius) 0;
}

/* 5: two on top, three below */
.message-media-gallery-count-5 {
  grid-template-columns: repeat(6, 1fr);
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 3 / 2;
  max-height: min(320px, 55vh);
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(1) {
  grid-column: 1 / 4;
  grid-row: 1;
  border-radius: var(--gallery-radius) 0 0 0;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(2) {
  grid-column: 4 / 7;
  grid-row: 1;
  border-radius: 0 var(--gallery-radius) 0 0;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(3) {
  grid-column: 1 / 3;
  grid-row: 2;
  border-radius: 0 0 0 var(--gallery-radius);
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(4) {
  grid-column: 3 / 5;
  grid-row: 2;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(5) {
  grid-column: 5 / 7;
  grid-row: 2;
  border-radius: 0 0 var(--gallery-radius) 0;
}

.message-media-gallery-count-6 {
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: 1fr 1fr;
  aspect-ratio: 3 / 2;
  max-height: min(320px, 55vh);
}

.message-media-gallery-count-7 {
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: 1fr;
  aspect-ratio: 3 / 2;
  max-height: min(360px, 60vh);
}

.message-media-gallery-count-7 .message-media-gallery__item:first-child {
  grid-column: 1 / 4;
}

.message-media-gallery-count-8,
.message-media-gallery-count-9,
.message-media-gallery-count-10 {
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: 1fr;
  aspect-ratio: 1 / 1;
  max-height: min(400px, 60vh);
}

.message-media-gallery-count-8 .message-media-gallery__item:nth-child(1),
.message-media-gallery-count-8 .message-media-gallery__item:nth-child(2) {
  grid-row: span 2;
}

.message-media-gallery .content-video {
  cursor: default;
}

.message-media-gallery .sticker-image,
.message-media-gallery .ai-emoji-image {
  object-fit: contain;
  max-height: 160px;
  cursor: default;
}

.image-skeleton {
  position: absolute;
  inset: 0;
  background: linear-gradient(90deg, #2b2d31 25%, #383a40 50%, #2b2d31 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
