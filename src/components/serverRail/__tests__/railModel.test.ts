import { describe, it, expect } from 'vitest'
import {
  applyDrop,
  buildRailLayout,
  isPlanEmpty,
  moveByOffset,
  moveToFolder,
  NEW_FOLDER_KEY,
  planLayout,
  resolveDropTarget,
  ungroupFolder,
  wrapInFolder,
  type RailLayout,
  type RailRect,
} from '../railModel'
import type { Server, ServerFolder } from '@/types'

const s = (id: string, position: number, folder_id: string | null = null) =>
  ({ id, name: id, position, folder_id }) as unknown as Server
const f = (id: string, position: number) =>
  ({ id, user_id: 'me', name: id, color: '#000', position, is_expanded: false }) as ServerFolder

// a, F1[b, c], d
const servers = [s('a', 0), s('b', 0, 'F1'), s('c', 1, 'F1'), s('d', 2)]
const folders = [f('F1', 1)]
const base = (): RailLayout => buildRailLayout(servers, folders)

const ids = (l: RailLayout) => l.root.map(e => (e.kind === 'folder' ? `[${e.id}:${l.folders[e.id].join(',')}]` : e.id)).join(' ')

describe('buildRailLayout', () => {
  it('interleaves folders and loose servers by position', () => {
    expect(ids(base())).toBe('a [F1:b,c] d')
  })

  it('puts a server whose folder is unknown at root', () => {
    const l = buildRailLayout([s('x', 0, 'gone'), s('y', 1)], [])
    expect(ids(l)).toBe('x y')
  })

  it('orders folders before servers on equal positions', () => {
    const l = buildRailLayout([s('x', 0), s('m', 0, 'F')], [f('F', 0)])
    expect(ids(l)).toBe('[F:m] x')
  })
})

describe('applyDrop', () => {
  it('reorders loose servers', () => {
    expect(ids(applyDrop(base(), { kind: 'server', id: 'd' }, { kind: 'before', id: 'a', folderId: null })!.layout)).toBe('d a [F1:b,c]')
  })

  it('combines two loose servers into a new folder at the target slot', () => {
    const r = applyDrop(base(), { kind: 'server', id: 'a' }, { kind: 'combine', id: 'd' })!
    expect(r.createdFolderId).toBe(NEW_FOLDER_KEY)
    expect(ids(r.layout)).toBe(`[F1:b,c] [${NEW_FOLDER_KEY}:d,a]`)
  })

  it('moves a server into a folder at a slot', () => {
    expect(ids(applyDrop(base(), { kind: 'server', id: 'a' }, { kind: 'before', id: 'c', folderId: 'F1' })!.layout)).toBe('[F1:b,a,c] d')
  })

  it('appends a server dropped on a folder', () => {
    expect(ids(applyDrop(base(), { kind: 'server', id: 'd' }, { kind: 'into-folder', folderId: 'F1' })!.layout)).toBe('a [F1:b,c,d]')
  })

  it('moves a server out of a folder', () => {
    expect(ids(applyDrop(base(), { kind: 'server', id: 'b' }, { kind: 'after', id: 'd', folderId: null })!.layout)).toBe('a [F1:c] d b')
  })

  it('reorders within a folder', () => {
    expect(ids(applyDrop(base(), { kind: 'server', id: 'c' }, { kind: 'before', id: 'b', folderId: 'F1' })!.layout)).toBe('a [F1:c,b] d')
  })

  it('removes a folder its last server leaves', () => {
    const one = applyDrop(base(), { kind: 'server', id: 'b' }, { kind: 'end' })!.layout
    const two = applyDrop(one, { kind: 'server', id: 'c' }, { kind: 'end' })!.layout
    expect(ids(two)).toBe('a d b c')
  })

  it('reorders folders and maps member targets to the folder', () => {
    const l = buildRailLayout([...servers, s('e', 0, 'F2')], [...folders, f('F2', 3)])
    expect(ids(applyDrop(l, { kind: 'folder', id: 'F2' }, { kind: 'before', id: 'b', folderId: 'F1' })!.layout)).toBe('a [F2:e] [F1:b,c] d')
  })

  it('refuses folder-into-folder and self drops', () => {
    expect(applyDrop(base(), { kind: 'folder', id: 'F1' }, { kind: 'combine', id: 'a' })).toBeNull()
    expect(applyDrop(base(), { kind: 'server', id: 'a' }, { kind: 'before', id: 'a', folderId: null })).toBeNull()
    expect(applyDrop(base(), { kind: 'server', id: 'a' }, { kind: 'before', id: 'F1', folderId: null })).toBeNull()
  })
})

