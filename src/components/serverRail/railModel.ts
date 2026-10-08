/**
 * Server rail ordering. Root entries (folders and loose servers) share one
 * position space; each folder's members have their own, starting at 0.
 * Positions persist to user_servers.position / server_folders.position.
 */

import type { Server, ServerFolder } from '@/types'

export type RailEntry = { kind: 'server'; id: string } | { kind: 'folder'; id: string }

export interface RailLayout {
  root: RailEntry[]
  /** Folder id to ordered member server ids. */
  folders: Record<string, string[]>
}

export type DragSource = { kind: 'server'; id: string } | { kind: 'folder'; id: string }

export type DropTarget =
  /** Insert next to `id`; `folderId` is the container of `id`, null for root. */
  | { kind: 'before' | 'after'; id: string; folderId: string | null }
  /** Server dropped on the centre of a loose server: new folder of both. */
  | { kind: 'combine'; id: string }
  /** Server dropped on a folder: appended to it. */
  | { kind: 'into-folder'; folderId: string }
  /** Below the last entry. */
  | { kind: 'end' }

export interface MoveResult {
  layout: RailLayout
  /** Present when the drop creates a folder; `id` is the placeholder key in `layout.folders`. */
  createdFolderId?: string
}

export interface RailPlan {
  serverUpdates: { serverId: string; folderId: string | null; position: number }[]
  folderUpdates: { folderId: string; position: number }[]
  createFolder?: { id: string; position: number }
  deleteFolders: string[]
}

const byPosition = (a: { position?: number | null }, b: { position?: number | null }) =>
  (a.position ?? 0) - (b.position ?? 0)

/**
 * Single pass over servers and folders. A server whose folder_id names no
 * known folder renders at root. Ties sort folders before servers.
 */
export function buildRailLayout(servers: readonly Server[], folders: readonly ServerFolder[]): RailLayout {
  const known = new Set(folders.map(f => f.id))
  const members: Record<string, Server[]> = {}
  for (const f of folders) members[f.id] = []
  const loose: Server[] = []
  for (const s of servers) {
    if (s.folder_id && known.has(s.folder_id)) members[s.folder_id].push(s)
    else loose.push(s)
  }

  const rootItems: { entry: RailEntry; position: number; rank: number }[] = []
  for (const f of folders) rootItems.push({ entry: { kind: 'folder', id: f.id }, position: f.position ?? 0, rank: 0 })
  for (const s of loose) rootItems.push({ entry: { kind: 'server', id: s.id }, position: s.position ?? 0, rank: 1 })
  rootItems.sort((a, b) => a.position - b.position || a.rank - b.rank)

  const result: Record<string, string[]> = {}
  for (const id of Object.keys(members)) result[id] = [...members[id]].sort(byPosition).map(s => s.id)
  return { root: rootItems.map(i => i.entry), folders: result }
}

function cloneLayout(layout: RailLayout): RailLayout {
  const folders: Record<string, string[]> = {}
  for (const id of Object.keys(layout.folders)) folders[id] = [...layout.folders[id]]
  return { root: [...layout.root], folders }
}

/** Folder holding `serverId`, or null at root. */
export function containerOf(layout: RailLayout, serverId: string): string | null {
  for (const id of Object.keys(layout.folders)) {
    if (layout.folders[id].includes(serverId)) return id
  }
  return null
}

function removeSource(layout: RailLayout, source: DragSource): void {
  if (source.kind === 'folder') {
    layout.root = layout.root.filter(e => !(e.kind === 'folder' && e.id === source.id))
    return
  }
  const from = containerOf(layout, source.id)
  if (from) layout.folders[from] = layout.folders[from].filter(id => id !== source.id)
  else layout.root = layout.root.filter(e => !(e.kind === 'server' && e.id === source.id))
}

function rootIndex(layout: RailLayout, entry: RailEntry): number {
  return layout.root.findIndex(e => e.kind === entry.kind && e.id === entry.id)
}

/** Drops folders left without members. */
function pruneEmpty(layout: RailLayout): void {
  for (const id of Object.keys(layout.folders)) {
    if (layout.folders[id].length === 0) {
      delete layout.folders[id]
      layout.root = layout.root.filter(e => !(e.kind === 'folder' && e.id === id))
    }
  }
}

/** Placeholder key for a folder the drop creates; replaced by a real id at persist time. */
export const NEW_FOLDER_KEY = '__new_folder__'

/**
 * Applies a drop. Returns null when the drop changes nothing or is not
 * allowed (a folder into a folder, a server onto itself).
 */
