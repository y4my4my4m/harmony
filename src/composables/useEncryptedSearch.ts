/**
 * Search of encrypted messages on this device, beside the server search (useMessageSearch).
 *
 * The server stores no text for encrypted messages, so a text query reads the on-device index
 * (services/search/encryptedSearchIndex) at once, then crawls the history of the encrypted
 * chats in scope (services/search/encryptedHistoryScan) and reads the index again as pages
 * land. The crawl belongs to the scope, not the query: a later search in the same chats reads
 * the index with its own query while the crawl goes on. A chat is encrypted when encryption is
 * on for it: the conversation's setting, the channel's resolved mode. Queries without text are
 * the server's alone: its filters reach encrypted rows, which load decrypted.
 *
 * Two reads per refresh: the first LOCAL_RESULT_LIMIT results (`results`, for the count and for
 * paging by count), and the results inside the page's time window (`windowed`, utils/searchMerge
 * localWindow), taken from the first read when it covers the window.
 */

import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { messageMatchesParams, type SearchRpcParams, type SearchSort } from '@/utils/searchQuery'
import { matchScore, parseIndexQuery, prepareText, searchableText, type IndexQuery } from '@/utils/searchTokens'
import { normalizeHistoryVisibility } from '@/utils/channelEncryption'
import type { LocalWindow } from '@/utils/searchMerge'
import type { Message } from '@/types'
import type { EncryptedSearchIndex, IndexedHit } from '@/services/search/encryptedSearchIndex'
import type { ScanProgress, ScanRoom } from '@/services/search/encryptedHistoryScan'

/** Most local results per read: the first results, and those of one page's window. */
export const LOCAL_RESULT_LIMIT = 500
/** Shortest wait between two reads of the index while the crawl runs, ms. */
export const REQUERY_MS = 1000

export type CrawlState = 'idle' | 'running' | 'stopped' | 'done' | 'error' | 'locked'

export interface EncryptedSearchScope {
  conversationId?: string | null
  serverId?: string | null
}

/** The chats a crawl reads; kept while searches stay in them. */
interface Scope {
  key: string
  rooms: string[]
  crawl: ScanRoom[]
  index: EncryptedSearchIndex
}

interface Run extends Scope {
  params: SearchRpcParams
  sort: SearchSort
  query: IndexQuery
}

const sameWindow = (a: LocalWindow | null | undefined, b: LocalWindow | null | undefined) =>
  a === b || (!!a && !!b && a.from === b.from && a.to === b.to)

