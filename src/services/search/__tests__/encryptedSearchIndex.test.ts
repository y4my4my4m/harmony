import 'fake-indexeddb/auto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  EncryptedSearchIndex,
  INDEX_DB_PREFIX,
  deleteSearchIndex,
  mergeSpans,
  type HistorySpan,
} from '../encryptedSearchIndex'
import { parseIndexQuery, prepareText, matchScore, searchableText } from '@/utils/searchTokens'
import type { Message } from '@/types'

const PROFILE = 'aaaaaaaa-0000-4000-8000-000000000001'
const ROOM = 'bbbbbbbb-0000-4000-8000-000000000001'
const OTHER_ROOM = 'bbbbbbbb-0000-4000-8000-000000000002'

const storageKey = () => crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])

function message(id: number, text: string, room = ROOM, at = Date.UTC(2025, 0, 1) + id * 60000): Message {
  return {
    id: `cccccccc-0000-4000-8000-${String(id).padStart(12, '0')}`,
    conversation_id: room,
    user_id: 'dddddddd-0000-4000-8000-000000000001',
    created_at: new Date(at),
    content: [{ type: 'text', text }],
    encrypted: false,
    decrypted: true,
  }
}

const entry = (m: Message) => ({ message: m, text: searchableText(m.content) })

async function find(index: EncryptedSearchIndex, q: string, rooms = [ROOM]) {
  const query = parseIndexQuery(q)
  const { hits } = await index.search(query, {
    rooms,
    accept: m => matchScore(query, prepareText(searchableText(m.content))) > 0,
    limit: 100,
  })
  return hits.map(h => (h.message.content[0] as { text: string }).text)
}

/** Every record of every store, as structured-clone values. */
function dump(): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open(INDEX_DB_PREFIX + PROFILE)
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const names = [...db.objectStoreNames]
      const tx = db.transaction(names, 'readonly')
      const out: unknown[] = []
      for (const name of names) {
        const all = tx.objectStore(name).getAll()
        all.onsuccess = () => out.push(...all.result)
      }
      tx.oncomplete = () => {
        db.close()
        resolve(out)
      }
    }
  })
}

function strings(value: unknown, out: string[] = []): string[] {
  if (typeof value === 'string') out.push(value)
  else if (value instanceof ArrayBuffer) out.push(new TextDecoder().decode(value))
  else if (ArrayBuffer.isView(value)) out.push(new TextDecoder().decode(value as Uint8Array))
  else if (Array.isArray(value)) value.forEach(v => strings(v, out))
  else if (value && typeof value === 'object') Object.values(value).forEach(v => strings(v, out))
  return out
}

