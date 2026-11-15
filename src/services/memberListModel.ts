// The member list of one server as a window over the server's order.
//
// get_server_member_list orders members by group, then name, and answers group counts with
// each page. The model keeps the pages near the viewport, keyed by their offset in that
// order. A page whose counts differ from the ones held means the order moved: the pages
// held before it are stale until read again, and stay on screen meanwhile.

import type { DirectoryMember, MemberGroupCount, MemberListPage } from '@/services/memberDirectoryService'

/** Members per page; page offsets are multiples of it. */
export const MEMBER_PAGE_ROWS = 100

/** Pages kept; the ones farthest from the viewport go first. */
export const MAX_LOADED_PAGES = 6

/** A server of at most this many members loads whole and is grouped on the client. */
export const COMPLETE_LIST_MAX = 200

export type MemberSlot =
  | { type: 'header'; groupKey: string; count: number }
  | { type: 'member'; groupKey: string; index: number; member: DirectoryMember }
  | { type: 'placeholder'; groupKey: string; index: number }

/** Member indexes [from, to], inclusive, in list order. */
export type MemberRun = [number, number]

interface LoadedPage {
  members: DirectoryMember[]
  stale: boolean
}

export const pageOffsetOf = (index: number): number => Math.floor(index / MEMBER_PAGE_ROWS) * MEMBER_PAGE_ROWS

function sameGroups(a: MemberGroupCount[], b: MemberGroupCount[]): boolean {
  return a.length === b.length && a.every((g, i) => g.key === b[i].key && g.count === b[i].count)
}

export class MemberListModel {
  total = 0
  groups: MemberGroupCount[] = []
  /** The instance has answered at least once; before that, total 0 means unknown. */
  answered = false
  private pages = new Map<number, LoadedPage>()

  /**
   * Stores the members of a response, which may span several pages. A response whose total
   * or group counts differ from the ones held marks every other page stale.
   */
  apply(response: MemberListPage): void {
    this.answered = true
    if (response.total !== this.total || !sameGroups(response.groups, this.groups)) {
      for (const page of this.pages.values()) page.stale = true
      this.total = response.total
      this.groups = response.groups
    }
    const first = pageOffsetOf(response.offset)
    for (let i = 0; i === 0 || i < response.members.length; i += MEMBER_PAGE_ROWS) {
      this.pages.set(first + i, { members: response.members.slice(i, i + MEMBER_PAGE_ROWS), stale: false })
    }
    for (const offset of [...this.pages.keys()]) {
      if (offset >= this.total) this.pages.delete(offset)
    }
  }

  markAllStale(): void {
    for (const page of this.pages.values()) page.stale = true
  }

  private offsetsOver(runs: MemberRun[]): number[] {
    const offsets = new Set<number>()
    for (const [from, to] of runs) {
      const last = Math.min(to, this.total - 1)
      for (let offset = pageOffsetOf(Math.max(from, 0)); offset <= last; offset += MEMBER_PAGE_ROWS) offsets.add(offset)
    }
    return [...offsets].sort((a, b) => a - b)
  }

  /**
   * Offsets of the pages over `runs` to read: the absent ones, and the stale ones when
   * `includeStale`. The first page, until the instance has answered at all.
   */
  wanted(runs: MemberRun[], includeStale = true): number[] {
    if (!this.answered) return [0]
    return this.offsetsOver(runs).filter((offset) => {
      const page = this.pages.get(offset)
      return !page || (includeStale && page.stale)
    })
  }

  /** Offsets of the pages over `runs` that are held and stale. */
  stale(runs: MemberRun[]): number[] {
    return this.offsetsOver(runs).filter(offset => this.pages.get(offset)?.stale === true)
  }

  /** Drops the pages farthest from every run until MAX_LOADED_PAGES remain. */
  trim(runs: MemberRun[]): void {
    if (this.pages.size <= MAX_LOADED_PAGES) return
    const distance = (offset: number): number => {
      const first = offset
      const last = offset + MEMBER_PAGE_ROWS - 1
      let nearest = Infinity
      for (const [from, to] of runs) {
        nearest = Math.min(nearest, last < from ? from - last : first > to ? first - to : 0)
      }
      return nearest
    }
    const farthestFirst = [...this.pages.keys()].sort((a, b) => distance(b) - distance(a))
    for (const offset of farthestFirst.slice(0, this.pages.size - MAX_LOADED_PAGES)) this.pages.delete(offset)
  }

  loadedIds(): string[] {
    const ids = new Set<string>()
    for (const page of this.pages.values()) for (const member of page.members) ids.add(member.id)
    return [...ids]
  }

  loadedMembers(): DirectoryMember[] {
    const members = new Map<string, DirectoryMember>()
    for (const page of this.pages.values()) for (const member of page.members) members.set(member.id, member)
    return [...members.values()]
  }

  /**
   * Headers and rows in display order. A row not loaded is a placeholder. A member held by
   * both a fresh and a stale page shows once, at its fresh position.
   */
  slots(collapsed: Record<string, boolean> = {}): MemberSlot[] {
    const fresh = new Set<string>()
    for (const page of this.pages.values()) {
      if (!page.stale) for (const member of page.members) fresh.add(member.id)
    }
    const shown = new Set<string>()
    const slots: MemberSlot[] = []
    let index = 0
    for (const group of this.groups) {
      slots.push({ type: 'header', groupKey: group.key, count: group.count })
      if (collapsed[group.key]) {
        index += group.count
        continue
      }
      for (let i = 0; i < group.count; i++, index++) {
        const offset = pageOffsetOf(index)
        const page = this.pages.get(offset)
        const member = page?.members[index - offset]
        if (!member || shown.has(member.id) || (page!.stale && fresh.has(member.id))) {
          slots.push({ type: 'placeholder', groupKey: group.key, index })
          continue
        }
        shown.add(member.id)
        slots.push({ type: 'member', groupKey: group.key, index, member })
      }
    }
    return slots
  }
}
