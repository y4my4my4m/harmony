/**
 * One result list from server pages and encrypted results found on the device.
 *
 * Newest first, each local result lands on exactly one server page by time: page p holds the
 * local results older than the match before it (`before`) and at least as new as its own last
 * match; the last page takes everything older. Oldest first mirrors it. A page past the end of
 * the server's matches holds none. The device reads each page's window from its index
 * (localWindow). Under relevance, and beside similar server rows, local results page by count
 * beside the server's. Similar rows (the server's typo fallback) give way to exact local
 * results. Without server results the local ones page alone.
 */

import type { Message } from '@/types'
import type { SearchSort } from '@/utils/searchQuery'

/** created_at bounds in ms, both inclusive; absent: open. */
export interface LocalWindow {
  from?: number
  to?: number
}

export interface PageInput {
  server: Message[]
  page: number
  pageSize: number
  serverPageCount: number
  sort: SearchSort
  /** The server rows are similar, not exact matches. */
  fuzzy: boolean
  /** created_at of the server match just before this page; null on the first page. */
  before: Date | null
}

export interface MergeInput extends PageInput {
  /** The first local results in `sort` order (newest first under relevance). */
  local: Message[]
  /** Local results inside localWindow(), in `sort` order. */
  windowed: Message[]
}

export interface MergedPage {
  messages: Message[]
  pageCount: number
  /** Server pages behind the list; 0: the local results page alone. */
  serverPageCount: number
  /** The page shows similar rows, not exact matches. */
  similar: boolean
}

const time = (m: Message) => new Date(m.created_at).getTime()

/** The server side of the list: similar rows drop out when the device holds exact results. */
function serverSide(input: PageInput, localCount: number): PageInput {
  return input.fuzzy && localCount > 0 ? { ...input, server: [], serverPageCount: 0 } : input
}

/**
 * Window of the local results on this page. undefined: they page by count, from the first
 * local results; null: the page holds none.
 */
export function localWindow(input: PageInput, localCount: number): LocalWindow | null | undefined {
  const { server, page, serverPageCount, sort, fuzzy, before } = serverSide(input, localCount)
  if (serverPageCount === 0 || fuzzy || sort === 'relevance') return undefined
  if (page > 0 && !before && server.length === 0) return null
  const first = server.length ? time(server[0]) : null
  const last = server.length ? time(server[server.length - 1]) : null
  const open = page >= serverPageCount - 1 || last === null
  // Without `before`, the page's first match bounds it.
  const edge = page === 0 ? undefined : before ? before.getTime() : first!
  const exclusive = !!before
  if (sort === 'oldest') {
    return {
      ...(edge !== undefined ? { from: exclusive ? edge + 1 : edge } : {}),
      ...(!open ? { to: last! } : {}),
    }
  }
  return {
    ...(!open ? { from: last! } : {}),
    ...(edge !== undefined ? { to: exclusive ? edge - 1 : edge } : {}),
  }
}

const inside = (t: number, w: LocalWindow) => (w.from === undefined || t >= w.from) && (w.to === undefined || t <= w.to)

export function mergeSearchPage(input: MergeInput): MergedPage {
  const view = serverSide(input, input.local.length)
  const { server, page, pageSize, serverPageCount, sort } = view
  const similar = view.fuzzy && server.length > 0
  const shown = new Set(server.map(m => m.id))
  const localPages = Math.ceil(input.local.length / pageSize)
  const byCount = () => input.local.slice(page * pageSize, page * pageSize + pageSize).filter(m => !shown.has(m.id))

  if (serverPageCount === 0) {
    return { messages: byCount(), pageCount: localPages, serverPageCount: 0, similar: false }
  }
  const window = localWindow(view, input.local.length)
  if (window === undefined) {
    return { messages: [...server, ...byCount()], pageCount: Math.max(serverPageCount, localPages), serverPageCount, similar }
  }
  if (window === null) return { messages: server, pageCount: serverPageCount, serverPageCount, similar }

  const newest = sort !== 'oldest'
  const local = input.windowed.filter(m => !shown.has(m.id) && inside(time(m), window))
  const merged = [...server.map((m, i) => ({ m, i, s: 0 })), ...local.map((m, i) => ({ m, i, s: 1 }))]
  merged.sort((a, b) => {
    const d = newest ? time(b.m) - time(a.m) : time(a.m) - time(b.m)
    return d || a.s - b.s || a.i - b.i
  })
  return { messages: merged.map(x => x.m), pageCount: serverPageCount, serverPageCount, similar }
}
