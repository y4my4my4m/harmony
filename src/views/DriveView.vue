<template>
  <div
    class="drive-view"
    :class="{ 'has-details': !!detailEntry, 'nav-open': navOpen }"
    data-testid="drive-view"
    @dragenter="onPageDragEnter"
    @dragover="onPageDragOver"
    @dragleave="onPageDragLeave"
    @drop="onPageDrop"
  >
    <DriveSidebar
      class="drive-view__nav"
      @navigate="navigate"
      @folder-menu="openFolderMenu"
      @drop-items="dropItems"
    />
    <div v-if="navOpen" class="drive-view__scrim" aria-hidden="true" @click="navOpen = false" />

    <section class="drive-view__main" :aria-labelledby="titleId">
      <header class="drive-toolbar">
        <div class="drive-toolbar__top">
          <button type="button" class="drive-icon-btn drive-view__nav-toggle" :aria-label="t('drive.nav.open')" :aria-expanded="navOpen" @click="navOpen = !navOpen">
            <Icon name="menu" :size="18" />
          </button>
          <nav v-if="drive.location.view === 'folder' && !drive.query.trim()" class="drive-crumbs" :aria-label="t('drive.nav.path')">
            <button type="button" class="drive-crumbs__item" :class="{ current: drive.breadcrumbs.length === 0 }" @click="navigate({ view: 'folder', id: null })">
              <h1 v-if="drive.breadcrumbs.length === 0" :id="titleId" class="drive-crumbs__title">{{ t('drive.nav.myDrive') }}</h1>
              <span v-else>{{ t('drive.nav.myDrive') }}</span>
            </button>
            <template v-for="(crumb, i) in drive.breadcrumbs" :key="crumb.id">
              <Icon name="chevron-right" :size="14" class="drive-crumbs__sep" aria-hidden="true" />
              <button type="button" class="drive-crumbs__item" :class="{ current: i === drive.breadcrumbs.length - 1 }" @click="navigate({ view: 'folder', id: crumb.id })">
                <h1 v-if="i === drive.breadcrumbs.length - 1" :id="titleId" class="drive-crumbs__title">{{ crumb.name }}</h1>
                <span v-else>{{ crumb.name }}</span>
              </button>
            </template>
          </nav>
          <h1 v-else :id="titleId" class="drive-crumbs__title drive-toolbar__title">{{ viewTitle }}</h1>

          <div class="drive-toolbar__actions">
            <button v-if="drive.location.view === 'folder'" type="button" class="drive-btn drive-btn--secondary" data-testid="drive-new-folder" @click="newFolderOpen = true">
              <Icon name="folder-plus" :size="16" /><span class="drive-hide-narrow">{{ t('drive.actions.newFolder') }}</span>
            </button>
            <button v-if="canUpload" type="button" class="drive-btn drive-btn--primary" data-testid="drive-upload" @click="fileInput?.click()">
              <Icon name="cloud-upload" :size="16" /><span class="drive-hide-narrow">{{ t('drive.actions.upload') }}</span>
            </button>
            <button v-if="drive.location.view === 'trash' && drive.entries.length" type="button" class="drive-btn drive-btn--danger" data-testid="drive-empty-trash" @click="confirmEmptyTrash = true">
              {{ t('drive.actions.emptyTrash') }}
            </button>
            <input ref="fileInput" type="file" multiple class="drive-hidden-input" tabindex="-1" aria-hidden="true" data-testid="drive-file-input" @change="onPickFiles" />
          </div>
        </div>

        <div class="drive-toolbar__filters">
          <div class="drive-search">
            <Icon name="search" :size="15" class="drive-search__icon" aria-hidden="true" />
            <input
              v-model="searchDraft"
              type="search"
              class="drive-input drive-search__input"
              :placeholder="t('drive.search.placeholder')"
              :aria-label="t('drive.search.placeholder')"
              data-testid="drive-search"
            />
          </div>
          <div class="drive-chips" role="radiogroup" :aria-label="t('drive.filter.label')">
            <button
              v-for="option in kindOptions"
              :key="option.value ?? 'all'"
              type="button"
              class="drive-chip"
              role="radio"
              :aria-checked="drive.kind === option.value"
              :class="{ active: drive.kind === option.value }"
              @click="setKind(option.value)"
            >{{ option.label }}</button>
          </div>
          <div class="drive-toolbar__view">
            <select class="drive-select" :value="drive.sort" :aria-label="t('drive.sort.label')" @change="setSort(($event.target as HTMLSelectElement).value as DriveSort)">
              <option value="newest">{{ t('drive.sort.newest') }}</option>
              <option value="oldest">{{ t('drive.sort.oldest') }}</option>
              <option value="name">{{ t('drive.sort.name') }}</option>
              <option value="size">{{ t('drive.sort.size') }}</option>
            </select>
            <div class="drive-segmented" role="group" :aria-label="t('drive.layout.label')">
              <button type="button" class="drive-icon-btn" :aria-pressed="drive.layout === 'grid'" :aria-label="t('drive.layout.grid')" data-testid="drive-layout-grid" @click="drive.setLayout('grid')">
                <Icon name="grid" :size="16" />
              </button>
              <button type="button" class="drive-icon-btn" :aria-pressed="drive.layout === 'list'" :aria-label="t('drive.layout.list')" data-testid="drive-layout-list" @click="drive.setLayout('list')">
                <Icon name="list" :size="16" />
              </button>
            </div>
          </div>
        </div>

        <Transition name="drive-selection">
          <div v-if="drive.selected.size > 1" class="drive-selection" role="toolbar" :aria-label="t('drive.selection.label')" data-testid="drive-selection">
            <span class="drive-selection__count">{{ t('drive.selection.count', { count: drive.selected.size }, drive.selected.size) }}</span>
            <button v-if="ownSelection && drive.location.view !== 'trash'" type="button" class="drive-btn drive-btn--ghost" @click="moveTarget = { files: [...drive.selected], folder: null }">
              <Icon name="folder-input" :size="15" />{{ t('drive.actions.move') }}
            </button>
            <button v-if="ownSelection && drive.location.view === 'trash'" type="button" class="drive-btn drive-btn--ghost" @click="restore([...drive.selected])">
              <Icon name="undo" :size="15" />{{ t('drive.actions.restore') }}
            </button>
            <button v-if="ownSelection" type="button" class="drive-btn drive-btn--ghost drive-selection__danger" @click="removeSelected">
              <Icon name="trash-2" :size="15" />{{ drive.location.view === 'trash' ? t('drive.actions.deleteForever') : t('drive.actions.trash') }}
            </button>
            <button type="button" class="drive-icon-btn" :aria-label="t('drive.selection.clear')" @click="drive.clearSelection()">
              <Icon name="x" :size="16" />
            </button>
          </div>
        </Transition>
      </header>

      <div ref="scroller" class="drive-content" @click.self="drive.clearSelection()">
        <p v-if="drive.location.view === 'ephemeral' && usage" class="drive-banner" data-testid="drive-temporary-banner">
          <Icon name="hourglass" :size="16" />
          {{ t('drive.banner.temporary', { count: usage.ephemeral_days }, usage.ephemeral_days) }}
        </p>
        <p v-else-if="drive.location.view === 'trash'" class="drive-banner">
          <Icon name="trash-2" :size="16" />{{ t('drive.banner.trash') }}
        </p>

        <div v-if="drive.loading && !drive.entries.length" class="drive-skeleton" :class="`drive-skeleton--${drive.layout}`" aria-hidden="true">
          <span v-for="n in 12" :key="n" class="drive-skeleton__item" />
        </div>
        <EmptyState
          v-else-if="drive.error"
          icon="alert-triangle"
          :title="t('drive.errors.load')"
          :description="drive.error"
        />
        <div v-else-if="!drive.entries.length && !drive.childFolders.length" class="drive-empty" data-testid="drive-empty">
          <span class="drive-empty__glyph"><Icon :name="emptyIcon" :size="30" /></span>
          <h2>{{ emptyTitle }}</h2>
          <p>{{ emptyText }}</p>
          <button v-if="canUpload" type="button" class="drive-btn drive-btn--primary" @click="fileInput?.click()">
            <Icon name="cloud-upload" :size="16" />{{ t('drive.actions.upload') }}
          </button>
        </div>
        <DriveItems
          v-else
          ref="itemsRef"
          :folders="drive.childFolders"
          :entries="drive.entries"
          :layout="drive.layout"
          :selected="drive.selected"
          :view="drive.location.view"
          :label="viewTitle"
          :own-id="ownId"
          @open-folder="(id) => navigate({ view: 'folder', id })"
          @open-file="openPreview"
          @select="(id, mode) => drive.select(id, mode)"
          @select-all="drive.selectAll()"
          @file-menu="openFileMenu"
          @folder-menu="openFolderMenu"
          @drop-items="dropItems"
          @delete="removeSelected"
          @rename="(entry) => renameFromList(entry)"
        />
      </div>

      <DriveUploads />
      <div v-if="pageDrop" class="drive-dropzone" aria-hidden="true">
        <div class="drive-dropzone__card">
          <Icon name="cloud-upload" :size="34" />
          <span>{{ t('drive.drop.title', { place: dropPlace }) }}</span>
        </div>
      </div>
    </section>

    <DriveDetails
      v-if="detailEntry"
      ref="detailsRef"
      class="drive-view__details"
      :file="detailEntry.file"
      :owner="detailEntry.owner"
      :own-id="ownId"
      @close="drive.clearSelection()"
      @rename="(file, name) => rename(file.id, name)"
      @keep="(file) => keep([file.id])"
      @share="(file) => (shareFile = file)"
      @download="download"
      @move="(file) => (moveTarget = { files: [file.id], folder: null })"
      @restore="(file) => restore([file.id])"
      @delete="(file) => file.state === 'trashed' ? (deleteForever = [file.id]) : trash([file.id])"
    />

    <ChatMenu v-if="fileMenu" :x="fileMenu.x" :y="fileMenu.y" :label="t('drive.menu.file')" data-testid="drive-file-menu" @close="fileMenu = null">
      <button type="button" role="menuitem" class="chat-menu-item" @click="fileMenu && openPreview(fileMenu.entry); fileMenu = null">
        <Icon name="eye" :size="15" />{{ t('drive.actions.open') }}
      </button>
      <button type="button" role="menuitem" class="chat-menu-item" @click="fileMenu && download(fileMenu.entry.file); fileMenu = null">
        <Icon name="download" :size="15" />{{ t('drive.actions.download') }}
      </button>
      <button type="button" role="menuitem" class="chat-menu-item" data-testid="drive-menu-copy-link" @click="fileMenu && copyLink(fileMenu.entry.file.link_token); fileMenu = null">
        <Icon name="link" :size="15" />{{ t('drive.actions.copyLink') }}
      </button>
      <template v-if="fileMenu && fileMenu.entry.file.owner_id === ownId">
        <template v-if="fileMenu.entry.file.state !== 'trashed'">
          <button type="button" role="menuitem" class="chat-menu-item" @click="renameFromMenu">
            <Icon name="pencil" :size="15" />{{ t('drive.actions.rename') }}
          </button>
          <button v-if="fileMenu.entry.file.bucket === 'message_media'" type="button" role="menuitem" class="chat-menu-item" @click="shareFile = fileMenu!.entry.file; fileMenu = null">
            <Icon name="share" :size="15" />{{ t('drive.actions.share') }}
          </button>
          <button type="button" role="menuitem" class="chat-menu-item" @click="moveTarget = { files: [...drive.selected], folder: null }; fileMenu = null">
            <Icon name="folder-input" :size="15" />{{ t('drive.actions.move') }}
          </button>
          <button v-if="fileMenu.entry.file.state === 'ephemeral'" type="button" role="menuitem" class="chat-menu-item" @click="keep([...drive.selected]); fileMenu = null">
            <Icon name="hard-drive" :size="15" />{{ t('drive.actions.keep') }}
          </button>
          <div class="chat-menu-divider" role="separator" />
          <button type="button" role="menuitem" class="chat-menu-item danger" @click="trash([...drive.selected]); fileMenu = null">
            <Icon name="trash-2" :size="15" />{{ t('drive.actions.trash') }}
          </button>
        </template>
        <template v-else>
          <button type="button" role="menuitem" class="chat-menu-item" @click="restore([...drive.selected]); fileMenu = null">
            <Icon name="undo" :size="15" />{{ t('drive.actions.restore') }}
          </button>
          <div class="chat-menu-divider" role="separator" />
          <button type="button" role="menuitem" class="chat-menu-item danger" @click="deleteForever = [...drive.selected]; fileMenu = null">
            <Icon name="trash-2" :size="15" />{{ t('drive.actions.deleteForever') }}
          </button>
        </template>
      </template>
    </ChatMenu>

    <ChatMenu v-if="folderMenu" :x="folderMenu.x" :y="folderMenu.y" :label="folderMenu.folder.name" data-testid="drive-folder-menu" @close="folderMenu = null">
      <button type="button" role="menuitem" class="chat-menu-item" @click="navigate({ view: 'folder', id: folderMenu!.folder.id }); folderMenu = null">
        <Icon name="folder-open" :size="15" />{{ t('drive.actions.open') }}
      </button>
      <button type="button" role="menuitem" class="chat-menu-item" @click="renameFolderTarget = folderMenu!.folder; folderMenu = null">
        <Icon name="pencil" :size="15" />{{ t('drive.actions.rename') }}
      </button>
      <button type="button" role="menuitem" class="chat-menu-item" @click="moveTarget = { files: [], folder: folderMenu!.folder.id }; folderMenu = null">
        <Icon name="folder-input" :size="15" />{{ t('drive.actions.move') }}
      </button>
      <div class="chat-menu-divider" role="separator" />
      <button type="button" role="menuitem" class="chat-menu-item danger" data-testid="drive-folder-delete" @click="deleteFolderTarget = folderMenu!.folder; folderMenu = null">
        <Icon name="trash-2" :size="15" />{{ t('drive.actions.deleteFolder') }}
      </button>
    </ChatMenu>

    <DriveNameDialog
      v-if="newFolderOpen"
      :title="t('drive.folder.newTitle')"
      :label="t('drive.folder.name')"
      :confirm="t('drive.folder.create')"
      @close="newFolderOpen = false"
      @save="createFolder"
    />
    <DriveNameDialog
      v-if="renameFolderTarget"
      :title="t('drive.folder.renameTitle')"
      :label="t('drive.folder.name')"
      :confirm="t('drive.actions.rename')"
      :initial="renameFolderTarget.name"
      @close="renameFolderTarget = null"
      @save="(name) => renameFolder(renameFolderTarget!.id, name)"
    />
    <DriveNameDialog
      v-if="renameFileTarget"
      :title="t('drive.file.renameTitle')"
      :label="t('drive.details.name')"
      :confirm="t('drive.actions.rename')"
      :initial="renameFileTarget.name ?? ''"
      select-stem
      @close="renameFileTarget = null"
      @save="(name) => { rename(renameFileTarget!.id, name); renameFileTarget = null }"
    />
    <ConfirmDialog
      v-if="deleteFolderTarget"
      :title="t('drive.folder.deleteTitle', { name: deleteFolderTarget.name })"
      :message="t('drive.folder.deleteText')"
      :confirm-label="t('drive.actions.deleteFolder')"
      danger
      @cancel="deleteFolderTarget = null"
      @confirm="deleteFolder(deleteFolderTarget!.id)"
    />
    <ConfirmDialog
      v-if="deleteForever"
      :title="t('drive.delete.title', { count: deleteForever.length }, deleteForever.length)"
      :message="t('drive.delete.text')"
      :confirm-label="t('drive.actions.deleteForever')"
      danger
      @cancel="deleteForever = null"
      @confirm="permanentlyDelete(deleteForever!)"
    />
    <ConfirmDialog
      v-if="confirmEmptyTrash"
      :title="t('drive.trash.emptyTitle')"
      :message="t('drive.delete.text')"
      :confirm-label="t('drive.actions.emptyTrash')"
      danger
      @cancel="confirmEmptyTrash = false"
      @confirm="emptyTrash"
    />
    <DriveMoveDialog
      v-if="moveTarget"
      :folders="drive.folders"
      :count="moveTarget.folder ? 1 : moveTarget.files.length"
      :moving-folder="moveTarget.folder"
      @close="moveTarget = null"
      @move="applyMove"
    />
    <DriveShareDialog
      v-if="shareFile"
      :file="shareFile"
      :name="displayName(shareFile)"
      :link-sharing="usage?.link_sharing !== false"
      @close="shareFile = null"
      @changed="detailsRef?.reloadUsage()"
      @token="(token) => shareFile && drive.setLinkToken(shareFile.id, token)"
    />
    <DrivePreview
      v-if="previewId"
      :files="drive.files.filter((f) => f.state !== 'gone')"
      :start-id="previewId"
      @close="previewId = null"
      @download="download"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import ChatMenu from '@/components/chat/ChatMenu.vue'
