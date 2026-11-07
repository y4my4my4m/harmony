<!-- Every custom emoji of the instance in one list (admin_list_emojis): instance uploads, imports,
     the federated cache, server and personal emojis, and remote emojis not yet imported. Remove
     is the soft delete, Purge the hard one; imports and re-hosting copy the image here. -->
<template>
  <section class="admin-module admin-emoji-library" :aria-labelledby="`${uid}-title`" data-testid="admin-emoji-library">
    <div class="module-header">
      <Icon name="emoji" :size="20" />
      <h2 :id="`${uid}-title`" ref="headingRef" tabindex="-1">{{ t('admin.emojis.title') }}</h2>
      <div class="module-actions">
        <button type="button" class="action-btn" :disabled="loading" data-testid="admin-emoji-refresh" @click="load()">
          <Icon :name="loading ? 'loader' : 'refresh-cw'" :size="16" :class="{ spin: loading }" />
          <span>{{ t('admin.emojis.refresh') }}</span>
        </button>
        <label class="primary-btn-sm upload-btn" :class="{ disabled: uploading }">
          <Icon name="upload" :size="16" />
          <span>{{ t('admin.emojis.upload.button') }}</span>
          <input
            type="file"
            class="sr-only"
            multiple
            accept="image/png,image/apng,image/gif,image/webp,image/jpeg"
            data-testid="admin-emoji-upload-input"
            :aria-label="t('admin.emojis.upload.label')"
            :disabled="uploading"
            @change="handlePick"
          />
        </label>
      </div>
    </div>

    <div class="module-body">
      <p class="module-hint">{{ t('admin.emojis.description') }}</p>
      <p v-if="uploadStatus" class="upload-status" role="status" data-testid="admin-emoji-upload-status">{{ uploadStatus }}</p>

      <div class="kind-chips" role="group" :aria-label="t('admin.emojis.kinds.label')">
        <button
          v-for="k in ADMIN_EMOJI_KINDS"
          :key="k"
          type="button"
          class="filter-btn"
          :class="{ active: kind === k }"
          :aria-pressed="kind === k"
          :data-testid="`admin-emoji-kind-${k}`"
          @click="kind = k"
        >{{ t(`admin.emojis.kinds.${k}`) }}</button>
      </div>

      <div class="emoji-filters">
        <input
          v-model="search"
          type="search"
          class="cyber-input emoji-search"
          :placeholder="t('admin.emojis.searchHint')"
          :aria-label="t('admin.emojis.searchLabel')"
          data-testid="admin-emoji-search"
        />
        <select
          v-if="kind !== 'not_imported'"
          v-model="status"
          class="cyber-select emoji-select"
          :aria-label="t('admin.emojis.status.label')"
          data-testid="admin-emoji-status"
        >
          <option value="active">{{ t('admin.emojis.status.active') }}</option>
          <option value="removed">{{ t('admin.emojis.status.removed') }}</option>
        </select>
        <select v-model="sort" class="cyber-select emoji-select" :aria-label="t('admin.emojis.sort.label')" data-testid="admin-emoji-sort">
          <option value="newest">{{ t('admin.emojis.sort.newest') }}</option>
          <option value="oldest">{{ t('admin.emojis.sort.oldest') }}</option>
          <option value="name">{{ t('admin.emojis.sort.name') }}</option>
          <option value="usage">{{ t('admin.emojis.sort.usage') }}</option>
        </select>
      </div>

      <div v-if="canSelect && rows.length > 0" class="bulk-bar" data-testid="admin-emoji-bulk">
        <template v-if="selecting">
          <button type="button" class="action-btn" data-testid="admin-emoji-select-page" @click="selectPage">
            {{ t('admin.emojis.bulk.selectPage') }}
          </button>
          <span class="bulk-count" aria-live="polite">{{ t('admin.emojis.bulk.selected', { count: selected.size }, selected.size) }}</span>
          <button
            v-if="status === 'active'"
            type="button"
            class="action-btn danger-outline"
            :disabled="selected.size === 0 || bulkBusy"
            data-testid="admin-emoji-bulk-remove"
            @click="bulk('remove')"
          >{{ t('admin.emojis.bulk.remove') }}</button>
          <button
            v-else
            type="button"
            class="action-btn"
            :disabled="selected.size === 0 || bulkBusy"
            data-testid="admin-emoji-bulk-restore"
            @click="bulk('restore')"
          >{{ t('admin.emojis.bulk.restore') }}</button>
          <button
            type="button"
            class="action-btn danger-outline"
            :disabled="selected.size === 0 || bulkBusy"
            data-testid="admin-emoji-bulk-purge"
            @click="bulk('purge')"
          >{{ t('admin.emojis.bulk.purge') }}</button>
          <button ref="selectToggle" type="button" class="action-btn" data-testid="admin-emoji-select" @click="stopSelecting">
            {{ t('common.cancel') }}
          </button>
        </template>
        <button v-else ref="selectToggle" type="button" class="action-btn" data-testid="admin-emoji-select" @click="startSelecting">
          <Icon name="check" :size="15" />
          {{ t('admin.emojis.bulk.select') }}
        </button>
      </div>

      <div v-if="loading && rows.length === 0" class="loading-state" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('admin.emojis.loading') }}</span>
      </div>
      <div v-else-if="loadFailed && rows.length === 0" class="load-failed">
        <p role="alert">{{ t('admin.emojis.errors.load') }}</p>
        <button type="button" class="action-btn" @click="load()">{{ t('admin.emojis.retry') }}</button>
      </div>
      <EmptyState
        v-else-if="rows.length === 0"
        class="empty-state"
        size="sm"
        icon="smile"
        :title="kind === 'not_imported' ? t('admin.emojis.emptyNotImported') : t('admin.emojis.empty')"
        data-testid="admin-emoji-empty"
      />
      <ul
        v-else
        ref="listRef"
        class="emoji-list"
        :aria-busy="loading || undefined"
        :aria-labelledby="`${uid}-title`"
        data-testid="admin-emoji-list"
      >
        <AdminEmojiRow
          v-for="row in rows"
          :key="row.id"
          :row="row"
          :busy="busy.has(row.id) || bulkBusy"
          :editing="editingId === row.id"
          :broken="broken.has(row.id)"
          :selectable="selecting"
          :selected="selected.has(row.id)"
          @broken="broken.add(row.id)"
          @toggle-select="toggleSelected(row.id)"
          @start-rename="editingId = row.id"
          @cancel-rename="cancelRename(row)"
          @save-rename="saveRename(row, $event)"
          @remove="removeOne(row)"
          @restore="restoreOne(row)"
          @purge="purgeOne(row)"
          @rehost="rehostOne(row)"
          @import="importOne(row)"
        />
      </ul>

      <div v-if="total > PAGE_SIZE" class="emoji-pagination">
        <button type="button" class="action-btn" :disabled="offset === 0 || loading" @click="goTo(offset - PAGE_SIZE)">{{ t('admin.instanceEmojis.previous') }}</button>
        <span class="page-info">{{ t('admin.instanceEmojis.range', { from: offset + 1, to: Math.min(offset + PAGE_SIZE, total), total }) }}</span>
        <button type="button" class="action-btn" :disabled="offset + PAGE_SIZE >= total || loading" @click="goTo(offset + PAGE_SIZE)">{{ t('admin.instanceEmojis.next') }}</button>
      </div>
    </div>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, reactive, ref, useId, watch } from 'vue'
