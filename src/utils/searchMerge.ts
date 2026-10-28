/**
 * One result list from server pages and encrypted results found on the device.
 *
 * By time, each local result lands on exactly one server page: newest first, page p holds the
 * local results older than the last match of page p - 1 (`before`) and at least as new as its
 * own last match; the last page takes everything older. Oldest first mirrors it. Under
 * relevance the local results follow the server's on the first page. Without server results
 * the local ones page alone.
 */

import type { Message } from '@/types'
import type { SearchSort } from '@/utils/searchQuery'

export interface MergeInput {
  server: Message[]
  page: number
  pageSize: number
  serverPageCount: number
  sort: SearchSort
  /** Every local result, in `sort` order. */
  local: Message[]
  /** created_at of the server match just before this page; null on the first page. */
  before: Date | null
}

export interface MergedPage {
  messages: Message[]
  pageCount: number
}

const time = (m: Message) => new Date(m.created_at).getTime()

export function mergeSearchPage(input: MergeInput): MergedPage {
  const { server, page, pageSize, serverPageCount, sort } = input
  const shown = new Set(server.map(m => m.id))
  const local = input.local.filter(m => !shown.has(m.id))

  if (serverPageCount === 0) {
    return {
      messages: local.slice(page * pageSize, page * pageSize + pageSize),
      pageCount: Math.ceil(local.length / pageSize),
    }
  }
  if (sort === 'relevance') {
    return { messages: page === 0 ? [...server, ...local] : server, pageCount: serverPageCount }
  }

  const newest = sort !== 'oldest'
  const last = server.length ? time(server[server.length - 1]) : null
  const isLast = page >= serverPageCount - 1
  const bound = input.before ? input.before.getTime() : page > 0 && server.length ? time(server[0]) : null
  const inWindow = (t: number) => {
    if (newest) {
      if (page > 0 && bound !== null && (input.before ? t >= bound : t > bound)) return false
      return isLast || last === null || t >= last
    }
    if (page > 0 && bound !== null && (input.before ? t <= bound : t < bound)) return false
    return isLast || last === null || t <= last
  }
  const window = local.filter(m => inWindow(time(m)))
  const merged = [...server.map((m, i) => ({ m, i, s: 0 })), ...window.map((m, i) => ({ m, i, s: 1 }))]
  merged.sort((a, b) => {
    const d = newest ? time(b.m) - time(a.m) : time(a.m) - time(b.m)
    return d || a.s - b.s || a.i - b.i
  })
  return { messages: merged.map(x => x.m), pageCount: serverPageCount }
}
