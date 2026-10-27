import { defineStore } from 'pinia'
import { ref } from 'vue'
import { userStorage } from '@/utils/userScopedStorage'

const STORAGE_KEY = 'message-drafts'
const SAVE_DEBOUNCE_MS = 500
const MAX_DRAFTS = 100

export const useDraftsStore = defineStore('drafts', () => {
  const drafts = ref<Record<string, string>>({})
  let saveTimer: ReturnType<typeof setTimeout> | null = null

  function load() {
    try {
      const raw = userStorage.getItem(STORAGE_KEY)
      if (raw) {
        drafts.value = JSON.parse(raw)
      }
    } catch {
      drafts.value = {}
    }
  }

  function persistNow() {
    try {
      userStorage.setItem(STORAGE_KEY, JSON.stringify(drafts.value))
    } catch { /* quota exceeded - silently drop */ }
  }

  function persistDebounced() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      persistNow()
    }, SAVE_DEBOUNCE_MS)
  }

  function makeKey(type: 'channel' | 'conversation' | 'thread', id: string): string {
    return `${type}:${id}`
  }

  // An emptied draft is written at once, not after the debounce: a send empties it, and a
  // stored draft still holding the sent text comes back on the next start.
  function persistRemoval() {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = null
    persistNow()
  }

  function saveDraft(key: string, content: string) {
    const trimmed = content.trim()
    if (!trimmed) {
      const had = key in drafts.value
      delete drafts.value[key]
      if (had) persistRemoval()
      return
    }
    drafts.value[key] = content
    evictOldest()
    persistDebounced()
  }

  function getDraft(key: string): string {
    return drafts.value[key] ?? ''
  }

  function clearDraft(key: string) {
    const had = key in drafts.value
    delete drafts.value[key]
    if (had) persistRemoval()
  }

  function evictOldest() {
    const keys = Object.keys(drafts.value)
    if (keys.length > MAX_DRAFTS) {
      const toRemove = keys.slice(0, keys.length - MAX_DRAFTS)
      for (const k of toRemove) {
        delete drafts.value[k]
      }
    }
  }

  // A reload, a closed tab or an app sent to the background inside the debounce window would
  // keep the draft as it was before the last keystrokes.
  function flush() {
    if (!saveTimer) return
    clearTimeout(saveTimer)
    saveTimer = null
    persistNow()
  }
  if (typeof window !== 'undefined') {
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') flush()
    })
  }

  load()

  return { drafts, makeKey, saveDraft, getDraft, clearDraft, load, flush }
})