import ConfirmDialog from '@/components/drive/DriveConfirmDialog.vue'
import DriveSidebar from '@/components/drive/DriveSidebar.vue'
import DriveItems from '@/components/drive/DriveItems.vue'
import DriveDetails from '@/components/drive/DriveDetails.vue'
import DriveUploads from '@/components/drive/DriveUploads.vue'
import DriveMoveDialog from '@/components/drive/DriveMoveDialog.vue'
import DriveShareDialog from '@/components/drive/DriveShareDialog.vue'
import DrivePreview from '@/components/drive/DrivePreview.vue'
import DriveNameDialog from '@/components/drive/DriveNameDialog.vue'
import '@/components/drive/drive.css'
import { useT } from '@/composables/useT'
import { useDriveUsage } from '@/composables/useDriveUsage'
import { useCopyDriveLink } from '@/composables/useCopyDriveLink'
import { useDriveStore, type DriveLocation } from '@/stores/drive'
import { useProfileStore } from '@/stores/useProfile'
import {
  driveDownloadUrl,
  driveFileDisplayName,
  type DriveFile,
  type DriveFileKind,
  type DriveFolder,
  type DriveListEntry,
  type DriveSort,
  type DriveView,
} from '@/services/drive/driveService'
import type { DriveDragPayload } from '@/components/drive/driveDrag'

