import { defineStore } from 'pinia'
import { computed, ref, watch } from 'vue'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { debug } from '@/utils/debug'

/**
 * The signed-in account's outside-link choices (outside_link_settings, trusted_link_hosts),
 * keyed by its auth user id. A copy in localStorage answers link clicks before the fetch on
 * load; the database is the truth once it lands. Signed out, nothing is trusted and only
 * masked links ask.
 */

const CACHE_PREFIX = 'harmony_outside_links:'

interface CachedChoices {
  askEveryLink: boolean
  trustedHosts: string[]
}

function readCache(accountId: string): CachedChoices | null {
  try {
    const raw = localStorage.getItem(CACHE_PREFIX + accountId)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<CachedChoices>
    return {
      askEveryLink: parsed.askEveryLink === true,
      trustedHosts: Array.isArray(parsed.trustedHosts) ? parsed.trustedHosts.filter((h): h is string => typeof h === 'string') : [],
    }
  } catch {
    return null
  }
}

function writeCache(accountId: string, choices: CachedChoices): void {
  try {
    localStorage.setItem(CACHE_PREFIX + accountId, JSON.stringify(choices))
  } catch {
    /* storage full or blocked */
  }
}

export const useOutsideLinkSettingsStore = defineStore('outsideLinkSettings', () => {
  const auth = useAuthStore()
  const accountId = ref<string | null>(null)
  const askEveryLink = ref(false)
  const hosts = ref<string[]>([])
  const loaded = ref(false)

  const trustedHosts = computed(() => new Set(hosts.value))
  const signedIn = computed(() => !!accountId.value)

  const persistCache = () => {
    if (accountId.value) writeCache(accountId.value, { askEveryLink: askEveryLink.value, trustedHosts: hosts.value })
  }

  async function load(id: string | null): Promise<void> {
    accountId.value = id
    loaded.value = false
    const cached = id ? readCache(id) : null
    askEveryLink.value = cached?.askEveryLink ?? false
    hosts.value = cached?.trustedHosts ?? []
    if (!id) return
    const [settings, trusted] = await Promise.all([
      supabase.from('outside_link_settings').select('ask_every_link').maybeSingle(),
      supabase.from('trusted_link_hosts').select('host').order('host'),
    ])
    if (accountId.value !== id) return
    if (settings.error) debug.warn('[outsideLinks] settings fetch failed:', settings.error)
    else askEveryLink.value = settings.data?.ask_every_link === true
    if (trusted.error) debug.warn('[outsideLinks] trusted hosts fetch failed:', trusted.error)
    else hosts.value = (trusted.data ?? []).map((row: { host: string }) => row.host)
    loaded.value = !settings.error && !trusted.error
    persistCache()
  }

  watch(
    () => auth.session?.user?.id ?? null,
    (id) => {
      if (id !== accountId.value) void load(id)
    },
    { immediate: true },
  )

  /** Adds `host` (trustHostOf form). Rejects with the database error, the list unchanged. */
  async function trust(host: string): Promise<void> {
    if (!accountId.value || hosts.value.includes(host)) return
    hosts.value = [...hosts.value, host].sort()
    persistCache()
    const { error } = await supabase.from('trusted_link_hosts').insert({ host })
    // 23505: already trusted from another device.
    if (error && error.code !== '23505') {
      hosts.value = hosts.value.filter((h) => h !== host)
      persistCache()
      throw error
    }
  }

  async function untrust(host: string): Promise<void> {
    if (!accountId.value || !hosts.value.includes(host)) return
    const before = hosts.value
    hosts.value = before.filter((h) => h !== host)
    persistCache()
    const { error } = await supabase.from('trusted_link_hosts').delete().eq('host', host)
    if (error) {
      hosts.value = before
      persistCache()
      throw error
    }
  }

  async function setAskEveryLink(on: boolean): Promise<void> {
    if (!accountId.value) return
    const before = askEveryLink.value
    askEveryLink.value = on
    persistCache()
    const { error } = await supabase
      .from('outside_link_settings')
      .upsert({ ask_every_link: on, updated_at: new Date().toISOString() }, { onConflict: 'user_id' })
    if (error) {
      askEveryLink.value = before
      persistCache()
      throw error
    }
  }

  return {
    askEveryLink,
    trustedHosts,
    hostList: computed(() => hosts.value),
    loaded,
    signedIn,
    trust,
    untrust,
    setAskEveryLink,
    reload: () => load(accountId.value),
  }
})
