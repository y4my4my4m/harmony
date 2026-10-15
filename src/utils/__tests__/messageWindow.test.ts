import { describe, it, expect } from 'vitest'
import {
  acceptsLiveRow,
  appendNewer,
  cursorOf,
  jumpWindow,
  mergeTail,
  newestPersisted,
} from '@/utils/messageWindow'

const T0 = Date.parse('2026-10-01T00:00:00Z')

/** Row `n` of a channel, n minutes after T0. */
const row = (n: number, extra: Record<string, unknown> = {}) =>
  ({ id: `m${n}`, created_at: new Date(T0 + n * 60_000).toISOString(), ...extra }) as any

const rows = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => row(from + i))
const ids = (list: Array<{ id: string }>) => list.map(m => m.id)

describe('jumpWindow', () => {
  it('joins the rows before the target with the target and the rows after it', () => {
    const w = jumpWindow(rows(15, 39), rows(40, 65), 25, 25)
    expect(ids(w.messages)).toEqual(ids(rows(15, 65)))
    expect(w.allOlderLoaded).toBe(false)
    expect(w.hasNewer).toBe(true)
  })

  it('reaches the oldest message when fewer rows precede the target than were asked for', () => {
    const w = jumpWindow(rows(0, 3), rows(4, 29), 25, 25)
    expect(w.allOlderLoaded).toBe(true)
    expect(w.hasNewer).toBe(true)
  })

  it('reaches the newest message when no more than the asked rows follow the target', () => {
    const w = jumpWindow(rows(260, 284), rows(285, 299), 25, 25)
    expect(w.hasNewer).toBe(false)
    // The target and afterLimit rows fill the read of afterLimit + 1: a page toward the
    // present finds out whether more follow.
    expect(jumpWindow(rows(0, 24), rows(25, 50), 25, 25).hasNewer).toBe(true)
    expect(jumpWindow(rows(0, 24), rows(25, 49), 25, 25).hasNewer).toBe(false)
  })

  it('holds a row read by both halves once', () => {
    const w = jumpWindow(rows(10, 20), rows(20, 30), 25, 25)
    expect(ids(w.messages)).toEqual(ids(rows(10, 30)))
  })
})

describe('appendNewer', () => {
  it('appends a page and stays detached while pages come back full', () => {
    const next = appendNewer(rows(15, 65), rows(66, 115), 50)
    expect(ids(next.messages)).toEqual(ids(rows(15, 115)))
    expect(next.hasNewer).toBe(true)
  })

  it('reaches the present on a short page', () => {
    const next = appendNewer(rows(15, 265), rows(266, 299), 50)
    expect(next.hasNewer).toBe(false)
    expect(next.messages.at(-1)!.id).toBe('m299')
  })

  it('skips the cursor row read again through a millisecond cursor', () => {
    const next = appendNewer(rows(0, 10), rows(10, 12), 50)
    expect(ids(next.messages)).toEqual(ids(rows(0, 12)))
  })
})

describe('mergeTail', () => {
  it('adds the tail rows newer than the newest row and nothing older', () => {
    const merged = mergeTail(rows(260, 299), [...rows(280, 302)])
    expect(ids(merged)).toEqual(ids(rows(260, 302)))
  })

  it('ends with the pending rows whatever their time, once', () => {
    // A client clock behind the server's stamps the send before the newest row.
    const pending = row(250, { id: 'temp-1', sending: true })
    const merged = mergeTail(rows(260, 299), [pending, row(300), pending])
    expect(ids(merged)).toEqual([...ids(rows(260, 300)), 'temp-1'])
  })

  it('is the tail when the base is empty', () => {
    expect(ids(mergeTail([], rows(1, 3)))).toEqual(ids(rows(1, 3)))
  })
})

describe('acceptsLiveRow', () => {
  const window = rows(40, 90)

  it('takes every row while attached', () => {
    expect(acceptsLiveRow(window, row(300), false)).toBe(true)
  })

  it('keeps rows past the end of a detached window out', () => {
    expect(acceptsLiveRow(window, row(300), true)).toBe(false)
  })

  it('takes a row inside the range of a detached window', () => {
    expect(acceptsLiveRow(window, row(60, { id: 'late' }), true)).toBe(true)
  })

  it('takes the pending row of a send', () => {
    expect(acceptsLiveRow(window, row(300, { id: 'temp-9', sending: true }), true)).toBe(true)
  })
})

describe('cursors', () => {
  it('keeps the server string with its microseconds', () => {
    expect(cursorOf({ created_at: '2026-10-01T00:00:00.123456+00:00' })).toBe('2026-10-01T00:00:00.123456+00:00')
  })

  it('formats a Date', () => {
    expect(cursorOf({ created_at: new Date(T0) })).toBe('2026-10-01T00:00:00.000Z')
  })

  it('has none for a missing row', () => {
    expect(cursorOf(undefined)).toBeUndefined()
  })

  it('takes the newest server row, past pending rows', () => {
    const list = [...rows(1, 3), row(4, { id: 'temp-1', sending: true })]
    expect(newestPersisted(list)!.id).toBe('m3')
  })
})