const { t } = useT()
const route = useRoute()
const router = useRouter()
const toast = useToast()
const drive = useDriveStore()
const profileStore = useProfileStore()
const { usage } = useDriveUsage()
const copyLink = useCopyDriveLink()
const titleId = useId()

const fileInput = ref<HTMLInputElement | null>(null)
const itemsRef = ref<InstanceType<typeof DriveItems> | null>(null)
const detailsRef = ref<InstanceType<typeof DriveDetails> | null>(null)
const navOpen = ref(false)
const searchDraft = ref(drive.query)
const fileMenu = ref<{ x: number; y: number; entry: DriveListEntry } | null>(null)
const folderMenu = ref<{ x: number; y: number; folder: DriveFolder } | null>(null)
const newFolderOpen = ref(false)
const renameFolderTarget = ref<DriveFolder | null>(null)
const renameFileTarget = ref<DriveFile | null>(null)
const deleteFolderTarget = ref<DriveFolder | null>(null)
const deleteForever = ref<string[] | null>(null)
const confirmEmptyTrash = ref(false)
const moveTarget = ref<{ files: string[]; folder: string | null } | null>(null)
const shareFile = ref<DriveFile | null>(null)
const previewId = ref<string | null>(null)
const pageDrop = ref(false)
let dragDepth = 0
let searchTimer: ReturnType<typeof setTimeout> | null = null

