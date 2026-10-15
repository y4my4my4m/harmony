import { computed, getCurrentScope, onScopeDispose, ref, shallowRef, watch } from 'vue'
import { supabase } from '@/supabase'
import { activityPubService } from '@/services/activityPubService'

/** A person offered by a picker. Local results carry no domain or handle. */
export interface UserSearchResult {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  domain?: string | null
  handle?: string | null
  is_local?: boolean
}

export interface UseUserSearchOptions {
  /** Accounts of this instance only: search_local_users. Otherwise search_federated_users. */
  localOnly?: boolean
  /** Ids left out of `results`; read reactively. */
  exclude?: () => Iterable<string | null | undefined>
  limit?: number
  /** Characters after trimming and dropping a leading @. */
  minLength?: number
  debounceMs?: number
}

/** search_local_users: accounts drive_share_file accepts, caller excluded server-side. */
async function searchLocalUsers(query: string, limit = 8): Promise<UserSearchResult[]> {
  const { data, error } = await supabase.rpc('search_local_users', { p_query: query, p_limit: limit })
  if (error) throw error
  return ((data ?? []) as Array<Omit<UserSearchResult, 'is_local'>>).map((row) => ({
    id: row.id,
    username: row.username,
    display_name: row.display_name,
    avatar_url: row.avatar_url,
    is_local: true,
  }))
}

async function searchFederatedUsers(query: string, limit: number): Promise<UserSearchResult[]> {
  const users = await activityPubService.searchUsers(query, limit)
  return users.map((user) => ({
    id: user.id,
    username: user.username,
    display_name: user.display_name ?? null,
    avatar_url: user.avatar_url ?? null,
    domain: user.domain ?? null,
    handle: user.handle ?? null,
    is_local: user.is_local,
  }))
}

export function normalizeUserQuery(raw: string): string {
  return raw.trim().replace(/^@+/, '').trim()
}

/**
 * Debounced people search. The latest query wins: a response for an older query is dropped.
 * `searching` is true from the keystroke until that query's response, so a picker shows
 * progress instead of an empty list during the debounce.
 */
export function useUserSearch(options: UseUserSearchOptions = {}) {
  const { localOnly = false, exclude, limit = 8, minLength = 1, debounceMs = 150 } = options

  const query = ref('')
  const found = shallowRef<UserSearchResult[]>([])
  const searching = ref(false)
  const error = ref<string | null>(null)
  let seq = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const excluded = computed(() => new Set(exclude ? [...exclude()].filter(Boolean) : []))
  const results = computed(() =>
    excluded.value.size ? found.value.filter((user) => !excluded.value.has(user.id)) : found.value,
  )

  function cancel(): void {
    if (timer) clearTimeout(timer)
    timer = null
    seq++
  }

  function reset(): void {
    cancel()
    found.value = []
    searching.value = false
    error.value = null
  }

  async function run(term: string, ticket: number): Promise<void> {
    try {
      const rows = localOnly ? await searchLocalUsers(term, limit) : await searchFederatedUsers(term, limit)
      if (ticket !== seq) return
      found.value = rows
      error.value = null
    } catch (e) {
      if (ticket !== seq) return
      found.value = []
      error.value = e instanceof Error ? e.message : String((e as { message?: unknown })?.message ?? e)
    } finally {
      if (ticket === seq) searching.value = false
    }
  }

  watch(query, (raw) => {
    const term = normalizeUserQuery(raw)
    if (!term || term.length < minLength) {
      reset()
      return
    }
    cancel()
    const ticket = seq
    searching.value = true
    timer = setTimeout(() => {
      timer = null
      void run(term, ticket)
    }, debounceMs)
  }, { flush: 'sync' })

  function clear(): void {
    reset()
    query.value = ''
  }

  if (getCurrentScope()) onScopeDispose(cancel)

  return { query, results, searching, error, clear }
}
