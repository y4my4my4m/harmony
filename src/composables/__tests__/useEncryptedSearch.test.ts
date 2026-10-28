import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref } from 'vue'
import type { Message } from '@/types'
import type { SearchRpcParams } from '@/utils/searchQuery'

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

type ScanOptions = { signal: AbortSignal; onPage?: () => void; onProgress?: (p: unknown) => void }
const scans: Array<{ options: ScanOptions; finish: Deferred<'done' | 'stopped' | 'error'> }> = []
const scanHistory = vi.fn((_rooms: unknown, _deps: unknown, options: ScanOptions) => {
  const finish = deferred<'done' | 'stopped' | 'error'>()
  options.signal.addEventListener('abort', () => finish.resolve('stopped'))
  scans.push({ options, finish })
  return finish.promise
})
const recordPage = vi.fn(async () => {})
vi.mock('@/services/search/encryptedHistoryScan', () => ({
  readableFloor: vi.fn(async () => ({})),
  scanHistory: (...a: Parameters<typeof scanHistory>) => scanHistory(...a),
  databaseScanDeps: () => ({}),
  recordPage: (...a: unknown[]) => recordPage(...(a as [])),
}))

const index = {
  search: vi.fn(),
  unreadable: vi.fn(async () => []),
  remove: vi.fn(async () => {}),
}
vi.mock('@/services/search/encryptedSearchIndex', () => ({ accountSearchIndex: async () => index }))
vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: { getCurrentUserId: () => 'p1' },
}))
vi.mock('@/stores/useProfile', () => ({ useProfileStore: () => ({ profile: { id: 'p1' } }) }))
vi.mock('@/services/conversationEncryption', () => ({ conversationEncryptionEnabled: async () => true }))
vi.mock('@/stores/useDM', () => ({ useDMStore: () => ({ conversations: [] }) }))
const processMessageDecryption = vi.fn(async (rows: Message[]) => rows)
vi.mock('@/utils/messageDecryption', () => ({
  processMessageDecryption: (...a: Parameters<typeof processMessageDecryption>) => processMessageDecryption(...a),
}))

import { supabase } from '@/supabase'
import { LOCAL_RESULT_LIMIT, REQUERY_MS, useEncryptedSearch } from '@/composables/useEncryptedSearch'

const from = supabase.from as unknown as ReturnType<typeof vi.fn>

const message = (n: number, text = 'zebra'): Message => ({
  id: `m${n}`,
  conversation_id: 'c1',
  created_at: new Date(Date.UTC(2025, 0, 1) + n * 60000),
  content: [{ type: 'text', text }],
})
const hit = (n: number) => ({ message: message(n), at: message(n).created_at.getTime() })
const params = (q: string): SearchRpcParams => ({ p_query: q, p_limit: 25, p_offset: 0 } as SearchRpcParams)

/** messages reads: every id present, unchanged, unless `stale` lists it as edited. */
function serveMessages(stale: string[] = []) {
  from.mockImplementation(() => {
    let ids: string[] = []
    const chain = {
      select: () => chain,
      in: (_c: string, list: string[]) => { ids = list; return chain },
      not: () => chain,
      then: (resolve: (v: unknown) => void) => resolve({
        data: ids.map(id => stale.includes(id)
          ? { id, updated_at: '2030-01-01T00:00:00Z', encrypted: true, encryption_metadata: {}, conversation_id: 'c1', created_at: '2025-01-01T00:00:00Z', content: [] }
          : { id, updated_at: null }),
        error: null,
      }),
    }
    return chain
  })
}

function mount(conversationId = ref('c1')) {
  const scope = effectScope()
  const search = scope.run(() => useEncryptedSearch(() => ({ conversationId: conversationId.value })))!
  return { search, scope, conversationId }
}

