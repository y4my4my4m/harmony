<template>
  <RailMenu :x="x" :y="y" :label="folder.name || t('serverRail.folder.unnamed')" @close="emit('close')">
    <button type="button" role="menuitem" class="rail-menu-item" data-action="mark-read" :disabled="!hasUnread" @click="act({ type: 'mark-read' })">
      {{ t('serverRail.folder.markRead') }}
    </button>
    <button type="button" role="menuitem" class="rail-menu-item" data-action="settings" @click="act({ type: 'settings' })">
      {{ t('serverRail.folder.settings') }}
    </button>
    <button type="button" role="menuitem" class="rail-menu-item" data-action="toggle" @click="act({ type: 'toggle' })">
      {{ folder.is_expanded ? t('serverRail.folder.collapse') : t('serverRail.folder.expand') }}
    </button>

    <div class="rail-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="rail-menu-item" data-action="move-up" :disabled="!canMoveUp" @click="act({ type: 'move', delta: -1 })">
      {{ t('serverRail.menu.moveUp') }}
      <span class="rail-menu-trail" aria-hidden="true">Alt+↑</span>
    </button>
    <button type="button" role="menuitem" class="rail-menu-item" data-action="move-down" :disabled="!canMoveDown" @click="act({ type: 'move', delta: 1 })">
      {{ t('serverRail.menu.moveDown') }}
      <span class="rail-menu-trail" aria-hidden="true">Alt+↓</span>
    </button>

    <div class="rail-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="rail-menu-item danger" data-action="ungroup" @click="act({ type: 'ungroup' })">
      {{ t('serverRail.folder.ungroup') }}
    </button>
  </RailMenu>
</template>

<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import RailMenu from '@/components/serverRail/RailMenu.vue'
import type { ServerFolder } from '@/types'

export type FolderMenuAction =
  | { type: 'mark-read' }
  | { type: 'settings' }
  | { type: 'toggle' }
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'ungroup' }

defineProps<{
  folder: ServerFolder
  x: number
  y: number
  hasUnread: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}>()

const emit = defineEmits<{
  close: []
  action: [action: FolderMenuAction]
}>()

const { t } = useI18n()

const act = (action: FolderMenuAction) => {
  emit('action', action)
  emit('close')
}
</script>
