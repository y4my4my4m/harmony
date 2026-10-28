/**
 * Sticker lists for the picker and management, and the url of each sticker id rendered in
 * messages. Lists live STICKER_TTL_MS. A sticker part of this instance renders its row's url,
 * not its own; one whose row is gone renders a placeholder (StickerView).
 */
import { defineStore } from 'pinia'
import { reactive, ref } from 'vue'
import { debug } from '@/utils/debug'
import {
  existingStickerIds,
  listInstanceStickers,
  listMyStickers,
  listServerStickers,
  type Sticker,
} from '@/services/stickerService'

const STICKER_TTL_MS = 5 * 60 * 1000
/** Ids seen while rendering are looked up together after this many ms. */
const PRESENCE_BATCH_MS = 50

interface Cached {
  stickers: Sticker[]
  loadedAt: number
}

export const useStickersStore = defineStore('stickers', () => {
  /** Keys: 'server:<id>', 'instance', 'user:<profile id>'. */
  const lists = reactive<Record<string, Cached>>({})
  const removed = reactive(new Set<string>())
  /** Row url by lower-case sticker id. */
  const present = reactive(new Map<string, string>())
  /** Ids whose last lookup failed; looked up again when next asked. */
  const failed = reactive(new Set<string>())
  const queued = new Set<string>()
  let flushTimer: ReturnType<typeof setTimeout> | null = null
  const loading = ref(false)

  function fresh(key: string): Sticker[] | null {
    const cached = lists[key]
    return cached && Date.now() - cached.loadedAt < STICKER_TTL_MS ? cached.stickers : null
  }

  async function load(key: string, read: () => Promise<Sticker[]>, force: boolean): Promise<Sticker[]> {
    const hit = force ? null : fresh(key)
    if (hit) return hit
    const stickers = await read()
    lists[key] = { stickers, loadedAt: Date.now() }
    for (const s of stickers) remember(s)
    return stickers
  }

  function serverStickers(serverId: string, force = false) {
    return load(`server:${serverId}`, () => listServerStickers(serverId), force)
  }

  function instanceStickers(force = false) {
    return load('instance', () => listInstanceStickers(), force)
  }

  function myStickers(profileId: string, force = false) {
    return load(`user:${profileId}`, () => listMyStickers(profileId), force)
  }

  function cached(key: string): Sticker[] {
    return lists[key]?.stickers ?? []
  }

  /** The picker's lists: the current server's (when given), the instance's and the caller's. */
  async function loadPicker(serverId: string | null, profileId: string | null, force = false): Promise<void> {
    loading.value = true
    try {
      await Promise.all([
        serverId ? serverStickers(serverId, force) : null,
        instanceStickers(force),
        profileId ? myStickers(profileId, force) : null,
      ].map((p) => p?.catch((err) => debug.warn('Sticker list failed:', err))))
    } finally {
      loading.value = false
    }
  }

  function keyOf(sticker: Pick<Sticker, 'scope' | 'server_id' | 'owner_id'>): string {
    if (sticker.scope === 'server') return `server:${sticker.server_id}`
    if (sticker.scope === 'user') return `user:${sticker.owner_id}`
    return 'instance'
  }

  function remember(sticker: Pick<Sticker, 'id' | 'url'>): void {
    const id = sticker.id.toLowerCase()
    present.set(id, sticker.url)
    removed.delete(id)
    failed.delete(id)
  }

  function upsert(sticker: Sticker): void {
    const key = keyOf(sticker)
    const list = lists[key]
    remember(sticker)
    if (!list) return
    const i = list.stickers.findIndex((s) => s.id === sticker.id)
    if (i >= 0) list.stickers.splice(i, 1, sticker)
    else list.stickers.push(sticker)
    list.stickers.sort((a, b) => a.name.localeCompare(b.name))
  }

  function markRemoved(id: string): void {
    present.delete(id.toLowerCase())
    removed.add(id.toLowerCase())
    for (const list of Object.values(lists)) {
      const i = list.stickers.findIndex((s) => s.id === id)
      if (i >= 0) list.stickers.splice(i, 1)
    }
  }

  async function flush(): Promise<void> {
    flushTimer = null
    const ids = [...queued]
    queued.clear()
    try {
      const found = await existingStickerIds(ids)
      for (const id of ids) {
        const url = found.get(id)
        if (url) present.set(id, url)
        else removed.add(id)
      }
    } catch (err) {
      debug.warn('Sticker presence lookup failed:', err)
      for (const id of ids) failed.add(id)
    }
  }

  /** Looks the id up once, batched with the others seen meanwhile; a failed lookup is retried. */
  function checkPresence(id: string): void {
    const key = id.toLowerCase()
    if (present.has(key) || removed.has(key) || queued.has(key)) return
    failed.delete(key)
    queued.add(key)
    flushTimer ??= setTimeout(() => void flush(), PRESENCE_BATCH_MS)
  }

  function isRemoved(id: string): boolean {
    return removed.has(id.toLowerCase())
  }

  /** The row's url, once looked up; undefined before, or when the row is gone. */
  function urlOf(id: string): string | undefined {
    return present.get(id.toLowerCase())
  }

  function lookupFailed(id: string): boolean {
    return failed.has(id.toLowerCase())
  }

  function $reset(): void {
    for (const key of Object.keys(lists)) delete lists[key]
    removed.clear()
    present.clear()
    failed.clear()
    queued.clear()
  }

  return {
    lists,
    loading,
    serverStickers,
    instanceStickers,
    myStickers,
    cached,
    loadPicker,
    upsert,
    markRemoved,
    checkPresence,
    isRemoved,
    urlOf,
    lookupFailed,
    $reset,
  }
})