import { useToast } from 'vue-toastification'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import AdminEmojiRow from '@/components/admin/AdminEmojiRow.vue'
import { emojiUploadCandidates } from '@/components/settings/emojiLibrary'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useT } from '@/composables/useT'
import { invalidateEmojiResolverCache } from '@/services/emojiShortcodeResolver'
import {
  ADMIN_EMOJI_KINDS,
  AdminEmojiRequestError,
  INSTANCE_EMOJI_NAME,
  importRemoteEmoji,
  listAdminEmojis,
  purgeEmoji,
  rehostEmoji,
  removeEmoji,
  renameEmoji,
  restoreEmoji,
  type AdminEmojiKindFilter,
  type AdminEmojiRow as Row,
  type AdminEmojiSort,
} from '@/services/InstanceEmojiAdminService'
import { uploadInstanceEmoji } from '@/services/instanceEmojiUpload'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { debug } from '@/utils/debug'
import { UploadRejectedError, imageSourceError } from '@/utils/uploadValidation'

const PAGE_SIZE = 50
const SEARCH_DEBOUNCE_MS = 300

/** Backend error codes with their own message; anything else reads as internal_error. */
const BACKEND_CODES = new Set([
  'not_authenticated', 'admin_required', 'insufficient_aal', 'not_found', 'already_imported',
  'name_taken', 'invalid_name', 'not_instance', 'not_hotlinked', 'unsupported_image', 'too_large',
  'fetch_failed', 'internal_error', 'network_error',
])

