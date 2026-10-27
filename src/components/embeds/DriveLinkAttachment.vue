<!-- A link to a Drive file of this instance, /drive/file/<id> or /d/<token>, drawn as a message
     attachment from drive_file_card: an image or a video inline, opening in the media viewer;
     audio in a player; any other file as a file row. Markup and styles mirror the attachments
     of UnifiedMessageContent. A reader without access gets one line naming nothing of the file. -->
<template>
  <div
    v-if="state === 'loading'"
    class="drive-attachment drive-attachment--loading"
    data-testid="drive-attachment"
    data-state="loading"
    aria-hidden="true"
  >
    <span class="media-skeleton drive-attachment__skeleton" />
  </div>

  <div
    v-else-if="state === 'restricted'"
    class="drive-attachment drive-attachment--restricted"
    role="note"
    :title="t('drive.card.restrictedText')"
    data-testid="drive-attachment"
    data-state="restricted"
  >
    <Icon name="lock" :size="14" aria-hidden="true" />
    <span>{{ t('drive.card.restrictedTitle') }}</span>
  </div>

  <div v-else-if="state === 'gone'" class="drive-attachment media-container" data-testid="drive-attachment" data-state="gone">
    <DriveGoneFile :reason="goneReason!" :name="name" :file-type="card?.kind ?? null" />
  </div>

  <div
    v-else-if="layout === 'image'"
    class="drive-attachment media-container image-container"
    data-testid="drive-attachment"
    data-state="ready"
    data-kind="image"
  >
    <div class="media-frame">
      <div v-if="!imageLoaded" class="media-skeleton image-skeleton" />
      <img
        v-show="imageLoaded"
        :src="thumbnail"
        :alt="name"
        class="content-image"
        draggable="false"
        data-testid="drive-attachment-image"
        @load="onImageSettled"
        @error="onImageError"
        @click="view()"
      />
      <button
        type="button"
        class="media-open"
        :aria-label="t('drive.card.view', { name })"
        data-testid="drive-attachment-view"
        @click.stop="view()"
      ></button>
      <span class="drive-attachment__mark drive-attachment__mark--overlay" :title="name" data-testid="drive-attachment-mark">
        <Icon name="hard-drive" :size="12" aria-hidden="true" />{{ t('drive.title') }}
      </span>
      <button
        type="button"
        class="drive-attachment__overlay-action"
        :title="t('drive.attachment.openInDrive')"
        :aria-label="t('drive.attachment.openNamedInDrive', { name })"
        data-testid="drive-attachment-open"
        @click.stop="openInDrive"
      >
        <Icon name="external-link" :size="16" aria-hidden="true" />
      </button>
    </div>
  </div>

  <div
    v-else-if="layout === 'video'"
    class="drive-attachment media-container video-container"
    data-testid="drive-attachment"
    data-state="ready"
    data-kind="video"
  >
    <div class="media-frame">
      <video
        :src="source"
        :controls="nativeControls"
        class="content-video"
        preload="metadata"
        :aria-label="name"
        data-testid="drive-attachment-video"
        @play="onPlay"
        @loadedmetadata="emit('embed-loaded')"
        @error="onMediaError"
      ></video>
      <VideoControls v-if="!nativeControls" :label="name" expandable @expand="view" />
      <span class="drive-attachment__mark drive-attachment__mark--overlay" :title="name" data-testid="drive-attachment-mark">
        <Icon name="hard-drive" :size="12" aria-hidden="true" />{{ t('drive.title') }}
      </span>
      <button
        type="button"
        class="drive-attachment__overlay-action"
        :title="t('drive.attachment.openInDrive')"
        :aria-label="t('drive.attachment.openNamedInDrive', { name })"
        data-testid="drive-attachment-open"
        @click.stop="openInDrive"
      >
        <Icon name="external-link" :size="16" aria-hidden="true" />
      </button>
    </div>
  </div>

  <div
    v-else-if="layout === 'audio'"
    class="drive-attachment media-container audio-container"
    data-testid="drive-attachment"
    data-state="ready"
    data-kind="audio"
  >
    <div class="audio-filename drive-attachment__head">
      <span class="drive-attachment__name">{{ name }}</span>
      <span class="drive-attachment__mark" :title="name" data-testid="drive-attachment-mark">
        <Icon name="hard-drive" :size="12" aria-hidden="true" />{{ t('drive.title') }}
      </span>
      <button
        type="button"
        class="drive-attachment__action drive-attachment__action--reveal"
        :title="t('drive.attachment.openInDrive')"
        :aria-label="t('drive.attachment.openNamedInDrive', { name })"
        data-testid="drive-attachment-open"
        @click="openInDrive"
      >
        <Icon name="external-link" :size="14" aria-hidden="true" />
      </button>
    </div>
    <audio
      :src="source"
      controls
      preload="metadata"
      class="content-audio"
      :aria-label="name"
      data-testid="drive-attachment-audio"
      @error="onMediaError"
    ></audio>
  </div>

  <div
    v-else-if="card"
    class="drive-attachment file-attachment"
    data-testid="drive-attachment"
    data-state="ready"
    data-kind="file"
  >
    <Icon :name="kindIcon(card.kind, card.mime_type)" :size="20" class="file-icon" aria-hidden="true" />
    <a
      v-if="safeSource"
      :href="namedDownloadUrl(safeSource, name)"
      rel="noopener noreferrer"
      class="file-name"
      data-testid="drive-attachment-name"
      @click.prevent="download"
    >{{ name }}</a>
    <span v-else class="file-name" data-testid="drive-attachment-name">{{ name }}</span>
    <span class="file-size">{{ size }}</span>
    <span class="drive-attachment__mark" :title="name" data-testid="drive-attachment-mark">
      <Icon name="hard-drive" :size="12" aria-hidden="true" />{{ t('drive.title') }}
    </span>
    <button
      type="button"
      class="drive-attachment__action drive-attachment__action--reveal"
      :title="t('drive.attachment.openInDrive')"
      :aria-label="t('drive.attachment.openNamedInDrive', { name })"
      data-testid="drive-attachment-open"
      @click="openInDrive"
    >
      <Icon name="external-link" :size="16" aria-hidden="true" />
    </button>
    <button
      type="button"
      class="drive-attachment__action"
      :title="t('drive.actions.download')"
      :aria-label="t('drive.card.download', { name })"
      data-testid="drive-attachment-download"
      @click="download"
    >
      <Icon name="download" :size="16" aria-hidden="true" />
    </button>
  </div>
