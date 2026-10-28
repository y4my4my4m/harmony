/**
 * On-device index of decrypted messages, per account (profile id) and device, in IndexedDB
 * `harmony_search_index_<profileId>`.
 *
 * Role of Element's Seshat (Tantivy, desktop): messages this device decrypted are indexed as
 * they decrypt, a crawl of room history fills the rest (encryptedHistoryScan.ts) and records
 * how far it got per room, results come from the device, and the store is encrypted at rest
 * and deleted on sign-out. Differences: IndexedDB on every platform, Tauri included (one code
 * path; the webviews keep IndexedDB in the app data directory); terms from utils/searchTokens
 * (word prefixes, CJK bigrams) instead of Tantivy's tokenizers; no BM25, results sort by time.
 *
 * At rest:
 *   meta['key']   64 random bytes sealed with AES-GCM under the account storage key (the
 *                 recovery-phrase key that also seals megolm sessions, MegolmService.storageKey),
 *                 AAD `harmony-search-index:v1:<profileId>`. Bytes 0-31: HMAC-SHA-256 term key;
 *                 32-63: AES-256-GCM content key. Imported non-extractable.
 *   meta['seq']   last batch number.
 *   rooms         r (auto) <-> room id.
 *   postings      t = base64url(HMAC(term))[0..16] (96 bits). One row per batch, room and
 *                 first character of t, keyed [t[0], r, s]: { t: [n, at, n, at, ...] } for the
 *                 batch's messages. A batch of new messages writes at most 64 rows per room
 *                 and reads none; a search reads the rows of its terms' buckets and opens only
 *                 the messages it returns. Indexing 100 more messages beside 10,000 (src/locales
 *                 strings: 2,100 postings, 1,417 terms), Chromium 1248 headless: 4 ms; a row
 *                 per term and batch 490 ms, a list per term (version 1) 634 ms, a row per term
 *                 and message 860 ms.
 *   docs          n (auto), id, room, r, s (batch), at (created_at ms), terms (hashes), ph
 *                 (payload hash), iv + blob = AES-GCM(JSON of the decrypted fields), AAD =
 *                 message id. A message indexed again unchanged writes nothing.
 *   spans         room -> history ranges the crawl read in full, newest first.
 *   unreadable    message ids the crawl could not decrypt, with room and time.
 * Plain text, words and terms never reach IndexedDB. Room ids, message ids, authors' ids and
 * times are stored in the clear; the server holds the same. Equal term hashes show which
 * messages share a term.
 */

import { debug } from '@/utils/debug'
import { indexTerms, type IndexQuery } from '@/utils/searchTokens'
import type { Message, MessagePart } from '@/types'

export const INDEX_DB_PREFIX = 'harmony_search_index_'
/** 2: posting rows per batch, rooms. Version 1 stores are dropped, not converted. */
const DB_VERSION = 2
const KEY_INFO = 'harmony-search-index:v1:'
const HASH_CHARS = 16
const HASH_CACHE_MAX = 50000

/** Inclusive end of a span: a message's created_at in microseconds and its id, ordered (at, id). */
export interface SpanEdge {
  at: number
  id: string
}

/**
 * Messages of a room from `lo` to `hi`, both inclusive, as the crawl read them. lo null: the
 * span reaches the start of the room's history, or `floor` when set.
 */
export interface HistorySpan {
  lo: SpanEdge | null
  hi: SpanEdge
  /** The readable start the crawl stopped at, microseconds; only with lo null. */
  floor?: number
}

export interface IndexedHit {
  message: Message
  at: number
}

interface DocRecord {
  n?: number
  id: string
  room: string
  r?: number
  s?: number
  at: number
  terms: string[]
  /** HMAC of the payload; terms are 'w:' or 'c:', the payload 'p:'. */
  ph: string
  iv: Uint8Array
  blob: ArrayBuffer
}

interface DocPayload {
  content: MessagePart[]
  user_id?: string
  bot_id?: string
  channel_id?: string
  conversation_id?: string
  thread_id?: string
  created_at: string
  updated_at?: string
  is_pinned?: boolean
  sender_verified?: boolean
  metadata?: Message['metadata']
}

