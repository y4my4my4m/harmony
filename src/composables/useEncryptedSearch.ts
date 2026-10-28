/**
 * Search of encrypted messages on this device, beside the server search (useMessageSearch).
 *
 * The server stores no text for encrypted messages, so a text query reads the on-device index
 * (services/search/encryptedSearchIndex) at once, then crawls the history of the encrypted
 * chats in scope (services/search/encryptedHistoryScan) and reads the index again as pages
 * land. A chat is encrypted when encryption is on for it: the conversation's setting, the
 * channel's resolved mode. Queries without text are the server's alone: its filters reach
 * encrypted rows, which load decrypted.
 */

import { computed, ref, shallowRef, toValue, type MaybeRefOrGetter } from 'vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { messageMatchesParams, type SearchRpcParams, type SearchSort } from '@/utils/searchQuery'
import { matchScore, parseIndexQuery, prepareText, searchableText } from '@/utils/searchTokens'
import { normalizeHistoryVisibility } from '@/utils/channelEncryption'
import type { Message } from '@/types'
import type { EncryptedSearchIndex } from '@/services/search/encryptedSearchIndex'
import type { ScanProgress, ScanRoom } from '@/services/search/encryptedHistoryScan'

/** Most local results kept per search. */
export const LOCAL_RESULT_LIMIT = 500
/** Shortest wait between two reads of the index while the crawl runs, ms. */
const REQUERY_MS = 1000

export type CrawlState = 'idle' | 'running' | 'stopped' | 'done' | 'error' | 'locked'

export interface EncryptedSearchScope {
  conversationId?: string | null
  serverId?: string | null
}

interface Run {
  params: SearchRpcParams
  sort: SearchSort
  rooms: string[]
  crawl: ScanRoom[]
  index: EncryptedSearchIndex
}

