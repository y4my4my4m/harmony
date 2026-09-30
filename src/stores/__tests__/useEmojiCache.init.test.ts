import { describe, it, expect, beforeEach, vi } from 'vitest'
import { setActivePinia, createPinia } from 'pinia'

const EMOJIS = [
  { id: 'e1', name: 'wave', url: 'https://x/1.png', server_id: 's1' },
  { id: 'e2', name: 'blob', url: 'https://x/2.png', server_id: 's2' },
]

vi.mock('@/supabase', () => {
  const query = (table: string) => {
    let ids: string[] = []
    const builder: any = {
      select: () => builder,
      in: (_col: string, v: string[]) => { ids = v; return builder },
      order: () => builder,
      then: (resolve: (r: any) => void) => {
        const data = table === 'emojis'
          ? EMOJIS.filter(e => ids.includes(e.server_id))
          : ids.map(id => ({ id, name: id, icon: null, allow_cross_server_emojis: true }))
        resolve({ data, error: null })
      },
    }
    return builder
  }
  return { supabase: { from: query, rpc: async () => ({ data: [], error: null }) } }
})

vi.mock('@/services/emojiIndexedDBCache', () => ({
  getAllCachedServerEmojis: async () => [],
  setCachedServerEmojis: () => {},
  removeCachedServerEmojis: () => {},
}))

describe('useEmojiCache.initializeSelective', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('loads servers named by a later caller after the first init', async () => {
    const { useEmojiCacheStore } = await import('@/stores/useEmojiCache')
    const store = useEmojiCacheStore()

    // First route (DM/social) initialized with a single server.
    await store.initializeSelective(['s1'], [])
    expect(store.getEmojiById('e2')).toBeNull()

    await store.initializeSelective(['s1'], ['s2'])
    expect(store.getEmojiById('e2')?.name).toBe('blob')
  })
})
