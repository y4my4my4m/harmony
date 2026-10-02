import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { SERVER_BOT_CHANGE_EVENT } from '@/services/serverBotsService'

// server-structure bot:* broadcasts reach the member list as a window event.

type Handler = (payload: { payload: Record<string, unknown> }) => Promise<void> | void

function captureServerEvents(): { handler: () => Handler } {
  let captured: Handler | null = null
  const channel: any = {
    on: vi.fn((_kind: string, filter: { event: string }, cb: Handler) => {
      if (filter.event === 'server_event') captured = cb
      return channel
    }),
    subscribe: vi.fn(() => channel),
    unsubscribe: vi.fn(async () => 'ok'),
  }
  vi.mocked(supabase.channel).mockReturnValue(channel)
  return {
    handler: () => {
      if (!captured) throw new Error('no server_event handler')
      return captured
    },
  }
}

describe('useServerChannelStore bot broadcasts', () => {
  const seen: unknown[] = []
  const listener = (event: Event) => seen.push((event as CustomEvent).detail)

  beforeEach(() => {
    setActivePinia(createPinia())
    seen.length = 0
    window.addEventListener(SERVER_BOT_CHANGE_EVENT, listener)
  })

  afterEach(() => {
    window.removeEventListener(SERVER_BOT_CHANGE_EVENT, listener)
  })

  it('re-dispatches each bot event type', async () => {
    const events = captureServerEvents()
    const store = useServerChannelStore()
    await store.subscribeToServerStructure('srv-1')

    for (const type of ['bot:insert', 'bot:update', 'bot:delete', 'bot:presence']) {
      await events.handler()({ payload: { type, server_id: 'srv-1', bot_id: 'bot-1' } })
    }
    await events.handler()({ payload: { type: 'bot:unknown', server_id: 'srv-1', bot_id: 'bot-1' } })

    expect(seen).toEqual(['bot:insert', 'bot:update', 'bot:delete', 'bot:presence'].map(type => ({
      type, server_id: 'srv-1', bot_id: 'bot-1',
    })))
  })
})
