import { defineStore } from 'pinia'
import { computed, markRaw, ref, shallowRef } from 'vue'
import { useAuthStore } from '@/stores/auth'
import {
  createDriveFolder,
  deleteDriveFiles,
  deleteDriveFolder,
  emptyDriveTrash,
  getDriveContextTree,
  keepDriveFiles,
  listDriveFiles,
  listDriveFolders,
  moveDriveFiles,
  moveDriveFolder,
  renameDriveFile,
  renameDriveFolder,
  restoreDriveFiles,
  trashDriveFiles,
  type DriveContextTree,
  type DriveFile,
  type DriveFileKind,
  type DriveFolder,
  type DriveListEntry,
  type DriveSort,
  type DriveView,
} from '@/services/drive/driveService'
import { startMessageMediaUpload, type MessageMediaUpload } from '@/services/messageMediaUpload'
import { messageMediaPath } from '@/services/privateMedia'
import { refreshDriveUsage } from '@/composables/useDriveUsage'

/** Where the Drive page is: a view and, for folder and context views, its id. */
export interface DriveLocation {
  view: DriveView
  /** Folder id (folder view, null for the root) or server, channel or conversation id. */
  id: string | null
}

export type DriveLayout = 'grid' | 'list'

const LAYOUT_KEY = 'harmony:drive-layout'
const PAGE_SIZE = 200

function storedLayout(): DriveLayout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === 'list' ? 'list' : 'grid'
  } catch {
    return 'grid'
  }
}

