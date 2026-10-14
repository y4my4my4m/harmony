<!-- Drive navigation: the folder tree, the smart views by where files were sent, trash and the
     usage meter. -->
<template>
  <nav class="drive-sidebar" :aria-label="t('drive.title')" data-testid="drive-sidebar">
    <div class="drive-sidebar__scroll">
      <ul class="drive-tree" role="tree" :aria-label="t('drive.nav.myDrive')">
        <li role="none">
          <div
            class="drive-nav-item"
            :class="{ active: isLoc('folder', null), 'is-drop': dropRoot }"
            role="treeitem"
            :aria-selected="isLoc('folder', null)"
            aria-level="1"
            tabindex="0"
            data-testid="drive-nav-root"
            @click="go({ view: 'folder', id: null })"
            @keydown.enter.prevent="go({ view: 'folder', id: null })"
            @dragover.prevent="onRootDragOver"
            @dragleave="dropRoot = false"
            @drop.prevent="onRootDrop"
          >
            <Icon name="hard-drive" :size="16" class="drive-nav-item__icon" />
            <span class="drive-nav-item__label">{{ t('drive.nav.myDrive') }}</span>
          </div>
          <ul v-if="rootFolders.length" class="drive-tree__children" role="group">
            <DriveFolderNode
              v-for="folder in rootFolders"
              :key="folder.id"
              :folder="folder"
              :folders="drive.folders"
              :active-id="drive.location.view === 'folder' ? drive.location.id : null"
              :depth="1"
              @open="(id) => go({ view: 'folder', id })"
              @menu="(f, e) => emit('folder-menu', f, e)"
              @drop-items="(id, payload) => emit('drop-items', id, payload)"
            />
          </ul>
        </li>
      </ul>

      <ul class="drive-nav">
        <li v-for="item in places" :key="item.view">
          <button
            type="button"
            class="drive-nav-item"
            :class="{ active: isLoc(item.view, null) }"
            :aria-current="isLoc(item.view, null) ? 'page' : undefined"
            :data-testid="`drive-nav-${item.view}`"
            @click="go({ view: item.view, id: null })"
          >
            <Icon :name="item.icon" :size="16" class="drive-nav-item__icon" />
            <span class="drive-nav-item__label">{{ item.label }}</span>
            <span v-if="item.count" class="drive-nav-item__count">{{ item.count }}</span>
          </button>
        </li>
      </ul>

      <section v-if="hasContexts" class="drive-sidebar__section" :aria-labelledby="sentId">
        <h3 :id="sentId" class="drive-sidebar__heading">{{ t('drive.nav.whereSent') }}</h3>
        <ul class="drive-nav">
          <li v-for="server in drive.tree?.servers ?? []" :key="server.id">
            <div class="drive-nav-group">
              <button
                type="button"
                class="drive-nav-item"
                :class="{ active: isLoc('server', server.id) }"
                :aria-current="isLoc('server', server.id) ? 'page' : undefined"
                :aria-expanded="openServers.has(server.id)"
                data-testid="drive-nav-server"
                @click="openServer(server.id)"
              >
                <ServerIcon :src="server.icon" :alt="server.name" size="mini" shape="rounded" :show-title="false" class="drive-nav-item__server" />
                <span class="drive-nav-item__label">{{ server.name }}</span>
                <span class="drive-nav-item__count">{{ server.files }}</span>
              </button>
              <ul v-if="openServers.has(server.id) && server.channels?.length" class="drive-nav drive-nav--nested">
                <li v-for="channel in server.channels" :key="channel.id">
                  <button
                    type="button"
                    class="drive-nav-item"
                    :class="{ active: isLoc('channel', channel.id) }"
                    :aria-current="isLoc('channel', channel.id) ? 'page' : undefined"
                    @click="go({ view: 'channel', id: channel.id })"
                  >
                    <Icon name="hash" :size="14" class="drive-nav-item__icon" />
                    <span class="drive-nav-item__label">{{ channel.name }}</span>
                    <span class="drive-nav-item__count">{{ channel.files }}</span>
                  </button>
                </li>
              </ul>
            </div>
          </li>
          <li v-if="drive.tree?.conversations.length">
            <div class="drive-nav-group">
              <button
                type="button"
                class="drive-nav-item"
                :class="{ active: isLoc('dms', null) }"
                :aria-current="isLoc('dms', null) ? 'page' : undefined"
                :aria-expanded="dmsOpen"
                data-testid="drive-nav-dms"
                @click="dmsOpen = !dmsOpen; go({ view: 'dms', id: null })"
              >
                <Icon name="message-circle" :size="16" class="drive-nav-item__icon" />
                <span class="drive-nav-item__label">{{ t('drive.nav.dms') }}</span>
              </button>
              <ul v-if="dmsOpen" class="drive-nav drive-nav--nested">
                <li v-for="conversation in drive.tree?.conversations ?? []" :key="conversation.id">
                  <button
                    type="button"
                    class="drive-nav-item"
                    :class="{ active: isLoc('conversation', conversation.id) }"
                    :aria-current="isLoc('conversation', conversation.id) ? 'page' : undefined"
                    @click="go({ view: 'conversation', id: conversation.id })"
                  >
                    <Icon :name="conversation.type === 'group' ? 'users' : 'at-sign'" :size="14" class="drive-nav-item__icon" />
                    <span class="drive-nav-item__label">{{ conversation.name || t('drive.nav.conversation') }}</span>
                    <span class="drive-nav-item__count">{{ conversation.files }}</span>
                  </button>
                </li>
              </ul>
            </div>
          </li>
          <li v-if="drive.tree?.fediverse">
            <button
              type="button"
              class="drive-nav-item"
              :class="{ active: isLoc('fediverse', null) }"
              :aria-current="isLoc('fediverse', null) ? 'page' : undefined"
              data-testid="drive-nav-fediverse"
              @click="go({ view: 'fediverse', id: null })"
            >
              <Icon name="globe" :size="16" class="drive-nav-item__icon" />
              <span class="drive-nav-item__label">{{ t('drive.nav.fediverse') }}</span>
              <span class="drive-nav-item__count">{{ drive.tree?.fediverse }}</span>
            </button>
          </li>
        </ul>
      </section>

      <ul class="drive-nav drive-nav--end">
        <li>
          <button
            type="button"
            class="drive-nav-item"
            :class="{ active: isLoc('trash', null) }"
            :aria-current="isLoc('trash', null) ? 'page' : undefined"
            data-testid="drive-nav-trash"
            @click="go({ view: 'trash', id: null })"
          >
            <Icon name="trash-2" :size="16" class="drive-nav-item__icon" />
            <span class="drive-nav-item__label">{{ t('drive.nav.trash') }}</span>
          </button>
        </li>
      </ul>
    </div>
    <footer class="drive-sidebar__footer">
      <DriveUsageMeter />
    </footer>
  </nav>
