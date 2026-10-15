<!-- Folders and files of a Drive view as tiles or rows. A multi-select listbox: click selects,
     Ctrl/Cmd adds, Shift extends; arrows move, Enter opens, Space toggles, Delete trashes, F2
     renames. Items drag onto folders here and in the tree. -->
<template>
  <div
    ref="root"
    class="drive-items"
    :class="`drive-items--${layout}`"
    role="listbox"
    aria-multiselectable="true"
    :aria-label="label"
    data-testid="drive-items"
    @keydown="onKeydown"
  >
    <div v-if="layout === 'list'" class="drive-row drive-row--head" aria-hidden="true">
      <span class="drive-row__name">{{ t('drive.columns.name') }}</span>
      <span class="drive-row__where">{{ secondColumn }}</span>
      <span class="drive-row__size">{{ t('drive.columns.size') }}</span>
      <span class="drive-row__date">{{ view === 'trash' ? t('drive.columns.trashed') : t('drive.columns.added') }}</span>
    </div>

    <div
      v-for="(folder, i) in folders"
      :key="`folder-${folder.id}`"
      :ref="(el) => setItemRef(i, el)"
      class="drive-item drive-item--folder"
      :class="[layout === 'grid' ? 'drive-tile' : 'drive-row', { 'is-drop': dropTarget === folder.id }]"
      role="option"
      :aria-selected="false"
      :tabindex="focusIndex === i ? 0 : -1"
      draggable="true"
      data-testid="drive-folder"
      :data-folder-id="folder.id"
      @click="focusIndex = i"
      @dblclick="emit('open-folder', folder.id)"
      @contextmenu.prevent="emit('folder-menu', folder, $event)"
      @dragstart="onDragStart($event, { files: [], folders: [folder.id] })"
      @dragover.prevent="onFolderDragOver($event, folder.id)"
      @dragleave="dropTarget = null"
      @drop.prevent="onFolderDrop($event, folder.id)"
    >
      <template v-if="layout === 'grid'">
        <div class="drive-tile__folder">
          <Icon name="folder" :size="22" class="drive-tile__folder-icon" />
          <span class="drive-tile__folder-name">{{ folder.name }}</span>
        </div>
      </template>
      <template v-else>
        <span class="drive-row__name">
          <span class="drive-row__thumb drive-row__thumb--folder"><Icon name="folder" :size="18" /></span>
          <span class="drive-row__label">{{ folder.name }}</span>
        </span>
        <span class="drive-row__where">—</span>
        <span class="drive-row__size">—</span>
        <span class="drive-row__date">{{ formatDate(folder.updated_at) }}</span>
      </template>
    </div>

    <div
      v-for="(entry, j) in entries"
      :key="entry.file.id"
      :ref="(el) => setItemRef(folders.length + j, el)"
      class="drive-item"
      :class="[layout === 'grid' ? 'drive-tile' : 'drive-row', { 'is-selected': selected.has(entry.file.id) }]"
      role="option"
      :aria-selected="selected.has(entry.file.id)"
      :aria-label="ariaFor(entry)"
      :tabindex="focusIndex === folders.length + j ? 0 : -1"
      :draggable="entry.file.owner_id === ownId && view !== 'trash'"
      data-testid="drive-file"
      :data-file-id="entry.file.id"
      @click="onFileClick($event, folders.length + j, entry)"
      @dblclick="emit('open-file', entry)"
      @contextmenu.prevent="onFileMenu($event, folders.length + j, entry)"
      @dragstart="onDragStart($event, dragPayloadFor(entry.file.id))"
    >
      <template v-if="layout === 'grid'">
        <div class="drive-tile__face">
          <DriveFileThumb :file="entry.file" />
          <span class="drive-tile__check" aria-hidden="true"><Icon name="check" :size="12" /></span>
          <span v-if="entry.file.state === 'ephemeral'" class="drive-tile__pill drive-tile__pill--temp" :title="t('drive.state.expiresIn', { count: daysUntil(entry.file.expires_at) }, daysUntil(entry.file.expires_at))">
            <Icon name="hourglass" :size="11" />{{ t('drive.state.daysShort', { count: daysUntil(entry.file.expires_at) }) }}
          </span>
        </div>
        <div class="drive-tile__meta">
          <span class="drive-tile__name" :title="nameOf(entry.file)">{{ nameOf(entry.file) }}</span>
          <span class="drive-tile__sub">
            <template v-if="entry.owner">{{ entry.owner.display_name || entry.owner.username }} · </template>{{ formatBytes(entry.file.size_bytes, locale.value) }}
          </span>
        </div>
      </template>
      <template v-else>
        <span class="drive-row__name">
          <span class="drive-row__thumb"><DriveFileThumb :file="entry.file" small /></span>
          <span class="drive-row__label" :title="nameOf(entry.file)">{{ nameOf(entry.file) }}</span>
          <span v-if="entry.file.state === 'ephemeral'" class="drive-row__state" :title="t('drive.state.expiresIn', { count: daysUntil(entry.file.expires_at) }, daysUntil(entry.file.expires_at))">
            <Icon name="hourglass" :size="12" />{{ t('drive.state.daysShort', { count: daysUntil(entry.file.expires_at) }) }}
          </span>
        </span>
        <span class="drive-row__where">
          <template v-if="entry.owner">{{ entry.owner.display_name || entry.owner.username }}</template>
          <template v-else>{{ kindLabel(entry.file.kind) }}</template>
        </span>
        <span class="drive-row__size">{{ formatBytes(entry.file.size_bytes, locale.value) }}</span>
        <span class="drive-row__date">{{ formatDate(view === 'trash' ? entry.file.trashed_at : entry.file.created_at) }}</span>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import type { DriveFile, DriveFileKind, DriveFolder, DriveListEntry, DriveView } from '@/services/drive/driveService'
