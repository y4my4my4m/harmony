<!--
  Import of remote emojis into the instance set. The names come from the server's preview
  (admin_preview_emoji_imports): a name an instance emoji holds is offered renamed, and each row
  can be renamed or skipped. Nothing replaces an existing emoji. One backend request per emoji,
  three at a time; every row ends with its own result.
-->
<template>
  <BaseModal
    :show="show"
    :title="title"
    icon="download"
    overlay-class="emoji-import-dialog"
    :close-on-overlay="phase !== 'running'"
    :close-on-escape="phase !== 'running'"
    :show-close-button="phase !== 'running'"
    @close="close"
  >
    <div class="import" data-testid="admin-emoji-import-dialog">
      <div v-if="phase === 'loading'" class="import-loading" role="status">
        <LoadingSpinner :size="20" />
        <span class="sr-only">{{ t('admin.emojis.import.loading') }}</span>
      </div>
      <p v-else-if="phase === 'error'" class="import-error" role="alert">{{ t('admin.emojis.import.previewFailed') }}</p>
      <template v-else>
        <p v-if="phase === 'plan'" class="import-note">{{ t('admin.emojis.import.explain') }}</p>
        <p v-if="phase === 'plan' && clashCount > 0" class="import-note import-clash-note" data-testid="admin-emoji-import-clashes">
          {{ t('admin.emojis.import.clashes', { count: clashCount }, clashCount) }}
        </p>
        <p v-if="phase !== 'plan'" class="import-summary" role="status" data-testid="admin-emoji-import-summary">{{ summary }}</p>

        <ul class="import-list" :aria-label="t('admin.emojis.import.listLabel')">
          <li
            v-for="item in items"
            :key="item.id"
            class="import-item"
            :class="{ skipped: item.skip && phase === 'plan' }"
            data-testid="admin-emoji-import-item"
            :data-emoji-id="item.id"
            :data-status="item.status"
          >
            <img class="import-img" :src="getEmojiUrl(item.url, 64)" alt="" loading="lazy" />
            <div class="import-main">
              <span class="import-source">
                <span class="import-shortcode">:{{ item.shortcode }}:</span>
                <span v-if="item.domain" class="import-domain">{{ t('admin.emojis.meta.from', { domain: item.domain }) }}</span>
                <span v-if="item.taken" class="badge taken">{{ t('admin.emojis.badges.nameTaken') }}</span>
              </span>
              <span v-if="item.license" class="import-license" :title="item.license">{{ t('admin.emojis.meta.license', { license: item.license }) }}</span>

              <template v-if="phase === 'plan' && item.status === 'pending'">
                <span class="import-controls">
                  <input
                    v-model.trim="item.name"
                    class="cyber-input import-name"
                    maxlength="64"
                    autocomplete="off"
                    spellcheck="false"
                    :disabled="item.skip"
                    :aria-label="t('admin.emojis.import.nameFor', { name: `:${item.shortcode}:` })"
                    :aria-invalid="!!problem(item) || undefined"
                    :aria-describedby="problem(item) ? `${uid}-${item.id}-problem` : undefined"
                    data-testid="admin-emoji-import-name"
                  />
                  <label class="import-skip">
                    <input v-model="item.skip" type="checkbox" data-testid="admin-emoji-import-skip" />
                    <span>{{ t('admin.emojis.import.skip') }}</span>
                    <span class="sr-only">:{{ item.shortcode }}:</span>
                  </label>
                </span>
                <span v-if="problem(item)" :id="`${uid}-${item.id}-problem`" class="import-problem" data-testid="admin-emoji-import-problem">
                  {{ problem(item) }}
                </span>
              </template>
              <span v-else class="import-status" :class="`status-${item.status}`" data-testid="admin-emoji-import-status">
                {{ statusText(item) }}
              </span>
            </div>
          </li>
        </ul>
      </template>
    </div>

    <template #footer>
      <template v-if="phase === 'running'">
        <button type="button" class="btn btn-secondary" :disabled="stopping" data-testid="admin-emoji-import-stop" @click="stopping = true">
          {{ t('admin.emojis.import.stop') }}
        </button>
      </template>
      <template v-else-if="phase === 'done'">
        <button type="button" class="btn btn-primary" data-testid="admin-emoji-import-close" @click="close">{{ t('common.close') }}</button>
      </template>
      <template v-else>
        <button type="button" class="btn btn-secondary" @click="close">{{ t('common.cancel') }}</button>
        <button
          type="button"
          class="btn btn-primary"
          :disabled="phase !== 'plan' || planned.length === 0 || hasProblems"
          data-testid="admin-emoji-import-confirm"
          @click="run"
        >{{ t('admin.emojis.import.confirm', { count: planned.length }, planned.length) }}</button>
      </template>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useAnnouncer } from '@/composables/useAnnouncer'
