<!-- Card of a link to a Drive file of this instance, /drive/file/<id> or /d/<token>, from
     drive_file_card. A reader without access gets a card naming nothing of the file. -->
<template>
  <article
    class="drive-card"
    :class="`drive-card--${state}`"
    data-testid="drive-card"
    :data-state="state"
  >
    <div v-if="state === 'loading'" class="drive-card__row" aria-hidden="true">
      <span class="drive-card__glyph drive-card__skeleton" />
      <span class="drive-card__text">
        <span class="drive-card__skeleton drive-card__skeleton--title" />
        <span class="drive-card__skeleton drive-card__skeleton--meta" />
      </span>
    </div>

    <div v-else-if="state === 'restricted'" class="drive-card__row" data-testid="drive-card-restricted">
      <span class="drive-card__glyph drive-card__glyph--muted"><Icon name="lock" :size="20" /></span>
      <span class="drive-card__text">
        <span class="drive-card__title">{{ t('drive.card.restrictedTitle') }}</span>
        <span class="drive-card__meta">{{ t('drive.card.restrictedText') }}</span>
      </span>
    </div>

    <div v-else-if="state === 'gone'" class="drive-card__row" data-testid="drive-card-gone">
      <span class="drive-card__glyph drive-card__glyph--muted"><Icon name="file" :size="20" /></span>
      <span class="drive-card__text">
        <span class="drive-card__title">{{ name }}</span>
        <span class="drive-card__meta">{{ t('drive.card.gone') }}</span>
      </span>
    </div>

    <template v-else-if="card">
      <button
        v-if="card.kind === 'image' && (thumb || source)"
        type="button"
        class="drive-card__image"
        :aria-label="t('drive.card.view', { name })"
        data-testid="drive-card-image"
        @click="source && openLightbox([{ url: source, type: 'image', name, alt: name }])"
      >
        <img :src="thumb || source" :alt="name" draggable="false" @load="emit('embed-loaded')" @error="emit('embed-loaded')" />
      </button>
      <div v-else-if="card.kind === 'video' && source" class="drive-card__video" data-testid="drive-card-video">
        <video :src="source" preload="metadata" playsinline :controls="nativeControls" />
        <VideoControls v-if="!nativeControls" :label="name" />
      </div>
      <audio
        v-else-if="card.kind === 'audio' && source"
        class="drive-card__audio"
        :src="source"
        controls
        preload="metadata"
        data-testid="drive-card-audio"
      />

      <div class="drive-card__row">
        <span class="drive-card__glyph"><Icon :name="kindIcon(card.kind, card.mime_type)" :size="20" /></span>
        <span class="drive-card__text">
          <a
            class="drive-card__title"
            :href="href"
            data-testid="drive-card-name"
            @click.prevent="open"
          >{{ name }}</a>
          <span class="drive-card__meta">{{ meta }}</span>
        </span>
        <span class="drive-card__actions">
          <button type="button" class="drive-card__action" :aria-label="t('drive.card.open', { name })" :title="t('drive.actions.open')" data-testid="drive-card-open" @click="open">
            <Icon name="external-link" :size="16" />
          </button>
          <button type="button" class="drive-card__action" :aria-label="t('drive.card.download', { name })" :title="t('drive.actions.download')" data-testid="drive-card-download" @click="download">
            <Icon name="download" :size="16" />
          </button>
        </span>
      </div>
    </template>
  </article>
</template>

<script lang="ts">
import type { DriveFileCard } from '@/services/drive/driveService'

/** Answers kept per account and link for virtual-scroller remounts; a share or unshare shows
 *  after this. */
const CARD_TTL_MS = 30_000
const cardCache = new Map<string, { card: DriveFileCard; at: number }>()

export function forgetDriveCards(): void {
  cardCache.clear()
}
</script>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useAuthStore } from '@/stores/auth'
import Icon from '@/components/common/Icon.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import { useLightbox } from '@/composables/useLightbox'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import {
  driveDownloadUrl,
  driveLinkContentUrl,
  getDriveFileCard,
  type DriveFileCardFile,
  type DriveFileCardLink,
} from '@/services/drive/driveService'
import { driveLinkPath, type DriveLinkRef } from '@/services/drive/driveLinks'
import { driveMediaSource, driveThumbnail, formatBytes, kindIcon } from '@/components/drive/driveFormat'

const props = defineProps<{ link: DriveLinkRef; url: string }>()
const emit = defineEmits<{ 'embed-loaded': [] }>()

const { t, locale } = useT()
const router = useRouter()
const nativeControls = useNativeVideoControls()
const { open: openLightbox } = useLightbox()
const card = ref<DriveFileCardFile | DriveFileCardLink | null>(null)
const state = ref<'loading' | 'ready' | 'restricted' | 'gone'>('loading')