const ownId = computed(() => profileStore.profile?.id ?? null)

const SECTION_VIEWS: Record<string, DriveView> = {
  folder: 'folder', recent: 'recent', temporary: 'ephemeral', shared: 'shared', trash: 'trash',
  dms: 'dms', fediverse: 'fediverse', server: 'server', channel: 'channel', conversation: 'conversation', all: 'all',
}
const VIEW_SECTIONS = Object.fromEntries(Object.entries(SECTION_VIEWS).map(([k, v]) => [v, k])) as Record<DriveView, string>

function locationFromRoute(): DriveLocation {
  const section = typeof route.params.section === 'string' ? route.params.section : 'folder'
  const id = typeof route.params.id === 'string' && route.params.id ? route.params.id : null
  return { view: SECTION_VIEWS[section] ?? 'folder', id }
}

function navigate(location: DriveLocation): void {
  navOpen.value = false
  const section = VIEW_SECTIONS[location.view]
  const params: Record<string, string> = {}
  if (!(location.view === 'folder' && !location.id)) params.section = section
  if (location.id) params.id = location.id
  void router.push({ name: 'Drive', params })
}

watch(() => [route.params.section, route.params.id], () => {
  if (route.name !== 'Drive') return
  const next = locationFromRoute()
  if (next.view !== drive.location.view || next.id !== drive.location.id) drive.open(next)
})

