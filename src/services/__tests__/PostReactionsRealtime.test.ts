import { describe, it, expect, vi, beforeEach } from 'vitest'

// Reaction events reach every mounted view of a post until its last view unmounts.

const channel = vi.hoisted(() => ({ handler: null as ((data: any) => void) | null, offs: 0 }))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: {
    on: (_type: string, handler: (data: any) => void) => {
      channel.handler = handler
      return () => { channel.handler = null; channel.offs++ }
    },
  },
}))
const store = vi.hoisted(() => ({ handleRealtimeUpdate: vi.fn() }))
vi.mock('@/stores/postReactions', () => ({ usePostReactionsStore: () => store }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { postReactionsRealtime } from '@/services/PostReactionsRealtime'

const react = (postId: string) =>
  channel.handler?.({ post_id: postId, interaction_type: 'emoji_reaction', op: 'INSERT', user_id: 'u', emoji_id: 'e' })

beforeEach(() => {
  store.handleRealtimeUpdate.mockClear()
  channel.offs = 0
})

describe('postReactionsRealtime', () => {
  it('keeps delivering a post shown twice after one of its views unmounts', () => {
    postReactionsRealtime.subscribe('p1')
    postReactionsRealtime.subscribe('p1')
    postReactionsRealtime.unsubscribe('p1')
    react('p1')
    expect(store.handleRealtimeUpdate).toHaveBeenCalledTimes(1)

    postReactionsRealtime.unsubscribe('p1')
    react('p1')
    expect(store.handleRealtimeUpdate).toHaveBeenCalledTimes(1)
    expect(channel.offs).toBe(1)
  })

  it('stops a post once its last view unmounts, leaving the other posts', () => {
    postReactionsRealtime.subscribe('a')
    postReactionsRealtime.subscribe('b')
    postReactionsRealtime.unsubscribe('a')
    react('a')
    expect(store.handleRealtimeUpdate).not.toHaveBeenCalled()
    react('b')
    expect(store.handleRealtimeUpdate).toHaveBeenCalledTimes(1)
    postReactionsRealtime.unsubscribe('b')
    expect(channel.offs).toBe(1)
  })

  it('ignores an unsubscribe of a post it does not hold', () => {
    postReactionsRealtime.subscribe('a')
    postReactionsRealtime.unsubscribe('z')
    react('a')
    expect(store.handleRealtimeUpdate).toHaveBeenCalledTimes(1)
    postReactionsRealtime.unsubscribe('a')
    expect(channel.offs).toBe(1)
  })
})
