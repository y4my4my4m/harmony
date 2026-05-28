/**
 * Regression test for the home-timeline realtime path.
 *
 * Bug history: `20260322_broadcast_post_follow_interaction.sql` replaced the
 * firehose `postgres_changes` subscription on `posts` with a targeted
 * `realtime.send()` that only delivered `post:new` to the AUTHOR's
 * `user:{author_id}` channel — so followers' home feeds stopped prepending
 * posts in real time (the user complaint: "I'm not seeing posts appearing
 * in realtime btw"). The DB-side fix broadcasts a new `home_feed:new_post`
 * event on each home-timeline recipient's channel; the frontend-side fix
 * (which this file exercises) is to route that event type through the
 * existing `UserEventChannel` dispatch path so registered handlers fire.
 *
 * The test mocks the Supabase client so we exercise the in-process
 * dispatch logic without opening a real broadcast channel.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const channelStub = {
  on: vi.fn().mockReturnThis(),
  subscribe: vi.fn().mockReturnThis(),
}

vi.mock('@/supabase', () => ({
  supabase: {
    channel: vi.fn(() => channelStub),
    removeChannel: vi.fn(),
  },
}))

vi.mock('@/utils/debug', () => ({
  debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

import { userEventChannel } from '@/services/UserEventChannel'

beforeEach(() => {
  channelStub.on.mockClear()
  channelStub.subscribe.mockClear()
})

afterEach(() => {
  userEventChannel.disconnect()
})

describe('UserEventChannel.dispatch', () => {
  it('routes home_feed:new_post events to registered handlers', () => {
    const handler = vi.fn()
    userEventChannel.on('home_feed:new_post', handler)

    // The real channel calls this via the Supabase broadcast subscription;
    // here we reach in and call the same private dispatch path to verify
    // the type-routing logic without spinning up a broker.
    ;(userEventChannel as unknown as {
      dispatch: (data: Record<string, unknown>) => void
    }).dispatch({
      type: 'home_feed:new_post',
      post_id: 'post-123',
      author_id: 'author-456',
      created_at: '2026-05-28T00:00:00Z',
      visibility: 'public',
    })

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'home_feed:new_post',
        post_id: 'post-123',
        author_id: 'author-456',
      }),
    )
  })

  it('does not invoke home_feed:new_post handlers for unrelated types', () => {
    const homeHandler = vi.fn()
    const postHandler = vi.fn()
    userEventChannel.on('home_feed:new_post', homeHandler)
    userEventChannel.on('post:updated', postHandler)

    ;(userEventChannel as unknown as {
      dispatch: (data: Record<string, unknown>) => void
    }).dispatch({ type: 'post:updated', post_id: 'p1', author_id: 'a1' })

    expect(homeHandler).not.toHaveBeenCalled()
    expect(postHandler).toHaveBeenCalledTimes(1)
  })

  it('allows multiple handlers to subscribe to home_feed:new_post', () => {
    const h1 = vi.fn()
    const h2 = vi.fn()
    userEventChannel.on('home_feed:new_post', h1)
    userEventChannel.on('home_feed:new_post', h2)

    ;(userEventChannel as unknown as {
      dispatch: (data: Record<string, unknown>) => void
    }).dispatch({
      type: 'home_feed:new_post',
      post_id: 'post-9',
      author_id: 'author-9',
    })

    expect(h1).toHaveBeenCalledTimes(1)
    expect(h2).toHaveBeenCalledTimes(1)
  })

  it('returns an unsubscribe function that detaches the handler', () => {
    const handler = vi.fn()
    const unsubscribe = userEventChannel.on('home_feed:new_post', handler)
    unsubscribe()

    ;(userEventChannel as unknown as {
      dispatch: (data: Record<string, unknown>) => void
    }).dispatch({
      type: 'home_feed:new_post',
      post_id: 'post-x',
      author_id: 'author-x',
    })

    expect(handler).not.toHaveBeenCalled()
  })
})
