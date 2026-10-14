<!-- Picks the folder files or a folder move to. -->
<template>
  <UnifiedModal
    :model-value="true"
    :title="t('drive.move.title', { count }, count)"
    size="sm"
    :actions="[
      { key: 'cancel', label: t('common.cancel'), variant: 'secondary', handler: () => emit('close') },
      { key: 'move', label: t('drive.move.here'), variant: 'primary', disabled: target === undefined, handler: () => { if (target !== undefined) emit('move', target) } },
    ]"
    @update:model-value="(open) => !open && emit('close')"
  >
    <ul class="drive-move" role="listbox" data-testid="drive-move-dialog" :aria-label="t('drive.move.title', { count }, count)">
      <li>
        <button type="button" class="drive-move__item" role="option" :aria-selected="target === null" :class="{ active: target === null }" data-testid="drive-move-root" @click="target = null">
          <Icon name="hard-drive" :size="16" />{{ t('drive.nav.myDrive') }}
        </button>
      </li>
      <li v-for="row in rows" :key="row.folder.id">
        <button
          type="button"
          class="drive-move__item"
          role="option"
          :aria-selected="target === row.folder.id"
          :class="{ active: target === row.folder.id }"
          :disabled="row.blocked"
          :style="{ paddingLeft: `${12 + row.depth * 16}px` }"
          data-testid="drive-move-folder"
          @click="target = row.folder.id"
        >
          <Icon name="folder" :size="16" />{{ row.folder.name }}
        </button>
      </li>
    </ul>
  </UnifiedModal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import UnifiedModal from '@/components/shared/UnifiedModal.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import type { DriveFolder } from '@/services/drive/driveService'

const props = withDefaults(defineProps<{
  folders: DriveFolder[]
  count: number
  /** A folder being moved: it and its subtree are not targets. */
  movingFolder?: string | null
}>(), { movingFolder: null })

const emit = defineEmits<{ close: []; move: [folderId: string | null] }>()
const { t } = useT()
const target = ref<string | null | undefined>(undefined)

const rows = computed(() => {
  const out: Array<{ folder: DriveFolder; depth: number; blocked: boolean }> = []
  const walk = (parent: string | null, depth: number, blocked: boolean) => {
    props.folders
      .filter((f) => f.parent_id === parent)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
      .forEach((folder) => {
        const inside = blocked || folder.id === props.movingFolder
        out.push({ folder, depth, blocked: inside })
        walk(folder.id, depth + 1, inside)
      })
  }
  walk(null, 1, false)
  return out
})
</script>

<style scoped>
.drive-move {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: calc(50 * var(--app-vh));
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}

.drive-move__item {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 34px;
  padding: 0 12px;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
}

.drive-move__item:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drive-move__item.active {
  background: color-mix(in srgb, var(--harmony-primary) 16%, transparent);
  color: var(--text-primary);
}

.drive-move__item:disabled {
  cursor: not-allowed;
  opacity: 0.45;
}
</style>