watch(searchDraft, (value) => {
  if (searchTimer) clearTimeout(searchTimer)
  searchTimer = setTimeout(() => {
    drive.query = value
    void drive.loadFiles()
  }, 220)
})

const detailEntry = computed(() => (drive.selected.size === 1
  ? drive.entries.find((e) => drive.selected.has(e.file.id)) ?? null
  : null))

const ownSelection = computed(() => drive.selectedFiles.every((f) => f.owner_id === ownId.value))
const canUpload = computed(() => drive.location.view === 'folder' || drive.location.view === 'recent' || drive.location.view === 'all')

const kindOptions = computed<Array<{ value: DriveFileKind | null; label: string }>>(() => [
  { value: null, label: t('drive.filter.all') },
  { value: 'image', label: t('drive.filter.images') },
  { value: 'video', label: t('drive.filter.videos') },
  { value: 'audio', label: t('drive.filter.audio') },
  { value: 'document', label: t('drive.filter.documents') },
])

const viewTitle = computed(() => {
  const loc = drive.location
  if (drive.query.trim()) return t('drive.search.results', { query: drive.query.trim() })
  switch (loc.view) {
    case 'folder': return drive.breadcrumbs.at(-1)?.name ?? t('drive.nav.myDrive')
    case 'recent': return t('drive.nav.recent')
    case 'ephemeral': return t('drive.nav.temporary')
    case 'shared': return t('drive.nav.shared')
    case 'trash': return t('drive.nav.trash')
    case 'dms': return t('drive.nav.dms')
    case 'fediverse': return t('drive.nav.fediverse')
    case 'server': return drive.tree?.servers.find((s) => s.id === loc.id)?.name ?? t('drive.nav.server')
    case 'channel': {
      for (const s of drive.tree?.servers ?? []) {
        const c = s.channels?.find((ch) => ch.id === loc.id)
        if (c) return `${s.name} › #${c.name}`
      }
      return t('drive.nav.channel')
    }
    case 'conversation': return drive.tree?.conversations.find((c) => c.id === loc.id)?.name ?? t('drive.nav.conversation')
    default: return t('drive.title')
  }
})