export const useDriveStore = defineStore('drive', () => {
  const location = ref<DriveLocation>({ view: 'folder', id: null })
  const entries = shallowRef<DriveListEntry[]>([])
  const total = ref(0)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const folders = ref<DriveFolder[]>([])
  const tree = ref<DriveContextTree | null>(null)
  const query = ref('')
  const kind = ref<DriveFileKind | null>(null)
  const sort = ref<DriveSort>('newest')
  const layout = ref<DriveLayout>(storedLayout())
  const selected = ref<Set<string>>(new Set())
  let loadSeq = 0

  const files = computed(() => entries.value.map((e) => e.file))
  const folderById = computed(() => new Map(folders.value.map((f) => [f.id, f])))

  /** Folders shown in the current folder view, sorted by name. */
  const childFolders = computed(() => {
    if (location.value.view !== 'folder' || query.value.trim()) return []
    return folders.value
      .filter((f) => f.parent_id === location.value.id)
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }))
  })

  /** Root-to-current chain of the current folder. */
  const breadcrumbs = computed(() => {
    const chain: DriveFolder[] = []
    let id = location.value.view === 'folder' ? location.value.id : null
    const seen = new Set<string>()
    while (id && !seen.has(id)) {
      seen.add(id)
      const folder = folderById.value.get(id)
      if (!folder) break
      chain.unshift(folder)
      id = folder.parent_id
    }
    return chain
  })

  const selectedFiles = computed(() => files.value.filter((f) => selected.value.has(f.id)))

  function setLayout(next: DriveLayout): void {
    layout.value = next
    try {
      localStorage.setItem(LAYOUT_KEY, next)
    } catch {
      /* private mode */
    }
  }

  async function loadFiles(): Promise<void> {
    const seq = ++loadSeq
    loading.value = true
    error.value = null
    const loc = location.value
    const q = query.value.trim()
    try {
      const result = await listDriveFiles({
        // A search covers the whole Drive, not the folder shown.
        view: q && loc.view === 'folder' ? 'all' : loc.view,
        folder: loc.view === 'folder' ? loc.id : null,
        context: ['server', 'channel', 'conversation'].includes(loc.view) ? loc.id : null,
        query: q || null,
        kind: kind.value,
        sort: sort.value,
        limit: PAGE_SIZE,
      })
      if (seq !== loadSeq) return
      entries.value = markRaw(result.entries)
      total.value = result.total
      const visible = new Set(result.entries.map((e) => e.file.id))
      selected.value = new Set([...selected.value].filter((id) => visible.has(id)))
    } catch (e) {
      if (seq !== loadSeq) return
      error.value = e instanceof Error ? e.message : String(e)
      entries.value = []
      total.value = 0
    } finally {
      if (seq === loadSeq) loading.value = false
    }
  }

  async function loadFolders(): Promise<void> {
    folders.value = await listDriveFolders()
  }

  async function loadTree(): Promise<void> {
    tree.value = await getDriveContextTree()
  }

  async function refreshAll(): Promise<void> {
    await Promise.all([loadFiles(), loadFolders().catch(() => {}), loadTree().catch(() => {}), refreshDriveUsage(true)])
  }

  function open(next: DriveLocation): void {
    // Another place's files never show under this one's title while it loads.
    if (next.view !== location.value.view || next.id !== location.value.id) {
      entries.value = []
      total.value = 0
    }
    location.value = next
    selected.value = new Set()
    void loadFiles()
  }

  function select(id: string, mode: 'only' | 'toggle' | 'range' = 'only'): void {
    if (mode === 'toggle') {
      const next = new Set(selected.value)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      selected.value = next
      return
    }
    if (mode === 'range' && selected.value.size > 0) {
      const order = files.value.map((f) => f.id)
      const anchor = order.findIndex((fid) => selected.value.has(fid))
      const target = order.indexOf(id)
      if (anchor >= 0 && target >= 0) {
        const [from, to] = anchor < target ? [anchor, target] : [target, anchor]
        selected.value = new Set(order.slice(from, to + 1))
        return
      }
    }
    selected.value = new Set([id])
  }

  function selectAll(): void {
    selected.value = new Set(files.value.map((f) => f.id))
  }

  function clearSelection(): void {
    selected.value = new Set()
  }

  /** Runs a change and reloads what it touched. */
  async function mutate<T>(work: () => Promise<T>, reload: { tree?: boolean; folders?: boolean } = {}): Promise<T> {
    const result = await work()
    await Promise.all([
      loadFiles(),
      reload.folders ? loadFolders().catch(() => {}) : null,
      reload.tree ? loadTree().catch(() => {}) : null,
      refreshDriveUsage(true),
    ])
    return result
  }

  const createFolder = (name: string, parentId: string | null) =>
    mutate(() => createDriveFolder(name, parentId), { folders: true })
  const renameFolder = (id: string, name: string) => mutate(() => renameDriveFolder(id, name), { folders: true })
  const moveFolder = (id: string, parentId: string | null) => mutate(() => moveDriveFolder(id, parentId), { folders: true })
  const deleteFolder = (id: string) => mutate(() => deleteDriveFolder(id), { folders: true, tree: true })

  async function renameFile(id: string, name: string): Promise<DriveFile> {
    const updated = await renameDriveFile(id, name)
    entries.value = markRaw(entries.value.map((e) => (e.file.id === id ? { ...e, file: updated } : e)))
    return updated
  }

  /** A file's new link token after Reset link. */
  function setLinkToken(id: string, token: string): void {
    entries.value = markRaw(entries.value.map((e) => (e.file.id === id ? { ...e, file: { ...e.file, link_token: token } } : e)))
  }

  const moveFiles = (ids: string[], folderId: string | null) => mutate(() => moveDriveFiles(ids, folderId))
  const trashFiles = (ids: string[]) => mutate(() => trashDriveFiles(ids), { tree: true })
  const restoreFiles = (ids: string[]) => mutate(() => restoreDriveFiles(ids), { tree: true })
  const deleteFiles = (ids: string[]) => mutate(() => deleteDriveFiles(ids), { tree: true })
  const keepFiles = (ids: string[]) => mutate(() => keepDriveFiles(ids))
  const emptyTrash = () => mutate(() => emptyDriveTrash())

  /**
   * Uploads files into Drive itself (u/<auth uid>/...), into `folderId`. Progress shows in the
   * transfers indicator, on any page.
   */
  function uploadFiles(list: File[], folderId: string | null): MessageMediaUpload[] {
    const uid = useAuthStore().session?.user?.id
    if (!uid) return []
    return list.map((file) => {
      const path = messageMediaPath('u', uid, file.name)
      const upload = markRaw(startMessageMediaUpload(path, file, {
        validate: true,
        name: file.name,
        reuse: false,
        folder: folderId,
        resumeKey: `u/${uid}`,
      }))
      upload.result.catch(() => {}).finally(() => {
        void loadFiles()
        void refreshDriveUsage(true)
      })
      return upload
    })
  }

  function reset(): void {
    location.value = { view: 'folder', id: null }
    entries.value = []
    total.value = 0
    folders.value = []
    tree.value = null
    query.value = ''
    kind.value = null
    selected.value = new Set()
  }

  return {
    location, entries, files, total, loading, error, folders, tree, query, kind, sort, layout,
    selected, selectedFiles, childFolders, breadcrumbs, folderById,
    setLayout, loadFiles, loadFolders, loadTree, refreshAll, open, select, selectAll, clearSelection,
    createFolder, renameFolder, moveFolder, deleteFolder, renameFile, setLinkToken, moveFiles, trashFiles,
    restoreFiles, deleteFiles, keepFiles, emptyTrash, uploadFiles, reset,
  }
})
