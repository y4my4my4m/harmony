/**
 * Sticker lists for the picker and management, and which sticker ids rendered in messages
 * are gone. Lists live STICKER_TTL_MS; a sticker part of this instance whose row is gone
 * renders a placeholder (StickerView).
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
  const present = new Set<string>()
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
    for (const s of stickers) {
      present.add(s.id)
      removed.delete(s.id)
    }
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

  function upsert(sticker: Sticker): void {
    const key = keyOf(sticker)
    const list = lists[key]
    present.add(sticker.id)
    removed.delete(sticker.id)
    if (!list) return
    const i = list.stickers.findIndex((s) => s.id === sticker.id)
    if (i >= 0) list.stickers.splice(i, 1, sticker)
    else list.stickers.push(sticker)
    list.stickers.sort((a, b) => a.name.localeCompare(b.name))
  }

  function markRemoved(id: string): void {
    present.delete(id)
    removed.add(id)
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
        if (found.has(id)) present.add(id)
        else removed.add(id)
      }
    } catch (err) {
      debug.warn('Sticker presence lookup failed:', err)
    }
  }

  /** Looks the id up once, batched with the others seen meanwhile. */
  function checkPresence(id: string): void {
    if (present.has(id) || removed.has(id) || queued.has(id)) return
    queued.add(id)
    flushTimer ??= setTimeout(() => void flush(), PRESENCE_BATCH_MS)
  }

  function isRemoved(id: string): boolean {
    return removed.has(id)
  }

  function $reset(): void {
    for (const key of Object.keys(lists)) delete lists[key]
    removed.clear()
    present.clear()
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
    $reset,
  }
})
