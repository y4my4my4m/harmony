<!-- One folder of the Drive tree with its subfolders; a drop target for files and folders. -->
<template>
  <li class="drive-node" role="none">
    <div
      class="drive-nav-item drive-node__row"
      :class="{ active, 'is-drop': dropping }"
      :style="{ '--depth': depth }"
      role="treeitem"
      :aria-expanded="children.length ? expanded : undefined"
      :aria-selected="active"
      :aria-level="depth + 1"
      tabindex="0"
      :data-folder-id="folder.id"
      data-testid="drive-tree-folder"
      @click="emit('open', folder.id)"
      @keydown.enter.prevent="emit('open', folder.id)"
      @keydown.right.prevent="expanded = true"
      @keydown.left.prevent="expanded = false"
      @contextmenu.prevent="emit('menu', folder, $event)"
      @dragover.prevent="onDragOver"
      @dragleave="dropping = false"
      @drop.prevent="onDrop"
    >
      <button
        v-if="children.length"
        type="button"
        class="drive-node__twisty"
        :aria-label="expanded ? t('drive.tree.collapse') : t('drive.tree.expand')"
        tabindex="-1"
        @click.stop="expanded = !expanded"
      >
        <Icon name="chevron-right" :size="14" :class="{ 'is-open': expanded }" />
      </button>
      <span v-else class="drive-node__twisty" aria-hidden="true" />
      <Icon :name="active || expanded ? 'folder-open' : 'folder'" :size="16" class="drive-nav-item__icon" />
      <span class="drive-nav-item__label">{{ folder.name }}</span>
    </div>
    <ul v-if="children.length && expanded" class="drive-tree__children" role="group">
      <DriveFolderNode
        v-for="child in children"
        :key="child.id"
        :folder="child"
        :folders="folders"
        :active-id="activeId"
        :depth="depth + 1"
        @open="emit('open', $event)"
        @menu="(f, e) => emit('menu', f, e)"
        @drop-items="(target, payload) => emit('drop-items', target, payload)"
      />
    </ul>
  </li>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import type { DriveFolder } from '@/services/drive/driveService'
import { readDriveDrag, type DriveDragPayload } from './driveDrag'

defineOptions({ name: 'DriveFolderNode' })

const props = withDefaults(defineProps<{
  folder: DriveFolder
  folders: DriveFolder[]
  activeId: string | null
  depth?: number
}>(), { depth: 0 })

const emit = defineEmits<{
  open: [id: string]
  menu: [folder: DriveFolder, event: MouseEvent]
  'drop-items': [folderId: string, payload: DriveDragPayload]
}>()

const { t } = useT()
const dropping = ref(false)

const children = computed(() => props.folders
  .filter((f) => f.parent_id === props.folder.id)
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))

const active = computed(() => props.activeId === props.folder.id)

/** The active folder lies below this one. */
const containsActive = computed(() => {
  let id = props.activeId
  const byId = new Map(props.folders.map((f) => [f.id, f]))
  const seen = new Set<string>()
  while (id && !seen.has(id)) {
    seen.add(id)
    const f = byId.get(id)
    if (!f) return false
    if (f.parent_id === props.folder.id) return true
    id = f.parent_id
  }
  return false
})

const expanded = ref(containsActive.value)
watch(containsActive, (inside) => {
  if (inside) expanded.value = true
})

function onDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes('application/x-harmony-drive')) return
  event.dataTransfer.dropEffect = 'move'
  dropping.value = true
}

function onDrop(event: DragEvent): void {
  dropping.value = false
  const payload = readDriveDrag(event)
  if (payload) emit('drop-items', props.folder.id, payload)
}
</script>