interface Keys {
  hmac: CryptoKey
  aes: CryptoKey
}

export function compareEdge(a: SpanEdge, b: SpanEdge): number {
  return a.at - b.at || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
}

/** Lowest edge a span covers; null: the start of the room. A floor is (floor, ''). */
function lowEdge(span: HistorySpan): SpanEdge | null {
  if (span.lo) return span.lo
  return span.floor !== undefined ? { at: span.floor, id: '' } : null
}

/** Sorted newest first, overlapping or touching spans merged. */
export function mergeSpans(spans: HistorySpan[]): HistorySpan[] {
  const sorted = [...spans].sort((a, b) => compareEdge(b.hi, a.hi))
  const out: HistorySpan[] = []
  for (const span of sorted) {
    const last = out[out.length - 1]
    const lastLow = last ? lowEdge(last) : undefined
    if (last && (lastLow === null || compareEdge(span.hi, lastLow!) >= 0)) {
      const low = lowEdge(span)
      if (lastLow !== null && (low === null || compareEdge(low, lastLow!) < 0)) {
        last.lo = span.lo
        if (span.lo === null && span.floor !== undefined) last.floor = span.floor
        else delete last.floor
      }
      continue
    }
    out.push({ ...span })
  }
  return out
}

function req<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error)
  })
}

function done(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error ?? new Error('Search index transaction aborted'))
  })
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function base64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

/** Posting row key: first character of its term hashes, room number, batch number. */
type RowKey = [string, number, number]
/** Term hash -> doc numbers and created_at ms, interleaved. */
type PostingRow = Record<string, number[]>
/** Doc numbers to take out of posting rows, by row and term hash. */
type Drops = Map<string, { key: RowKey; terms: Map<string, Set<number>> }>

const rowId = (key: RowKey) => key.join('|')

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Search index open blocked'))
    request.onupgradeneeded = (event) => {
      const db = request.result
      // Spans name history whose messages are indexed: they go with the docs.
      if (event.oldVersion < 2) {
        for (const store of ['docs', 'postings', 'spans', 'unreadable']) {
          if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store)
        }
      }
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' })
      if (!db.objectStoreNames.contains('docs')) {
        const docs = db.createObjectStore('docs', { keyPath: 'n', autoIncrement: true })
        docs.createIndex('id', 'id', { unique: true })
        docs.createIndex('room_at', ['room', 'at'])
      }
      if (!db.objectStoreNames.contains('rooms')) {
        const rooms = db.createObjectStore('rooms', { keyPath: 'r', autoIncrement: true })
        rooms.createIndex('room', 'room', { unique: true })
      }
      if (!db.objectStoreNames.contains('postings')) db.createObjectStore('postings')
      if (!db.objectStoreNames.contains('spans')) db.createObjectStore('spans', { keyPath: 'room' })
      if (!db.objectStoreNames.contains('unreadable')) {
        const unreadable = db.createObjectStore('unreadable', { keyPath: 'id' })
        unreadable.createIndex('room_at', ['room', 'at'])
      }
    }
    request.onsuccess = () => resolve(request.result)
  })
}

function deleteDb(name: string): Promise<void> {
  return new Promise((resolve) => {
    const request = indexedDB.deleteDatabase(name)
    request.onsuccess = () => resolve()
    request.onerror = () => resolve()
    request.onblocked = () => resolve()
  })
}

async function sealedKeys(db: IDBDatabase, profileId: string, storageKey: CryptoKey): Promise<Keys | null> {
  const aad = utf8(KEY_INFO + profileId)
  const read = db.transaction('meta', 'readonly')
  let meta = await req(read.objectStore('meta').get('key')) as { iv: Uint8Array; sealed: ArrayBuffer } | undefined
  if (!meta) {
    const raw = crypto.getRandomValues(new Uint8Array(64))
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const sealed = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: aad }, storageKey, raw)
    raw.fill(0)
    const write = db.transaction('meta', 'readwrite')
    // add(): a second tab sealing its own key at the same moment fails here and reads the first.
    write.objectStore('meta').add({ k: 'key', iv, sealed, created: Date.now() })
    await done(write).catch(() => {})
    meta = await req(db.transaction('meta', 'readonly').objectStore('meta').get('key'))
    if (!meta) return null
  }
  let raw: Uint8Array
  try {
    raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: meta.iv, additionalData: aad }, storageKey, meta.sealed))
  } catch {
    return null
  }
  try {
    const hmac = await crypto.subtle.importKey('raw', raw.slice(0, 32), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const aes = await crypto.subtle.importKey('raw', raw.slice(32, 64), { name: 'AES-GCM' }, false, ['encrypt', 'decrypt'])
    return { hmac, aes }
  } finally {
    raw.fill(0)
  }
}