describe('EncryptedSearchIndex', () => {
  let key: CryptoKey
  let index: EncryptedSearchIndex

  beforeEach(async () => {
    await deleteSearchIndex(PROFILE)
    key = await storageKey()
    index = (await EncryptedSearchIndex.open(PROFILE, key))!
    expect(index).not.toBeNull()
  })

  afterEach(async () => {
    index.close()
    await deleteSearchIndex(PROFILE)
  })

  it('finds indexed messages by word prefix and Japanese', async () => {
    await index.add([
      entry(message(1, 'the quarterly budget is final')),
      entry(message(2, '来週の金曜日に東京タワーへ行きましょう')),
      entry(message(3, 'nothing to see here')),
    ])
    expect(await find(index, 'budg')).toEqual(['the quarterly budget is final'])
    expect(await find(index, 'タワー')).toEqual(['来週の金曜日に東京タワーへ行きましょう'])
    expect(await find(index, 'budget tower')).toEqual([])
  })

  it('keeps no plain text, term or word at rest', async () => {
    const secret = 'zebraphone 秘密の合言葉'
    const m = message(1, secret)
    await index.add([entry(m)])
    const stored = strings(await dump()).join('\n')
    for (const needle of ['zebraphone', 'zebra', 'w:ze', '秘密', '合言葉', 'c:秘']) {
      expect(stored).not.toContain(needle)
    }
    // Control: the id travels in the clear, so the dump does reach the records.
    expect(stored).toContain(m.id)
    expect(await find(index, 'zebra')).toEqual([secret])
  })

  it('reopens under the same storage key', async () => {
    await index.add([entry(message(1, 'persistent words'))])
    index.close()
    index = (await EncryptedSearchIndex.open(PROFILE, key))!
    expect(await find(index, 'persist')).toEqual(['persistent words'])
  })

  it('starts empty under another storage key', async () => {
    await index.add([entry(message(1, 'persistent words'))])
    index.close()
    index = (await EncryptedSearchIndex.open(PROFILE, await storageKey()))!
    expect(await find(index, 'persist')).toEqual([])
  })

  it('replaces the terms of an edited message', async () => {
    const m = message(1, 'original wording')
    await index.add([entry(m)])
    await index.add([entry({ ...m, content: [{ type: 'text', text: 'edited phrasing' }] })])
    expect(await find(index, 'original')).toEqual([])
    expect(await find(index, 'phras')).toEqual(['edited phrasing'])
  })

  it('removes messages', async () => {
    const a = message(1, 'alpha one')
    const b = message(2, 'alpha two')
    await index.add([entry(a), entry(b)])
    await index.remove([a.id])
    expect(await find(index, 'alpha')).toEqual(['alpha two'])
  })

  it('searches only the rooms asked for', async () => {
    await index.add([entry(message(1, 'shared word', ROOM)), entry(message(2, 'shared word elsewhere', OTHER_ROOM))])
    expect(await find(index, 'shared')).toEqual(['shared word'])
    expect((await find(index, 'shared', [ROOM, OTHER_ROOM])).sort()).toEqual(['shared word', 'shared word elsewhere'])
  })

  it('sorts newest first and honours the date range', async () => {
    await index.add([1, 2, 3].map(i => entry(message(i, `note ${i}`))))
    const query = parseIndexQuery('note')
    const { hits } = await index.search(query, {
      rooms: [ROOM],
      from: Date.UTC(2025, 0, 1) + 2 * 60000,
      accept: () => true,
      limit: 10,
    })
    expect(hits.map(h => (h.message.content[0] as { text: string }).text)).toEqual(['note 3', 'note 2'])
  })

  it('counts unreadable messages until they decrypt', async () => {
    const m = message(1, 'later readable')
    await index.markUnreadable([m])
    expect(await index.unreadable([ROOM])).toHaveLength(1)
    await index.add([entry(m)])
    expect(await index.unreadable([ROOM])).toHaveLength(0)
  })

  it('stores read spans merged', async () => {
    await index.addSpan(ROOM, { lo: { at: 50, id: 'b' }, hi: { at: 100, id: 'z' } })
    await index.addSpan(ROOM, { lo: { at: 10, id: 'a' }, hi: { at: 50, id: 'b' } })
    expect(await index.spans(ROOM)).toEqual([{ lo: { at: 10, id: 'a' }, hi: { at: 100, id: 'z' } }])
  })

  it('adds without reading a posting', async () => {
    await index.add(Array.from({ length: 50 }, (_, i) => entry(message(i, `the thing number ${i}`))))
    const reads = (['get', 'getAll', 'getAllKeys', 'getKey', 'openCursor', 'openKeyCursor', 'count'] as const)
      .map(method => vi.spyOn(IDBObjectStore.prototype, method))
    try {
      await index.add([entry(message(60, 'the thing again')), entry(message(61, 'then there'))])
      const postingReads = reads.flatMap(spy => spy.mock.contexts).filter(store => (store as IDBObjectStore).name === 'postings')
      expect(postingReads).toHaveLength(0)
    } finally {
      reads.forEach(spy => spy.mockRestore())
    }
    expect(await find(index, 'then')).toEqual(['then there'])
  })

  it('writes nothing for a message indexed again unchanged', async () => {
    const batch = Array.from({ length: 20 }, (_, i) => entry(message(i, `the thing number ${i}`)))
    await index.add(batch)
    const writes = (['put', 'add', 'delete', 'clear'] as const).map(method => vi.spyOn(IDBObjectStore.prototype, method))
    try {
      await index.add(batch)
      expect(writes.reduce((sum, spy) => sum + spy.mock.calls.length, 0)).toBe(0)
      await index.add([entry({ ...message(3, 'the thing number 3'), is_pinned: true })])
      // A changed payload rewrites the doc alone.
      const [put] = writes
      expect(put.mock.contexts.filter(store => (store as IDBObjectStore).name === 'docs')).toHaveLength(1)
      expect(writes.flatMap(spy => spy.mock.contexts).filter(store => (store as IDBObjectStore).name === 'postings')).toHaveLength(0)
    } finally {
      writes.forEach(spy => spy.mockRestore())
    }
    expect(await find(index, 'number')).toHaveLength(20)
  })

  it('opens only the messages a search returns', async () => {
    await index.add(Array.from({ length: 120 }, (_, i) => entry(message(i, `common word ${i}`))))
    const get = vi.spyOn(IDBObjectStore.prototype, 'get')
    try {
      const query = parseIndexQuery('common')
      const { hits, capped } = await index.search(query, { rooms: [ROOM], accept: () => true, limit: 10 })
      expect(hits.map(h => (h.message.content[0] as { text: string }).text)).toEqual(
        Array.from({ length: 10 }, (_, i) => `common word ${119 - i}`))
      expect(capped).toBe(true)
      const docReads = get.mock.contexts.filter(store => (store as IDBObjectStore).name === 'docs')
      expect(docReads.length).toBeLessThanOrEqual(50)
    } finally {
      get.mockRestore()
    }
  })

  it('merges rooms by time inside a window', async () => {
    const at = (minute: number) => Date.UTC(2025, 0, 1) + minute * 60000
    await index.add([
      entry(message(1, 'deploy one', ROOM, at(1))),
      entry(message(2, 'deploy two', OTHER_ROOM, at(2))),
      entry(message(3, 'deploy three', ROOM, at(3))),
      entry(message(4, 'deploy four', OTHER_ROOM, at(4))),
      entry(message(5, 'deploy five', ROOM, at(5))),
    ])
    const query = parseIndexQuery('deploy')
    const window = (ascending: boolean) => index.search(query, {
      rooms: [ROOM, OTHER_ROOM], from: at(2), to: at(4), ascending, accept: () => true, limit: 10,
    }).then(r => r.hits.map(h => (h.message.content[0] as { text: string }).text))
    expect(await window(false)).toEqual(['deploy four', 'deploy three', 'deploy two'])
    expect(await window(true)).toEqual(['deploy two', 'deploy three', 'deploy four'])
  })

  it('leaves no posting behind after edits and removal', async () => {
    const a = message(1, 'alpha beta')
    const b = message(2, 'gamma')
    await index.add([entry(a), entry(b)])
    await index.add([entry({ ...a, content: [{ type: 'text', text: 'alpha delta' }] })])
    expect(await find(index, 'beta')).toEqual([])
    expect(await find(index, 'delta')).toEqual(['alpha delta'])
    await index.remove([a.id, b.id])
    const rows = await new Promise<number>((resolve, reject) => {
      const open = indexedDB.open(INDEX_DB_PREFIX + PROFILE)
      open.onerror = () => reject(open.error)
      open.onsuccess = () => {
        const count = open.result.transaction('postings', 'readonly').objectStore('postings').count()
        count.onsuccess = () => {
          open.result.close()
          resolve(count.result)
        }
      }
    })
    expect(rows).toBe(0)
  })

  it('is gone after deleteSearchIndex', async () => {
    await index.add([entry(message(1, 'before sign out'))])
    await deleteSearchIndex(PROFILE)
    expect(index.isClosed).toBe(true)
    index = (await EncryptedSearchIndex.open(PROFILE, key))!
    expect(await find(index, 'sign')).toEqual([])
  })
})