import { useT } from '@/composables/useT'
import {
  AdminEmojiRequestError,
  INSTANCE_EMOJI_NAME,
  importRemoteEmoji,
  previewEmojiImports,
  type AdminEmojiRow,
} from '@/services/InstanceEmojiAdminService'
import { debug } from '@/utils/debug'
import { getEmojiUrl } from '@/utils/emojiUtils'

const props = defineProps<{
  show: boolean
  /** not_imported rows: id is the remote_emojis_cache id. */
  rows: AdminEmojiRow[]
}>()

const emit = defineEmits<{
  /** `imported`: emojis added while the dialog was open. */
  close: [imported: number]
}>()

type Status = 'pending' | 'imported' | 'skipped' | 'failed' | 'gone' | 'stopped'

interface Item {
  id: string
  shortcode: string
  domain: string | null
  url: string
  license: string | null
  /** The name an import takes from the shortcode; held when `taken`. */
  base: string
  taken: boolean
  name: string
  skip: boolean
  status: Status
  /** Backend error code of a failed import. */
  code: string
}

/** Backend codes with their own sentence under admin.emojis.errors.backend. */
const BACKEND_CODES = new Set([
  'not_authenticated', 'admin_required', 'insufficient_aal', 'not_found', 'already_imported',
  'name_taken', 'invalid_name', 'unsupported_image', 'too_large', 'fetch_failed',
  'internal_error', 'network_error', 'rate_limited',
])

const CONCURRENCY = 3

const { t } = useT()
const { polite } = useAnnouncer()
const uid = `emoji-import-${useId()}`

const phase = ref<'loading' | 'error' | 'plan' | 'running' | 'done'>('loading')
const items = ref<Item[]>([])
const stopping = ref(false)
const finished = ref(0)
const runTotal = ref(0)

const planned = computed(() => items.value.filter((i) => i.status === 'pending' && !i.skip))
const clashCount = computed(() => items.value.filter((i) => i.taken).length)
const importedCount = computed(() => items.value.filter((i) => i.status === 'imported').length)

/** Lower-cased names more than one planned row asks for. */
const repeated = computed(() => {
  const seen = new Map<string, number>()
  for (const item of planned.value) seen.set(item.name.toLowerCase(), (seen.get(item.name.toLowerCase()) ?? 0) + 1)
  return new Set([...seen].filter(([, n]) => n > 1).map(([name]) => name))
})

function problem(item: Item): string {
  if (item.skip || item.status !== 'pending') return ''
  if (!INSTANCE_EMOJI_NAME.test(item.name)) return t('admin.emojis.errors.invalidName')
  if (item.taken && item.name.toLowerCase() === item.base.toLowerCase()) return t('admin.emojis.import.nameInUse')
  if (repeated.value.has(item.name.toLowerCase())) return t('admin.emojis.import.nameRepeated')
  return ''
}

const hasProblems = computed(() => planned.value.some((item) => problem(item) !== ''))

const title = computed(() => {
  const count = phase.value === 'loading' || phase.value === 'error' ? props.rows.length : items.value.length
  return t('admin.emojis.import.title', { count }, count)
})

const summary = computed(() => {
  if (phase.value === 'running') {
    return t('admin.emojis.import.progress', { current: finished.value, total: runTotal.value })
  }
  const count = (status: Status) => items.value.filter((i) => i.status === status).length
  const parts = [t('admin.emojis.import.result.imported', { count: importedCount.value }, importedCount.value)]
  const skipped = count('skipped') + count('gone')
  const failed = count('failed')
  const stopped = count('stopped')
  if (skipped > 0) parts.push(t('admin.emojis.import.result.skipped', { count: skipped }, skipped))
  if (failed > 0) parts.push(t('admin.emojis.import.result.failed', { count: failed }, failed))
  if (stopped > 0) parts.push(t('admin.emojis.import.result.stopped', { count: stopped }, stopped))
  return parts.join(' · ')
})