export class EncryptedSearchIndex {
  private hashCache = new Map<string, string>()
  /** Committed room numbers; an assignment never changes once committed. */
  private roomCache = new Map<string, number>()
  private writes: Promise<void> = Promise.resolve()
  private closed = false

  private constructor(
    readonly profileId: string,
    private db: IDBDatabase,
    private keys: Keys,
  ) {
    db.onversionchange = () => this.close()
  }

  /**
   * Opens the account's index with the account storage key. A store sealed under another key
   * (encryption reset on this device) is deleted and started again. Null when IndexedDB fails.
   */
  static async open(profileId: string, storageKey: CryptoKey): Promise<EncryptedSearchIndex | null> {
    const name = INDEX_DB_PREFIX + profileId
    try {
      let db = await openDb(name)
      let keys = await sealedKeys(db, profileId, storageKey)
      if (!keys) {
        db.close()
        await deleteDb(name)
        db = await openDb(name)
        keys = await sealedKeys(db, profileId, storageKey)
        if (!keys) {
          db.close()
          return null
        }
      }
      return new EncryptedSearchIndex(profileId, db, keys)
    } catch (error) {
      debug.warn('Search index unavailable:', error)
      return null
    }
  }

  get isClosed(): boolean {
    return this.closed
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    this.hashCache.clear()
    this.roomCache.clear()
    try { this.db.close() } catch { /* already closed */ }
  }

  private async hash(term: string): Promise<string> {
    const cached = this.hashCache.get(term)
    if (cached) return cached
    const mac = new Uint8Array(await crypto.subtle.sign('HMAC', this.keys.hmac, utf8(term)))
    const out = base64url(mac).slice(0, HASH_CHARS)
    if (this.hashCache.size >= HASH_CACHE_MAX) this.hashCache.clear()
    this.hashCache.set(term, out)
    return out
  }

