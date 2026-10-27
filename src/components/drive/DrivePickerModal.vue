<!-- Picks files from the account's Drive: the composer's "From Drive" and activities. -->
<template>
  <UnifiedModal
    :model-value="true"
    :title="title || t('drive.picker.title')"
    size="lg"
    topmost
    @update:model-value="(open) => !open && emit('close')"
  >
    <div class="drive-picker" data-testid="drive-picker">
      <div class="drive-picker__bar">
        <div class="drive-picker__search">
          <Icon name="search" :size="15" class="drive-picker__search-icon" aria-hidden="true" />
          <input v-model="query" type="search" class="drive-input" :placeholder="t('drive.search.hint')" :aria-label="t('drive.search.label')" data-testid="drive-picker-search" />
        </div>
        <select v-model="folder" class="drive-select" :aria-label="t('drive.picker.folder')">
          <option :value="ALL">{{ t('drive.picker.everything') }}</option>
          <option :value="ROOT">{{ t('drive.nav.myDrive') }}</option>
          <option v-for="f in folders" :key="f.id" :value="f.id">{{ f.name }}</option>
        </select>
      </div>

      <div v-if="loading && !entries.length" class="drive-picker__state">{{ t('common.loading') }}</div>
      <div v-else-if="!entries.length" class="drive-picker__state">{{ t('drive.picker.empty') }}</div>
      <ul v-else class="drive-picker__grid" role="listbox" :aria-multiselectable="multiple" :aria-label="t('drive.picker.title')">
        <li
          v-for="entry in entries"
          :key="entry.file.id"
          class="drive-picker__item"
          :class="{ selected: chosen.has(entry.file.id) }"
          role="option"
          :aria-selected="chosen.has(entry.file.id)"
          tabindex="0"
          data-testid="drive-picker-file"
          @click="toggle(entry.file)"
          @dblclick="toggle(entry.file, true)"
          @keydown.enter.prevent="toggle(entry.file, !multiple)"
          @keydown.space.prevent="toggle(entry.file)"
        >
          <div class="drive-picker__face">
            <DriveFileThumb :file="entry.file" />
            <span class="drive-picker__check" aria-hidden="true"><Icon name="check" :size="12" /></span>
          </div>
          <span class="drive-picker__name">{{ nameOf(entry.file) }}</span>
          <span class="drive-picker__meta">{{ formatBytes(entry.file.size_bytes, locale.value) }}</span>
        </li>
      </ul>
    </div>
    <template #footer>
      <div class="drive-picker__footer">
        <span class="drive-picker__count">{{ chosen.size ? t('drive.selection.count', { count: chosen.size }, chosen.size) : '' }}</span>
        <button type="button" class="drive-btn drive-btn--secondary" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button type="button" class="drive-btn drive-btn--primary" :disabled="!chosen.size" data-testid="drive-picker-confirm" @click="confirm">
          {{ confirmLabel || t('drive.picker.attach', { count: chosen.size }, chosen.size) }}
        </button>
      </div>
    </template>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import {
  driveFileDisplayName,
  listDriveFiles,
  listDriveFolders,
  type DriveFile,
  type DriveFileKind,
  type DriveFolder,
  type DriveListEntry,
} from '@/services/drive/driveService'
import DriveFileThumb from './DriveFileThumb.vue'
import { formatBytes } from './driveFormat'
import './drive.css'

const props = withDefaults(defineProps<{
  /** Kinds offered; null for every kind. */
  kinds?: DriveFileKind[] | null
  /** Buckets offered: chat files (message_media) by default; post media (user_media) on request. */
  buckets?: Array<'message_media' | 'user_media'>
  multiple?: boolean
  title?: string
  confirmLabel?: string
}>(), { kinds: null, buckets: () => ['message_media'], multiple: false, title: '', confirmLabel: '' })

const emit = defineEmits<{ pick: [files: DriveFile[]]; close: [] }>()

const ALL = '__all'
const ROOT = '__root'
const { t, locale } = useT()
const query = ref('')
const folder = ref(ALL)
const folders = ref<DriveFolder[]>([])
const all = ref<DriveListEntry[]>([])
const loading = ref(false)
const chosen = ref(new Map<string, DriveFile>())
let timer: ReturnType<typeof setTimeout> | null = null

const entries = computed(() => all.value.filter((e) => !props.kinds || props.kinds.includes(e.file.kind)))

function nameOf(file: DriveFile): string {
  return driveFileDisplayName(file, t('drive.file.unnamed'))
}

async function load(): Promise<void> {
  loading.value = true
  try {
    const q = query.value.trim()
    const result = await listDriveFiles({
      view: folder.value === ALL || q ? 'all' : 'folder',
      folder: folder.value === ALL || folder.value === ROOT ? null : folder.value,
      query: q || null,
      kind: props.kinds?.length === 1 ? props.kinds[0] : null,
      limit: 200,
    })
    all.value = result.entries.filter((e) => props.buckets.includes(e.file.bucket as 'message_media' | 'user_media'))
  } catch {
    all.value = []
  } finally {
    loading.value = false
  }
}

function toggle(file: DriveFile, submit = false): void {
  const next = new Map(props.multiple ? chosen.value : [])
  if (next.has(file.id) && !submit) next.delete(file.id)
  else next.set(file.id, file)
  chosen.value = next
  if (submit) confirm()
}

function confirm(): void {
  if (chosen.value.size) emit('pick', [...chosen.value.values()])
}

watch(query, () => {
  if (timer) clearTimeout(timer)
  timer = setTimeout(load, 200)
})
watch(folder, load)

onMounted(async () => {
  void load()
  folders.value = await listDriveFolders().catch(() => [])
})
</script>

<style scoped>
.drive-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  min-height: 360px;
}

.drive-picker__bar {
  display: flex;
  gap: var(--space-2);
}

.drive-picker__search {
  position: relative;
  flex: 1;
}

.drive-picker__search-icon {
  position: absolute;
  top: 50%;
  left: 10px;
  color: var(--text-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.drive-picker__search .drive-input {
  padding-left: 32px;
}

.drive-picker__state {
  display: flex;
  align-items: center;
  justify-content: center;
  min-height: 240px;
  font-size: var(--font-size-sm);
  color: var(--text-muted);
}

.drive-picker__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: var(--space-2);
  max-height: calc(52 * var(--app-vh));
  margin: 0;
  padding: 2px;
  overflow-y: auto;
  list-style: none;
}

.drive-picker__item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
  padding: 5px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: pointer;
  outline: none;
  transition: background-color 0.12s ease, border-color 0.12s ease;
}

.drive-picker__item:hover {
  background: var(--background-modifier-hover);
}

.drive-picker__item:focus-visible {
  box-shadow: 0 0 0 2px var(--border-focus);
}

.drive-picker__item.selected {
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  border-color: color-mix(in srgb, var(--harmony-primary) 60%, transparent);
}

.drive-picker__face {
  position: relative;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  border-radius: calc(var(--radius-md) - 3px);
}

.drive-picker__check {
  position: absolute;
  top: 6px;
  right: 6px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: rgb(12 14 20 / 0.55);
  border: 1.5px solid rgb(255 255 255 / 0.85);
  border-radius: var(--radius-full);
  color: transparent;
}

.drive-picker__item.selected .drive-picker__check {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: #fff;
}

.drive-picker__name {
  overflow: hidden;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-picker__meta {
  font-size: 11px;
  color: var(--text-muted);
}

.drive-picker__footer {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
}

.drive-picker__count {
  margin-right: auto;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}
</style>