import { driveFileDisplayName } from '@/services/drive/driveService'
import DriveFileThumb from './DriveFileThumb.vue'
import { daysUntil, formatBytes } from './driveFormat'
import { DRIVE_DRAG_TYPE, readDriveDrag, writeDriveDrag, type DriveDragPayload } from './driveDrag'

const props = defineProps<{
  folders: DriveFolder[]
  entries: DriveListEntry[]
  layout: 'grid' | 'list'
  selected: Set<string>
  view: DriveView
  label: string
  ownId: string | null
}>()

const emit = defineEmits<{
  'open-folder': [id: string]
  'open-file': [entry: DriveListEntry]
  select: [id: string, mode: 'only' | 'toggle' | 'range']
  'select-all': []
  'file-menu': [entry: DriveListEntry, event: MouseEvent]
  'folder-menu': [folder: DriveFolder, event: MouseEvent]
  'drop-items': [folderId: string, payload: DriveDragPayload]
  delete: []
  rename: [entry: DriveListEntry]
}>()

const { t, locale } = useT()
const root = ref<HTMLElement | null>(null)
const items: Array<HTMLElement | null> = []
const focusIndex = ref(0)
const dropTarget = ref<string | null>(null)

const count = computed(() => props.folders.length + props.entries.length)
const secondColumn = computed(() => (props.view === 'shared' ? t('drive.columns.owner') : t('drive.columns.type')))

watch(count, (n) => {
  if (focusIndex.value >= n) focusIndex.value = Math.max(0, n - 1)
})

function setItemRef(index: number, el: unknown): void {
  items[index] = (el as HTMLElement | null) ?? null
}

function nameOf(file: DriveFile): string {
  return driveFileDisplayName(file, t('drive.file.unnamed'))
}

function kindLabel(kind: DriveFileKind): string {
  return t(`drive.kind.${kind}`)
}

function ariaFor(entry: DriveListEntry): string {
  const parts = [nameOf(entry.file), formatBytes(entry.file.size_bytes, locale.value)]
  if (entry.file.state === 'ephemeral') {
    parts.push(t('drive.state.expiresIn', { count: daysUntil(entry.file.expires_at) }, daysUntil(entry.file.expires_at)))
  }
  return parts.join(', ')
}

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium' }))
function formatDate(iso: string | null): string {
  return iso ? dateFormat.value.format(new Date(iso)) : '—'
}

function modeOf(event: MouseEvent | KeyboardEvent): 'only' | 'toggle' | 'range' {
  if (event.shiftKey) return 'range'
  if (event.ctrlKey || event.metaKey) return 'toggle'
  return 'only'
}