const { t } = useT()
const toast = useToast()
const { confirm, prompt } = useConfirmDialog()
const { polite } = useAnnouncer()
const uid = `ael-${useId()}`

const rows = ref<Row[]>([])
const total = ref(0)
const offset = ref(0)
const loading = ref(false)
const loadFailed = ref(false)
const search = ref('')
const kind = ref<AdminEmojiKindFilter>('all')
const status = ref<'active' | 'removed'>('active')
const sort = ref<AdminEmojiSort>('newest')
const busy = reactive(new Set<string>())
/** Images that failed once: drawn as the broken-image icon and never requested again. */
const broken = reactive(new Set<string>())
const editingId = ref<string | null>(null)
const selecting = ref(false)
const selected = reactive(new Set<string>())
const bulkBusy = ref(false)
const uploading = ref(false)
const uploadStatus = ref('')

const headingRef = ref<HTMLElement | null>(null)
const listRef = ref<HTMLElement | null>(null)
const selectToggle = ref<HTMLButtonElement | null>(null)

const canSelect = computed(() => kind.value !== 'not_imported')

let requestSeq = 0

async function load(): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  try {
    const page = await listAdminEmojis({
      search: search.value,
      kind: kind.value,
      status: status.value,
      sort: sort.value,
      limit: PAGE_SIZE,
      offset: offset.value,
    })
    if (seq !== requestSeq) return
    // A removal can empty the last page; step back to the new last page.
    if (page.rows.length === 0 && offset.value > 0) {
      offset.value = Math.max(0, offset.value - PAGE_SIZE)
      return load()
    }
    rows.value = page.rows
    total.value = page.total
    loadFailed.value = false
    const present = new Set(page.rows.map((r) => r.id))
    for (const id of [...selected]) if (!present.has(id)) selected.delete(id)
  } catch (err) {
    if (seq !== requestSeq) return
    debug.error('Failed to load emojis:', err)
    loadFailed.value = true
    toast.error(t('admin.emojis.errors.load'))
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function goTo(next: number) {
  offset.value = Math.max(0, next)
  void load()
}

function reloadFromStart() {
  offset.value = 0
  editingId.value = null
  selected.clear()
  void load()
}

let searchTimer: ReturnType<typeof setTimeout> | null = null
watch(search, () => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(reloadFromStart, SEARCH_DEBOUNCE_MS)
})
watch([status, sort], reloadFromStart)
watch(kind, () => {
  selecting.value = false
  reloadFromStart()
})

/** The picker's instance and personal groups and :name: lookups refetch on next open. */
function refreshPicker() {
  invalidateEmojiResolverCache()
  useEmojiCacheStore().expirePersonalEmojis()
}

function rpcMessage(err: unknown, fallback: string): string {
  const code = (err as { code?: string } | null)?.code
  if (code === '22023') return t('admin.emojis.errors.invalidName')
  if (code === '23505') return t('admin.emojis.errors.nameTaken')
  if (code === '23514') return t('admin.emojis.errors.limit')
  if (code === '42501') return t('admin.emojis.errors.notAllowed')
  if (code === 'P0002') return t('admin.emojis.errors.notFound')
  return fallback
}

