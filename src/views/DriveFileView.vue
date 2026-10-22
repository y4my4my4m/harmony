<!-- /drive/file/<id>: a Drive file for whoever may read it (drive_file_card). Anyone else gets a
     page that names nothing of the file. -->
<template>
  <main class="drive-file" data-testid="drive-file-page">
    <div class="drive-file__card">
      <div v-if="state === 'loading'" class="drive-file__status">
        <span class="drive-file__spinner" aria-hidden="true" />
        <span class="sr-only">{{ t('common.loading') }}</span>
      </div>

      <div v-else-if="state === 'denied'" class="drive-file__status" data-testid="drive-file-no-access">
        <span class="drive-file__glyph"><Icon name="lock" :size="28" /></span>
        <h1>{{ t('drive.filePage.noAccessTitle') }}</h1>
        <p>{{ t('drive.filePage.noAccessText') }}</p>
        <button type="button" class="drive-btn drive-btn--secondary" @click="router.push({ name: 'Drive' })">
          <Icon name="hard-drive" :size="15" />{{ t('drive.filePage.toDrive') }}
        </button>
      </div>

      <div v-else-if="state === 'error'" class="drive-file__status" data-testid="drive-file-error">
        <span class="drive-file__glyph"><Icon name="alert-triangle" :size="28" /></span>
        <h1>{{ t('drive.filePage.errorTitle') }}</h1>
        <button type="button" class="drive-btn drive-btn--secondary" @click="load">
          <Icon name="refresh-cw" :size="15" />{{ t('drive.filePage.retry') }}
        </button>
      </div>

      <template v-else-if="card">
        <div class="drive-file__preview" :class="`drive-file__preview--${card.kind}`">
          <button
            v-if="card.kind === 'image' && card.state !== 'gone' && (thumb || source)"
            type="button"
            class="drive-file__media-btn"
            :aria-label="t('drive.card.view', { name })"
            data-testid="drive-file-open-media"
            @click="openLightbox"
          >
            <img :src="thumb || source" :alt="name" class="drive-file__media" data-testid="drive-file-image" draggable="false" />
          </button>
          <button
            v-else-if="card.kind === 'video' && card.state !== 'gone' && source"
            type="button"
            class="drive-file__media-btn drive-file__poster"
            :aria-label="t('drive.card.play', { name })"
            data-testid="drive-file-open-media"
            @click="openLightbox"
          >
            <video :src="`${source}#t=0.5`" class="drive-file__media" preload="metadata" muted playsinline tabindex="-1" aria-hidden="true" />
            <span class="drive-file__play" aria-hidden="true"><Icon name="play" :size="26" /></span>
          </button>
          <div v-else-if="card.kind === 'audio' && card.state !== 'gone' && source" class="drive-file__audio">
            <Icon name="music" :size="40" />
            <audio :src="source" controls preload="metadata" />
          </div>
          <div v-else class="drive-file__icon">
            <Icon :name="kindIcon(card.kind, card.mime_type)" :size="44" />
          </div>
        </div>

        <div class="drive-file__body">
          <h1 class="drive-file__name" data-testid="drive-file-name">{{ name }}</h1>
          <p class="drive-file__meta">
            {{ formatBytes(card.size_bytes, locale.value) }}
            <span aria-hidden="true">·</span>
            {{ card.mime_type || t(`drive.kind.${card.kind}`) }}
            <span aria-hidden="true">·</span>
            {{ dateFormat.format(new Date(card.created_at)) }}
          </p>
          <p v-if="card.owner" class="drive-file__owner" data-testid="drive-file-owner">
            <Avatar :src="card.owner.avatar_url" size="sm" class="drive-file__avatar" />
            <span>{{ card.own ? t('drive.filePage.yours') : t('drive.filePage.ownedBy', { name: card.owner.display_name || card.owner.username }) }}</span>
          </p>
          <p v-if="card.state === 'trashed'" class="drive-file__notice" data-testid="drive-file-trashed">
            <Icon name="trash-2" :size="14" />{{ t('drive.filePage.trashed') }}
          </p>
          <p v-else-if="card.state === 'gone'" class="drive-file__notice" data-testid="drive-file-gone">
            <Icon name="alert-circle" :size="14" />{{ t('drive.card.gone') }}
          </p>
          <p v-else-if="card.state === 'ephemeral' && card.expires_at" class="drive-file__notice">
            <Icon name="hourglass" :size="14" />{{ t('drive.state.expiresIn', { count: daysUntil(card.expires_at) }, daysUntil(card.expires_at)) }}
          </p>

          <div v-if="card.state !== 'gone'" class="drive-file__actions">
            <button type="button" class="drive-btn drive-btn--primary" data-testid="drive-file-download" @click="download">
              <Icon name="download" :size="15" />{{ t('drive.actions.download') }}
            </button>
            <button type="button" class="drive-btn drive-btn--secondary" data-testid="drive-file-copy-link" @click="copyLink(card.id)">
              <Icon name="link" :size="15" />{{ t('drive.actions.copyLink') }}
            </button>
            <button
              v-if="canShare"
              type="button"
              class="drive-btn drive-btn--secondary"
              data-testid="drive-file-share"
              @click="sharing = true"
            >
              <Icon name="share" :size="15" />{{ t('drive.actions.share') }}
            </button>
          </div>
        </div>
      </template>
    </div>

    <MediaLightbox v-if="lightbox.item.value" :visible="true" :imgs="[lightbox.item.value]" @hide="lightbox.close()" />
    <DriveShareDialog
      v-if="sharing && shareTarget"
      :file="shareTarget"
      :name="name"
      :link-sharing="usage?.link_sharing !== false"
      @close="sharing = false"
    />
  </main>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import MediaLightbox from '@/components/common/MediaLightbox.vue'