export function applyDrop(layout: RailLayout, source: DragSource, target: DropTarget): MoveResult | null {
  if (target.kind !== 'end' && target.kind !== 'into-folder' && target.id === source.id) return null
  if (source.kind === 'folder' && target.kind === 'into-folder' && target.folderId === source.id) return null

  const next = cloneLayout(layout)
  let createdFolderId: string | undefined

  if (source.kind === 'folder') {
    // Folders live at root only; a target inside a folder resolves to that folder.
    let anchor: RailEntry | null = null
    let after = true
    if (target.kind === 'end') anchor = null
    else if (target.kind === 'into-folder') return null
    else if (target.kind === 'combine') return null
    else if (target.folderId) {
      if (target.folderId === source.id) return null
      anchor = { kind: 'folder', id: target.folderId }
      after = target.kind === 'after'
    } else {
      anchor = { kind: layout.folders[target.id] ? 'folder' : 'server', id: target.id }
      after = target.kind === 'after'
    }
    removeSource(next, source)
    const entry: RailEntry = { kind: 'folder', id: source.id }
    if (!anchor) next.root.push(entry)
    else {
      const i = rootIndex(next, anchor)
      if (i === -1) return null
      next.root.splice(after ? i + 1 : i, 0, entry)
    }
  } else {
    removeSource(next, source)
    const entry: RailEntry = { kind: 'server', id: source.id }
    if (target.kind === 'end') {
      next.root.push(entry)
    } else if (target.kind === 'into-folder') {
      if (!next.folders[target.folderId]) return null
      next.folders[target.folderId].push(source.id)
    } else if (target.kind === 'combine') {
      const holder = containerOf(next, target.id)
      if (holder) {
        const members = next.folders[holder]
        members.splice(members.indexOf(target.id) + 1, 0, source.id)
      } else {
        const i = rootIndex(next, { kind: 'server', id: target.id })
        if (i === -1) return null
        createdFolderId = NEW_FOLDER_KEY
        next.folders[createdFolderId] = [target.id, source.id]
        next.root.splice(i, 1, { kind: 'folder', id: createdFolderId })
      }
    } else if (target.folderId) {
      const members = next.folders[target.folderId]
      if (!members) return null
      const i = members.indexOf(target.id)
      if (i === -1) return null
      members.splice(target.kind === 'after' ? i + 1 : i, 0, source.id)
    } else {
      const anchorKind = layout.folders[target.id] ? 'folder' : 'server'
      const i = rootIndex(next, { kind: anchorKind, id: target.id })
      if (i === -1) return null
      next.root.splice(target.kind === 'after' ? i + 1 : i, 0, entry)
    }
  }

  pruneEmpty(next)
  if (sameLayout(layout, next)) return null
  return { layout: next, createdFolderId }
}

/**
 * Keyboard move by one slot. A server at the edge of its folder steps out
 * to root, next to the folder; a loose server never enters a folder.
 */
export function moveByOffset(layout: RailLayout, source: DragSource, delta: -1 | 1): RailLayout | null {
  if (source.kind === 'server') {
    const holder = containerOf(layout, source.id)
    if (holder) {
      const members = layout.folders[holder]
      const i = members.indexOf(source.id)
      const j = i + delta
      if (j >= 0 && j < members.length) {
        return applyDrop(layout, source, { kind: delta < 0 ? 'before' : 'after', id: members[j], folderId: holder })?.layout ?? null
      }
      return applyDrop(layout, source, { kind: delta < 0 ? 'before' : 'after', id: holder, folderId: null })?.layout ?? null
    }
  }
  const i = rootIndex(layout, source)
  const j = i + delta
  if (i === -1 || j < 0 || j >= layout.root.length) return null
  const neighbour = layout.root[j]
  return applyDrop(layout, source, { kind: delta < 0 ? 'before' : 'after', id: neighbour.id, folderId: null })?.layout ?? null
}

/** Replaces a folder with its members, in place. */
export function ungroupFolder(layout: RailLayout, folderId: string): RailLayout | null {
  const i = rootIndex(layout, { kind: 'folder', id: folderId })
  if (i === -1) return null
  const next = cloneLayout(layout)
  const members = next.folders[folderId] ?? []
  delete next.folders[folderId]
  next.root.splice(i, 1, ...members.map(id => ({ kind: 'server' as const, id })))
  return next
}

/** Moves a server to the end of a folder, or to the slot after its folder for `null`. */
export function moveToFolder(layout: RailLayout, serverId: string, folderId: string | null): RailLayout | null {
  const source: DragSource = { kind: 'server', id: serverId }
  if (folderId) return applyDrop(layout, source, { kind: 'into-folder', folderId })?.layout ?? null
  const holder = containerOf(layout, serverId)
  if (!holder) return null
  return applyDrop(layout, source, { kind: 'after', id: holder, folderId: null })?.layout ?? null
}

