<template>
  <div
    ref="scrollEl"
    class="servers-scroll-area"
    @pointerdown="onPointerDown"
    @click="onClick"
    @keydown="onKeydown"
    @contextmenu="onContextMenu"
    @mouseover="onMouseOver"
    @mouseout="onMouseOut"
    @focusin="onFocusIn"
    @focusout="emit('leave-server')"
  >
    <TransitionGroup tag="div" name="rail-move" class="rail-list">
      <div
        v-for="row in view"
        :key="row.key"
        class="rail-entry"
        :data-rail-root="row.id"
      >
        <ServerFolder v-if="row.folder" :folder="row.folder" :servers="row.members" />
        <ServerRailItem v-else-if="row.server" :server="row.server" :folder-id="null" />
      </div>
    </TransitionGroup>

    <div ref="indicatorEl" class="rail-drop-indicator" data-mode="none" aria-hidden="true"></div>

    <slot name="end" />

    <ServerContextMenu
      v-if="menu?.kind === 'server' && menuServer"
      :server="menuServer"
      :x="menu.x"
      :y="menu.y"
      :folder-id="menuServerFolder"
      :folders="serverChannelStore.folders"
      :has-unread="menuHasUnread"
      :muted="isServerMuted(menuServer)"
      :is-owner="isOwner(menuServer)"
      :can-move-up="canMove(-1)"
      :can-move-down="canMove(1)"
      @close="closeMenu"
      @action="onServerAction(menuServer.id, $event)"
    />
    <ServerFolderContextMenu
      v-if="menu?.kind === 'folder' && menuFolder"
      :folder="menuFolder"
      :x="menu.x"
      :y="menu.y"
      :has-unread="menuHasUnread"
      :can-move-up="canMove(-1)"
      :can-move-down="canMove(1)"
      @close="closeMenu"
      @action="onFolderAction(menuFolder, $event)"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef } from 'vue'
import { useRouter } from 'vue-router'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import ServerFolder from '@/components/ServerFolder.vue'
import ServerFolderContextMenu, { type FolderMenuAction } from '@/components/ServerFolderContextMenu.vue'
import ServerRailItem from './ServerRailItem.vue'
import ServerContextMenu, { type ServerMenuAction } from './ServerContextMenu.vue'
import {
  applyDrop,
  buildRailLayout,
  containerOf,
  isPlanEmpty,
  moveByOffset,
  moveToFolder,
  planLayout,
  ungroupFolder,
  wrapInFolder,
  type DragSource,
  type DropTarget,
  type RailLayout,
} from './railModel'
import { isServerMuted, retainRailClock } from './railState'
import { sourceFromElement, useRailDrag } from './useRailDrag'
import { markServersRead } from './markRead'
import { serverUnreadTotals, useUnreadCounts } from '@/composables/useUnreadCounts'
import { useLeaveServer } from '@/composables/useLeaveServer'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useNotificationStore } from '@/stores/useNotification'
import { debug } from '@/utils/debug'
import type { Server, ServerFolder as ServerFolderType } from '@/types'

const props = defineProps<{
  servers: readonly Server[]
}>()

const emit = defineEmits<{
  'select-server': [serverId: string]
  'hover-server': [serverId: string]
  'leave-server': []
  'tooltip': [anchor: HTMLElement, name: string, serverCount?: number]
  'tooltip-hide': []
  'invite': [server: Server]
  'edit-folder': [folder: ServerFolderType]
}>()

const router = useRouter()
const { t } = useI18n()
const toast = useToast()
const serverChannelStore = useServerChannelStore()
const notificationStore = useNotificationStore()
// Holds a subscriber: the rail outlives every channel view, and the unread
// feed stops when its last subscriber unmounts.
useUnreadCounts()
const { leaveServer, isOwner } = useLeaveServer()

const scrollEl = ref<HTMLElement | null>(null)
const indicatorEl = ref<HTMLElement | null>(null)

// Reads only ids, folder_id and position: unread, mute, name and icon
// changes never re-render the list.
const layout = computed<RailLayout>(() => buildRailLayout(props.servers, serverChannelStore.folders))

interface RailRow {
  key: string
  id: string
  server?: Server
  folder?: ServerFolderType
  members: Server[]
}

const view = computed<RailRow[]>(() => {
  const servers = new Map(props.servers.map(s => [s.id, s]))
  const folders = new Map(serverChannelStore.folders.map(f => [f.id, f]))
  const rows: RailRow[] = []
  for (const entry of layout.value.root) {
    if (entry.kind === 'folder') {
      const folder = folders.get(entry.id)
      if (!folder) continue
      const members = (layout.value.folders[entry.id] ?? []).map(id => servers.get(id)).filter((s): s is Server => !!s)
      rows.push({ key: `f:${entry.id}`, id: entry.id, folder, members })
    } else {
      const server = servers.get(entry.id)
      if (server) rows.push({ key: `s:${entry.id}`, id: entry.id, server, members: [] })
    }
  }
  return rows
})

// Persistence