import DriveShareDialog from '@/components/drive/DriveShareDialog.vue'
import '@/components/drive/drive.css'
import { useT } from '@/composables/useT'
import { useDriveUsage } from '@/composables/useDriveUsage'
import { useCopyDriveLink } from '@/composables/useCopyDriveLink'
import {
  driveDownloadUrl,
  getDriveFileCard,
  type DriveFile,
  type DriveFileCardFile,
} from '@/services/drive/driveService'
import { daysUntil, driveMediaSource, driveThumbnail, formatBytes, kindIcon } from '@/components/drive/driveFormat'
import { useDriveLightbox } from '@/components/drive/useDriveLightbox'

const { t, locale } = useT()
const route = useRoute()
const router = useRouter()
const copyLink = useCopyDriveLink()
const { usage } = useDriveUsage()

const card = ref<DriveFileCardFile | null>(null)
const state = ref<'loading' | 'ready' | 'denied' | 'error'>('loading')
const lightbox = useDriveLightbox()
const sharing = ref(false)
let loadSeq = 0

const fileId = computed(() => String(route.params.fileId ?? ''))
const name = computed(() => card.value?.name || t('drive.file.unnamed'))
const source = computed(() => (card.value ? driveMediaSource(card.value) : undefined))
const thumb = computed(() => (card.value ? driveThumbnail(card.value) : undefined))
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))
const canShare = computed(() => !!card.value?.own && card.value.bucket === 'message_media'
  && (card.value.state === 'drive' || card.value.state === 'ephemeral'))
// DriveShareDialog reads the id and the owner of the file.
const shareTarget = computed(() => (card.value && card.value.owner
  ? ({ id: card.value.id, owner_id: card.value.owner.id } as DriveFile)
  : null))

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

async function load(): Promise<void> {
  const seq = ++loadSeq
  const id = fileId.value
  state.value = 'loading'
  card.value = null
  if (!UUID.test(id)) {
    state.value = 'denied'
    return
  }
  try {
    const answer = await getDriveFileCard({ fileId: id })
    if (seq !== loadSeq) return
    if (answer.access && answer.via === 'file') {
      card.value = answer
      state.value = 'ready'
      document.title = name.value
    } else {
      state.value = 'denied'
    }
  } catch {
    if (seq === loadSeq) state.value = 'error'
  }
}

watch(fileId, () => void load(), { immediate: true })

function openLightbox(): void {
  if (card.value) lightbox.open(card.value, name.value)
}

async function download(): Promise<void> {
  if (!card.value) return
  let url: string
  try {
    url = await driveDownloadUrl(card.value)
  } catch {
    return
  }
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.download = card.value.name || ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}
</script>

<style scoped>
.drive-file {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-5) var(--space-4);
  background: var(--background-primary);
}

.drive-file__card {
  width: min(600px, 100%);
  overflow: hidden;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.drive-file__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 180px;
  max-height: calc(55 * var(--app-vh));
  background: #0b0d12;
}

.drive-file__media-btn {
  position: relative;
  display: block;
  width: 100%;
  padding: 0;
  background: none;
  border: none;
  cursor: zoom-in;
}

.drive-file__media-btn:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

.drive-file__media {
  display: block;
  width: 100%;
  max-height: calc(55 * var(--app-vh));
  object-fit: contain;
}

.drive-file__poster {
  aspect-ratio: 16 / 9;
  cursor: pointer;
}

.drive-file__poster .drive-file__media {
  height: 100%;
}

.drive-file__play {
  position: absolute;
  top: 50%;
  left: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  background: rgb(12 14 20 / 0.7);
  border-radius: var(--radius-full);
  color: #fff;
  transform: translate(-50%, -50%);
}

.drive-file__audio,
.drive-file__icon {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6);
  color: rgb(255 255 255 / 0.8);
}

.drive-file__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
}

.drive-file__name {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--text-primary);
  word-break: break-word;
}

.drive-file__meta,
.drive-file__owner,
.drive-file__notice {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-file__owner .drive-file__avatar {
  width: 22px;
  height: 22px;
}

.drive-file__notice {
  color: var(--warning);
}

.drive-file__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin-top: var(--space-3);
}

.drive-file__status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8, 48px) var(--space-5);
  text-align: center;
}

.drive-file__status h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--text-primary);
}

.drive-file__status p {
  margin: 0 0 var(--space-3);
  max-width: 380px;
  color: var(--text-secondary);
}

.drive-file__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  margin-bottom: var(--space-2);
  background: var(--background-modifier-hover);
  border-radius: 18px;
  color: var(--text-muted);
}

.drive-file__spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--background-modifier-active);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: drive-file-spin 0.8s linear infinite;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

@keyframes drive-file-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .drive-file__spinner { animation-duration: 2s; }
}
</style>
