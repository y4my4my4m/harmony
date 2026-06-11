<!-- Discord-style mosaic for multiple chat/DM/thread image or video attachments -->
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
        <div
          v-if="item.fileType === 'image' && !imageLoaded[item.url]"
          class="media-skeleton image-skeleton"
        />
        <img
          v-if="item.fileType === 'image'"
          :src="item.url"
          class="content-image"
          :class="{ 'sticker-image': item.isSticker, 'ai-emoji-image': item.isAiEmoji }"
          draggable="false"
          v-show="imageLoaded[item.url]"
          @load="onImageLoad(item.url)"
          @click="!item.isSticker && $emit('open-lightbox', item.url)"
        />
        <video
          v-else-if="item.fileType === 'video'"
          :src="item.url"
          class="content-video"
          controls
          preload="metadata"
          :data-video-index="videoIndexBase + index"
          @play="$emit('video-play', $event)"
          @pause="$emit('video-pause', $event)"
        />
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import type { MessagePart } from '@/types';
import {
  isImageMediaUrl,
  isVideoMediaUrl,
  mediaGalleryLayoutClass,
} from '@/utils/mediaGalleryUtils';
import { stripKlipyAttributionFragment, isStickerMessageUrl, isAiEmojiMessageUrl } from '@/utils/klipyAttribution';

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
}>();

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
}>();

function onImageLoad(url: string) {
  emit('image-loaded', url);
}
</script>

<style scoped>
.message-media-gallery {
  margin: 4px 0 8px;
  max-width: min(430px, 100%);
  border-radius: 8px;
  overflow: hidden;
  gap: 2px;
}

.message-media-gallery__item {
  position: relative;
  min-width: 0;
  background: var(--background-secondary, #2b2d31);
  overflow: hidden;
}

.message-media-gallery__frame {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 0;
}

.message-media-gallery-count-1 {
  display: block;
}

.message-media-gallery-count-1 .content-image,
.message-media-gallery-count-1 .content-video {
  max-height: 320px;
  width: 100%;
  object-fit: contain;
  background: #000;
}

.message-media-gallery-count-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
}

/* 3 images: one wide on top, two side-by-side below */
.message-media-gallery-count-3 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  min-height: 220px;
}

.message-media-gallery-count-3 .message-media-gallery__item:first-child {
  grid-column: 1 / 3;
  grid-row: 1;
}

.message-media-gallery-count-4 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  min-height: 220px;
}

.message-media-gallery-count-5 {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  grid-template-rows: 1fr 1fr;
  min-height: 220px;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(1) {
  grid-column: 1 / 4;
  grid-row: 1;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(2) {
  grid-column: 4 / 7;
  grid-row: 1;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(3) {
  grid-column: 1 / 3;
  grid-row: 2;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(4) {
  grid-column: 3 / 5;
  grid-row: 2;
}

.message-media-gallery-count-5 .message-media-gallery__item:nth-child(5) {
  grid-column: 5 / 7;
  grid-row: 2;
}

.message-media-gallery-count-6 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-template-rows: 1fr 1fr;
  min-height: 220px;
}

.message-media-gallery-count-7 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: minmax(100px, 1fr);
  min-height: 280px;
}

.message-media-gallery-count-7 .message-media-gallery__item:first-child {
  grid-column: 1 / 4;
}

.message-media-gallery-count-8,
.message-media-gallery-count-9,
.message-media-gallery-count-10 {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  grid-auto-rows: minmax(100px, 1fr);
  min-height: 280px;
}

.message-media-gallery-count-8 .message-media-gallery__item:nth-child(1),
.message-media-gallery-count-8 .message-media-gallery__item:nth-child(2) {
  grid-row: span 2;
}

.message-media-gallery:not(.message-media-gallery-count-1) .content-image,
.message-media-gallery:not(.message-media-gallery-count-1) .content-video {
  display: block;
  width: 100%;
  height: 100%;
  min-height: 100px;
  max-height: none;
  object-fit: cover;
  cursor: pointer;
  border-radius: 0;
}

.message-media-gallery-count-2,
.message-media-gallery-count-3,
.message-media-gallery-count-4,
.message-media-gallery-count-5,
.message-media-gallery-count-6,
.message-media-gallery-count-7,
.message-media-gallery-count-8,
.message-media-gallery-count-9,
.message-media-gallery-count-10 {
  grid-auto-rows: minmax(100px, 1fr);
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
  min-height: 0;
}

.message-media-gallery .content-video {
  cursor: default;
  object-fit: cover;
}

.message-media-gallery .sticker-image,
.message-media-gallery .ai-emoji-image {
  object-fit: contain;
  max-height: 160px;
  cursor: default;
}

.image-skeleton {
  width: 100%;
  min-height: 120px;
  background: linear-gradient(90deg, #2b2d31 25%, #383a40 50%, #2b2d31 75%);
  background-size: 200% 100%;
  animation: shimmer 1.5s infinite;
}

@keyframes shimmer {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
</style>
