/**
 * IndexedDB-based persistent cache for emoji data.
 *
 * Avoids re-fetching and re-parsing large JSON payloads on every page load:
 *   - unicode-emoji-data.json  (~713 KB)
 *   - twemoji-file-map.json    (~111 KB)
 *   - Custom server emojis from Supabase
 *
 * Data is versioned so it can be invalidated when the underlying assets change.
 */

import { debug } from '@/utils/debug'

const DB_NAME = 'harmony_emoji_cache'
const DB_VERSION = 1

const STORES = {
  STATIC_DATA: 'static_data',
  SERVER_EMOJIS: 'server_emojis',
  META: 'meta',
} as const

let dbInstance: IDBDatabase | null = null
let dbOpenPromise: Promise<IDBDatabase> | null = null

function openDB(): Promise<IDBDatabase> {
  if (dbInstance) return Promise.resolve(dbInstance)
  if (dbOpenPromise) return dbOpenPromise

  dbOpenPromise = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION)

    request.onerror = () => {
      dbOpenPromise = null
      reject(request.error)
    }

    request.onsuccess = () => {
      dbInstance = request.result
      dbInstance.onclose = () => {
        dbInstance = null
        dbOpenPromise = null
      }
      resolve(dbInstance)
    }

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result

      if (!db.objectStoreNames.contains(STORES.STATIC_DATA)) {
        db.createObjectStore(STORES.STATIC_DATA, { keyPath: 'key' })
      }
      if (!db.objectStoreNames.contains(STORES.SERVER_EMOJIS)) {
        const store = db.createObjectStore(STORES.SERVER_EMOJIS, { keyPath: 'serverId' })
        store.createIndex('lastFetched', 'lastFetched')
      }
      if (!db.objectStoreNames.contains(STORES.META)) {
        db.createObjectStore(STORES.META, { keyPath: 'key' })
      }
    }
  })

  return dbOpenPromise
}

async function idbGet<T>(storeName: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const req = store.get(key)
    req.onsuccess = () => resolve(req.result as T | undefined)
    req.onerror = () => reject(req.error)
  })
}

async function idbPut(storeName: string, value: unknown): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const req = store.put(value)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function idbDelete(storeName: string, key: IDBValidKey): Promise<void> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readwrite')
    const store = tx.objectStore(storeName)
    const req = store.delete(key)
    req.onsuccess = () => resolve()
    req.onerror = () => reject(req.error)
  })
}

async function idbGetAll<T>(storeName: string): Promise<T[]> {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, 'readonly')
    const store = tx.objectStore(storeName)
    const req = store.getAll()
    req.onsuccess = () => resolve(req.result as T[])
    req.onerror = () => reject(req.error)
  })
}

// ---------------------------------------------------------------------------
// Static emoji data (JSON files)
// ---------------------------------------------------------------------------

interface CachedStaticData {
  key: string
  data: unknown
  version: string
  cachedAt: number
}

/**
 * Retrieve a static JSON blob from IndexedDB.
 * Returns `undefined` if not cached or if the version doesn't match.
 */
export async function getCachedStaticEmojiData<T>(
  key: string,
  expectedVersion: string,
): Promise<T | undefined> {
  try {
    const entry = await idbGet<CachedStaticData>(STORES.STATIC_DATA, key)
    if (!entry) return undefined
    if (entry.version !== expectedVersion) {
      debug.log(`🔄 Emoji cache version mismatch for ${key}, will re-fetch`)
      return undefined
    }
    return entry.data as T
  } catch (e) {
    debug.warn('Failed to read emoji cache from IndexedDB:', e)
    return undefined
  }
}

export async function setCachedStaticEmojiData(
  key: string,
  data: unknown,
  version: string,
): Promise<void> {
  try {
    await idbPut(STORES.STATIC_DATA, {
      key,
      data,
      version,
      cachedAt: Date.now(),
    } satisfies CachedStaticData)
  } catch (e) {
    debug.warn('Failed to write emoji cache to IndexedDB:', e)
  }
}

// ---------------------------------------------------------------------------
// Custom server emojis (from Supabase)
// ---------------------------------------------------------------------------

export interface CachedServerEmojiData {
  serverId: string
  serverName: string
  serverIcon?: string
  allowCrossServer: boolean
  emojis: unknown[]
  lastFetched: number
}

const SERVER_EMOJI_MAX_AGE = 60 * 60 * 1000 // 1 hour persistent cache

export async function getCachedServerEmojis(
  serverId: string,
): Promise<CachedServerEmojiData | undefined> {
  try {
    const entry = await idbGet<CachedServerEmojiData>(STORES.SERVER_EMOJIS, serverId)
    if (!entry) return undefined
    if (Date.now() - entry.lastFetched > SERVER_EMOJI_MAX_AGE) {
      return undefined
    }
    return entry
  } catch (e) {
    debug.warn('Failed to read server emojis from IndexedDB:', e)
    return undefined
  }
}

export async function getAllCachedServerEmojis(): Promise<CachedServerEmojiData[]> {
  try {
    const all = await idbGetAll<CachedServerEmojiData>(STORES.SERVER_EMOJIS)
    return all.filter((e) => Date.now() - e.lastFetched <= SERVER_EMOJI_MAX_AGE)
  } catch (e) {
    debug.warn('Failed to read all server emojis from IndexedDB:', e)
    return []
  }
}

export async function setCachedServerEmojis(
  data: CachedServerEmojiData,
): Promise<void> {
  try {
    await idbPut(STORES.SERVER_EMOJIS, data)
  } catch (e) {
    debug.warn('Failed to write server emojis to IndexedDB:', e)
  }
}

export async function removeCachedServerEmojis(serverId: string): Promise<void> {
  try {
    await idbDelete(STORES.SERVER_EMOJIS, serverId)
  } catch (e) {
    debug.warn('Failed to remove server emojis from IndexedDB:', e)
  }
}