</template>

<script setup lang="ts">
import { computed, ref, useId } from 'vue'
import Icon from '@/components/common/Icon.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import { useT } from '@/composables/useT'
import { useDriveStore, type DriveLocation } from '@/stores/drive'
import type { DriveFolder, DriveView } from '@/services/drive/driveService'
import DriveFolderNode from './DriveFolderNode.vue'
import DriveUsageMeter from './DriveUsageMeter.vue'
import { DRIVE_DRAG_TYPE, readDriveDrag, type DriveDragPayload } from './driveDrag'

const emit = defineEmits<{
  navigate: [location: DriveLocation]
  'folder-menu': [folder: DriveFolder, event: MouseEvent]
  'drop-items': [folderId: string | null, payload: DriveDragPayload]
}>()

const { t } = useT()
const drive = useDriveStore()
const sentId = useId()
const openServers = ref(new Set<string>())
const dmsOpen = ref(false)
const dropRoot = ref(false)

const rootFolders = computed(() => drive.folders
  .filter((f) => !f.parent_id)
  .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })))

const places = computed<Array<{ view: DriveView; icon: string; label: string; count?: number }>>(() => [
  { view: 'recent', icon: 'clock', label: t('drive.nav.recent') },
  { view: 'ephemeral', icon: 'hourglass', label: t('drive.nav.temporary') },
  { view: 'shared', icon: 'users', label: t('drive.nav.shared'), count: drive.tree?.shared || undefined },
])