async function commit(next: RailLayout | null, created?: string): Promise<string | null> {
  if (!next) return null
  const newFolderId = created ? crypto.randomUUID() : undefined
  const plan = planLayout(props.servers, serverChannelStore.folders, next, newFolderId)
  if (isPlanEmpty(plan)) return null
  const ok = await serverChannelStore.applyRailPlan(plan)
  return ok ? (newFolderId ?? null) : null
}

const onDrop = (source: DragSource, target: DropTarget) => {
  const result = applyDrop(layout.value, source, target)
  if (result) void commit(result.layout, result.createdFolderId)
}

// Menus

type MenuState =
  | { kind: 'server'; id: string; x: number; y: number }
  | { kind: 'folder'; id: string; x: number; y: number }

const menu = shallowRef<MenuState | null>(null)

const menuServer = computed(() =>
  menu.value?.kind === 'server' ? props.servers.find(s => s.id === menu.value!.id) ?? null : null)
const menuFolder = computed(() =>
  menu.value?.kind === 'folder' ? serverChannelStore.folders.find(f => f.id === menu.value!.id) ?? null : null)
const menuServerFolder = computed(() => (menuServer.value ? containerOf(layout.value, menuServer.value.id) : null))

const menuServerIds = computed<string[]>(() => {
  if (!menu.value) return []
  return menu.value.kind === 'server' ? [menu.value.id] : layout.value.folders[menu.value.id] ?? []
})

const menuHasUnread = computed(() => {
  const mentions = notificationStore.notificationCounts?.unreadServerMentions
  return menuServerIds.value.some(id => {
    const totals = serverUnreadTotals.value.get(id)
    return (totals?.messages ?? 0) > 0 || (totals?.mentions ?? 0) > 0 || (mentions?.get(id) ?? 0) > 0
  })
})

const menuSource = (): DragSource | null => (menu.value ? { kind: menu.value.kind, id: menu.value.id } : null)

const canMove = (delta: -1 | 1) => {
  const source = menuSource()
  return !!source && moveByOffset(layout.value, source, delta) !== null
}

const openMenuFor = (el: HTMLElement, at?: { x: number; y: number }) => {
  const source = sourceFromElement(el)
  if (!source) return
  emit('tooltip-hide')
  const r = el.getBoundingClientRect()
  const pos = at ?? { x: r.right + 8, y: r.top }
  menu.value = { kind: source.kind, id: source.id, ...pos }
}

const closeMenu = () => {
  menu.value = null
}

const moveAndRefocus = async (source: DragSource, delta: -1 | 1) => {
  await commit(moveByOffset(layout.value, source, delta))
  await nextTick()
  scrollEl.value
    ?.querySelector<HTMLElement>(`[data-rail-kind="${source.kind}"][data-rail-id="${CSS.escape(source.id)}"]`)
    ?.focus()
}

async function onServerAction(serverId: string, action: ServerMenuAction) {
  const server = props.servers.find(s => s.id === serverId)
  if (!server) return
  switch (action.type) {
    case 'mark-read':
      await markServersRead([serverId])
      break
    case 'invite':
      emit('invite', server)
      break
    case 'mute':
      await serverChannelStore.setServerMuted(serverId, action.until)
      break
    case 'settings':
      router.push(`/server/${serverId}`)
      break
    case 'create-channel':
    case 'create-category':
      serverChannelStore.pendingStructureCreate = {
        serverId,
        kind: action.type === 'create-channel' ? 'channel' : 'category',
      }
      if (serverChannelStore.currentServerId !== serverId) emit('select-server', serverId)
      break
    case 'move':
      await moveAndRefocus({ kind: 'server', id: serverId }, action.delta)
      break
    case 'create-folder': {
      const wrapped = wrapInFolder(layout.value, serverId)
      const folderId = wrapped ? await commit(wrapped.layout, wrapped.createdFolderId) : null
      const folder = folderId ? serverChannelStore.folders.find(f => f.id === folderId) : null
      if (folder) emit('edit-folder', folder)
      break
    }
    case 'move-to-folder':
      await commit(moveToFolder(layout.value, serverId, action.folderId))
      break
    case 'copy-id':
      try {
        await navigator.clipboard.writeText(serverId)
        toast.success(t('serverRail.idCopied'))
      } catch (error) {
        debug.error('Failed to copy server ID:', error)
        toast.error(t('serverRail.idCopyFailed'))
      }
      break
    case 'leave':
      await leaveServer(serverId)
      break
  }
}

async function onFolderAction(folder: ServerFolderType, action: FolderMenuAction) {
  switch (action.type) {
    case 'mark-read':
      await markServersRead(layout.value.folders[folder.id] ?? [])
      break
    case 'settings':
      emit('edit-folder', folder)
      break
    case 'toggle':
      await serverChannelStore.toggleFolderExpanded(folder.id)
      break
    case 'move':
      await moveAndRefocus({ kind: 'folder', id: folder.id }, action.delta)
      break
    case 'ungroup':
      await commit(ungroupFolder(layout.value, folder.id))
      break
  }
}

// Drag