</template>

<script lang="ts">
import type { DriveFileCard } from '@/services/drive/driveService'

/** Answers kept per account and link for virtual-scroller remounts; a share or unshare shows
 *  after this. */
const CARD_TTL_MS = 30_000
const cardCache = new Map<string, { card: DriveFileCard; at: number }>()
const cardInflight = new Map<string, Promise<DriveFileCard>>()

export function forgetDriveCards(): void {
  cardCache.clear()
  cardInflight.clear()
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import DriveGoneFile from '@/components/drive/DriveGoneFile.vue'
import { useLightbox, type LightboxMedia } from '@/composables/useLightbox'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import { useFloatingVideo } from '@/composables/useFloatingVideo'
import {
  driveDownloadUrl,
  driveLinkContentUrl,
  getDriveFileCard,
  postMediaPublicUrl,
  type DriveFileCardFile,
  type DriveFileCardLink,
} from '@/services/drive/driveService'
import { driveLinkPath, type DriveLinkRef } from '@/services/drive/driveLinks'
import { formatBytes, kindIcon } from '@/components/drive/driveFormat'
import {
  ensureMediaPartSources,
  mediaPartGone,
  mediaPartSource,
  reportMediaPartError,
  type GoneReason,
  type MediaPartLike,
} from '@/services/privateMedia'
import { sanitizeUrl } from '@/utils/sanitize'
import { namedDownloadUrl, saveFile } from '@/services/downloads'

const props = defineProps<{ link: DriveLinkRef; url: string }>()
const emit = defineEmits<{ 'embed-loaded': [] }>()

const { t, locale } = useT()
const router = useRouter()
const nativeControls = useNativeVideoControls()
const { open: openLightbox } = useLightbox()
const { notifyPlaybackStarted } = useFloatingVideo()
const card = ref<DriveFileCardFile | DriveFileCardLink | null>(null)
const state = ref<'loading' | 'ready' | 'restricted' | 'gone'>('loading')
const imageLoaded = ref(false)

const authStore = useAuthStore()
const cacheKey = computed(() => `${authStore.session?.user?.id ?? ''}:${props.link.kind === 'file' ? `file:${props.link.id}` : `token:${props.link.token}`}`)
const name = computed(() => card.value?.name || t('drive.file.unnamed'))
const size = computed(() => (card.value ? formatBytes(card.value.size_bytes, locale.value) : ''))

/** /d/ token the bytes of a link card are served under: the card's, else the link's. */
const linkToken = computed(() => card.value?.token
  || (props.link.kind === 'token' ? props.link.token : null))

/**
 * The file as a message media part: a message_media object signs as an attachment does; a
 * user_media object is public; a link card's bytes come from the backend link route.
 */
const part = computed<MediaPartLike | null>(() => {
  const value = card.value
  if (!value) return null
  if (value.via === 'file') {
    return value.bucket === 'user_media' ? { url: postMediaPublicUrl(value.path) } : { path: value.path }
  }
  return linkToken.value ? { url: driveLinkContentUrl(linkToken.value) } : null
})
const source = computed(() => mediaPartSource(part.value))
const thumbnail = computed(() => mediaPartSource(part.value, 'thumbnail'))
const safeSource = computed(() => (source.value ? sanitizeUrl(source.value) : ''))

const goneReason = computed<GoneReason | null>(() => {
  const value = card.value
  if (value?.via === 'file' && value.state === 'gone') return value.gone_reason ?? 'deleted'
  return mediaPartGone(part.value)
})

/** How the file draws: images and videos inline, audio in a player, the rest as a file row. */
const layout = computed<'image' | 'video' | 'audio' | 'file'>(() => {
  const kind = card.value?.kind
  if (!part.value) return 'file'
  return kind === 'image' || kind === 'video' || kind === 'audio' ? kind : 'file'
})

async function fetchCard(key: string): Promise<DriveFileCard> {
  const cached = cardCache.get(key)
  if (cached && Date.now() - cached.at < CARD_TTL_MS) return cached.card
  let pending = cardInflight.get(key)
  if (!pending) {
    pending = getDriveFileCard(props.link.kind === 'file' ? { fileId: props.link.id } : { token: props.link.token })
      .then((answer) => {
        cardCache.set(key, { card: answer, at: Date.now() })
        return answer
      })
      .finally(() => cardInflight.delete(key))
    cardInflight.set(key, pending)
  }
  return pending
}

async function load(): Promise<void> {
  const key = cacheKey.value
  if (!cardCache.has(key)) state.value = 'loading'
  let answer: DriveFileCard
  try {
    answer = await fetchCard(key)
  } catch {
    answer = { access: false }
  }
  if (key !== cacheKey.value) return
  imageLoaded.value = false
  if (!answer.access || (answer.via === 'link' && !answer.token && props.link.kind !== 'token')) {
    card.value = null
    state.value = 'restricted'
  } else {
    card.value = answer
    state.value = goneReason.value ? 'gone' : 'ready'
  }
  if (state.value !== 'ready' || layout.value !== 'image') emit('embed-loaded')
}

watch(cacheKey, () => void load(), { immediate: true })
watch(goneReason, (reason) => {
  if (reason && state.value === 'ready') state.value = 'gone'
})

function onImageSettled(): void {
  imageLoaded.value = true
  emit('embed-loaded')
}

function onImageError(): void {
  reportMediaPartError(part.value, 'thumbnail')
  onImageSettled()
}

function onMediaError(): void {
  reportMediaPartError(part.value)
  emit('embed-loaded')
}

function onPlay(event: Event): void {
  notifyPlaybackStarted(event.target as HTMLElement)
}

/** Opens the media viewer at the file; `origin` is the inline player the viewer takes over. */
async function view(origin?: HTMLMediaElement): Promise<void> {
  const media = part.value
  if (!media || (layout.value !== 'image' && layout.value !== 'video')) return
  await ensureMediaPartSources([media])
  const url = mediaPartSource(media)
  if (!url) return
  const item: LightboxMedia = layout.value === 'video'
    ? { url, type: 'video', name: name.value }
    : { url, type: 'image', name: name.value, alt: name.value }
  openLightbox([item], 0, { origin: origin ?? null })
}

function openInDrive(): void {
  void router.push(driveLinkPath(props.link))
}

async function download(): Promise<void> {
  const value = card.value
  if (!value) return
  if (value.via === 'link') {
    if (!linkToken.value) return
    // The backend link route names the file itself.
    await saveFile(driveLinkContentUrl(linkToken.value, true), value.name || '', { named: true })
    return
  }
  let url: string
  try {
    url = await driveDownloadUrl(value)
  } catch {
    return
  }
  await saveFile(url, value.name || '', { named: true })
}
</script>

<style scoped>
/* Attachment rules of UnifiedMessageContent, whose styles are scoped to it. */
.media-container {
  display: block;
  margin: 4px 0;
  max-width: 100%;
}

.media-frame {
  display: inline-block;
  position: relative;
  max-width: min(400px, 100%);
  vertical-align: top;
}

.media-open {
  position: absolute;
  inset: 0;
  z-index: 1;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  pointer-events: none;
}

.media-open:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}