function statusText(item: Item): string {
  if (item.status === 'imported') return t('admin.emojis.import.status.imported', { name: `:${item.name}:` })
  if (item.status === 'skipped') return t('admin.emojis.import.status.skipped')
  if (item.status === 'gone') return t('admin.emojis.import.status.gone')
  if (item.status === 'stopped') return t('admin.emojis.import.status.stopped')
  if (item.status === 'failed') {
    return t(`admin.emojis.errors.backend.${BACKEND_CODES.has(item.code) ? item.code : 'internal_error'}`)
  }
  return t('admin.emojis.import.status.waiting')
}

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  phase.value = 'loading'
  stopping.value = false
  finished.value = 0
  items.value = []
  const rows = props.rows
  try {
    const preview = new Map((await previewEmojiImports(rows.map((r) => r.id))).map((p) => [p.id, p]))
    if (seq !== loadSeq) return
    const built = rows.map((row): Item => {
      const p = preview.get(row.id)
      return {
        id: row.id,
        shortcode: row.name,
        domain: row.domain,
        url: row.url,
        license: row.license,
        base: p?.name ?? row.name,
        taken: p?.taken === true,
        name: p?.suggested ?? row.name,
        skip: false,
        // No preview row: imported or dropped from the cache since the list was read.
        status: p ? 'pending' : 'gone',
        code: '',
      }
    })
    // Rows that need a decision first.
    items.value = [...built.filter((i) => i.taken), ...built.filter((i) => !i.taken)]
    phase.value = 'plan'
  } catch (err) {
    if (seq !== loadSeq) return
    debug.error('Emoji import preview failed:', err)
    phase.value = 'error'
  }
}

watch(() => props.show, (open) => { if (open) void load() }, { immediate: true })

async function run() {
  if (phase.value !== 'plan' || hasProblems.value || planned.value.length === 0) return
  for (const item of items.value) if (item.status === 'pending' && item.skip) item.status = 'skipped'
  const queue = items.value.filter((i) => i.status === 'pending')
  runTotal.value = queue.length
  finished.value = 0
  stopping.value = false
  phase.value = 'running'

  let next = 0
  let limited = false
  const worker = async () => {
    while (next < queue.length && !stopping.value && !limited) {
      const item = queue[next++]
      try {
        const emoji = await importRemoteEmoji(item.id, item.name)
        item.name = emoji.name || item.name
        item.status = 'imported'
      } catch (err) {
        debug.error(`Emoji import failed: ${item.shortcode}`, err)
        item.code = err instanceof AdminEmojiRequestError ? err.code : 'internal_error'
        item.status = 'failed'
        // The hourly limit refuses every later request as well.
        if (item.code === 'rate_limited') limited = true
      }
      finished.value++
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, worker))

  for (const item of queue) {
    if (item.status !== 'pending') continue
    item.status = limited ? 'failed' : 'stopped'
    if (limited) item.code = 'rate_limited'
  }
  phase.value = 'done'
  polite(summary.value)
}

function close() {
  if (phase.value === 'running') return
  emit('close', importedCount.value)
}
</script>

<style scoped src="./adminShared.css"></style>
<style scoped>
.import {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-width: 0;
}

.import-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.import-note,
.import-summary {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.import-clash-note,
.import-summary {
  color: var(--text-primary);
}

.import-error {
  margin: 0;
  color: var(--text-danger);
  font-size: 14px;
}

.import-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: min(calc(50 * var(--app-vh)), 420px);
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
}

.import-item {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 10px 12px;
}

.import-item + .import-item {
  border-top: 1px solid var(--border-color);
}

.import-item.skipped .import-img,
.import-item.skipped .import-source {
  opacity: 0.55;
}

.import-img {
  flex: 0 0 auto;
  width: 32px;
  height: 32px;
  object-fit: contain;
}

.import-main {
  display: flex;
  flex-direction: column;
  gap: 6px;
  flex: 1 1 auto;
  min-width: 0;
}

.import-source {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  font-size: 13px;
  color: var(--text-secondary);
}

.import-shortcode {
  color: var(--text-primary);
  font-weight: 600;
  overflow-wrap: anywhere;
}

.import-license {
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.import-controls {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
}

.import-name {
  flex: 1 1 160px;
  min-width: 0;
  padding: 6px 10px;
}

.import-skip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
}

.import-problem,
.status-failed {
  font-size: 13px;
  color: var(--text-danger);
}

.import-status {
  font-size: 13px;
  color: var(--text-secondary);
}

.status-imported {
  color: var(--text-primary);
}

.badge.taken {
  padding: 0 6px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warning) 20%, transparent);
  color: var(--text-primary);
  font-size: var(--font-size-xs);
  font-weight: 600;
  text-transform: none;
}
</style>
