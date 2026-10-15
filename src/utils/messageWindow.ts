// The loaded slice of a channel or conversation, shared by useChat and useDM.
//
// The slice is contiguous: it holds every visible row between its first and its
// last. Attached, it ends at the newest message and realtime rows append to it.
// Detached (a jump to a message outside it), it ends earlier; realtime rows past
// its end stay out of it, and pages toward the present extend it until a short
// page shows the end was reached.

import type { Message } from '@/types'
import { isOptimisticId } from '@/stores/shared/optimisticMessages'

/** Rows a jump loads before its target. */
export const JUMP_BEFORE = 25
/** Rows a jump loads after its target. */
export const JUMP_AFTER = 25
/** Rows a page toward the present reads. */
export const NEWER_PAGE = 50

type Row = Pick<Message, 'id' | 'created_at'> & { sending?: boolean }

export const rowTime = (row: { created_at: unknown }): number =>
  new Date(row.created_at as string | Date).getTime()

/** created_at as a query cursor. A string is the server's value; a Date has lost the microseconds. */
export function cursorOf(row: { created_at: unknown } | undefined): string | undefined {
  const ts = row?.created_at
  if (typeof ts === 'string' && ts) return ts
  if (ts instanceof Date && !Number.isNaN(ts.getTime())) return ts.toISOString()
  return undefined
}

/** Optimistic and outbox rows: sent from this client, not yet a server row. */
export const isPendingRow = (row: Row): boolean => isOptimisticId(row.id) || !!row.sending

/** The newest row the server holds; pending rows are no cursor. */
export function newestPersisted<T extends Row>(rows: readonly T[]): T | undefined {
  for (let i = rows.length - 1; i >= 0; i--) {
    if (!isPendingRow(rows[i])) return rows[i]
  }
  return undefined
}

export interface JumpWindow<T> {
  messages: T[]
  /** No row precedes the first one. */
  allOlderLoaded: boolean
  /** Rows follow the last one: the window is detached from the present. */
  hasNewer: boolean
}

/**
 * The window a jump lands in. `older` holds up to `beforeLimit` rows before the
 * target, `fromTarget` the target and up to `afterLimit` rows after it, read with
 * a limit of `afterLimit + 1`.
 */
export function jumpWindow<T extends Row>(
  older: readonly T[],
  fromTarget: readonly T[],
  beforeLimit: number,
  afterLimit: number,
): JumpWindow<T> {
  const ids = new Set(older.map(m => m.id))
  return {
    messages: [...older, ...fromTarget.filter(m => !ids.has(m.id))],
    allOlderLoaded: older.length < beforeLimit,
    hasNewer: fromTarget.length > afterLimit,
  }
}

/**
 * The window with a page toward the present appended. A page read with `limit`
 * that comes back short reached the newest message. Rows already held (the cursor
 * row read again through a millisecond cursor) are skipped.
 */
export function appendNewer<T extends Row>(
  window: readonly T[],
  page: readonly T[],
  limit: number,
): { messages: T[]; hasNewer: boolean } {
  const ids = new Set(window.map(m => m.id))
  return {
    messages: [...window, ...page.filter(m => !ids.has(m.id))],
    hasNewer: page.length >= limit,
  }
}

/**
 * `base` followed by the rows of `tail` newer than base's newest server row that
 * base lacks, then the pending rows of `tail` whatever their time: a client
 * clock behind the server's stamps a send before rows already shown.
 */
export function mergeTail<T extends Row>(base: readonly T[], tail: readonly T[]): T[] {
  const newest = newestPersisted(base)
  const after = newest ? rowTime(newest) : Number.NEGATIVE_INFINITY
  const ids = new Set(base.map(m => m.id))
  const persisted: T[] = []
  const pending: T[] = []
  for (const m of tail) {
    if (ids.has(m.id)) continue
    if (isPendingRow(m)) pending.push(m)
    else if (rowTime(m) > after) persisted.push(m)
    else continue
    ids.add(m.id)
  }
  persisted.sort((a, b) => rowTime(a) - rowTime(b))
  return [...base, ...persisted, ...pending]
}

/**
 * Whether a realtime row joins the window. A detached window takes rows inside
 * its range only, and the pending rows of a send, which return the view to the
 * present.
 */
export function acceptsLiveRow(window: readonly Row[], row: Row, detached: boolean): boolean {
  if (!detached || isPendingRow(row)) return true
  const newest = newestPersisted(window)
  return !!newest && rowTime(row) <= rowTime(newest)
}