const drag = useRailDrag({
  container: scrollEl,
  indicator: indicatorEl,
  onDrop,
  onLongPress: (_source, el) => openMenuFor(el),
})

const entryOf = (e: Event) => {
  const el = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-rail-kind]')
  return el && scrollEl.value?.contains(el) ? el : null
}

const activate = (el: HTMLElement) => {
  const source = sourceFromElement(el)
  if (!source) return
  if (source.kind === 'server') emit('select-server', source.id)
  else void serverChannelStore.toggleFolderExpanded(source.id)
}

const onPointerDown = (e: PointerEvent) => {
  if (entryOf(e)) emit('tooltip-hide')
  drag.onPointerDown(e)
}

const onClick = (e: MouseEvent) => {
  if (drag.consumeClick()) {
    e.preventDefault()
    e.stopPropagation()
    return
  }
  const el = entryOf(e)
  if (el) activate(el)
}

const onKeydown = (e: KeyboardEvent) => {
  const el = entryOf(e)
  if (!el || e.target !== el) return
  const source = sourceFromElement(el)
  if (!source) return
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault()
    activate(el)
  } else if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    e.preventDefault()
    void moveAndRefocus(source, e.key === 'ArrowUp' ? -1 : 1)
  } else if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
    e.preventDefault()
    openMenuFor(el)
  }
}

const onContextMenu = (e: MouseEvent) => {
  const el = entryOf(e)
  if (!el) return
  e.preventDefault()
  if (drag.isTouchContextMenu()) return
  openMenuFor(el, { x: e.clientX, y: e.clientY })
}

let hovered: HTMLElement | null = null

const onMouseOver = (e: MouseEvent) => {
  if (drag.isDragging()) return
  const el = entryOf(e)
  if (!el || el === hovered) return
  hovered = el
  const source = sourceFromElement(el)
  if (!source) return
  if (source.kind === 'server') {
    const server = props.servers.find(s => s.id === source.id)
    emit('tooltip', el, server?.name ?? '')
    emit('hover-server', source.id)
  } else {
    const folder = serverChannelStore.folders.find(f => f.id === source.id)
    emit('tooltip', el, folder?.name || t('serverRail.folder.unnamed'), layout.value.folders[source.id]?.length ?? 0)
  }
}

const onMouseOut = (e: MouseEvent) => {
  if (!hovered) return
  const to = e.relatedTarget as Node | null
  if (to && hovered.contains(to)) return
  hovered = null
  emit('tooltip-hide')
  emit('leave-server')
}

const onFocusIn = (e: FocusEvent) => {
  const el = entryOf(e)
  const source = el ? sourceFromElement(el) : null
  if (source?.kind === 'server') emit('hover-server', source.id)
}

let releaseClock: (() => void) | null = null

onMounted(() => {
  releaseClock = retainRailClock()
  scrollEl.value?.addEventListener('touchmove', drag.onTouchMove, { passive: false })
})

onBeforeUnmount(() => {
  releaseClock?.()
  scrollEl.value?.removeEventListener('touchmove', drag.onTouchMove)
})
</script>

<style scoped>
.servers-scroll-area {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  overflow-x: hidden;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  scrollbar-width: none;
  -ms-overflow-style: none;
}

.servers-scroll-area::-webkit-scrollbar {
  display: none;
}

/* Trailing space: a drop below the last entry lands at the end. */
.servers-scroll-area::after {
  content: '';
  display: block;
  width: 100%;
  min-height: 120px;
  flex-shrink: 0;
}

.rail-list {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 4px 0;
}

.rail-entry {
  display: flex;
  justify-content: center;
  width: 100%;
}

.rail-move-move {
  transition: transform 0.2s cubic-bezier(0.2, 0, 0, 1);
}

.rail-drop-indicator {
  position: absolute;
  top: 0;
  left: 8px;
  right: 8px;
  pointer-events: none;
  z-index: 5;
}

.rail-drop-indicator[data-mode='none'] {
  display: none;
}

.rail-drop-indicator[data-mode='line'] {
  height: 4px !important;
  margin-top: -2px;
  border-radius: 2px;
  background: var(--harmony-primary);
  box-shadow: 0 0 0 1px var(--background-tertiary);
}

.rail-drop-indicator[data-mode='ring'] {
  left: 10px;
  right: 10px;
  border: 2px solid var(--harmony-primary);
  border-radius: 16px;
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
}

.servers-scroll-area.rail-dragging {
  cursor: grabbing;
}

.servers-scroll-area :deep(.rail-drag-source) {
  opacity: 0.3;
}

.servers-scroll-area :deep(.rail-press-armed) {
  transform: scale(0.94);
  transition: transform 0.12s ease;
}

@media (prefers-reduced-motion: reduce) {
  .rail-move-move {
    transition: none;
  }
}
</style>

<style>
.rail-drag-ghost {
  opacity: 0.9;
  border-radius: 16px;
  filter: drop-shadow(0 6px 12px rgba(0, 0, 0, 0.35));
  cursor: grabbing;
}
</style>