const authStore = useAuthStore()
const cacheKey = computed(() => `${authStore.session?.user?.id ?? ''}:${props.link.kind === 'file' ? `file:${props.link.id}` : `token:${props.link.token}`}`)
const href = computed(() => driveLinkPath(props.link))
const name = computed(() => card.value?.name || t('drive.file.unnamed'))
const kindLabel = computed(() => (card.value ? t(`drive.kind.${card.value.kind}`) : ''))
const meta = computed(() => (card.value ? `${formatBytes(card.value.size_bytes, locale.value)} · ${kindLabel.value}` : ''))

const fileSource = computed(() => (card.value?.via === 'file'
  ? { bucket: card.value.bucket, path: card.value.path, kind: card.value.kind, state: card.value.state }
  : null))
const source = computed(() => {
  if (props.link.kind === 'token') return card.value ? driveLinkContentUrl(props.link.token) : undefined
  return fileSource.value ? driveMediaSource(fileSource.value) : undefined
})
const thumb = computed(() => (fileSource.value ? driveThumbnail(fileSource.value) : undefined))

async function load(): Promise<void> {
  const key = cacheKey.value
  const cached = cardCache.get(key)
  let answer: DriveFileCard
  if (cached && Date.now() - cached.at < CARD_TTL_MS) {
    answer = cached.card
  } else {
    state.value = 'loading'
    try {
      answer = await getDriveFileCard(props.link.kind === 'file' ? { fileId: props.link.id } : { token: props.link.token })
      cardCache.set(key, { card: answer, at: Date.now() })
    } catch {
      answer = { access: false }
    }
  }
  if (key !== cacheKey.value) return
  if (!answer.access) {
    card.value = null
    state.value = 'restricted'
  } else {
    card.value = answer
    state.value = answer.via === 'file' && answer.state === 'gone' ? 'gone' : 'ready'
  }
  if (state.value !== 'ready' || card.value?.kind !== 'image') emit('embed-loaded')
}

watch(cacheKey, () => void load(), { immediate: true })

function open(): void {
  void router.push(href.value)
}

async function download(): Promise<void> {
  const value = card.value
  if (!value) return
  let url: string
  if (value.via === 'link' && props.link.kind === 'token') {
    url = driveLinkContentUrl(props.link.token, true)
  } else if (value.via === 'file') {
    try {
      url = await driveDownloadUrl(value)
    } catch {
      return
    }
  } else {
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.download = value.name || ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>

<style scoped>
.drive-card {
  display: flex;
  flex-direction: column;
  width: min(420px, 100%);
  margin: 6px 0;
  overflow: hidden;
  background: var(--background-secondary);
  border: 1px solid var(--border-primary, var(--border-color));
  border-radius: var(--radius-lg);
}

.drive-card--restricted {
  background: color-mix(in srgb, var(--text-muted) 6%, var(--background-secondary));
}

.drive-card__row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px 14px;
  min-width: 0;
}

.drive-card__glyph {
  display: inline-flex;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  border-radius: var(--radius-md);
  color: var(--harmony-primary);
}

.drive-card__glyph--muted {
  background: var(--background-modifier-hover);
  color: var(--text-muted);
}

.drive-card__text {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.drive-card__title {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-decoration: none;
  text-overflow: ellipsis;
  white-space: nowrap;
}

a.drive-card__title:hover {
  text-decoration: underline;
}

.drive-card__meta {
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

.drive-card__actions {
  display: flex;
  flex-shrink: 0;
  gap: 4px;
}

.drive-card__action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.drive-card__action:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drive-card__action:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 1px;
}

.drive-card__image {
  display: block;
  padding: 0;
  max-height: 320px;
  overflow: hidden;
  background: var(--background-tertiary, #0b0d12);
  border: none;
  cursor: zoom-in;
}

.drive-card__image img {
  display: block;
  width: 100%;
  max-height: 320px;
  object-fit: contain;
}

.drive-card__video {
  position: relative;
  aspect-ratio: 16 / 9;
  background: #000;
}

.drive-card__video video {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}

.drive-card__audio {
  display: block;
  width: calc(100% - 28px);
  margin: 12px 14px 0;
}

.drive-card__skeleton {
  display: block;
  background: var(--background-modifier-hover);
  border-radius: 4px;
}

.drive-card__skeleton--title {
  width: 160px;
  height: 14px;
}

.drive-card__skeleton--meta {
  width: 90px;
  height: 11px;
  margin-top: 4px;
}
</style>