export function useEncryptedSearch(scope: MaybeRefOrGetter<EncryptedSearchScope>) {
  const results = shallowRef<Message[]>([])
  const capped = ref(false)
  const state = ref<CrawlState>('idle')
  /** Every encrypted chat in scope is searched back to this time, ms. */
  const reachedAt = ref<number | null>(null)
  const unreadable = ref(0)
  /** Encrypted chats in scope whose history the crawl reads. */
  const crawlRooms = ref(0)
  const isQuerying = ref(false)

  let run: Run | null = null
  let controller: AbortController | null = null
  let generation = 0
  let lastQuery = 0
  let pendingQuery: ReturnType<typeof setTimeout> | null = null

  const active = computed(() => state.value === 'running')

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

  /** Reads the index for the run's query; replaces `results`. */
  const query = async (current: Run, gen: number): Promise<void> => {
    lastQuery = Date.now()
    const parsed = parseIndexQuery(current.params.p_query ?? '')
    if (parsed.alternatives.length === 0) {
      results.value = []
      capped.value = false
      return
    }
    const accept = (m: Message) =>
      messageMatchesParams(m, current.params) && matchScore(parsed, prepareText(searchableText(m.content))) > 0
    const { hits, capped: more } = await current.index.search(parsed, {
      rooms: current.rooms,
      from: current.params.p_from_date ? Date.parse(current.params.p_from_date) : undefined,
      to: current.params.p_to_date ? Date.parse(current.params.p_to_date) : undefined,
      ascending: current.sort === 'oldest',
      accept,
      limit: LOCAL_RESULT_LIMIT,
    })
    if (gen !== generation) return
    results.value = hits.map(h => h.message)
    capped.value = more
  }

  const scheduleQuery = (current: Run, gen: number) => {
    if (pendingQuery) return
    const wait = Math.max(0, lastQuery + REQUERY_MS - Date.now())
    pendingQuery = setTimeout(() => {
      pendingQuery = null
      if (gen === generation) void query(current, gen).catch(error => debug.warn('Encrypted search failed:', error))
    }, wait)
  }

  const countUnreadable = async (current: Run, gen: number) => {
    const floors = Object.fromEntries(current.crawl.map(r => [r.room, r.floor !== undefined ? r.floor / 1000 : undefined]))
    const ids = await current.index.unreadable(current.crawl.map(r => r.room), floors)
    if (gen === generation) unreadable.value = ids.length
  }

  /**
   * Drops results deleted or hidden since they were indexed and indexes edits again: one
   * id/updated_at read per hundred results.
   */
  const validate = async (current: Run, gen: number) => {
    const shown = results.value
    if (shown.length === 0) return
    const stale: string[] = []
    const gone = new Set<string>()
    for (let i = 0; i < shown.length; i += 100) {
      const chunk = shown.slice(i, i + 100)
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
      await recordPage(current.index, await processMessageDecryption((data ?? []) as Message[], { index: false }))
    }
    if ((gone.size || stale.length) && gen === generation) await query(current, gen)
  }

  const crawl = async (current: Run, gen: number) => {
    if (current.crawl.length === 0) {
      state.value = 'done'
      return
    }
    const ctrl = new AbortController()
    controller = ctrl
    state.value = 'running'
    const { scanHistory, databaseScanDeps } = await import('@/services/search/encryptedHistoryScan')
    let outcome: 'done' | 'stopped' | 'error'
    try {
      outcome = await scanHistory(current.crawl, databaseScanDeps(current.index), {
        signal: ctrl.signal,
        onProgress: (p: ScanProgress) => {
          if (gen === generation) reachedAt.value = p.reachedAt
        },
        onPage: () => {
          if (gen !== generation) return
          scheduleQuery(current, gen)
          void countUnreadable(current, gen)
        },
      })
    } catch (error) {
      debug.warn('Encrypted history crawl failed:', error)
      outcome = 'error'
    }
    if (controller === ctrl) controller = null
    if (gen !== generation) return
    state.value = outcome
    if (pendingQuery) {
      clearTimeout(pendingQuery)
      pendingQuery = null
    }
    await query(current, gen)
    await countUnreadable(current, gen)
  }

  /** Searches for `params`: the index at once, then the crawl. Text-less queries clear. */
  const search = async (params: SearchRpcParams | null, sort: SearchSort): Promise<void> => {
    clear()
    const gen = generation
    if (!params?.p_query) return
    isQuerying.value = true
    try {
      const [{ accountSearchIndex }, { megolmMessageEncryptionService }, { useProfileStore }] = await Promise.all([
        import('@/services/search/encryptedSearchIndex'),
        import('@/services/encryption/MegolmMessageEncryptionService'),
        import('@/stores/useProfile'),
      ])
      const profileId = megolmMessageEncryptionService.getCurrentUserId() ?? useProfileStore().profile?.id
      if (!profileId) return
      const [index, { rooms, crawl: crawlTargets }] = await Promise.all([accountSearchIndex(), roomsInScope(params, profileId)])
      if (gen !== generation) return
      if (!index) {
        // Locked keys matter only where a chat in scope is encrypted.
        if (crawlTargets.length > 0) {
          crawlRooms.value = crawlTargets.length
          state.value = 'locked'
        }
        return
      }
      run = { params, sort, rooms, crawl: crawlTargets, index }
      crawlRooms.value = crawlTargets.length
      await query(run, gen)
      await countUnreadable(run, gen)
      void validate(run, gen).catch(error => debug.warn('Validating encrypted results failed:', error))
    } catch (error) {
      debug.warn('Encrypted search failed:', error)
      if (gen === generation) state.value = 'error'
      return
    } finally {
      if (gen === generation) isQuerying.value = false
    }
    if (run && gen === generation) void crawl(run, gen)
  }

  /** Stops the crawl; what it read stays indexed. */
  const stop = () => {
    controller?.abort()
  }

  /** Crawls again from where the last one stopped. */
  const searchOlder = () => {
    if (!run || state.value === 'running') return
    void crawl(run, generation)
  }

  const clear = () => {
    generation++
    controller?.abort()
    controller = null
    if (pendingQuery) {
      clearTimeout(pendingQuery)
      pendingQuery = null
    }
    run = null
    results.value = []
    capped.value = false
    state.value = 'idle'
    reachedAt.value = null
    unreadable.value = 0
    crawlRooms.value = 0
    isQuerying.value = false
  }

  return {
    results,
    capped,
    state,
    active,
    reachedAt,
    unreadable,
    crawlRooms,
    isQuerying,
    search,
    stop,
    searchOlder,
    clear,
  }
}