export function useEncryptedSearch(scope: MaybeRefOrGetter<EncryptedSearchScope>) {
  const results = shallowRef<Message[]>([])
  /** More results matched than `results` holds. */
  const capped = ref(false)
  const windowed = shallowRef<Message[]>([])
  const state = ref<CrawlState>('idle')
  /** Every encrypted chat in scope is searched back to this time, ms. */
  const reachedAt = ref<number | null>(null)
  const unreadable = ref(0)
  /** Encrypted chats in scope whose history the crawl reads. */
  const crawlRooms = ref(0)
  const isQuerying = ref(false)

  let run: Run | null = null
  let crawlScope: Scope | null = null
  let controller: AbortController | null = null
  /** Bumps on every search and clear. */
  let generation = 0
  /** Bumps when the crawl's scope ends. */
  let crawlGeneration = 0
  let window: LocalWindow | null | undefined
  let first: { hits: IndexedHit[]; capped: boolean } | null = null
  let firstStale = true
  let inflight: Promise<void> | null = null
  let dirty = false
  let deferred = false
  let lastRead = 0
  let pendingRead: ReturnType<typeof setTimeout> | null = null
  const validated = new Set<string>()

  const active = computed(() => state.value === 'running')

  const scopeKey = (params: SearchRpcParams, profileId: string) => {
    const { conversationId, serverId } = toValue(scope)
    return [profileId, conversationId ?? '', serverId ?? '', [...(params.p_channel_ids ?? [])].sort().join(',')].join('|')
  }

  const roomsInScope = async (params: SearchRpcParams, profileId: string): Promise<{ rooms: string[]; crawl: ScanRoom[] }> => {
    const { conversationId, serverId } = toValue(scope)
    const { readableFloor } = await import('@/services/search/encryptedHistoryScan')
    if (conversationId) {
      const { conversationEncryptionEnabled } = await import('@/services/conversationEncryption')
      const encrypted = await conversationEncryptionEnabled(conversationId)
      if (!encrypted) return { rooms: [conversationId], crawl: [] }
      const { useDMStore } = await import('@/stores/useDM')
      const type = useDMStore().conversations.find(c => c.id === conversationId)?.type
      const floor = await readableFloor({ kind: 'conversation', room: conversationId, profileId, type })
      return { rooms: [conversationId], crawl: [{ room: conversationId, kind: 'conversation', ...floor }] }
    }
    if (!serverId) return { rooms: [], crawl: [] }

    const [{ useServerChannelStore }, { useChannelEncryptionStore }, { historyCutoff }] = await Promise.all([
      import('@/stores/useServerChannel'),
      import('@/stores/useChannelEncryption'),
      import('@/services/channelHistoryCutoff'),
    ])
    const channelStore = useServerChannelStore()
    const encryption = useChannelEncryptionStore()
    let channels = channelStore.channels.filter(c => c.type === 0 && (!c.server_id || c.server_id === serverId))
    if (params.p_channel_ids) channels = channels.filter(c => params.p_channel_ids!.includes(c.id))
    const ids = channels.map(c => c.id)
    if (ids.some(id => encryption.stateFor(id) === null)) {
      await encryption.loadServer(serverId, channelStore.channels.filter(c => !c.server_id || c.server_id === serverId).map(c => c.id))
    }
    const encrypted = ids.filter(id => encryption.isMessagesEncrypted(id))
    const crawl = await Promise.all(encrypted.map(async (id): Promise<ScanRoom> => {
      const floor = await readableFloor({
        kind: 'channel',
        room: id,
        profileId,
        serverId,
        visibility: normalizeHistoryVisibility(encryption.rows[id]?.history_visibility),
        cutoff: historyCutoff(id),
      })
      return { room: id, kind: 'channel', ...floor }
    }))
    return { rooms: ids, crawl }
  }

  /** Reads the index for the run's query: the first results, then the window's. */
  const read = async (current: Run, gen: number): Promise<void> => {
    if (current.query.alternatives.length === 0) {
      results.value = []
      windowed.value = []
      capped.value = false
      return
    }
    const { params } = current
    const accept = (m: Message) =>
      messageMatchesParams(m, params) && matchScore(current.query, prepareText(searchableText(m.content))) > 0
    const ascending = current.sort === 'oldest'
    const from = params.p_from_date ? Date.parse(params.p_from_date) : -Infinity
    const to = params.p_to_date ? Date.parse(params.p_to_date) : Infinity
    const search = (lo: number, hi: number) =>
      current.index.search(current.query, { rooms: current.rooms, from: lo, to: hi, ascending, accept, limit: LOCAL_RESULT_LIMIT })

    if (firstStale || !first) {
      firstStale = false
      const got = await search(from, to)
      if (gen !== generation) return
      first = got
    }
    const list = first
    const w = window
    let inWindow: Message[] = []
    if (w === undefined) {
      inWindow = list.hits.map(h => h.message)
    } else if (w !== null) {
      const lo = Math.max(from, w.from ?? -Infinity)
      const hi = Math.min(to, w.to ?? Infinity)
      const edge = list.hits.length ? list.hits[list.hits.length - 1].at : null
      // Results at the edge's time may lie past the limit: strict comparison.
      const covered = !list.capped || (edge !== null && (ascending ? hi < edge : lo > edge))
      if (covered) {
        inWindow = list.hits.filter(h => h.at >= lo && h.at <= hi).map(h => h.message)
      } else {
        const got = await search(lo, hi)
        if (gen !== generation) return
        inWindow = got.hits.map(h => h.message)
      }
    }
    results.value = list.hits.map(h => h.message)
    capped.value = list.capped
    windowed.value = inWindow
  }

  /** Reads again once the read in flight ends; never two at once. */
  const refresh = (): Promise<void> => {
    dirty = true
    if (!inflight) {
      inflight = (async () => {
        try {
          while (dirty) {
            dirty = false
            const current = run
            if (!current) break
            try {
              await read(current, generation)
            } catch (error) {
              debug.warn('Encrypted search failed:', error)
            }
          }
        } finally {
          inflight = null
          lastRead = Date.now()
          if (deferred) {
            deferred = false
            scheduleRefresh()
          }
        }
      })()
    }
    return inflight
  }

  /** A crawl page landed: read again, REQUERY_MS after the last read ended. */
  const scheduleRefresh = () => {
    firstStale = true
    if (pendingRead) return
    if (inflight) {
      deferred = true
      return
    }
    pendingRead = setTimeout(() => {
      pendingRead = null
      void refresh()
    }, Math.max(0, lastRead + REQUERY_MS - Date.now()))
  }

  const cancelPendingRead = () => {
    if (pendingRead) clearTimeout(pendingRead)
    pendingRead = null
    deferred = false
  }

  const countUnreadable = async () => {
    const current = crawlScope
    if (!current) return
    const cg = crawlGeneration
    const floors = Object.fromEntries(current.crawl.map(r => [r.room, r.floor !== undefined ? r.floor / 1000 : undefined]))
    const ids = await current.index.unreadable(current.crawl.map(r => r.room), floors)
    if (cg === crawlGeneration) unreadable.value = ids.length
  }

  /**
   * Drops results deleted or hidden since they were indexed and indexes edits again: one
   * id/updated_at read per hundred results not yet checked in this search.
   */
  const validate = async (current: Run, gen: number, shown: Message[]) => {
    const todo = [...new Map(shown.filter(m => !validated.has(m.id)).map(m => [m.id, m])).values()]
    if (todo.length === 0) return
    for (const m of todo) validated.add(m.id)
    const stale: string[] = []
    const gone = new Set<string>()
    for (let i = 0; i < todo.length; i += 100) {
      const chunk = todo.slice(i, i + 100)
      const { data, error } = await supabase
        .from('messages')
        .select('id, updated_at')
        .in('id', chunk.map(m => m.id))
        .not('is_deleted', 'is', true)
      if (error || gen !== generation) return
      const rows = new Map((data ?? []).map(r => [r.id as string, r.updated_at as string | null]))
      for (const m of chunk) {
        if (!rows.has(m.id)) gone.add(m.id)
        else if (rows.get(m.id) && (!m.updated_at || Date.parse(rows.get(m.id)!) > new Date(m.updated_at).getTime())) stale.push(m.id)
      }
    }
    if (gone.size) await current.index.remove([...gone])
    if (stale.length) {
      const { data } = await supabase.from('messages').select('*').in('id', stale)
      const { processMessageDecryption } = await import('@/utils/messageDecryption')
      const { recordPage } = await import('@/services/search/encryptedHistoryScan')
      // A key missing here stays missing: the crawl asks for keys, a check does not.
      await recordPage(current.index, await processMessageDecryption((data ?? []) as Message[], { index: false, heldKeysOnly: true }))
    }
    if ((gone.size || stale.length) && gen === generation) {
      firstStale = true
      await refresh()
    }
  }

  const crawl = async (current: Scope) => {
    if (current.crawl.length === 0) {
      state.value = 'done'
      return
    }
    const cg = crawlGeneration
    const ctrl = new AbortController()
    controller = ctrl
    state.value = 'running'
    let outcome: 'done' | 'stopped' | 'error'
    try {
      const { scanHistory, databaseScanDeps } = await import('@/services/search/encryptedHistoryScan')
      outcome = await scanHistory(current.crawl, databaseScanDeps(current.index), {
        signal: ctrl.signal,
        onProgress: (p: ScanProgress) => {
          if (cg === crawlGeneration) reachedAt.value = p.reachedAt
        },
        onPage: () => {
          if (cg !== crawlGeneration) return
          scheduleRefresh()
          void countUnreadable()
        },
      })
    } catch (error) {
      debug.warn('Encrypted history crawl failed:', error)
      outcome = 'error'
    }
    if (controller === ctrl) controller = null
    if (cg !== crawlGeneration) return
    state.value = outcome
    cancelPendingRead()
    firstStale = true
    await refresh()
    await countUnreadable()
  }

  /** Ends the crawl and forgets its scope; what it read stays indexed. */
  const endCrawl = () => {
    crawlGeneration++
    controller?.abort()
    controller = null
    crawlScope = null
    state.value = 'idle'
    reachedAt.value = null
    unreadable.value = 0
    crawlRooms.value = 0
  }

  /**
   * Searches for `params`: the index at once, then the crawl of the chats in scope, which a
   * search in the same chats leaves running. Text-less queries clear.
   */
  const search = async (params: SearchRpcParams | null, sort: SearchSort): Promise<void> => {
    generation++
    const gen = generation
    run = null
    first = null
    firstStale = true
    window = undefined
    validated.clear()
    cancelPendingRead()
    results.value = []
    windowed.value = []
    capped.value = false
    isQuerying.value = false
    if (!params?.p_query) {
      endCrawl()
      return
    }
    isQuerying.value = true
    try {
      const [{ accountSearchIndex }, { megolmMessageEncryptionService }, { useProfileStore }] = await Promise.all([
        import('@/services/search/encryptedSearchIndex'),
        import('@/services/encryption/MegolmMessageEncryptionService'),
        import('@/stores/useProfile'),
      ])
      const profileId = megolmMessageEncryptionService.getCurrentUserId() ?? useProfileStore().profile?.id
      if (!profileId) {
        endCrawl()
        return
      }
      const index = await accountSearchIndex()
      if (gen !== generation) return
      const key = scopeKey(params, profileId)
      let current = crawlScope && crawlScope.key === key && crawlScope.index === index ? crawlScope : null
      if (!current) {
        const found = await roomsInScope(params, profileId)
        if (gen !== generation) return
        endCrawl()
        if (!index) {
          // Locked keys matter only where a chat in scope is encrypted.
          if (found.crawl.length > 0) {
            crawlRooms.value = found.crawl.length
            state.value = 'locked'
          }
          return
        }
        current = { key, index, ...found }
        crawlScope = current
        crawlRooms.value = found.crawl.length
      }
      run = { ...current, params, sort, query: parseIndexQuery(params.p_query) }
      await refresh()
      if (gen !== generation) return
      await countUnreadable()
      void validate(run, gen, [...results.value, ...windowed.value]).catch(error => debug.warn('Validating encrypted results failed:', error))
    } catch (error) {
      debug.warn('Encrypted search failed:', error)
      if (gen === generation) state.value = 'error'
      return
    } finally {
      if (gen === generation) isQuerying.value = false
    }
    if (run && gen === generation && crawlScope && state.value === 'idle') void crawl(crawlScope)
  }

  /**
   * The page's time window (utils/searchMerge localWindow): undefined reads the first results
   * alone, null none.
   */
  const setWindow = (next: LocalWindow | null | undefined) => {
    if (sameWindow(next, window)) return
    window = next
    if (!run) return
    const current = run
    const gen = generation
    void refresh()
      .then(() => validate(current, gen, windowed.value))
      .catch(error => debug.warn('Validating encrypted results failed:', error))
  }

  /** Stops the crawl; what it read stays indexed. */
  const stop = () => {
    controller?.abort()
  }

  /** Crawls again from where the last one stopped. */
  const searchOlder = () => {
    if (!crawlScope || state.value === 'running') return
    void crawl(crawlScope)
  }

  const clear = () => {
    generation++
    endCrawl()
    cancelPendingRead()
    run = null
    first = null
    window = undefined
    validated.clear()
    results.value = []
    windowed.value = []
    capped.value = false
    isQuerying.value = false
  }

  return {
    results,
    capped,
    windowed,
    state,
    active,
    reachedAt,
    unreadable,
    crawlRooms,
    isQuerying,
    search,
    setWindow,
    stop,
    searchOlder,
    clear,
  }
}
