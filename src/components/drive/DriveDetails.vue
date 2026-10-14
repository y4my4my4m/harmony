<!-- Details of one Drive file: preview, name, facts, where it was sent, sharing and actions. -->
<template>
  <aside class="drive-details" :aria-label="t('drive.details.label')" data-testid="drive-details">
    <header class="drive-details__head">
      <h2 class="drive-details__title">{{ t('drive.details.title') }}</h2>
      <button type="button" class="drive-icon-btn" :aria-label="t('common.close')" @click="emit('close')">
        <Icon name="x" :size="18" />
      </button>
    </header>

    <div class="drive-details__scroll">
      <div class="drive-details__preview">
        <img v-if="file.kind === 'image' && src" :src="src" :alt="name" class="drive-details__media" />
        <div v-else-if="file.kind === 'video' && src" class="drive-details__video">
          <video :src="src" class="drive-details__media" preload="metadata" playsinline :controls="nativeControls" />
          <VideoControls v-if="!nativeControls" :label="name" />
        </div>
        <audio v-else-if="file.kind === 'audio' && src" :src="src" controls preload="metadata" class="drive-details__audio" />
        <DriveFileThumb v-else :file="file" />
      </div>

      <form v-if="owned && editing" class="drive-details__rename" @submit.prevent="saveName">
        <input
          ref="nameInput"
          v-model="draft"
          class="drive-input"
          maxlength="255"
          :aria-label="t('drive.details.name')"
          data-testid="drive-rename-input"
          @keydown.esc.prevent="editing = false"
          @blur="saveName"
        />
      </form>
      <button
        v-else
        type="button"
        class="drive-details__name"
        :disabled="!owned || file.state === 'gone'"
        :title="owned ? t('drive.details.rename') : undefined"
        data-testid="drive-details-name"
        @click="startRename"
      >
        <span>{{ name }}</span>
        <Icon v-if="owned" name="pencil" :size="14" class="drive-details__name-edit" />
      </button>

      <div v-if="file.state === 'ephemeral'" class="drive-details__notice" data-testid="drive-temporary-notice">
        <Icon name="hourglass" :size="16" />
        <div>
          <p>{{ t('drive.state.expiresIn', { count: daysUntil(file.expires_at) }, daysUntil(file.expires_at)) }}</p>
          <button v-if="owned" type="button" class="drive-link-btn" data-testid="drive-keep" @click="emit('keep', file)">
            {{ t('drive.actions.keep') }}
          </button>
        </div>
      </div>

      <dl class="drive-details__facts">
        <div><dt>{{ t('drive.details.type') }}</dt><dd>{{ file.mime_type || t(`drive.kind.${file.kind}`) }}</dd></div>
        <div><dt>{{ t('drive.details.size') }}</dt><dd>{{ formatBytes(file.size_bytes, locale.value) }}</dd></div>
        <div><dt>{{ t('drive.details.added') }}</dt><dd>{{ dateTime(file.created_at) }}</dd></div>
        <div v-if="owner"><dt>{{ t('drive.details.owner') }}</dt><dd>{{ owner.display_name || owner.username }}</dd></div>
      </dl>

      <section v-if="owned" class="drive-details__section">
        <h3>{{ t('drive.details.used') }}</h3>
        <p v-if="usageLoading" class="drive-details__muted">{{ t('common.loading') }}</p>
        <p v-else-if="!usage || (usage.messages.length === 0 && usage.posts.length === 0)" class="drive-details__muted">
          {{ t('drive.details.unused') }}
        </p>
        <ul v-else class="drive-details__uses">
          <li v-for="use in usage.messages" :key="use.message_id">
            <button type="button" class="drive-use" data-testid="drive-use" @click="jump(use)">
              <Icon :name="use.conversation_id ? 'message-circle' : 'hash'" :size="14" />
              <span class="drive-use__where">{{ whereLabel(use) }}</span>
              <span class="drive-use__when">{{ shortDate(use.created_at) }}</span>
            </button>
          </li>
          <li v-for="post in usage.posts" :key="post.post_id">
            <button type="button" class="drive-use" @click="router.push(`/social/post/${post.post_id}`)">
              <Icon name="globe" :size="14" />
              <span class="drive-use__where">{{ t('drive.details.post') }}</span>
              <span class="drive-use__when">{{ shortDate(post.created_at) }}</span>
            </button>
          </li>
        </ul>
      </section>

      <section v-if="owned && file.bucket === 'message_media' && file.state !== 'gone'" class="drive-details__section">
        <h3>{{ t('drive.details.sharing') }}</h3>
        <p class="drive-details__muted">{{ shareSummary }}</p>
        <button type="button" class="drive-btn drive-btn--secondary drive-btn--block" data-testid="drive-share-open" @click="emit('share', file)">
          <Icon name="share" :size="15" />{{ t('drive.actions.share') }}
        </button>
      </section>
    </div>

    <footer v-if="file.state !== 'gone'" class="drive-details__actions">
      <button type="button" class="drive-btn drive-btn--secondary" @click="emit('download', file)">
        <Icon name="download" :size="15" />{{ t('drive.actions.download') }}
      </button>
      <template v-if="owned">
        <button v-if="file.state === 'trashed'" type="button" class="drive-btn drive-btn--secondary" @click="emit('restore', file)">
          <Icon name="undo" :size="15" />{{ t('drive.actions.restore') }}
        </button>
        <button v-else type="button" class="drive-btn drive-btn--secondary" @click="emit('move', file)">
          <Icon name="folder-input" :size="15" />{{ t('drive.actions.move') }}
        </button>
        <button type="button" class="drive-btn drive-btn--danger" data-testid="drive-details-delete" @click="emit('delete', file)">
          <Icon name="trash-2" :size="15" />{{ file.state === 'trashed' ? t('drive.actions.deleteForever') : t('drive.actions.trash') }}
        </button>
      </template>
    </footer>
  </aside>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import {
  driveFileDisplayName,
  getDriveFileUsage,
  type DriveFile,
  type DriveFileUsage,
  type DriveOwner,
} from '@/services/drive/driveService'
import DriveFileThumb from './DriveFileThumb.vue'
import { daysUntil, driveMediaSource, driveThumbnail, formatBytes } from './driveFormat'

