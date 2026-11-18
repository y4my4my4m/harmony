/**
 * Realtime reactions relayed by a bridge bot: each person (metadata.discord_user or
 * metadata.matrix_user) is an entry of its own, keyed by platform and id.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

vi.mock('vue-i18n', () => ({
  useI18n: () => ({ t: (key: string) => key }),
  createI18n: () => ({ install: () => {}, global: { t: (key: string) => key } }),
}))

import { useReactionsStore } from '@/stores/useReactions'

function payload(op: 'INSERT' | 'DELETE', reactionId: string, metadata: Record<string, unknown>) {
  return {
    type: op === 'INSERT' ? 'reaction:insert' : 'reaction:delete',
    op,
    reaction_id: reactionId,
    message_id: 'm1',
    emoji_id: null,
    emoji_name: '🔥',
    custom_emoji_content: '🔥',
    user_id: null,
    bot_id: 'bridge-bot',
    metadata,
  }
}

const matrix = (id: string) => ({ matrix_user: { id, username: id.slice(1, id.indexOf(':')) } })
const discord = (id: string) => ({ discord_user: { id, username: `u${id}` } })

describe('bridged reactors from realtime', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('counts Discord and Matrix people relayed by one bot separately', async () => {
    const store = useReactionsStore()
    store.bulkSetReactions({ m1: [] })
    await store.handleRealtimeUpdate(payload('INSERT', 'r1', matrix('@sam:example.org')))
    await store.handleRealtimeUpdate(payload('INSERT', 'r2', matrix('@lee:example.org')))
    await store.handleRealtimeUpdate(payload('INSERT', 'r3', discord('42')))
    expect(store.getMessageReactions('m1')[0]).toMatchObject({ count: 3 })

    await store.handleRealtimeUpdate(payload('DELETE', 'r1', matrix('@sam:example.org')))
    const group = store.getMessageReactions('m1')[0]!
    expect(group.count).toBe(2)
    expect(group.reactions.map(r => r.reaction_id).sort()).toEqual(['r2', 'r3'])
  })

  it('keys a Discord reactor without an id by its bot, not by an empty platform key', async () => {
    const store = useReactionsStore()
    store.bulkSetReactions({ m1: [] })
    await store.handleRealtimeUpdate(payload('INSERT', 'r1', { discord_user: { username: 'legacy' } }))
    await store.handleRealtimeUpdate(payload('INSERT', 'r2', discord('42')))
    expect(store.getMessageReactions('m1')[0]).toMatchObject({ count: 2 })

    await store.handleRealtimeUpdate(payload('DELETE', 'r1', {}))
    const group = store.getMessageReactions('m1')[0]!
    expect(group.reactions.map(r => r.reaction_id)).toEqual(['r2'])
  })
})