  private async seal(message: Message, text: string): Promise<DocRecord> {
    const payload: DocPayload = {
      content: message.content,
      user_id: message.user_id ?? undefined,
      bot_id: message.bot_id ?? undefined,
      channel_id: message.channel_id ?? undefined,
      conversation_id: message.conversation_id ?? undefined,
      thread_id: message.thread_id ?? undefined,
      created_at: new Date(message.created_at).toISOString(),
      updated_at: message.updated_at ? new Date(message.updated_at).toISOString() : undefined,
      is_pinned: message.is_pinned || undefined,
      sender_verified: message.sender_verified,
      metadata: message.metadata,
    }
    const json = JSON.stringify(payload)
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const [blob, mac, terms] = await Promise.all([
      crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: utf8(message.id) }, this.keys.aes, utf8(json)),
      crypto.subtle.sign('HMAC', this.keys.hmac, utf8(`p:${json}`)),
      Promise.all([...indexTerms(text)].map(t => this.hash(t))),
    ])
    return {
      id: message.id,
      room: message.channel_id || message.conversation_id || '',
      at: new Date(message.created_at).getTime(),
      terms: [...new Set(terms)],
      ph: base64url(new Uint8Array(mac)).slice(0, HASH_CHARS),
      iv,
      blob,
    }
  }

  private async open(record: DocRecord): Promise<Message | null> {
    try {
      const plain = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: record.iv, additionalData: utf8(record.id) },
        this.keys.aes,
        record.blob,
      )
      const p = JSON.parse(new TextDecoder().decode(plain)) as DocPayload
      return {
        id: record.id,
        content: p.content,
        user_id: p.user_id,
        bot_id: p.bot_id,
        channel_id: p.channel_id,
        conversation_id: p.conversation_id,
        thread_id: p.thread_id,
        created_at: new Date(p.created_at),
        updated_at: p.updated_at ? new Date(p.updated_at) : undefined,
        is_pinned: p.is_pinned ?? false,
        sender_verified: p.sender_verified,
        metadata: p.metadata,
        reactions: [],
        encrypted: true,
        decrypted: true,
      }
    } catch {
      return null
    }
  }

  /** Serializes writes: a batch reads the docs it replaces before it writes them. */
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.then(work, work)
    this.writes = next.catch((error) => debug.warn('Search index write failed:', error))
    return next
  }

  /**
   * Room numbers of `rooms` within `tx`, which spans 'rooms'. Unknown rooms are left out, or
   * numbered when `assign` is given; it collects those numbers, which enter the cache once the
   * transaction commits (an aborted transaction rolls the key generator back).
   */
  private async roomNumbers(
    tx: IDBTransaction,
    rooms: string[],
    assign: Map<string, number> | null,
  ): Promise<Map<string, number>> {
    const out = new Map<string, number>()
    const store = tx.objectStore('rooms')
    await Promise.all(rooms.map(async (room) => {
      const cached = this.roomCache.get(room)
      if (cached !== undefined) {
        out.set(room, cached)
        return
      }
      const row = await req(store.index('room').get(room)) as { r: number } | undefined
      if (row) {
        this.roomCache.set(room, row.r)
        out.set(room, row.r)
      } else if (assign) {
        const r = await req(store.add({ room })) as number
        assign.set(room, r)
        out.set(room, r)
      }
    }))
    return out
  }

  /** Adds the postings of `prior` (its terms, room and batch) to `drops`. */
  private static notePriorRows(drops: Drops, prior: DocRecord): void {
    if (prior.n === undefined || prior.r === undefined || prior.s === undefined) return
    for (const t of prior.terms) {
      const key: RowKey = [t[0], prior.r, prior.s]
      const id = rowId(key)
      let row = drops.get(id)
      if (!row) drops.set(id, row = { key, terms: new Map() })
      let ns = row.terms.get(t)
      if (!ns) row.terms.set(t, ns = new Set())
      ns.add(prior.n)
    }
  }

  private static async dropPostings(postings: IDBObjectStore, drops: Drops): Promise<void> {
    await Promise.all([...drops.values()].map(async ({ key, terms }) => {
      const row = await req(postings.get(key)) as PostingRow | undefined
      if (!row) return
      for (const [t, ns] of terms) {
        const list = row[t]
        if (!list) continue
        const kept: number[] = []
        for (let i = 0; i < list.length; i += 2) if (!ns.has(list[i])) kept.push(list[i], list[i + 1])
        if (kept.length) row[t] = kept
        else delete row[t]
      }
      if (Object.keys(row).length) postings.put(row, key)
      else postings.delete(key)
    }))
  }

  /**
   * Adds or replaces decrypted messages. `texts` holds each message's searchable text
   * (utils/searchTokens searchableText). An indexed message no longer unreadable leaves that list.
   * New messages write their batch's posting rows and read none; a message indexed again with
   * the same terms writes no posting.
   */
  add(entries: Array<{ message: Message; text: string }>): Promise<void> {
    if (this.closed || entries.length === 0) return Promise.resolve()
    return this.queue(async () => {
      const sealed = await Promise.all(entries.map(e => this.seal(e.message, e.text)))
      // One record per id: two adds of an id in one transaction violate the unique index.
      const records = [...new Map(sealed.map(r => [r.id, r])).values()]
      if (this.closed || records.length === 0) return
      const tx = this.db.transaction(['docs', 'postings', 'unreadable', 'rooms', 'meta'], 'readwrite')
      const docs = tx.objectStore('docs')
      const postings = tx.objectStore('postings')
      const unreadable = tx.objectStore('unreadable')
      const meta = tx.objectStore('meta')
      const finished = done(tx)

      const assigned = new Map<string, number>()
      const [numbers, last, existing] = await Promise.all([
        this.roomNumbers(tx, [...new Set(records.map(r => r.room))], assigned),
        req(meta.get('seq')) as Promise<{ v: number } | undefined>,
        Promise.all(records.map(r => req(docs.index('id').get(r.id)) as Promise<DocRecord | undefined>)),
      ])
      const s = (last?.v ?? 0) + 1
      let batched = false
      const rows = new Map<string, { key: RowKey; row: PostingRow }>()
      const drops: Drops = new Map()
      const post = (record: DocRecord, r: number, n: number) => {
        batched = true
        for (const t of record.terms) {
          const key: RowKey = [t[0], r, s]
          const id = rowId(key)
          let entry = rows.get(id)
          if (!entry) rows.set(id, entry = { key, row: {} })
          ;(entry.row[t] ??= []).push(n, record.at)
        }
      }

      await Promise.all(records.map(async (record, i) => {
        const prior = existing[i]
        const r = numbers.get(record.room)!
        if (prior?.n !== undefined) {
          const terms = new Set(prior.terms)
          const same = prior.r === r && prior.at === record.at && prior.s !== undefined
            && prior.terms.length === record.terms.length && record.terms.every(t => terms.has(t))
          if (same) {
            if (prior.ph !== record.ph) docs.put({ ...record, r, s: prior.s, n: prior.n })
            return
          }
          EncryptedSearchIndex.notePriorRows(drops, prior)
          docs.put({ ...record, r, s, n: prior.n })
          post(record, r, prior.n)
          return
        }
        unreadable.delete(record.id)
        const n = await req(docs.add({ ...record, r, s })) as number
        post(record, r, n)
      }))
      await EncryptedSearchIndex.dropPostings(postings, drops)
      if (batched) meta.put({ k: 'seq', v: s })
      for (const { key, row } of rows.values()) postings.add(row, key)
      await finished
      for (const [room, r] of assigned) this.roomCache.set(room, r)
    })
  }

  /** Drops messages: deleted or no longer visible. */
  remove(messageIds: string[]): Promise<void> {
    if (this.closed || messageIds.length === 0) return Promise.resolve()
    return this.queue(async () => {
      const tx = this.db.transaction(['docs', 'postings', 'unreadable'], 'readwrite')
      const docs = tx.objectStore('docs')
      const finished = done(tx)
      const found = await Promise.all(messageIds.map(id => req(docs.index('id').get(id)) as Promise<DocRecord | undefined>))
      const drops: Drops = new Map()
      for (const record of found) {
        if (record?.n === undefined) continue
        docs.delete(record.n)
        EncryptedSearchIndex.notePriorRows(drops, record)
      }
      for (const id of messageIds) tx.objectStore('unreadable').delete(id)
      await EncryptedSearchIndex.dropPostings(tx.objectStore('postings'), drops)
      await finished
    })
  }

  /** Records messages the device could not decrypt. Indexed messages are left alone. */
  markUnreadable(messages: Array<Pick<Message, 'id' | 'created_at' | 'channel_id' | 'conversation_id'>>): Promise<void> {
    if (this.closed || messages.length === 0) return Promise.resolve()
    return this.queue(async () => {
      const tx = this.db.transaction(['docs', 'unreadable'], 'readwrite')
      const finished = done(tx)
      const docs = tx.objectStore('docs').index('id')
      const indexed = await Promise.all(messages.map(m => req(docs.getKey(m.id))))
      messages.forEach((m, i) => {
        if (indexed[i] !== undefined) return
        tx.objectStore('unreadable').put({
          id: m.id,
          room: m.channel_id || m.conversation_id || '',
          at: new Date(m.created_at).getTime(),
        })
      })
      await finished
    })
  }

  /** Unreadable message ids of the rooms, at or after `floor` ms where given. */
  async unreadable(rooms: string[], floors: Record<string, number | undefined> = {}): Promise<Array<{ id: string; room: string; at: number }>> {
    if (this.closed) return []
    await this.writes
    const store = this.db.transaction('unreadable', 'readonly').objectStore('unreadable').index('room_at')
    const lists = await Promise.all(rooms.map(room =>
      req(store.getAll(IDBKeyRange.bound([room, floors[room] ?? -Infinity], [room, Infinity]))) as Promise<Array<{ id: string; room: string; at: number }>>))
    return lists.flat()
  }

  async spans(room: string): Promise<HistorySpan[]> {
    if (this.closed) return []
    const row = await req(this.db.transaction('spans', 'readonly').objectStore('spans').get(room)) as { spans: HistorySpan[] } | undefined
    return row?.spans ?? []
  }

  /** Adds a span the crawl read in full, merged with the room's others. */
  addSpan(room: string, span: HistorySpan): Promise<void> {
    if (this.closed) return Promise.resolve()
    return this.queue(async () => {
      const tx = this.db.transaction('spans', 'readwrite')
      const store = tx.objectStore('spans')
      const finished = done(tx)
      const row = await req(store.get(room)) as { spans: HistorySpan[] } | undefined
      store.put({ room, spans: mergeSpans([...(row?.spans ?? []), span]) })
      await finished
    })
  }

  /**
   * Doc numbers and times of the room's messages in [from, to] holding every hashed term of
   * the alternative; `rows` holds the room's posting rows by bucket.
   */
  private static candidates(
    rows: Map<string, PostingRow[]>,
    hashes: string[],
    from: number,
    to: number,
    out: Map<number, number>,
  ): void {
    const lists = hashes.map((h) => {
      const found = new Map<number, number>()
      for (const row of rows.get(h[0]) ?? []) {
        const list = row[h]
        if (!list) continue
        for (let i = 0; i < list.length; i += 2) {
          if (list[i + 1] >= from && list[i + 1] <= to) found.set(list[i], list[i + 1])
        }
      }
      return found
    }).sort((a, b) => a.size - b.size)
    for (const [n, at] of lists[0]) {
      if (lists.every(l => l.has(n))) out.set(n, at)
    }
  }

  /**
   * Indexed messages of `rooms` in [from, to] ms whose terms cover the query, newest first
   * (oldest first with `ascending`), decrypted, at most `limit`. A query without terms lists
   * the rooms' messages. The caller matches the decrypted text: terms only narrow. `capped`:
   * candidates remained unopened at the limit.
   */
  async search(
    query: IndexQuery,
    options: {
      rooms: string[]
      from?: number
      to?: number
      ascending?: boolean
      accept: (message: Message) => boolean
      limit: number
    },
  ): Promise<{ hits: IndexedHit[]; capped: boolean }> {
    if (this.closed) return { hits: [], capped: false }
    await this.writes
    const from = options.from ?? -Infinity
    const to = options.to ?? Infinity
    if (from > to) return { hits: [], capped: false }

    let order: Array<{ n: number; at: number }>
    const lookups = query.alternatives.map(a => [...new Set(a.terms.flatMap(t => t.lookup))]).filter(l => l.length)
    if (lookups.length === 0) {
      const store = this.db.transaction('docs', 'readonly').objectStore('docs').index('room_at')
      const lists = await Promise.all(options.rooms.map(room =>
        req(store.getAll(IDBKeyRange.bound([room, from], [room, to]))) as Promise<DocRecord[]>))
      order = lists.flat().map(d => ({ n: d.n!, at: d.at }))
    } else {
      // Hashing awaits WebCrypto, which would end a transaction left open across it.
      const hashed = await Promise.all(lookups.map(lookup => Promise.all(lookup.map(t => this.hash(t)))))
      const buckets = [...new Set(hashed.flat().map(h => h[0]))]
      const tx = this.db.transaction(['postings', 'rooms'], 'readonly')
      const postings = tx.objectStore('postings')
      const numbers = [...(await this.roomNumbers(tx, options.rooms, null)).values()]
      const found = new Map<number, number>()
      await Promise.all(numbers.map(async (r) => {
        const rows = new Map<string, PostingRow[]>()
        await Promise.all(buckets.map(async (b) => {
          rows.set(b, await req(postings.getAll(IDBKeyRange.bound([b, r, -Infinity], [b, r, Infinity]))) as PostingRow[])
        }))
        for (const hashes of hashed) EncryptedSearchIndex.candidates(rows, hashes, from, to, found)
      }))
      order = [...found].map(([n, at]) => ({ n, at }))
    }

    order.sort(options.ascending ? (a, b) => a.at - b.at || a.n - b.n : (a, b) => b.at - a.at || b.n - a.n)
    const hits: IndexedHit[] = []
    const BATCH = 50
    for (let i = 0; i < order.length; i += BATCH) {
      if (this.closed) break
      const slice = order.slice(i, i + BATCH)
      const store = this.db.transaction('docs', 'readonly').objectStore('docs')
      const records = await Promise.all(slice.map(c => req(store.get(c.n)) as Promise<DocRecord | undefined>))
      const opened = await Promise.all(records.map(r => (r ? this.open(r) : Promise.resolve(null))))
      for (let j = 0; j < opened.length; j++) {
        const message = opened[j]
        if (!message || !options.accept(message)) continue
        hits.push({ message, at: slice[j].at })
        if (hits.length >= options.limit) return { hits, capped: i + j + 1 < order.length }
      }
    }
    return { hits, capped: false }
  }

  /** Indexed message count per room. */
  async count(room: string): Promise<number> {
    if (this.closed) return 0
    await this.writes
    const store = this.db.transaction('docs', 'readonly').objectStore('docs').index('room_at')
    return req(store.count(IDBKeyRange.bound([room, -Infinity], [room, Infinity])))
  }
}

