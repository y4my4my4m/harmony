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
    saveTimer = setTimeout(persistNow, SAVE_DEBOUNCE_MS)
  }

  function makeKey(type: 'channel' | 'conversation' | 'thread', id: string): string {
    return `${type}:${id}`
  }

  function saveDraft(key: string, content: string) {
    const trimmed = content.trim()
    if (!trimmed) {
      delete drafts.value[key]
    } else {
      drafts.value[key] = content
      evictOldest()
    }
    persistDebounced()
  }

  function getDraft(key: string): string {
    return drafts.value[key] ?? ''
  }

  function clearDraft(key: string) {
    delete drafts.value[key]
    persistDebounced()
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

  load()

  return { drafts, makeKey, saveDraft, getDraft, clearDraft, load }
})