function backendMessage(err: unknown): string {
  const code = err instanceof AdminEmojiRequestError && BACKEND_CODES.has(err.code) ? err.code : 'internal_error'
  return t(`admin.emojis.errors.backend.${code}`)
}

function control(id: string, action: string): HTMLElement | null {
  const row = listRef.value?.querySelector<HTMLElement>(`[data-emoji-id="${CSS.escape(id)}"]`)
  return row?.querySelector<HTMLElement>(`[data-action="${action}"]`) ?? row?.querySelector<HTMLElement>('[data-action]') ?? null
}

/** Reloads, then focuses the same action of the row at `index` (the next one once a row left the list). */
async function reloadAndRefocus(id: string, index: number, action: string) {
  await load()
  await nextTick()
  const stay = rows.value.find((r) => r.id === id)
  const next = stay ?? rows.value[Math.min(index, rows.value.length - 1)]
  ;(next ? control(next.id, action) : headingRef.value)?.focus()
}

async function run(row: Row, action: string, op: () => Promise<string | null>, failure: (err: unknown) => string) {
  const index = rows.value.findIndex((r) => r.id === row.id)
  busy.add(row.id)
  let done: string | null
  try {
    done = await op()
  } catch (err) {
    debug.error(`Emoji ${action} failed:`, err)
    toast.error(failure(err))
    return
  } finally {
    busy.delete(row.id)
  }
  refreshPicker()
  if (done) {
    toast.success(done)
    polite(done)
  }
  await reloadAndRefocus(row.id, index, action)
}

// Rename -------------------------------------------------------------------------------
async function cancelRename(row: Row) {
  editingId.value = null
  await nextTick()
  control(row.id, 'rename')?.focus()
}

async function saveRename(row: Row, name: string) {
  if (name === row.name) return cancelRename(row)
  if (!INSTANCE_EMOJI_NAME.test(name)) {
    toast.error(t('admin.emojis.errors.invalidName'))
    return
  }
  busy.add(row.id)
  try {
    await renameEmoji(row.id, name)
  } catch (err) {
    toast.error(rpcMessage(err, t('admin.emojis.errors.rename')))
    return
  } finally {
    busy.delete(row.id)
  }
  row.name = name
  refreshPicker()
  const message = t('admin.emojis.done.renamed', { name: `:${name}:` })
  toast.success(message)
  polite(message)
  await cancelRename(row)
}

// Remove, restore, purge ---------------------------------------------------------------
async function removeOne(row: Row) {
  const ok = await confirm({
    title: t('admin.emojis.confirm.removeTitle'),
    message: t('admin.emojis.confirm.remove', { name: `:${row.name}:` }),
    confirmButtonText: t('admin.emojis.confirm.removeButton'),
    dangerAction: true,
  })
  if (!ok) return
  await run(row, 'remove', async () => {
    await removeEmoji(row.id)
    return t('admin.emojis.done.removed', { name: `:${row.name}:` })
  }, (err) => rpcMessage(err, t('admin.emojis.errors.remove')))
}

async function restoreOne(row: Row) {
  await run(row, 'restore', async () => {
    await restoreEmoji(row.id)
    return t('admin.emojis.done.restored', { name: `:${row.name}:` })
  }, (err) => rpcMessage(err, t('admin.emojis.errors.restore')))
}

async function purgeOne(row: Row) {
  const ok = await confirm({
    title: t('admin.emojis.confirm.purgeTitle'),
    message: t('admin.emojis.confirm.purge', { name: `:${row.name}:` }),
    confirmButtonText: t('admin.emojis.confirm.purgeButton'),
    dangerAction: true,
  })
  if (!ok) return
  await run(row, 'purge', async () => {
    const fileGone = await purgeEmoji(row.id)
    if (!fileGone) toast.warning(t('admin.emojis.errors.purgeFile', { name: `:${row.name}:` }))
    return t('admin.emojis.done.purged', { name: `:${row.name}:` })
  }, (err) => rpcMessage(err, t('admin.emojis.errors.purge')))
}