function onFileClick(event: MouseEvent, index: number, entry: DriveListEntry): void {
  focusIndex.value = index
  emit('select', entry.file.id, modeOf(event))
}

function onFileMenu(event: MouseEvent, index: number, entry: DriveListEntry): void {
  focusIndex.value = index
  if (!props.selected.has(entry.file.id)) emit('select', entry.file.id, 'only')
  emit('file-menu', entry, event)
}

function dragPayloadFor(id: string): DriveDragPayload {
  return { files: props.selected.has(id) ? [...props.selected] : [id], folders: [] }
}

function onDragStart(event: DragEvent, payload: DriveDragPayload): void {
  writeDriveDrag(event, payload)
}

function onFolderDragOver(event: DragEvent, id: string): void {
  if (!event.dataTransfer?.types.includes(DRIVE_DRAG_TYPE)) return
  event.dataTransfer.dropEffect = 'move'
  dropTarget.value = id
}

function onFolderDrop(event: DragEvent, id: string): void {
  dropTarget.value = null
  const payload = readDriveDrag(event)
  if (payload && !payload.folders.includes(id)) emit('drop-items', id, payload)
}

/** Items per row in the grid, from the laid-out tiles. */
function columns(): number {
  if (props.layout === 'list') return 1
  const first = items.find(Boolean)
  if (!first || !root.value) return 1
  const top = first.getBoundingClientRect().top
  let n = 0
  for (const el of items) {
    if (!el) continue
    if (Math.abs(el.getBoundingClientRect().top - top) > 2) break
    n++
  }
  return Math.max(1, n)
}

function focusAt(index: number): void {
  if (count.value === 0) return
  focusIndex.value = Math.min(count.value - 1, Math.max(0, index))
  void nextTick(() => items[focusIndex.value]?.focus())
}

function entryAt(index: number): DriveListEntry | null {
  return index >= props.folders.length ? props.entries[index - props.folders.length] ?? null : null
}

function onKeydown(event: KeyboardEvent): void {
  if ((event.target as HTMLElement).closest('input, textarea')) return
  const i = focusIndex.value
  const cols = columns()
  switch (event.key) {
    case 'ArrowRight': event.preventDefault(); focusAt(props.layout === 'grid' ? i + 1 : i); break
    case 'ArrowLeft': event.preventDefault(); focusAt(props.layout === 'grid' ? i - 1 : i); break
    case 'ArrowDown': event.preventDefault(); focusAt(i + cols); break
    case 'ArrowUp': event.preventDefault(); focusAt(i - cols); break
    case 'Home': event.preventDefault(); focusAt(0); break
    case 'End': event.preventDefault(); focusAt(count.value - 1); break
    case 'Enter': {
      event.preventDefault()
      const entry = entryAt(i)
      if (entry) emit('open-file', entry)
      else if (props.folders[i]) emit('open-folder', props.folders[i].id)
      break
    }
    case ' ': {
      event.preventDefault()
      const entry = entryAt(i)
      if (entry) emit('select', entry.file.id, event.shiftKey ? 'range' : 'toggle')
      break
    }
    case 'Delete':
    case 'Backspace':
      if (props.selected.size > 0) { event.preventDefault(); emit('delete') }
      break
    case 'F2': {
      const entry = entryAt(i)
      if (entry) { event.preventDefault(); emit('rename', entry) }
      break
    }
    case 'a':
    case 'A':
      if (event.ctrlKey || event.metaKey) { event.preventDefault(); emit('select-all') }
      break
  }
}

defineExpose({ focusFirst: () => focusAt(0) })
</script>

<style scoped>
.drive-items {
  outline: none;
}

.drive-items--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: var(--space-3);
}

.drive-item {
  outline: none;
  user-select: none;
  -webkit-user-drag: element;
}

/* Tiles */
.drive-tile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 6px;
  background: var(--background-secondary);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  cursor: default;
  transition: background-color 0.12s ease, border-color 0.12s ease, transform 0.12s ease, box-shadow 0.12s ease;
}

.drive-tile:hover {
  background: var(--background-modifier-hover);
}