// ---------------------------------------------------------------------------
// The signed-in account's index
// ---------------------------------------------------------------------------

let current: { profileId: string; key: CryptoKey; index: Promise<EncryptedSearchIndex | null> } | null = null

/** The index of the account whose encryption is unlocked; null while locked. */
export async function accountSearchIndex(): Promise<EncryptedSearchIndex | null> {
  const [{ megolmMessageEncryptionService }, { megolmService }] = await Promise.all([
    import('@/services/encryption/MegolmMessageEncryptionService'),
    import('@/services/encryption/MegolmService'),
  ])
  const profileId = megolmMessageEncryptionService.getCurrentUserId()
  const key = megolmService.storageKey()
  if (!profileId || !key) return null
  if (current && current.profileId === profileId && current.key === key) {
    const index = await current.index
    if (index && !index.isClosed) return index
  }
  if (current) void current.index.then(i => i?.close())
  const opening = EncryptedSearchIndex.open(profileId, key)
  current = { profileId, key, index: opening }
  return opening
}

/** Closes the open index without deleting it. */
export function closeAccountSearchIndex(): void {
  const open = current
  current = null
  void open?.index.then(i => i?.close())
}

/**
 * Deletes the account's index; every account's on this device without an id (sign-out
 * before the account was known). indexedDB.databases() lists them where the browser has it.
 */