.content-image {
  display: block;
  width: auto;
  max-width: min(400px, 100%);
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  cursor: pointer;
}

.content-video {
  display: block;
  width: auto;
  max-width: min(400px, 100%);
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  background-color: #000;
}

.media-skeleton {
  border-radius: 8px;
  background-color: var(--background-quaternary);
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: drive-attachment-shimmer 1.8s ease-in-out infinite;
}

.image-skeleton {
  display: block;
  width: 200px;
  height: 150px;
}

@keyframes drive-attachment-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

.file-attachment {
  position: relative;
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: var(--background-tertiary);
  border-radius: 8px;
  margin: 4px 0;
  max-width: 400px;
}

.audio-container {
  position: relative;
}

.file-icon {
  flex-shrink: 0;
  color: var(--text-secondary);
}

.file-name {
  color: var(--text-link);
  text-decoration: none;
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  -webkit-user-select: text;
}

a.file-name:hover {
  text-decoration: underline;
}

.file-size {
  color: var(--text-secondary);
  font-size: 0.875rem;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.audio-filename {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

/* Drive additions */
.drive-attachment--loading {
  display: block;
  margin: 4px 0;
}

.drive-attachment__skeleton {
  display: block;
  width: min(240px, 100%);
  height: 40px;
}

/* Block-level, as attachments are, and as wide as its text. */
.drive-attachment--restricted {
  display: flex;
  width: fit-content;
  align-items: center;
  gap: 6px;
  max-width: 100%;
  margin: 4px 0;
  padding: 4px 10px;
  border-radius: 8px;
  background-color: var(--background-tertiary);
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.drive-attachment__mark {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border-radius: var(--radius-full, 999px);
  background: color-mix(in srgb, var(--harmony-primary) 16%, transparent);
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  line-height: 1.4;
  opacity: 0;
  transition: opacity var(--transition-fast, 0.15s ease);
}

/* Over a picture or video: top left, the box of the attachment controls. */
.drive-attachment__mark--overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  z-index: 2;
  border: 1px solid rgb(255 255 255 / 0.12);
  background: rgb(12 14 20 / 0.72);
  color: #fff;
}

/* Top right, the box of .floating-video-popout and .attachment-remove-btn. */
.drive-attachment__overlay-action {
  position: absolute;
  top: 8px;
  right: 8px;
  z-index: 3;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  padding: 0;
  border: 1px solid rgb(255 255 255 / 0.12);
  border-radius: 8px;
  background: rgb(12 14 20 / 0.72);
  color: #fff;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast, 0.15s ease), background-color var(--transition-fast, 0.15s ease);
}

.drive-attachment__overlay-action:hover {
  background: var(--harmony-primary, #0ea5e9);
  border-color: var(--harmony-primary, #0ea5e9);
}

.drive-attachment__overlay-action:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}

.drive-attachment__head {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: 400px;
}

.drive-attachment__name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-attachment__action {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm, 4px);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.drive-attachment__action:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drive-attachment__action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.drive-attachment__action--reveal {
  opacity: 0;
}

.media-frame:hover > .drive-attachment__mark,
.media-frame:focus-within > .drive-attachment__mark,
.media-frame:hover > .drive-attachment__overlay-action,
.media-frame:focus-within > .drive-attachment__overlay-action,
.drive-attachment:hover .drive-attachment__mark,
.drive-attachment:focus-within .drive-attachment__mark,
.drive-attachment:hover .drive-attachment__action--reveal,
.drive-attachment:focus-within .drive-attachment__action--reveal {
  opacity: 1;
}

@media (hover: none), (pointer: coarse) {
  .drive-attachment__mark,
  .drive-attachment__overlay-action,
  .drive-attachment__action--reveal {
    opacity: 1;
  }
}

@media (prefers-reduced-motion: reduce) {
  .media-skeleton {
    animation: none;
  }
}
</style>
