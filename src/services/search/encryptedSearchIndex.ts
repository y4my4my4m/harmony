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
 *   postings      t = base64url(HMAC(term))[0..16] (96 bits) -> d = doc numbers.
 *   docs          n (auto), id, room, at (created_at ms), terms (hashes), iv + blob =
 *                 AES-GCM(JSON of the decrypted fields), AAD = message id.
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
const DB_VERSION = 1
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
  at: number
  terms: string[]
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

function openDb(name: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(name, DB_VERSION)
    request.onerror = () => reject(request.error)
    request.onblocked = () => reject(new Error('Search index open blocked'))
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' })
      if (!db.objectStoreNames.contains('docs')) {
        const docs = db.createObjectStore('docs', { keyPath: 'n', autoIncrement: true })
        docs.createIndex('id', 'id', { unique: true })
        docs.createIndex('room_at', ['room', 'at'])
      }
      if (!db.objectStoreNames.contains('postings')) db.createObjectStore('postings', { keyPath: 't' })
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
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const blob = await crypto.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: utf8(message.id) },
      this.keys.aes,
      utf8(JSON.stringify(payload)),
    )
    const terms = await Promise.all([...indexTerms(text)].map(t => this.hash(t)))
    return {
      id: message.id,
      room: message.channel_id || message.conversation_id || '',
      at: new Date(message.created_at).getTime(),
      terms: [...new Set(terms)],
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

  /** Serializes writes: two batches never read-modify-write the same posting list at once. */
  private queue(work: () => Promise<void>): Promise<void> {
    const next = this.writes.then(work, work)
    this.writes = next.catch((error) => debug.warn('Search index write failed:', error))
    return next
  }

  /**
   * Adds or replaces decrypted messages. `texts` holds each message's searchable text
   * (utils/searchTokens searchableText). An indexed message no longer unreadable leaves that list.
   */
  add(entries: Array<{ message: Message; text: string }>): Promise<void> {
    if (this.closed || entries.length === 0) return Promise.resolve()
    return this.queue(async () => {
      const records = await Promise.all(entries.map(e => this.seal(e.message, e.text)))
      if (this.closed) return
      const tx = this.db.transaction(['docs', 'postings', 'unreadable'], 'readwrite')
      const docs = tx.objectStore('docs')
      const postings = tx.objectStore('postings')
      const unreadable = tx.objectStore('unreadable')
      const finished = done(tx)

      const existing = await Promise.all(records.map(r => req(docs.index('id').get(r.id)) as Promise<DocRecord | undefined>))
      const added = new Map<string, number[]>()
      const removed = new Map<string, number[]>()
      const push = (map: Map<string, number[]>, t: string, n: number) => {
        const list = map.get(t)
        if (list) list.push(n)
        else map.set(t, [n])
      }
      await Promise.all(records.map((record, i) => {
        const prior = existing[i]
        unreadable.delete(record.id)
        if (prior?.n !== undefined) {
          const n = prior.n
          const next = new Set(record.terms)
          const before = new Set(prior.terms)
          for (const t of prior.terms) if (!next.has(t)) push(removed, t, n)
          for (const t of record.terms) if (!before.has(t)) push(added, t, n)
          return req(docs.put({ ...record, n })).then(() => n)
        }
        return req(docs.add(record)).then((n) => {
          for (const t of record.terms) push(added, t, n as number)
          return n as number
        })
      }))

      const touched = [...new Set([...added.keys(), ...removed.keys()])]
      const lists = await Promise.all(touched.map(t => req(postings.get(t)) as Promise<{ t: string; d: number[] } | undefined>))
      touched.forEach((t, i) => {
        const set = new Set(lists[i]?.d ?? [])
        for (const n of added.get(t) ?? []) set.add(n)
        for (const n of removed.get(t) ?? []) set.delete(n)
        if (set.size === 0) postings.delete(t)
        else postings.put({ t, d: [...set] })
      })
      await finished
    })
  }

  /** Drops messages: deleted or no longer visible. */
  remove(messageIds: string[]): Promise<void> {
    if (this.closed || messageIds.length === 0) return Promise.resolve()
    return this.queue(async () => {
      const tx = this.db.transaction(['docs', 'postings', 'unreadable'], 'readwrite')
      const docs = tx.objectStore('docs')
      const postings = tx.objectStore('postings')
      const finished = done(tx)
      const found = await Promise.all(messageIds.map(id => req(docs.index('id').get(id)) as Promise<DocRecord | undefined>))
      const removed = new Map<string, number[]>()
      for (const record of found) {
        if (record?.n === undefined) continue
        docs.delete(record.n)
        for (const t of record.terms) {
          const list = removed.get(t)
          if (list) list.push(record.n)
          else removed.set(t, [record.n])
        }
      }
      for (const id of messageIds) tx.objectStore('unreadable').delete(id)
      const touched = [...removed.keys()]
      const lists = await Promise.all(touched.map(t => req(postings.get(t)) as Promise<{ t: string; d: number[] } | undefined>))
      touched.forEach((t, i) => {
        const drop = new Set(removed.get(t))
        const d = (lists[i]?.d ?? []).filter(n => !drop.has(n))
        if (d.length === 0) postings.delete(t)
        else postings.put({ t, d })
      })
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

  /** Doc numbers holding every term of the alternative. */
  private async candidates(lookups: string[]): Promise<Set<number> | null> {
    const hashes = await Promise.all(lookups.map(t => this.hash(t)))
    const store = this.db.transaction('postings', 'readonly').objectStore('postings')
    const lists = await Promise.all(hashes.map(h => req(store.get(h)) as Promise<{ d: number[] } | undefined>))
    let out: Set<number> | null = null
    for (const list of lists.sort((a, b) => (a?.d.length ?? 0) - (b?.d.length ?? 0))) {
      if (!list) return new Set()
      if (out === null) {
        out = new Set(list.d)
        continue
      }
      const next = new Set<number>()
      for (const n of list.d) if (out.has(n)) next.add(n)
      out = next
      if (out.size === 0) return out
    }
    return out
  }

  /**
   * Indexed messages of `rooms` in [from, to] ms whose terms cover the query, newest first
   * (oldest first with `ascending`), decrypted, at most `limit`. A query without terms lists
   * the rooms' messages. The caller matches the decrypted text: terms only narrow.
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
    const rooms = new Set(options.rooms)
    const from = options.from ?? -Infinity
    const to = options.to ?? Infinity

    let records: DocRecord[]
    const lookups = query.alternatives.map(a => [...new Set(a.terms.flatMap(t => t.lookup))]).filter(l => l.length)
    if (lookups.length === 0) {
      const store = this.db.transaction('docs', 'readonly').objectStore('docs').index('room_at')
      const lists = await Promise.all([...rooms].map(room =>
        req(store.getAll(IDBKeyRange.bound([room, from], [room, to]))) as Promise<DocRecord[]>))
      records = lists.flat()
    } else {
      const numbers = new Set<number>()
      for (const lookup of lookups) {
        const found = await this.candidates(lookup)
        for (const n of found ?? []) numbers.add(n)
      }
      const store = this.db.transaction('docs', 'readonly').objectStore('docs')
      const found = await Promise.all([...numbers].map(n => req(store.get(n)) as Promise<DocRecord | undefined>))
      records = found.filter((r): r is DocRecord => !!r && rooms.has(r.room) && r.at >= from && r.at <= to)
    }

    records.sort((a, b) => (options.ascending ? a.at - b.at : b.at - a.at))
    const hits: IndexedHit[] = []
    const BATCH = 50
    for (let i = 0; i < records.length; i += BATCH) {
      const opened = await Promise.all(records.slice(i, i + BATCH).map(r => this.open(r)))
      for (let j = 0; j < opened.length; j++) {
        const message = opened[j]
        if (!message || !options.accept(message)) continue
        hits.push({ message, at: records[i + j].at })
        if (hits.length >= options.limit) return { hits, capped: i + j + 1 < records.length }
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