export async function deleteSearchIndex(profileId?: string | null): Promise<void> {
  const open = current
  if (!profileId || open?.profileId === profileId) {
    current = null
    const index = await open?.index.catch(() => null)
    index?.close()
  }
  if (typeof indexedDB === 'undefined') return
  if (profileId) {
    await deleteDb(INDEX_DB_PREFIX + profileId)
    return
  }
  const listed = typeof indexedDB.databases === 'function' ? await indexedDB.databases().catch(() => []) : []
  await Promise.all(listed
    .map(d => d.name)
    .filter((name): name is string => !!name && name.startsWith(INDEX_DB_PREFIX))
    .map(deleteDb))
}

/**
 * Indexes messages processMessageDecryption decrypted and records the ones it could not.
 * Fire and forget: indexing never holds up a message list.
 */
export function noteDecryption(decrypted: Message[], failed: Message[]): void {
  if (decrypted.length === 0 && failed.length === 0) return
  void (async () => {
    const index = await accountSearchIndex()
    if (!index) return
    const { searchableText } = await import('@/utils/searchTokens')
    const stored = (m: Message) => !m.is_system && !String(m.id).startsWith('temp-') && !!(m.channel_id || m.conversation_id)
    await index.add(decrypted.filter(stored).map(message => ({ message, text: searchableText(message.content) })))
    await index.markUnreadable(failed.filter(stored))
  })().catch(error => debug.warn('Indexing decrypted messages failed:', error))
}