const props = defineProps<{ file: DriveFile; owner: DriveOwner | null; ownId: string | null }>()

const emit = defineEmits<{
  close: []
  rename: [file: DriveFile, name: string]
  keep: [file: DriveFile]
  share: [file: DriveFile]
  download: [file: DriveFile]
  move: [file: DriveFile]
  restore: [file: DriveFile]
  delete: [file: DriveFile]
}>()

const { t, locale } = useT()
const router = useRouter()
const nativeControls = useNativeVideoControls()
const usage = ref<DriveFileUsage | null>(null)
const usageLoading = ref(false)
const editing = ref(false)
const draft = ref('')
const nameInput = ref<HTMLInputElement | null>(null)

const owned = computed(() => props.file.owner_id === props.ownId)
const name = computed(() => driveFileDisplayName(props.file, t('drive.file.unnamed')))
const src = computed(() => (props.file.kind === 'image'
  ? driveThumbnail(props.file) ?? driveMediaSource(props.file)
  : driveMediaSource(props.file)))

const shareSummary = computed(() => {
  const shares = usage.value?.shares ?? []
  if (shares.length === 0) return t('drive.share.private')
  const link = shares.some((s) => s.scope === 'link')
  const others = shares.filter((s) => s.scope !== 'link').length
  if (link && others) return t('drive.share.summaryBoth', { count: others }, others)
  if (link) return t('drive.share.summaryLink')
  return t('drive.share.summaryPeople', { count: others }, others)
})

async function loadUsage(): Promise<void> {
  usage.value = null
  if (!owned.value || props.file.state === 'gone') return
  usageLoading.value = true
  try {
    usage.value = await getDriveFileUsage(props.file.id)
  } catch {
    usage.value = null
  } finally {
    usageLoading.value = false
  }
}

watch(() => [props.file.id, props.file.updated_at], () => {
  editing.value = false
  void loadUsage()
}, { immediate: true })

