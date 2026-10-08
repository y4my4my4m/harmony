<template>
  <RailMenu :x="x" :y="y" :label="server.name" @close="emit('close')">
    <button type="button" role="menuitem" class="rail-menu-item" data-action="mark-read" :disabled="!hasUnread" @click="act({ type: 'mark-read' })">
      {{ t('serverRail.menu.markRead') }}
    </button>
    <button type="button" role="menuitem" class="rail-menu-item" data-action="invite" @click="act({ type: 'invite' })">
      {{ t('serverRail.menu.invite') }}
    </button>

    <div class="rail-menu-divider" role="separator"></div>

    <button v-if="muted" type="button" role="menuitem" class="rail-menu-item" data-action="unmute" @click="act({ type: 'mute', until: false })">
      {{ t('serverRail.menu.unmute') }}
    </button>
    <div v-else class="rail-menu-sub" role="none">
      <button type="button" role="menuitem" class="rail-menu-item" data-action="mute" aria-haspopup="menu">
        {{ t('serverRail.menu.mute') }}
        <span class="rail-menu-trail" aria-hidden="true">›</span>
      </button>
      <div role="menu" :aria-label="t('serverRail.menu.mute')">
        <button
          v-for="d in MUTE_DURATIONS"
          :key="d.key"
          type="button"
          role="menuitem"
          class="rail-menu-item"
          :data-action="`mute-${d.key}`"
          @click="act({ type: 'mute', until: d.minutes === null ? null : new Date(Date.now() + d.minutes * 60_000) })"
        >
          {{ t(`serverRail.mute.${d.key}`) }}
        </button>
      </div>
    </div>
    <div v-if="muted && mutedUntilLabel" class="rail-menu-note">{{ mutedUntilLabel }}</div>

    <div class="rail-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="rail-menu-item" data-action="settings" @click="act({ type: 'settings' })">
      {{ canManageServer ? t('server.settings') : t('server.overview') }}
    </button>
    <button v-if="canManageChannels" type="button" role="menuitem" class="rail-menu-item" data-action="create-channel" @click="act({ type: 'create-channel' })">
      {{ t('channel.create') }}
    </button>
    <button v-if="canManageChannels" type="button" role="menuitem" class="rail-menu-item" data-action="create-category" @click="act({ type: 'create-category' })">
      {{ t('server.createCategory') }}
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
    <button v-if="!folderId" type="button" role="menuitem" class="rail-menu-item" data-action="create-folder" @click="act({ type: 'create-folder' })">
      {{ t('serverRail.menu.createFolder') }}
    </button>
    <div v-if="targetFolders.length" class="rail-menu-sub" role="none">
      <button type="button" role="menuitem" class="rail-menu-item" data-action="move-to-folder" aria-haspopup="menu">
        {{ t('serverRail.menu.moveToFolder') }}
        <span class="rail-menu-trail" aria-hidden="true">›</span>
      </button>
      <div role="menu" :aria-label="t('serverRail.menu.moveToFolder')">
        <button
          v-for="f in targetFolders"
          :key="f.id"
          type="button"
          role="menuitem"
          class="rail-menu-item"
          :data-action="`move-to-${f.id}`"
          @click="act({ type: 'move-to-folder', folderId: f.id })"
        >
          <span class="rail-menu-swatch" :style="{ background: f.color }" aria-hidden="true"></span>
          {{ f.name || t('serverRail.folder.unnamed') }}
        </button>
      </div>
    </div>
    <button v-if="folderId" type="button" role="menuitem" class="rail-menu-item" data-action="remove-from-folder" @click="act({ type: 'move-to-folder', folderId: null })">
      {{ t('serverRail.menu.removeFromFolder') }}
    </button>

    <div class="rail-menu-divider" role="separator"></div>

    <button type="button" role="menuitem" class="rail-menu-item" data-action="copy-id" @click="act({ type: 'copy-id' })">
      {{ t('serverRail.menu.copyId') }}
    </button>
    <button v-if="!isOwner" type="button" role="menuitem" class="rail-menu-item danger" data-action="leave" @click="act({ type: 'leave' })">
      {{ t('server.leaveServer') }}
    </button>
  </RailMenu>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import RailMenu from './RailMenu.vue'
import { useServerPermissions } from '@/composables/useServerPermissions'
import type { Server, ServerFolder } from '@/types'

export type ServerMenuAction =
  | { type: 'mark-read' }
  | { type: 'invite' }
  | { type: 'mute'; until: Date | null | false }
  | { type: 'settings' }
  | { type: 'create-channel' }
  | { type: 'create-category' }
  | { type: 'move'; delta: -1 | 1 }
  | { type: 'create-folder' }
  | { type: 'move-to-folder'; folderId: string | null }
  | { type: 'copy-id' }
  | { type: 'leave' }

/** Discord's mute presets; null minutes mutes until unmuted. */
const MUTE_DURATIONS = [
  { key: 'm15', minutes: 15 },
  { key: 'h1', minutes: 60 },
  { key: 'h3', minutes: 180 },
  { key: 'h8', minutes: 480 },
  { key: 'h24', minutes: 1440 },
  { key: 'forever', minutes: null },
] as const

const props = defineProps<{
  server: Server
  x: number
  y: number
  folderId: string | null
  folders: readonly ServerFolder[]
  hasUnread: boolean
  muted: boolean
  isOwner: boolean
  canMoveUp: boolean
  canMoveDown: boolean
}>()

const emit = defineEmits<{
  close: []
  action: [action: ServerMenuAction]
}>()

const { t, locale } = useI18n()

const { serverSettingsPermissions, channelPermissions } = useServerPermissions(() => props.server.id)
const canManageServer = computed(() => serverSettingsPermissions.value.canEditBasicInfo)
const canManageChannels = computed(() => channelPermissions.value.canCreateChannels)

const targetFolders = computed(() => props.folders.filter(f => f.id !== props.folderId))

const mutedUntilLabel = computed(() => {
  if (!props.server.muted_until) return ''
  return t('serverRail.mute.until', { time: new Date(props.server.muted_until).toLocaleString(locale.value, { dateStyle: 'short', timeStyle: 'short' }) })
})

const act = (action: ServerMenuAction) => {
  emit('action', action)
  emit('close')
}
</script>