const emptyIcon = computed(() => ({ trash: 'trash-2', ephemeral: 'hourglass', shared: 'users' } as Record<string, string>)[drive.location.view] ?? 'folder-open')
const emptyTitle = computed(() => {
  if (drive.query.trim()) return t('drive.empty.searchTitle')
  return t(`drive.empty.${drive.location.view === 'ephemeral' ? 'temporary' : ['trash', 'shared', 'folder'].includes(drive.location.view) ? drive.location.view : 'other'}Title`)
})
const emptyText = computed(() => {
  if (drive.query.trim()) return t('drive.empty.searchText')
  return t(`drive.empty.${drive.location.view === 'ephemeral' ? 'temporary' : ['trash', 'shared', 'folder'].includes(drive.location.view) ? drive.location.view : 'other'}Text`)
})

const dropPlace = computed(() => (drive.location.view === 'folder' ? drive.breadcrumbs.at(-1)?.name ?? t('drive.nav.myDrive') : t('drive.nav.myDrive')))

function displayName(file: DriveFile): string {
  return driveFileDisplayName(file, t('drive.file.unnamed'))
}

function setKind(kind: DriveFileKind | null): void {
  drive.kind = kind
  void drive.loadFiles()
}

function setSort(sort: DriveSort): void {
  drive.sort = sort
  void drive.loadFiles()
}

function fail(error: unknown): void {
  toast.error(error instanceof Error ? error.message : String(error))
}

async function attempt<T>(work: () => Promise<T>): Promise<T | undefined> {
  try {
    return await work()
  } catch (error) {
    fail(error)
    return undefined
  }
}

const uploadFolder = () => (drive.location.view === 'folder' ? drive.location.id : null)

function onPickFiles(event: Event): void {
  const input = event.target as HTMLInputElement
  const list = Array.from(input.files ?? [])
  input.value = ''
  if (list.length) drive.uploadFiles(list, uploadFolder())
}

function openPreview(entry: DriveListEntry): void {
  if (entry.file.state === 'gone') return
  previewId.value = entry.file.id
}

function openFileMenu(entry: DriveListEntry, event: MouseEvent): void {
  folderMenu.value = null
  fileMenu.value = { x: event.clientX, y: event.clientY, entry }
}

function openFolderMenu(folder: DriveFolder, event: MouseEvent): void {
  fileMenu.value = null
  folderMenu.value = { x: event.clientX, y: event.clientY, folder }
}

function renameFromMenu(): void {
  if (!fileMenu.value) return
  renameFileTarget.value = fileMenu.value.entry.file
  fileMenu.value = null
}

function renameFromList(entry: DriveListEntry): void {
  if (entry.file.owner_id === ownId.value && entry.file.state !== 'gone') renameFileTarget.value = entry.file
}

async function createFolder(name: string): Promise<void> {
  const folder = await attempt(() => drive.createFolder(name, drive.location.view === 'folder' ? drive.location.id : null))
  if (folder) newFolderOpen.value = false
}

async function renameFolder(id: string, name: string): Promise<void> {
  if (await attempt(() => drive.renameFolder(id, name))) renameFolderTarget.value = null
}

async function deleteFolder(id: string): Promise<void> {
  deleteFolderTarget.value = null
  const trashed = await attempt(() => drive.deleteFolder(id))
  if (drive.location.view === 'folder' && drive.location.id === id) navigate({ view: 'folder', id: null })
  if (trashed !== undefined) toast.info(t('drive.toast.folderDeleted', { count: trashed }, trashed))
}

const rename = (id: string, name: string) => attempt(() => drive.renameFile(id, name))
const keep = async (ids: string[]) => {
  const kept = await attempt(() => drive.keepFiles(ids))
  if (kept === undefined) return
  if (kept < ids.length) toast.warning(t('drive.toast.keepPartial', { kept, total: ids.length }))
  else toast.success(t('drive.toast.kept', { count: kept }, kept))
}

async function trash(ids: string[]): Promise<void> {
  const count = await attempt(() => drive.trashFiles(ids))
  if (!count) return
  drive.clearSelection()
  toast.info(t('drive.toast.trashed', { count }, count))
}

async function restore(ids: string[]): Promise<void> {
  const count = await attempt(() => drive.restoreFiles(ids))
  if (count) toast.success(t('drive.toast.restored', { count }, count))
}

async function permanentlyDelete(ids: string[]): Promise<void> {
  deleteForever.value = null
  const count = await attempt(() => drive.deleteFiles(ids))
  if (count) toast.info(t('drive.toast.deleted', { count }, count))
}

async function emptyTrash(): Promise<void> {
  confirmEmptyTrash.value = false
  await attempt(() => drive.emptyTrash())
}

function removeSelected(): void {
  const ids = drive.selectedFiles.filter((f) => f.owner_id === ownId.value).map((f) => f.id)
  if (!ids.length) return
  if (drive.location.view === 'trash') deleteForever.value = ids
  else void trash(ids)
}