const hasContexts = computed(() => !!drive.tree
  && (drive.tree.servers.length > 0 || drive.tree.conversations.length > 0 || drive.tree.fediverse > 0))

function isLoc(view: DriveView, id: string | null): boolean {
  return drive.location.view === view && drive.location.id === id
}

function go(location: DriveLocation): void {
  emit('navigate', location)
}

function openServer(id: string): void {
  const next = new Set(openServers.value)
  if (next.has(id) && isLoc('server', id)) next.delete(id)
  else next.add(id)
  openServers.value = next
  go({ view: 'server', id })
}

function onRootDragOver(event: DragEvent): void {
  if (!event.dataTransfer?.types.includes(DRIVE_DRAG_TYPE)) return
  event.dataTransfer.dropEffect = 'move'
  dropRoot.value = true
}

function onRootDrop(event: DragEvent): void {
  dropRoot.value = false
  const payload = readDriveDrag(event)
  if (payload) emit('drop-items', null, payload)
}
</script>

<style scoped>
.drive-sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--background-secondary);
  border-right: 1px solid var(--border-color);
}

.drive-sidebar__scroll {
  flex: 1;
  min-height: 0;
  padding: var(--space-3) var(--space-2);
  overflow-y: auto;
  overscroll-behavior: contain;
}

.drive-sidebar__footer {
  padding: var(--space-3) var(--space-4) var(--space-4);
  border-top: 1px solid var(--border-color);
}

.drive-sidebar__section {
  margin-top: var(--space-4);
}

.drive-sidebar__heading {
  margin: 0 0 var(--space-1);
  padding: 0 var(--space-2);
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.drive-tree,
.drive-nav,
:deep(.drive-tree__children) {
  margin: 0;
  padding: 0;
  list-style: none;
}

.drive-nav {
  margin-top: var(--space-1);
}

.drive-nav--nested {
  margin: 1px 0 var(--space-1) var(--space-5);
}

.drive-nav--end {
  margin-top: var(--space-4);
}

:deep(.drive-nav-item) {
  --depth: 0;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 32px;
  padding: 0 var(--space-2) 0 calc(var(--space-2) + var(--depth) * 14px);
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  text-align: left;
  cursor: pointer;
  user-select: none;
  transition: background-color 0.12s ease, color 0.12s ease;
}

:deep(.drive-nav-item:hover) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

:deep(.drive-nav-item.active) {
  background: var(--background-modifier-selected, var(--background-modifier-active));
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

:deep(.drive-nav-item.is-drop) {
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  box-shadow: inset 0 0 0 1px var(--harmony-primary);
  color: var(--text-primary);
}

:deep(.drive-nav-item:focus-visible) {
  outline: 2px solid var(--border-focus);
  outline-offset: -2px;
}

:deep(.drive-nav-item__icon) {
  flex-shrink: 0;
  opacity: 0.85;
}

:deep(.drive-nav-item__server) {
  flex-shrink: 0;
  width: 18px;
  height: 18px;
}

:deep(.drive-nav-item__label) {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

:deep(.drive-nav-item__count) {
  flex-shrink: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
}

:deep(.drive-node__twisty) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 16px;
  height: 16px;
  margin-right: -4px;
  padding: 0;
  background: none;
  border: none;
  border-radius: 3px;
  color: var(--text-muted);
  cursor: pointer;
}

:deep(.drive-node__twisty svg) {
  transition: transform 0.15s ease;
}

:deep(.drive-node__twisty .is-open),
:deep(.drive-node__twisty .is-open svg) {
  transform: rotate(90deg);
}
</style>
