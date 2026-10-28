import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'

/**
 * The signed-in account's "Keep photo details by default" (photo_details_settings), keyed by its
 * auth user id: the starting state of each new photo or video attachment's "Keep photo details".
 * A copy in localStorage answers before the fetch on load; the database is the truth once it
 * lands. Off when signed out, absent or unreadable.
 */

const CACHE_PREFIX = 'harmony_photo_details:'

/** Longest wait of ready() on a load still in flight. */
export const READY_TIMEOUT_MS = 3000

function readCache(accountId: string): boolean {
  try {
    return localStorage.getItem(CACHE_PREFIX + accountId) === '1'
  } catch {
    return false
  }
}

function writeCache(accountId: string, keep: boolean): void {
  try {
    if (keep) localStorage.setItem(CACHE_PREFIX + accountId, '1')
    else localStorage.removeItem(CACHE_PREFIX + accountId)
  } catch {
    /* storage full or blocked */
  }
}

export const usePhotoDetailsSettingsStore = defineStore('photoDetailsSettings', () => {
  const auth = useAuthStore()
  const accountId = ref<string | null>(null)
  const keepByDefault = ref(false)
  const loaded = ref(false)
  let loading: Promise<void> | null = null

  function load(id: string | null): Promise<void> {
    const pending = fetchSetting(id).finally(() => {
      if (loading === pending) loading = null
    })
    loading = pending
    return pending
  }

  async function fetchSetting(id: string | null): Promise<void> {
    accountId.value = id
    loaded.value = false
    keepByDefault.value = id ? readCache(id) : false
    if (!id) return
    const { data, error } = await supabase.from('photo_details_settings').select('keep_by_default').maybeSingle()
    if (accountId.value !== id) return
    if (error) {
      debug.warn('[photoDetails] settings fetch failed:', error)
      return
    }
    keepByDefault.value = data?.keep_by_default === true
    loaded.value = true
    writeCache(id, keepByDefault.value)
  }

  watch(
    () => auth.session?.user?.id ?? null,
    (id) => {
      if (id !== accountId.value) void load(id)
    },
    { immediate: true },
  )

  /** Rejects with the database error, the setting unchanged. */
  async function setKeepByDefault(on: boolean): Promise<void> {
    const id = accountId.value
    if (!id) return
    const before = keepByDefault.value
    keepByDefault.value = on
    writeCache(id, on)
    const { error } = await supabase
      .from('photo_details_settings')
      .upsert({ keep_by_default: on, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) {
      keepByDefault.value = before
      writeCache(id, before)
      throw error
    }
  }

  /** Settles once a load in flight lands, or after READY_TIMEOUT_MS. */
  function ready(): Promise<void> {
    if (!loading) return Promise.resolve()
    return Promise.race([loading, new Promise<void>((resolve) => setTimeout(resolve, READY_TIMEOUT_MS))])
  }

  return {
    keepByDefault,
    loaded,
    ready,
    signedIn: computed(() => !!accountId.value),
    setKeepByDefault,
    reload: () => load(accountId.value),
  }
})
