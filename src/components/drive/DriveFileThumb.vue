<!-- Preview face of a Drive file: image thumbnail, video poster frame once visible, or a typed
     icon with the extension. -->
<template>
  <div ref="root" class="drive-thumb" :class="[`drive-thumb--${file.kind}`, { 'drive-thumb--small': small }]">
    <img
      v-if="thumb && !failed"
      :src="thumb"
      alt=""
      class="drive-thumb__media"
      loading="lazy"
      decoding="async"
      draggable="false"
      @error="failed = true"
    />
    <video
      v-else-if="file.kind === 'video' && visible && videoSrc && !failed && !small"
      :src="`${videoSrc}#t=0.5`"
      class="drive-thumb__media"
      preload="metadata"
      muted
      playsinline
      tabindex="-1"
      aria-hidden="true"
      @error="failed = true"
    />
    <div v-else class="drive-thumb__icon">
      <Icon :name="kindIcon(file.kind, file.mime_type)" :size="small ? 18 : 30" />
      <span v-if="!small" class="drive-thumb__ext">{{ extensionLabel(file) }}</span>
    </div>
    <span v-if="file.kind === 'video' && !small" class="drive-thumb__badge" aria-hidden="true">
      <Icon name="play" :size="12" />
    </span>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import type { DriveFile } from '@/services/drive/driveService'
import { driveMediaSource, driveThumbnail, extensionLabel, kindIcon } from './driveFormat'

const props = withDefaults(defineProps<{ file: DriveFile; small?: boolean }>(), { small: false })

const root = ref<HTMLElement | null>(null)
const visible = ref(false)
const failed = ref(false)
let observer: IntersectionObserver | null = null

const thumb = computed(() => driveThumbnail(props.file))
const videoSrc = computed(() => (props.file.kind === 'video' && visible.value ? driveMediaSource(props.file) : undefined))

onMounted(() => {
  if (props.file.kind !== 'video' || props.small || typeof IntersectionObserver === 'undefined') return
  observer = new IntersectionObserver((records) => {
    if (records.some((r) => r.isIntersecting)) {
      visible.value = true
      observer?.disconnect()
      observer = null
    }
  }, { rootMargin: '200px' })
  if (root.value) observer.observe(root.value)
})

onBeforeUnmount(() => observer?.disconnect())
</script>

<style scoped>
.drive-thumb {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  overflow: hidden;
  background: var(--background-tertiary, var(--background-secondary));
  border-radius: inherit;
}

.drive-thumb__media {
  width: 100%;
  height: 100%;
  object-fit: cover;
  pointer-events: none;
}

.drive-thumb__icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 6px;
  color: var(--text-muted);
}

.drive-thumb--image .drive-thumb__icon { color: #35b8f0; }
.drive-thumb--video .drive-thumb__icon { color: #a78bfa; }
.drive-thumb--audio .drive-thumb__icon { color: #f472b6; }
.drive-thumb--document .drive-thumb__icon { color: #60a5fa; }

.drive-thumb__ext {
  font-size: 10px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.06em;
  color: var(--text-muted);
}

.drive-thumb__badge {
  position: absolute;
  left: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  background: rgb(12 14 20 / 0.7);
  border-radius: var(--radius-full);
  color: #fff;
  backdrop-filter: blur(6px);
}

.drive-thumb--small .drive-thumb__icon {
  gap: 0;
}
</style>