describe('EncryptedSearchIndex upgrade', () => {
  it('drops a version 1 store with its spans and starts empty', async () => {
    await deleteSearchIndex(PROFILE)
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open(INDEX_DB_PREFIX + PROFILE, 1)
      open.onerror = () => reject(open.error)
      open.onupgradeneeded = () => {
        const db = open.result
        db.createObjectStore('meta', { keyPath: 'k' })
        const docs = db.createObjectStore('docs', { keyPath: 'n', autoIncrement: true })
        docs.createIndex('id', 'id', { unique: true })
        docs.createIndex('room_at', ['room', 'at'])
        db.createObjectStore('postings', { keyPath: 't' }).put({ t: 'old', d: [1] })
        db.createObjectStore('spans', { keyPath: 'room' }).put({ room: ROOM, spans: [{ lo: null, hi: { at: 1, id: 'z' } }] })
        db.createObjectStore('unreadable', { keyPath: 'id' }).createIndex('room_at', ['room', 'at'])
      }
      open.onsuccess = () => {
        open.result.close()
        resolve()
      }
    })
    const index = (await EncryptedSearchIndex.open(PROFILE, await storageKey()))!
    try {
      expect(await index.spans(ROOM)).toEqual([])
      await index.add([entry(message(1, 'after the upgrade'))])
      expect(await find(index, 'upgr')).toEqual(['after the upgrade'])
    } finally {
      index.close()
      await deleteSearchIndex(PROFILE)
    }
  })
})

describe('mergeSpans', () => {
  const span = (lo: number | null, hi: number, floor?: number): HistorySpan => ({
    lo: lo === null ? null : { at: lo, id: 'm' },
    hi: { at: hi, id: 'm' },
    ...(floor !== undefined ? { floor } : {}),
  })

  it('merges touching spans and keeps gaps', () => {
    expect(mergeSpans([span(1, 2), span(2, 5), span(7, 9)])).toEqual([span(7, 9), span(1, 5)])
  })

  it('a span to the start absorbs those inside it', () => {
    expect(mergeSpans([span(null, 10), span(3, 6)])).toEqual([span(null, 10)])
  })

  it('a span below a floor extends one that stopped at it', () => {
    const merged = mergeSpans([span(null, 10, 5), { lo: { at: 1, id: 'm' }, hi: { at: 5, id: '' } }])
    expect(merged).toEqual([span(1, 10)])
  })
})