async function applyMove(folderId: string | null): Promise<void> {
  const target = moveTarget.value
  moveTarget.value = null
  if (!target) return
  if (target.folder) await attempt(() => drive.moveFolder(target.folder!, folderId))
  else if (target.files.length) {
    const moved = await attempt(() => drive.moveFiles(target.files, folderId))
    if (moved) toast.success(t('drive.toast.moved', { count: moved }, moved))
  }
}

async function dropItems(folderId: string | null, payload: DriveDragPayload): Promise<void> {
  if (payload.files.length) {
    const moved = await attempt(() => drive.moveFiles(payload.files, folderId))
    if (moved) toast.success(t('drive.toast.moved', { count: moved }, moved))
  }
  for (const id of payload.folders) {
    if (id !== folderId) await attempt(() => drive.moveFolder(id, folderId))
  }
}

async function download(file: DriveFile): Promise<void> {
  const url = await attempt(() => driveDownloadUrl(file))
  if (!url) return
  const a = document.createElement('a')
  a.href = url
  a.rel = 'noopener'
  a.download = file.name || ''
  document.body.appendChild(a)
  a.click()
  a.remove()
}

function hasFiles(event: DragEvent): boolean {
  return !!event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files')
}

function onPageDragEnter(event: DragEvent): void {
  if (!hasFiles(event) || !canUpload.value) return
  dragDepth++
  pageDrop.value = true
}

function onPageDragOver(event: DragEvent): void {
  if (!hasFiles(event) || !canUpload.value) return
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onPageDragLeave(event: DragEvent): void {
  if (!hasFiles(event)) return
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) pageDrop.value = false
}

function onPageDrop(event: DragEvent): void {
  if (!hasFiles(event) || !canUpload.value) return
  event.preventDefault()
  dragDepth = 0
  pageDrop.value = false
  const list = Array.from(event.dataTransfer?.files ?? [])
  if (list.length) drive.uploadFiles(list, uploadFolder())
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && drive.selected.size && !(event.target as HTMLElement).closest('input, [role="dialog"], .app-menu')) {
    drive.clearSelection()
  }
}

onMounted(() => {
  drive.location = locationFromRoute()
  void drive.refreshAll()
  document.addEventListener('keydown', onKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', onKeydown)
  if (searchTimer) clearTimeout(searchTimer)
})
</script>

<style scoped>
.drive-view {
  --drive-nav-width: 264px;
  --drive-details-width: 320px;
  position: relative;
  display: grid;
  grid-template-columns: var(--drive-nav-width) minmax(0, 1fr);
  height: 100%;
  min-height: 0;
  background: var(--background-primary);
}

.drive-view.has-details {
  grid-template-columns: var(--drive-nav-width) minmax(0, 1fr) var(--drive-details-width);
}

.drive-view__main {
  position: relative;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}

.drive-view__nav-toggle,
.drive-view__scrim {
  display: none;
}

.drive-toolbar {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-5) var(--space-3);
  border-bottom: 1px solid var(--border-color);
}

.drive-toolbar__top {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  min-height: 36px;
}

.drive-toolbar__title {
  flex: 1;
  min-width: 0;
}

.drive-toolbar__actions {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}

.drive-hidden-input {
  display: none;
}

.drive-crumbs {
  display: flex;
  flex: 1;
  align-items: center;
  gap: 2px;
  min-width: 0;
  overflow: hidden;
}

.drive-crumbs__item {
  min-width: 0;
  max-width: 220px;
  padding: 4px 8px;
  overflow: hidden;
  background: none;
  border: none;
  border-radius: var(--radius-sm);
  font: inherit;
  font-size: var(--font-size-md, 15px);
  color: var(--text-secondary);
  text-overflow: ellipsis;
  white-space: nowrap;
  cursor: pointer;
}

.drive-crumbs__item:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.drive-crumbs__item.current {
  color: var(--text-primary);
}

.drive-crumbs__sep {
  flex-shrink: 0;
  color: var(--text-muted);
}

.drive-crumbs__title {
  margin: 0;
  overflow: hidden;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.drive-toolbar__filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
}

.drive-search {
  position: relative;
  flex: 1 1 220px;
  max-width: 360px;
}

.drive-search__icon {
  position: absolute;
  top: 50%;
  left: 10px;
  color: var(--text-muted);
  transform: translateY(-50%);
  pointer-events: none;
}

.drive-search__input {
  padding-left: 32px;
}

.drive-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.drive-chip {
  min-height: 28px;
  padding: 0 12px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-full);
  font: inherit;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease, border-color 0.12s ease;
}

.drive-chip:hover {
  color: var(--text-primary);
}

.drive-chip.active {
  background: color-mix(in srgb, var(--harmony-primary) 18%, transparent);
  border-color: color-mix(in srgb, var(--harmony-primary) 60%, transparent);
  color: var(--text-primary);
}

