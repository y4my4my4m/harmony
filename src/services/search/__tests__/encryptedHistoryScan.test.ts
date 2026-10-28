import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EncryptedSearchIndex, deleteSearchIndex, type SpanEdge } from '../encryptedSearchIndex'
import {
  PAGE_INTERVAL_MS,
  PAGE_SIZE,
  RETRY_DELAYS_MS,
  messageEdge,
  microsIso,
  readableFloor,
  recordPage,
  scanHistory,
  timeMicros,
  type ScanDeps,
  type ScanRoom,
} from '../encryptedHistoryScan'
import { parseIndexQuery } from '@/utils/searchTokens'
import type { Message } from '@/types'

vi.mock('@/utils/messageDecryption', () => ({
  processMessageDecryption: vi.fn(async (rows: unknown[]) => rows),
}))

const PROFILE = 'aaaaaaaa-0000-4000-8000-000000000009'
const DM = 'bbbbbbbb-0000-4000-8000-000000000001'
const CHANNEL = 'bbbbbbbb-0000-4000-8000-000000000002'
const T0 = Date.UTC(2024, 0, 1)

/** Row as the database returns it, decrypted unless `unreadable`. */
function row(room: string, i: number, text: string, unreadable = false): Message {
  const iso = new Date(T0 + i * 3600_000).toISOString().replace('Z', '123+00:00')
  return {
    id: `${room.slice(0, 8)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
    conversation_id: room,
    created_at: iso as unknown as Date,
    content: [{ type: 'text', text }],
    encrypted: unreadable,
    decrypted: !unreadable,
  }
}

class History {
  rows = new Map<string, Message[]>()
  calls: Array<{ room: string; cursor: SpanEdge | null; after?: SpanEdge; rows: number }> = []
  byId: Array<{ room: string; ids: string[] }> = []
  failures = 0

  add(room: string, count: number, text: (i: number) => string, unreadable: (i: number) => boolean = () => false) {
    const list = this.rows.get(room) ?? []
    const start = list.length
    for (let i = start; i < start + count; i++) list.push(row(room, i, text(i), unreadable(i)))
    this.rows.set(room, list)
  }

  /** Keys for every row arrive: they read as decrypted from now on. */
  readAll(room: string) {
    this.rows.set(room, (this.rows.get(room) ?? []).map(m => ({ ...m, encrypted: false, decrypted: true })))
  }

  deps(index: EncryptedSearchIndex, sleep = vi.fn(async () => {})): ScanDeps & { sleep: typeof sleep } {
    return {
      index,
      sleep,
      record: recordPage,
      loadPinnedBefore: async () => [],
      loadPage: async (room: ScanRoom, cursor: SpanEdge | null, limit: number, after?: SpanEdge) => {
        if (this.failures > 0) {
          this.calls.push({ room: room.room, cursor, after, rows: 0 })
          this.failures--
          throw new Error('503')
        }
        const all = [...(this.rows.get(room.room) ?? [])].reverse()
        const page = all
          .filter(m => {
            const e = messageEdge(m)
            if (room.floor !== undefined && e.at < room.floor) return false
            if (after && !(e.at > after.at || (e.at === after.at && e.id > after.id))) return false
            if (!cursor) return true
            return e.at < cursor.at || (cursor.id !== '' && e.at === cursor.at && e.id < cursor.id)
          })
          .slice(0, limit)
        this.calls.push({ room: room.room, cursor, after, rows: page.length })
        return page
      },
      loadMessages: async (room: ScanRoom, ids: string[]) => {
        this.byId.push({ room: room.room, ids })
        const wanted = new Set(ids)
        return (this.rows.get(room.room) ?? []).filter(m => wanted.has(m.id))
      },
    }
  }
}

async function texts(index: EncryptedSearchIndex, q: string, rooms = [DM]) {
  const { hits } = await index.search(parseIndexQuery(q), { rooms, accept: () => true, limit: 1000 })
  return hits.map(h => (h.message.content[0] as { text: string }).text)
}

describe('time edges', () => {
  it('keeps microseconds of PostgREST timestamps', () => {
    const us = timeMicros('2026-10-28T12:00:00.123456+00:00')
    expect(us % 1000).toBe(456)
    expect(microsIso(us)).toBe('2026-10-28T12:00:00.123456Z')
    expect(timeMicros('2026-10-28T12:00:00+00:00') % 1_000_000).toBe(0)
  })
})

describe('scanHistory', () => {
  let index: EncryptedSearchIndex
  let history: History
  const dm: ScanRoom = { room: DM, kind: 'conversation' }

  beforeEach(async () => {
    await deleteSearchIndex(PROFILE)
    index = (await EncryptedSearchIndex.open(PROFILE, await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])))!
    history = new History()
  })

  afterEach(async () => {
    index.close()
    await deleteSearchIndex(PROFILE)
  })

  it('pages back to the start and finds the oldest message', async () => {
    history.add(DM, 350, i => (i === 0 ? 'the needle at the very start' : `filler message ${i}`))
    const deps = history.deps(index)
    const progress: Array<number | null> = []
    expect(await scanHistory([dm], deps, { onProgress: p => progress.push(p.reachedAt) })).toBe('done')
    expect(history.calls).toHaveLength(Math.ceil(350 / PAGE_SIZE))
    expect(await texts(index, 'needle')).toEqual(['the needle at the very start'])
    // Progress moves back in time.
    const dates = progress.filter((p): p is number => p !== null)
    expect(dates.length).toBeGreaterThan(1)
    expect([...dates].sort((a, b) => b - a)).toEqual(dates)
  })

  it('a second crawl reads one empty page above the read span and nothing older', async () => {
    history.add(DM, 350, i => `filler ${i}`)
    await scanHistory([dm], history.deps(index))
    history.calls = []
    expect(await scanHistory([dm], history.deps(index))).toBe('done')
    expect(history.calls).toEqual([
      { room: DM, cursor: null, after: messageEdge(history.rows.get(DM)![349]), rows: 0 },
    ])
  })

  it('a later crawl reads the new messages and stops at the read span', async () => {
    history.add(DM, 250, i => `old ${i}`)
    await scanHistory([dm], history.deps(index))
    history.add(DM, 150, i => (i === 300 ? 'fresh needle' : `new ${i}`))
    history.calls = []
    expect(await scanHistory([dm], history.deps(index))).toBe('done')
    // 150 new rows: two pages, the second ending at the old span.
    expect(history.calls.map(c => c.rows)).toEqual([PAGE_SIZE, 50])
    expect(history.calls.every(c => c.after?.id === history.rows.get(DM)![249].id)).toBe(true)
    expect(await texts(index, 'needle')).toEqual(['fresh needle'])
  })

  it('stops when asked and resumes where it stopped', async () => {
    history.add(DM, 500, i => (i === 1 ? 'deep needle' : `filler ${i}`))
    const ctrl = new AbortController()
    const deps = history.deps(index)
    expect(await scanHistory([dm], deps, { signal: ctrl.signal, onPage: () => ctrl.abort() })).toBe('stopped')
    expect(history.calls).toHaveLength(1)
    expect(await texts(index, 'needle')).toEqual([])

    history.calls = []
    expect(await scanHistory([dm], history.deps(index))).toBe('done')
    // Nothing newer than the read span, then from where the first crawl stopped.
    expect(history.calls[0]).toMatchObject({ cursor: null, rows: 0 })
    expect(history.calls[1].cursor).toEqual(messageEdge(history.rows.get(DM)![500 - PAGE_SIZE]))
    // 400 older rows fill four pages; an empty fifth ends the history.
    expect(history.calls).toHaveLength(1 + (500 - PAGE_SIZE) / PAGE_SIZE + 1)
    expect(await texts(index, 'needle')).toEqual(['deep needle'])
  })

  it('waits between pages', async () => {
    history.add(DM, 250, i => `filler ${i}`)
    const deps = history.deps(index)
    await scanHistory([dm], deps)
    // The first page goes at once; each later one waits out the interval.
    expect(deps.sleep).toHaveBeenCalledTimes(2)
    for (const [ms] of deps.sleep.mock.calls as unknown as Array<[number]>) {
      expect(ms).toBeGreaterThan(0)
      expect(ms).toBeLessThanOrEqual(PAGE_INTERVAL_MS)
    }
  })

  it('backs off on failures, then gives up', async () => {
    history.add(DM, 50, i => `filler ${i}`)
    history.failures = 2
    const deps = history.deps(index)
    expect(await scanHistory([dm], deps)).toBe('done')
    expect(deps.sleep.mock.calls.map(c => (c as unknown as [number])[0])).toEqual(expect.arrayContaining([RETRY_DELAYS_MS[0], RETRY_DELAYS_MS[1]]))

    const again = new History()
    again.add(CHANNEL, 50, () => 'x')
    again.failures = 99
    const failing = again.deps(index)
    expect(await scanHistory([{ room: CHANNEL, kind: 'channel' }], failing)).toBe('error')
    expect(again.calls).toHaveLength(RETRY_DELAYS_MS.length + 1)
  })

  it('stops at the readable start', async () => {
    history.add(DM, 300, i => (i < 100 ? `before join ${i}` : `after join ${i}`), i => i < 100)
    const floor = messageEdge(history.rows.get(DM)![100]).at
    expect(await scanHistory([{ ...dm, floor }], history.deps(index))).toBe('done')
    expect(await index.unreadable([DM])).toHaveLength(0)
    expect((await texts(index, 'after')).length).toBe(200)
  })

  it('names messages it cannot decrypt', async () => {
    history.add(DM, 120, i => `message ${i}`, i => i % 10 === 0)
    await scanHistory([dm], history.deps(index))
    expect(await index.unreadable([DM])).toHaveLength(12)
    expect((await texts(index, 'message')).length).toBe(108)
  })

  it('reads unreadable messages again once a key arrives for their room', async () => {
    history.add(DM, 120, i => `message ${i}`, i => i % 10 === 0)
    await scanHistory([dm], history.deps(index))
    expect(await index.unreadable([DM])).toHaveLength(12)

    // No key arrived: nothing is read again.
    history.byId = []
    history.readAll(DM)
    await scanHistory([dm], history.deps(index))
    expect(history.byId).toEqual([])
    expect(await index.unreadable([DM])).toHaveLength(12)

    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: DM, sessionId: 's' } }))
    const onPage = vi.fn()
    expect(await scanHistory([dm], history.deps(index), { onPage })).toBe('done')
    expect(history.byId).toHaveLength(1)
    expect(history.byId[0].ids).toHaveLength(12)
    expect(onPage).toHaveBeenCalled()
    expect(await index.unreadable([DM])).toHaveLength(0)
    expect((await texts(index, 'message')).length).toBe(120)
  })

  it('a key arriving during a crawl is tried before the crawl ends', async () => {
    history.add(DM, 50, i => `message ${i}`, i => i < 5)
    const deps = history.deps(index)
    const load = deps.loadPage
    deps.loadPage = async (...args) => {
      const page = await load(...args)
      history.readAll(DM)
      window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: DM, sessionId: 's' } }))
      return page
    }
    expect(await scanHistory([dm], deps)).toBe('done')
    expect(await index.unreadable([DM])).toHaveLength(0)
  })

  it('a key for another room leaves this room alone', async () => {
    history.add(DM, 20, i => `message ${i}`, i => i < 5)
    await scanHistory([dm], history.deps(index))
    history.byId = []
    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: CHANNEL, sessionId: 's' } }))
    await scanHistory([dm], history.deps(index))
    expect(history.byId).toEqual([])
  })

  it('drops unreadable messages the server no longer returns', async () => {
    history.add(DM, 20, i => `message ${i}`, i => i < 5)
    await scanHistory([dm], history.deps(index))
    history.rows.set(DM, history.rows.get(DM)!.slice(2))
    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
    await scanHistory([dm], history.deps(index))
    expect(await index.unreadable([DM])).toHaveLength(3)
  })

  it('advances rooms together, newest crawl first', async () => {
    history.add(DM, 150, i => `dm ${i}`)
    history.add(CHANNEL, 150, i => `channel ${i}`)
    const rooms: ScanRoom[] = [dm, { room: CHANNEL, kind: 'channel' }]
    expect(await scanHistory(rooms, history.deps(index))).toBe('done')
    expect(history.calls.map(c => c.room)).toEqual([DM, CHANNEL, DM, CHANNEL])
  })
})

describe('readableFloor', () => {
  it('looks up the join once for the channels of one server', async () => {
    const SERVER = 'dddddddd-0000-4000-8000-000000000001'
    const tables: string[] = []
    const { supabase } = await import('@/supabase')
    vi.mocked(supabase.from).mockImplementation((table: string) => {
      tables.push(table)
      const chain: Record<string, unknown> = {}
      for (const name of ['select', 'eq']) chain[name] = () => chain
      chain.maybeSingle = async () => ({ data: { created_at: '2026-01-02T03:04:05.678901+00:00' }, error: null })
      return chain as never
    })
    const channel = (room: string) => readableFloor({ kind: 'channel', room, profileId: PROFILE, serverId: SERVER, visibility: 'none' })

    const floors = await Promise.all(['c1', 'c2', 'c3'].map(channel))
    const later = await channel('c4')

    expect(tables).toEqual(['user_servers'])
    for (const floor of [...floors, later]) expect(floor).toEqual({ floor: timeMicros('2026-01-02T03:04:05.678901+00:00') })
  })
})

describe('loadHistoryPage', () => {
  it('pages by (created_at, id) with microseconds, newest first, deleted rows out', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'not', 'order', 'limit', 'eq', 'gte', 'or', 'lt']) {
      chain[name] = (...args: unknown[]) => {
        calls.push([name, ...args])
        return chain
      }
    }
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null })
    const { supabase } = await import('@/supabase')
    vi.mocked(supabase.from).mockReturnValue(chain as never)
    const { loadHistoryPage } = await import('../encryptedHistoryScan')
    const cursor = { at: timeMicros('2025-02-03T04:05:06.789012+00:00'), id: 'cccccccc-0000-4000-8000-000000000001' }
    await loadHistoryPage({ room: DM, kind: 'conversation', floor: timeMicros('2025-01-01T00:00:00+00:00') }, cursor, PAGE_SIZE)
    expect(supabase.from).toHaveBeenCalledWith('messages')
    expect(calls).toContainEqual(['not', 'is_deleted', 'is', true])
    expect(calls).toContainEqual(['eq', 'conversation_id', DM])
    expect(calls).toContainEqual(['order', 'created_at', { ascending: false }])
    expect(calls).toContainEqual(['order', 'id', { ascending: false }])
    expect(calls).toContainEqual(['gte', 'created_at', '2025-01-01T00:00:00.000000Z'])
    expect(calls).toContainEqual(['or', `created_at.lt.2025-02-03T04:05:06.789012Z,and(created_at.eq.2025-02-03T04:05:06.789012Z,id.lt.${cursor.id})`])
    expect(calls).toContainEqual(['limit', PAGE_SIZE])
  })

  it('ends at a read span and decrypts with held keys only', async () => {
    const calls: Array<[string, ...unknown[]]> = []
    const chain: Record<string, unknown> = {}
    for (const name of ['select', 'not', 'order', 'limit', 'eq', 'gte', 'or', 'lt', 'in']) {
      chain[name] = (...args: unknown[]) => {
        calls.push([name, ...args])
        return chain
      }
    }
    const rows = [row(DM, 1, 'x', true)]
    chain.then = (resolve: (v: unknown) => void) => resolve({ data: rows, error: null })
    const { supabase } = await import('@/supabase')
    vi.mocked(supabase.from).mockReturnValue(chain as never)
    const { processMessageDecryption } = await import('@/utils/messageDecryption')
    const { loadHistoryPage, loadMessagesById } = await import('../encryptedHistoryScan')
    const after = { at: timeMicros('2025-02-03T04:05:06.789012+00:00'), id: 'cccccccc-0000-4000-8000-000000000002' }

    await loadHistoryPage({ room: DM, kind: 'conversation' }, null, PAGE_SIZE, after)
    expect(calls).toContainEqual(['or', `created_at.gt.2025-02-03T04:05:06.789012Z,and(created_at.eq.2025-02-03T04:05:06.789012Z,id.gt.${after.id})`])
    expect(processMessageDecryption).toHaveBeenLastCalledWith(rows, { index: false, heldKeysOnly: true })

    calls.length = 0
    await loadMessagesById({ room: CHANNEL, kind: 'channel' }, ['a', 'b'])
    expect(calls).toContainEqual(['in', 'id', ['a', 'b']])
    expect(calls).toContainEqual(['eq', 'channel_id', CHANNEL])
    expect(processMessageDecryption).toHaveBeenLastCalledWith(rows, { index: false, heldKeysOnly: true })
  })
})