describe('keyboard and menu moves', () => {
  it('steps a member out of its folder at the edge', () => {
    expect(ids(moveByOffset(base(), { kind: 'server', id: 'b' }, -1)!)).toBe('a b [F1:c] d')
    expect(ids(moveByOffset(base(), { kind: 'server', id: 'c' }, 1)!)).toBe('a [F1:b] c d')
  })

  it('moves a loose server past a folder without entering it', () => {
    expect(ids(moveByOffset(base(), { kind: 'server', id: 'a' }, 1)!)).toBe('[F1:b,c] a d')
  })

  it('returns null at the ends', () => {
    expect(moveByOffset(base(), { kind: 'server', id: 'a' }, -1)).toBeNull()
    expect(moveByOffset(base(), { kind: 'server', id: 'd' }, 1)).toBeNull()
  })

  it('moves folders', () => {
    expect(ids(moveByOffset(base(), { kind: 'folder', id: 'F1' }, -1)!)).toBe('[F1:b,c] a d')
  })

  it('ungroups in place', () => {
    expect(ids(ungroupFolder(base(), 'F1')!)).toBe('a b c d')
  })

  it('moves to and out of a folder', () => {
    expect(ids(moveToFolder(base(), 'd', 'F1')!)).toBe('a [F1:b,c,d]')
    expect(ids(moveToFolder(base(), 'b', null)!)).toBe('a [F1:c] b d')
  })

  it('wraps a server in a new folder', () => {
    expect(ids(wrapInFolder(base(), 'd')!.layout)).toBe(`a [F1:b,c] [${NEW_FOLDER_KEY}:d]`)
  })
})

describe('planLayout', () => {
  it('writes only rows whose folder or position changed', () => {
    const next = applyDrop(base(), { kind: 'server', id: 'c' }, { kind: 'before', id: 'b', folderId: 'F1' })!.layout
    const plan = planLayout(servers, folders, next)
    expect(plan.serverUpdates).toEqual([
      { serverId: 'c', folderId: 'F1', position: 0 },
      { serverId: 'b', folderId: 'F1', position: 1 },
    ])
    expect(plan.folderUpdates).toEqual([])
    expect(plan.deleteFolders).toEqual([])
  })

  it('creates the new folder under the given id and deletes emptied ones', () => {
    const r = applyDrop(base(), { kind: 'server', id: 'a' }, { kind: 'combine', id: 'd' })!
    const plan = planLayout(servers, folders, r.layout, 'NEW')
    expect(plan.createFolder).toEqual({ id: 'NEW', position: 1 })
    expect(plan.serverUpdates).toEqual([
      { serverId: 'd', folderId: 'NEW', position: 0 },
      { serverId: 'a', folderId: 'NEW', position: 1 },
    ])
    expect(plan.folderUpdates).toEqual([{ folderId: 'F1', position: 0 }])

    const gone = ungroupFolder(base(), 'F1')!
    expect(planLayout(servers, folders, gone).deleteFolders).toEqual(['F1'])
  })

  it('is empty for the stored layout', () => {
    const dense = [s('a', 0), s('b', 0, 'F1'), s('c', 1, 'F1'), s('d', 2)]
    expect(isPlanEmpty(planLayout(dense, folders, buildRailLayout(dense, folders)))).toBe(true)
  })
})

describe('resolveDropTarget', () => {
  // a at 0..48, collapsed F1 at 56..104, member m of expanded F2 at 112..160
  const rects: RailRect[] = [
    { top: 0, height: 48, entry: { kind: 'server', id: 'a' }, folderId: null, accepts: 'combine' },
    { top: 56, height: 48, entry: { kind: 'folder', id: 'F1' }, folderId: null, accepts: 'into-folder' },
    { top: 112, height: 48, entry: { kind: 'server', id: 'm' }, folderId: 'F2', accepts: null },
  ]
  const srv = { kind: 'server', id: 'x' } as const
  const fol = { kind: 'folder', id: 'F9' } as const

  it('splits a loose server into before, combine and after', () => {
    expect(resolveDropTarget(5, rects, srv)).toEqual({ kind: 'before', id: 'a', folderId: null })
    expect(resolveDropTarget(24, rects, srv)).toEqual({ kind: 'combine', id: 'a' })
    expect(resolveDropTarget(45, rects, srv)).toEqual({ kind: 'after', id: 'a', folderId: null })
  })

  it('treats the gap as before the next entry', () => {
    expect(resolveDropTarget(52, rects, srv)).toEqual({ kind: 'before', id: 'F1', folderId: null })
  })

  it('drops into a folder centre', () => {
    expect(resolveDropTarget(80, rects, srv)).toEqual({ kind: 'into-folder', folderId: 'F1' })
  })

  it('never combines inside a folder', () => {
    expect(resolveDropTarget(136, rects, srv)).toEqual({ kind: 'after', id: 'm', folderId: 'F2' })
  })

  it('keeps folders at root', () => {
    expect(resolveDropTarget(80, rects, fol)).toEqual({ kind: 'after', id: 'F1', folderId: null })
    expect(resolveDropTarget(120, rects, fol)).toEqual({ kind: 'before', id: 'F2', folderId: null })
  })

  it('falls through to the end', () => {
    expect(resolveDropTarget(400, rects, srv)).toEqual({ kind: 'end' })
    expect(resolveDropTarget(10, [], srv)).toEqual({ kind: 'end' })
  })
})