.drive-toolbar__view {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: auto;
}

.drive-segmented {
  display: flex;
  padding: 2px;
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
}

.drive-segmented .drive-icon-btn {
  width: 30px;
  height: 28px;
}

.drive-selection {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: 4px 4px 4px var(--space-3);
  background: color-mix(in srgb, var(--harmony-primary) 12%, var(--background-secondary));
  border: 1px solid color-mix(in srgb, var(--harmony-primary) 40%, transparent);
  border-radius: var(--radius-md);
}

.drive-selection__count {
  margin-right: auto;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.drive-selection__danger {
  color: var(--danger);
}

.drive-selection-enter-active,
.drive-selection-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.drive-selection-enter-from,
.drive-selection-leave-to {
  opacity: 0;
  transform: translateY(-4px);
}

.drive-content {
  flex: 1;
  min-height: 0;
  padding: var(--space-4) var(--space-5) var(--space-8, 48px);
  overflow-y: auto;
}

.drive-banner {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  padding: var(--space-3) var(--space-4);
  background: var(--background-secondary);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  max-width: 360px;
  margin: calc(12 * var(--app-vh)) auto 0;
  text-align: center;
}

.drive-empty__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 64px;
  height: 64px;
  margin-bottom: var(--space-2);
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  border-radius: 20px;
  color: var(--harmony-primary);
}

.drive-empty h2 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--text-primary);
}

.drive-empty p {
  margin: 0 0 var(--space-3);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.drive-skeleton--grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(168px, 1fr));
  gap: var(--space-3);
}

.drive-skeleton--list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.drive-skeleton__item {
  display: block;
  background: linear-gradient(90deg, var(--background-secondary) 0%, var(--background-modifier-hover) 50%, var(--background-secondary) 100%);
  background-size: 200% 100%;
  border-radius: var(--radius-md);
  animation: drive-shimmer 1.2s ease-in-out infinite;
}

.drive-skeleton--grid .drive-skeleton__item {
  aspect-ratio: 1 / 1;
}

.drive-skeleton--list .drive-skeleton__item {
  height: 40px;
}

.drive-dropzone {
  position: absolute;
  inset: 8px;
  z-index: 6;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--harmony-primary) 10%, rgb(0 0 0 / 0.35));
  border: 2px dashed var(--harmony-primary);
  border-radius: var(--radius-lg);
  pointer-events: none;
  animation: drive-drop-in 0.12s ease-out;
}

.drive-dropzone__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-5) var(--space-6);
  background: var(--background-floating, var(--background-secondary));
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-high, 0 12px 32px rgb(0 0 0 / 0.35));
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
}

.drive-dropzone__card :deep(svg) {
  color: var(--harmony-primary);
}

:deep(.app-menu button.danger) {
  color: var(--danger);
}

@keyframes drive-shimmer {
  from { background-position: 100% 0; }
  to { background-position: -100% 0; }
}

@keyframes drive-drop-in {
  from { opacity: 0; transform: scale(0.99); }
  to { opacity: 1; transform: none; }
}

@media (max-width: 1100px) {
  .drive-view.has-details {
    grid-template-columns: var(--drive-nav-width) minmax(0, 1fr);
  }

  .drive-view__details {
    position: absolute;
    top: 0;
    right: 0;
    bottom: 0;
    z-index: 8;
    width: min(var(--drive-details-width), 100%);
    box-shadow: -12px 0 32px rgb(0 0 0 / 0.3);
  }
}

@media (max-width: 760px) {
  .drive-view,
  .drive-view.has-details {
    grid-template-columns: minmax(0, 1fr);
  }

  .drive-view__nav {
    position: absolute;
    top: 0;
    bottom: 0;
    left: 0;
    z-index: 9;
    width: min(300px, 86%);
    transform: translateX(-102%);
    transition: transform 0.2s ease;
  }

  .drive-view.nav-open .drive-view__nav {
    transform: none;
    box-shadow: 12px 0 32px rgb(0 0 0 / 0.35);
  }

  .drive-view__nav-toggle {
    display: inline-flex;
  }

  .drive-view__scrim {
    position: absolute;
    inset: 0;
    z-index: 8;
    display: block;
    background: rgb(0 0 0 / 0.4);
  }

  .drive-toolbar {
    padding: var(--space-3) var(--space-3) var(--space-2);
  }

  .drive-content {
    padding: var(--space-3);
  }

  .drive-hide-narrow {
    display: none;
  }

  .drive-search {
    max-width: none;
  }

  .drive-toolbar__view {
    margin-left: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .drive-skeleton__item,
  .drive-dropzone {
    animation: none;
  }

  .drive-view__nav {
    transition: none;
  }
}
</style>