.drive-tile:focus-visible {
  box-shadow: 0 0 0 2px var(--border-focus);
}

.drive-tile.is-selected {
  background: color-mix(in srgb, var(--harmony-primary) 14%, var(--background-secondary));
  border-color: color-mix(in srgb, var(--harmony-primary) 60%, transparent);
}

.drive-tile.is-drop {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 18%, var(--background-secondary));
  transform: scale(1.02);
}

.drive-tile__face {
  position: relative;
  aspect-ratio: 4 / 3;
  border-radius: calc(var(--radius-md) - 3px);
  overflow: hidden;
}

.drive-tile__check {
  position: absolute;
  top: 8px;
  left: 8px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  background: rgb(12 14 20 / 0.55);
  border: 1.5px solid rgb(255 255 255 / 0.85);
  border-radius: var(--radius-full);
  color: transparent;
  opacity: 0;
  transform: scale(0.8);
  transition: opacity 0.12s ease, transform 0.12s ease, background-color 0.12s ease;
}

.drive-tile:hover .drive-tile__check,
.drive-tile.is-selected .drive-tile__check {
  opacity: 1;
  transform: scale(1);
}

.drive-tile.is-selected .drive-tile__check {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: #fff;
}

.drive-tile__pill {
  position: absolute;
  right: 8px;
  bottom: 8px;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 7px 2px 6px;
  background: rgb(12 14 20 / 0.72);
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: var(--font-weight-semibold);
  color: #fff;
  backdrop-filter: blur(6px);
}

.drive-tile__pill--temp {
  color: #ffd27a;
}

.drive-tile__meta {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 8px 4px 2px;
  min-width: 0;
}

.drive-tile__name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-tile__sub {
  overflow: hidden;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* Muted text on the selection tint is 4.4:1 in dark. */
.drive-tile.is-selected .drive-tile__sub {
  color: var(--text-secondary);
}

.drive-tile.drive-item--folder {
  padding: 0;
}

.drive-tile__folder {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  height: 48px;
  padding: 0 var(--space-3);
}

.drive-tile__folder-icon {
  flex-shrink: 0;
  color: var(--harmony-primary);
}

.drive-tile__folder-name {
  overflow: hidden;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

/* Rows */
.drive-items--list {
  display: flex;
  flex-direction: column;
}

.drive-row {
  display: grid;
  grid-template-columns: minmax(0, 3fr) minmax(0, 1.4fr) 88px 120px;
  align-items: center;
  gap: var(--space-3);
  min-height: 44px;
  padding: 0 var(--space-3);
  border-radius: var(--radius-sm);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  transition: background-color 0.1s ease;
}

.drive-row:not(.drive-row--head):hover {
  background: var(--background-modifier-hover);
}

.drive-row:focus-visible {
  box-shadow: inset 0 0 0 2px var(--border-focus);
}

.drive-row.is-selected {
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  color: var(--text-primary);
}

.drive-row.is-drop {
  box-shadow: inset 0 0 0 1px var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
}

.drive-row--head {
  position: sticky;
  top: 0;
  z-index: 1;
  min-height: 32px;
  background: var(--background-primary);
  border-bottom: 1px solid var(--border-color);
  border-radius: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-muted);
}

.drive-row__name {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-width: 0;
}

.drive-row__thumb {
  flex-shrink: 0;
  width: 30px;
  height: 30px;
  overflow: hidden;
  border-radius: 6px;
}

.drive-row__thumb--folder {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  color: var(--harmony-primary);
}

.drive-row__label {
  overflow: hidden;
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-row__state {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  flex-shrink: 0;
  padding: 1px 6px;
  background: color-mix(in srgb, var(--warning) 16%, transparent);
  border-radius: var(--radius-full);
  font-size: 11px;
  color: var(--warning);
}

.drive-row__where,
.drive-row__size,
.drive-row__date {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

@media (max-width: 720px) {
  .drive-items--grid {
    grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
    gap: var(--space-2);
  }

  .drive-row {
    grid-template-columns: minmax(0, 1fr) 72px;
  }

  .drive-row__where,
  .drive-row__date {
    display: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .drive-tile,
  .drive-tile__check {
    transition: none;
  }
}
</style>