/** Wraps a loose server in a new folder at its slot. */
export function wrapInFolder(layout: RailLayout, serverId: string): MoveResult | null {
  const i = rootIndex(layout, { kind: 'server', id: serverId })
  if (i === -1) return null
  const next = cloneLayout(layout)
  next.folders[NEW_FOLDER_KEY] = [serverId]
  next.root.splice(i, 1, { kind: 'folder', id: NEW_FOLDER_KEY })
  return { layout: next, createdFolderId: NEW_FOLDER_KEY }
}

export function sameLayout(a: RailLayout, b: RailLayout): boolean {
  if (a.root.length !== b.root.length) return false
  for (let i = 0; i < a.root.length; i++) {
    if (a.root[i].kind !== b.root[i].kind || a.root[i].id !== b.root[i].id) return false
  }
  const ak = Object.keys(a.folders)
  if (ak.length !== Object.keys(b.folders).length) return false
  for (const id of ak) {
    const x = a.folders[id]
    const y = b.folders[id]
    if (!y || x.length !== y.length || x.some((v, i) => v !== y[i])) return false
  }
  return true
}

/**
 * Rows whose folder or position differ between the stored state and
 * `layout`. Positions are dense indices in their container.
 */
export function planLayout(
  servers: readonly Server[],
  folders: readonly ServerFolder[],
  layout: RailLayout,
  newFolderId?: string,
): RailPlan {
  const plan: RailPlan = { serverUpdates: [], folderUpdates: [], deleteFolders: [] }
  const serverById = new Map(servers.map(s => [s.id, s]))
  const folderById = new Map(folders.map(f => [f.id, f]))
  const realId = (id: string) => (id === NEW_FOLDER_KEY && newFolderId ? newFolderId : id)

  const pushServer = (id: string, folderId: string | null, position: number) => {
    const s = serverById.get(id)
    if (!s) return
    if ((s.folder_id ?? null) !== folderId || (s.position ?? 0) !== position) {
      plan.serverUpdates.push({ serverId: id, folderId, position })
    }
  }

  layout.root.forEach((entry, position) => {
    if (entry.kind === 'server') {
      pushServer(entry.id, null, position)
      return
    }
    if (entry.id === NEW_FOLDER_KEY) {
      plan.createFolder = { id: realId(entry.id), position }
      return
    }
    const f = folderById.get(entry.id)
    if (f && (f.position ?? 0) !== position) plan.folderUpdates.push({ folderId: f.id, position })
  })

  for (const id of Object.keys(layout.folders)) {
    layout.folders[id].forEach((serverId, position) => pushServer(serverId, realId(id), position))
  }

  for (const f of folders) {
    if (!layout.folders[f.id]) plan.deleteFolders.push(f.id)
  }
  return plan
}

export function isPlanEmpty(plan: RailPlan): boolean {
  return !plan.createFolder && plan.serverUpdates.length === 0 && plan.folderUpdates.length === 0 && plan.deleteFolders.length === 0
}

export interface RailRect {
  /** Top in scroll-content coordinates, px. */
  top: number
  height: number
  entry: RailEntry
  /** Container folder for a member; null for root entries and folder rows. */
  folderId: string | null
  /** Collapsed folders and loose servers accept a centre drop. */
  accepts: 'combine' | 'into-folder' | null
}

/**
 * Resolves a pointer position to a drop target. `rects` are in visual order.
 * The middle half of a loose server combines; the middle half of a collapsed
 * folder (or an expanded folder header) appends. Folders being dragged never
 * combine or enter.
 */
export function resolveDropTarget(
  y: number,
  rects: readonly RailRect[],
  source: DragSource,
): DropTarget {
  if (rects.length === 0) return { kind: 'end' }
  for (const r of rects) {
    if (r.entry.id === source.id && r.entry.kind === source.kind) {
      if (y >= r.top && y < r.top + r.height) return { kind: 'before', id: r.entry.id, folderId: r.folderId }
      continue
    }
    if (y >= r.top + r.height) continue
    const rel = (y - r.top) / r.height
    const centre = rel >= 0.25 && rel <= 0.75
    if (source.kind === 'server' && centre && r.accepts === 'combine' && r.folderId === null) {
      return { kind: 'combine', id: r.entry.id }
    }
    if (source.kind === 'server' && centre && r.accepts === 'into-folder') {
      return { kind: 'into-folder', folderId: r.entry.id }
    }
    if (source.kind === 'folder' && r.folderId) {
      return { kind: rel < 0.5 ? 'before' : 'after', id: r.folderId, folderId: null }
    }
    return { kind: rel < 0.5 ? 'before' : 'after', id: r.entry.id, folderId: r.folderId }
  }
  return { kind: 'end' }
}