beforeEach(() => {
  scans.length = 0
  scanHistory.mockClear()
  recordPage.mockClear()
  processMessageDecryption.mockClear()
  index.search.mockReset()
  index.search.mockResolvedValue({ hits: [], capped: false })
  serveMessages()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useEncryptedSearch', () => {
  it('a second search in the same chats keeps the crawl running', async () => {
    const { search, conversationId } = mount()
    await search.search(params('zebra'), 'newest')
    await vi.waitFor(() => expect(scanHistory).toHaveBeenCalledTimes(1))
    expect(search.state.value).toBe('running')

    await search.search(params('other'), 'newest')
    await search.search(params('other'), 'oldest')
    expect(scanHistory).toHaveBeenCalledTimes(1)
    expect(scans[0].options.signal.aborted).toBe(false)
    expect(search.state.value).toBe('running')
    expect(index.search.mock.calls.at(-1)![1]).toMatchObject({ ascending: true })

    // A page of the running crawl refreshes the latest query.
    index.search.mockClear()
    scans[0].options.onPage!()
    await vi.waitFor(() => expect(index.search).toHaveBeenCalled(), { timeout: REQUERY_MS * 3 })
    expect(index.search.mock.calls[0][0].alternatives[0].terms[0].value).toBe('other')

    conversationId.value = 'c2'
    await search.search(params('other'), 'newest')
    expect(scans[0].options.signal.aborted).toBe(true)
    await vi.waitFor(() => expect(scanHistory).toHaveBeenCalledTimes(2))
  })

  it('never reads the index twice at once while the crawl lands pages', async () => {
    const { search } = mount()
    await search.search(params('zebra'), 'newest')
    await vi.waitFor(() => expect(scanHistory).toHaveBeenCalledTimes(1))
    vi.useFakeTimers()
    let running = 0
    let most = 0
    const reads: Array<Deferred<{ hits: unknown[]; capped: boolean }>> = []
    index.search.mockImplementation(() => {
      running++
      most = Math.max(most, running)
      const d = deferred<{ hits: unknown[]; capped: boolean }>()
      reads.push(d)
      return d.promise.finally(() => { running-- })
    })
    for (let i = 0; i < 6; i++) {
      scans[0].options.onPage!()
      await vi.advanceTimersByTimeAsync(REQUERY_MS)
    }
    expect(reads.length).toBe(1)
    expect(most).toBe(1)
    reads[0].resolve({ hits: [], capped: false })
    await vi.advanceTimersByTimeAsync(REQUERY_MS)
    // The pages that landed meanwhile get one more read.
    expect(reads.length).toBe(2)
    expect(most).toBe(1)
    reads[1].resolve({ hits: [], capped: false })
    await vi.advanceTimersByTimeAsync(REQUERY_MS * 3)
    expect(reads.length).toBe(2)
  })

  it('reads a page window past its first results from the index', async () => {
    const first = Array.from({ length: LOCAL_RESULT_LIMIT }, (_, i) => hit(10_000 - i))
    index.search.mockImplementation(async (_q: unknown, o: { from: number; to: number }) =>
      o.to === Infinity ? { hits: first, capped: true } : { hits: [hit(42)], capped: false })
    const { search } = mount()
    await search.search(params('zebra'), 'newest')
    expect(search.capped.value).toBe(true)
    expect(search.windowed.value).toHaveLength(LOCAL_RESULT_LIMIT)

    // Inside the first results: no second read.
    index.search.mockClear()
    search.setWindow({ from: hit(9_800).at, to: hit(9_900).at })
    await vi.waitFor(() => expect(search.windowed.value).toHaveLength(101))
    expect(index.search).not.toHaveBeenCalled()

    // Older than the 500th: read on its own.
    search.setWindow({ from: hit(40).at, to: hit(50).at })
    await vi.waitFor(() => expect(search.windowed.value.map(m => m.id)).toEqual(['m42']))
    expect(index.search).toHaveBeenCalledTimes(1)
    expect(index.search.mock.calls[0][1]).toMatchObject({ from: hit(40).at, to: hit(50).at })

    search.setWindow(null)
    await vi.waitFor(() => expect(search.windowed.value).toEqual([]))
  })

  it('re-decrypts an edited result with the keys this device holds only', async () => {
    index.search.mockResolvedValue({ hits: [hit(1)], capped: false })
    serveMessages(['m1'])
    const { search } = mount()
    await search.search(params('zebra'), 'newest')
    await vi.waitFor(() => expect(processMessageDecryption).toHaveBeenCalled())
    expect(processMessageDecryption.mock.calls[0][1]).toEqual({ index: false, heldKeysOnly: true })
    await vi.waitFor(() => expect(recordPage).toHaveBeenCalled())
  })
})
