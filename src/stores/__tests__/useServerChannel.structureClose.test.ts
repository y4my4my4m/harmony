import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useServerChannelStore } from '@/stores/useServerChannel'

// A server-structure topic the server closes is opened again; once it is back, the channel list
// is read again for the changes broadcast while it was down.

type Opened = { topic: string; opts: any; status?: (s: string, e?: Error) => void; handler?: (p: any) => unknown }

function captureChannels(): Opened[] {
  const opened: Opened[] = []
  vi.mocked(supabase.channel).mockImplementation(((topic: string, opts: any) => {
    const record: Opened = { topic, opts }
    opened.push(record)
    const channel: any = {
      on: vi.fn((_kind: string, _filter: unknown, cb: (p: any) => unknown) => { record.handler = cb; return channel }),
      subscribe: vi.fn((cb: (s: string, e?: Error) => void) => { record.status = cb; return channel }),
    }
    return channel
  }) as any)
  return opened
}

describe('server-structure closed by the server', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('opens the topic again and re-reads the channel list once it is back', async () => {
    const opened = captureChannels()
    const store = useServerChannelStore()
    store.currentServerId = 'srv-1'
    const refetch = vi.spyOn(store, 'fetchCategoriesAndChannels').mockResolvedValue(undefined)
    await store.subscribeToServerStructure('srv-1')
    expect(opened.map((o) => [o.topic, o.opts.config.private])).toEqual([['server-structure:srv-1', true]])

    opened[0].status!('SUBSCRIBED')
    opened[0].status!('CLOSED')
    await vi.advanceTimersByTimeAsync(7_500)
    expect(opened).toHaveLength(2)
    expect(opened[1].topic).toBe('server-structure:srv-1')

    opened[1].status!('SUBSCRIBED')
    await vi.advanceTimersByTimeAsync(500)
    expect(refetch).toHaveBeenCalledWith('srv-1', undefined, true)
  })

  it('opens nothing for a server switched away from', async () => {
    const opened = captureChannels()
    const store = useServerChannelStore()
    await store.subscribeToServerStructure('srv-1')
    opened[0].status!('CLOSED')
    await store.subscribeToServerStructure('srv-2')
    await vi.advanceTimersByTimeAsync(120_000)
    expect(opened.map((o) => o.topic)).toEqual(['server-structure:srv-1', 'server-structure:srv-2'])
  })
})