// Re-host and import -------------------------------------------------------------------
async function rehostOne(row: Row) {
  await run(row, 'rehost', async () => {
    await rehostEmoji(row.id)
    broken.delete(row.id)
    return t('admin.emojis.done.rehosted', { name: `:${row.name}:` })
  }, backendMessage)
}

async function importOne(row: Row) {
  const value = await prompt({
    title: t('admin.emojis.confirm.importTitle', { name: `:${row.name}:` }),
    message: t('admin.emojis.confirm.import', { name: `:${row.name}:`, domain: row.domain ?? '' }),
    label: t('admin.emojis.confirm.importLabel'),
    placeholder: row.name,
    confirmButtonText: t('admin.emojis.confirm.importButton'),
  })
  if (value === null) return
  const name = value.trim().replace(/^:+|:+$/g, '')
  if (name && !INSTANCE_EMOJI_NAME.test(name)) {
    toast.error(t('admin.emojis.errors.invalidName'))
    return
  }
  await run(row, 'import', async () => {
    const emoji = await importRemoteEmoji(row.id, name || undefined)
    return t('admin.emojis.done.imported', { name: `:${emoji.name || name || row.name}:` })
  }, backendMessage)
}

// Selection ----------------------------------------------------------------------------
async function startSelecting() {
  selecting.value = true
  selected.clear()
  await nextTick()
  listRef.value?.querySelector<HTMLElement>('[data-action="select"]')?.focus()
}

async function stopSelecting() {
  selecting.value = false
  selected.clear()
  await nextTick()
  selectToggle.value?.focus()
}

function toggleSelected(id: string) {
  if (selected.has(id)) selected.delete(id)
  else selected.add(id)
}

function selectPage() {
  for (const row of rows.value) selected.add(row.id)
}

async function bulk(action: 'remove' | 'restore' | 'purge') {
  const targets = rows.value.filter((r) => selected.has(r.id))
  if (targets.length === 0) return
  const count = targets.length
  if (action !== 'restore') {
    const ok = await confirm({
      title: t(action === 'remove' ? 'admin.emojis.confirm.removeTitle' : 'admin.emojis.confirm.purgeTitle'),
      message: t(action === 'remove' ? 'admin.emojis.confirm.removeMany' : 'admin.emojis.confirm.purgeMany', { count }, count),
      confirmButtonText: t(action === 'remove' ? 'admin.emojis.confirm.removeButton' : 'admin.emojis.confirm.purgeButton'),
      dangerAction: true,
    })
    if (!ok) return
  }
  bulkBusy.value = true
  let failed = 0
  let filesKept = 0
  try {
    for (const row of targets) {
      try {
        if (action === 'remove') await removeEmoji(row.id)
        else if (action === 'restore') await restoreEmoji(row.id)
        else if (!(await purgeEmoji(row.id))) filesKept++
      } catch (err) {
        debug.error(`Bulk emoji ${action} failed:`, err)
        failed++
      }
    }
  } finally {
    bulkBusy.value = false
  }
  refreshPicker()
  const done = count - failed
  if (done > 0) {
    const key = { remove: 'removedMany', restore: 'restoredMany', purge: 'purgedMany' }[action]
    const message = t(`admin.emojis.done.${key}`, { count: done }, done)
    toast.success(message)
    polite(message)
  }
  if (failed > 0) toast.error(t('admin.emojis.errors.bulk', { count: failed }, failed))
  if (filesKept > 0) toast.warning(t('admin.emojis.errors.purgeFiles', { count: filesKept }, filesKept))
  selecting.value = false
  selected.clear()
  await load()
  await nextTick()
  ;(selectToggle.value ?? headingRef.value)?.focus()
}

// Upload -------------------------------------------------------------------------------
function uploadMessage(err: unknown): string {
  if (err instanceof UploadRejectedError) return err.message
  const code = (err as { code?: string } | null)?.code
  if (code === '42501') return t('admin.emojis.errors.notAdmin')
  if (code === '23505') return t('admin.emojis.errors.duplicateFile')
  return t('admin.emojis.upload.failed')
}