function startRename(): void {
  if (!owned.value) return
  draft.value = props.file.name ?? ''
  editing.value = true
  void nextTick(() => {
    nameInput.value?.focus()
    const dot = draft.value.lastIndexOf('.')
    nameInput.value?.setSelectionRange(0, dot > 0 ? dot : draft.value.length)
  })
}

function saveName(): void {
  if (!editing.value) return
  editing.value = false
  const next = draft.value.trim()
  if (next && next !== props.file.name) emit('rename', props.file, next)
}

const longFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))
const shortFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))
const dateTime = (iso: string) => longFormat.value.format(new Date(iso))
const shortDate = (iso: string) => shortFormat.value.format(new Date(iso))

function whereLabel(use: DriveFileUsage['messages'][number]): string {
  if (use.conversation_id) return use.conversation_name || t('drive.nav.conversation')
  return use.server_name ? `${use.server_name} › #${use.channel_name ?? ''}` : `#${use.channel_name ?? ''}`
}

function jump(use: DriveFileUsage['messages'][number]): void {
  if (use.thread_id && use.server_id) {
    void router.push({ name: 'ThreadView', params: { serverId: use.server_id, threadId: use.thread_id }, query: { messageId: use.message_id } })
  } else if (use.channel_id && use.server_id) {
    void router.push({ name: 'ChatChannel', params: { serverId: use.server_id, channelId: use.channel_id }, query: { messageId: use.message_id } })
  } else if (use.conversation_id) {
    void router.push({ name: 'DMConversation', params: { conversationId: use.conversation_id }, query: { messageId: use.message_id } })
  }
}

defineExpose({ startRename, reloadUsage: loadUsage })
</script>

<style scoped>
.drive-details {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--background-secondary);
  border-left: 1px solid var(--border-color);
}

.drive-details__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-3) var(--space-3) var(--space-3) var(--space-4);
  border-bottom: 1px solid var(--border-color);
}

.drive-details__title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.drive-details__scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-4);
  overflow-y: auto;
}

.drive-details__preview {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  aspect-ratio: 4 / 3;
  overflow: hidden;
  background: var(--background-tertiary, var(--background-primary));
  border-radius: var(--radius-md);
}

.drive-details__video {
  position: relative;
  width: 100%;
  height: 100%;
}

.drive-details__media {
  width: 100%;
  height: 100%;
  object-fit: contain;
  background: #000;
}

.drive-details__preview img.drive-details__media {
  background: transparent;
}

.drive-details__audio {
  width: calc(100% - var(--space-6));
}

.drive-details__name {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  margin-top: var(--space-3);
  padding: 6px var(--space-2);
  background: none;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-md, 15px);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-align: left;
  word-break: break-word;
  cursor: text;
}

.drive-details__name:disabled {
  cursor: default;
}

.drive-details__name:not(:disabled):hover {
  border-color: var(--border-color);
}

.drive-details__name-edit {
  flex-shrink: 0;
  margin-left: auto;
  opacity: 0;
  color: var(--text-muted);
  transition: opacity 0.12s ease;
}

.drive-details__name:hover .drive-details__name-edit {
  opacity: 1;
}

.drive-details__rename {
  margin-top: var(--space-3);
}

.drive-details__notice {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-3);
  padding: var(--space-3);
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 35%, transparent);
  border-radius: var(--radius-md);
  color: var(--warning);
  font-size: var(--font-size-sm);
}

.drive-details__notice p {
  margin: 0 0 4px;
  color: var(--text-primary);
}

.drive-details__facts {
  display: grid;
  gap: 6px;
  margin: var(--space-4) 0 0;
}

.drive-details__facts div {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  font-size: var(--font-size-sm);
}

.drive-details__facts dt {
  color: var(--text-muted);
}

.drive-details__facts dd {
  margin: 0;
  overflow: hidden;
  color: var(--text-primary);
  text-align: right;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-details__section {
  margin-top: var(--space-5);
}

.drive-details__section h3 {
  margin: 0 0 var(--space-2);
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.drive-details__muted {
  margin: 0 0 var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-details__uses {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.drive-use {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--space-2);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.drive-use:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drive-use__where {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-use__when {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.drive-details__actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
  border-top: 1px solid var(--border-color);
}

.drive-details__actions .drive-btn {
  flex: 1 1 auto;
}
</style>