async function handlePick(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = ''
  if (uploading.value || picked.length === 0) return
  const { files, notImage, tooLarge } = emojiUploadCandidates(picked)
  if (picked.length === 1 && files.length === 0) {
    toast.error(imageSourceError(picked[0]) ?? t('admin.emojis.upload.noValid'))
    return
  }
  if (notImage.length > 0) toast.warning(t('admin.emojis.upload.notImage', { count: notImage.length }, notImage.length))
  if (tooLarge.length > 0) toast.warning(t('admin.emojis.upload.tooLarge', { count: tooLarge.length }, tooLarge.length))
  if (files.length === 0) {
    toast.error(t('admin.emojis.upload.noValid'))
    return
  }

  uploading.value = true
  let succeeded = 0
  let lastName = ''
  let reason: string | null = null
  try {
    for (const [i, file] of files.entries()) {
      uploadStatus.value = files.length === 1
        ? t('admin.emojis.upload.uploading', { name: file.name })
        : t('admin.emojis.upload.uploadingMany', { current: i + 1, total: files.length })
      try {
        const emoji = await uploadInstanceEmoji(file)
        succeeded++
        lastName = emoji.name
      } catch (err) {
        debug.error(`Instance emoji upload failed: ${file.name}`, err)
        reason ??= uploadMessage(err)
      }
    }
  } finally {
    uploading.value = false
    uploadStatus.value = ''
  }
  const failed = files.length - succeeded
  if (succeeded > 0) {
    refreshPicker()
    const message = succeeded === 1 && files.length === 1
      ? t('admin.emojis.upload.uploaded', { name: `:${lastName}:` })
      : t('admin.emojis.upload.uploadedMany', { count: succeeded }, succeeded)
    toast.success(message)
    polite(message)
    if (kind.value !== 'all' && kind.value !== 'instance') kind.value = 'instance'
    else reloadFromStart()
  }
  if (failed > 0) toast.error(files.length === 1 ? (reason ?? t('admin.emojis.upload.failed')) : t('admin.emojis.upload.failedMany', { count: failed }, failed))
}

defineExpose({ load })

onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.module-header h2:focus {
  outline: none;
}

.module-header h2:focus-visible {
  outline: 2px solid var(--focus-ring, var(--harmony-primary));
  outline-offset: 2px;
}

.module-body {
  padding: 16px 24px 24px;
}

.module-hint {
  margin: 0 0 16px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.upload-btn {
  position: relative;
  font-size: 14px;
}

.upload-btn.disabled {
  opacity: 0.5;
  cursor: progress;
}

.upload-btn:focus-within {
  outline: 2px solid var(--focus-ring, var(--harmony-primary));
  outline-offset: 2px;
}

.upload-status {
  margin: 0 0 12px;
  font-size: 13px;
  color: var(--text-secondary);
}

.kind-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}

.filter-btn {
  padding: 6px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  color: var(--text-secondary);
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}

.filter-btn:hover {
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.filter-btn.active {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.emoji-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.emoji-filters .cyber-input,
.emoji-filters .cyber-select {
  padding: 8px 12px;
}

.emoji-search {
  flex: 1 1 240px;
  min-width: 0;
}

.emoji-filters .emoji-select {
  flex: 0 1 auto;
  width: auto;
  min-width: 140px;
}

.bulk-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}

.bulk-bar .action-btn {
  padding: 6px 12px;
  font-size: 13px;
}

.bulk-count {
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.danger-outline {
  color: var(--text-danger);
}

.danger-outline:hover:not(:disabled) {
  border-color: var(--error);
}

.load-failed {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 32px 0;
  color: var(--text-secondary);
}

.load-failed p {
  margin: 0;
}

.emoji-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 12px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.emoji-pagination {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 12px;
  margin-top: 16px;
}

.page-info {
  font-size: 13px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

.spin {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .emoji-list {
    grid-template-columns: 1fr;
  }
}

@media (max-width: 640px) {
  .module-header {
    flex-wrap: wrap;
    padding: 16px 12px;
  }

  .module-body {
    padding: 12px 12px 16px;
  }

  .emoji-filters .emoji-select {
    flex: 1 1 120px;
    min-width: 0;
  }
}
</style>
