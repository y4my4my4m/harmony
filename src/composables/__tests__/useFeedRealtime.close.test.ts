import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { mount } from '@vue/test-utils'

// A feed topic the server closes is opened again while the view is mounted.

const realtime = vi.hoisted(() => ({
  opened: [] as Array<{ topic: string; opts: any; status?: (s: string) => void; handler?: (p: any) => void }>,
  removed: [] as string[],
}))

vi.mock('@/supabase', () => ({
  supabase: {
    channel: (topic: string, opts: any) => {
      const record: (typeof realtime.opened)[number] = { topic, opts }
      realtime.opened.push(record)
      const ch: any = {
        topic,
        on: (_t: string, _f: unknown, cb: (p: any) => void) => { record.handler = cb; return ch },
        subscribe: (cb: (s: string) => void) => { record.status = cb; return ch },
      }
      return ch
    },
    removeChannel: async (ch: any) => { realtime.removed.push(ch.topic); return 'ok' },
  },
}))
const store = vi.hoisted(() => ({ handleRealtimePostCreate: vi.fn(), handleRealtimePostUpdate: vi.fn(), handleRealtimePostDelete: vi.fn(), handleRealtimeInteractionChange: vi.fn() }))
vi.mock('@/stores/useActivityPub', () => ({ useActivityPubStore: () => store }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { useFeedRealtime, type FeedKind } from '@/composables/useFeedRealtime'

const View = defineComponent({
  setup() {
    useFeedRealtime(ref<FeedKind>('public'))
    return () => h('div')
  },
})

beforeEach(() => {
  realtime.opened.length = 0
  realtime.removed.length = 0
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useFeedRealtime and a server close', () => {
  it('opens the feed topic again and delivers on it', async () => {
    const view = mount(View)
    expect(realtime.opened.map((o) => [o.topic, o.opts.config.private])).toEqual([['feed:public', true]])
    realtime.opened[0].status!('CLOSED')
    await vi.advanceTimersByTimeAsync(7_500)
    expect(realtime.opened.map((o) => o.topic)).toEqual(['feed:public', 'feed:public'])

    realtime.opened[1].handler!({ payload: { type: 'post:new', post_id: 'p1', author_id: 'a1', visibility: 'public', is_local: true } })
    expect(store.handleRealtimePostCreate).toHaveBeenCalledWith(expect.objectContaining({ id: 'p1' }))
    view.unmount()
  })

  it('opens nothing once the view is unmounted', async () => {
    const view = mount(View)
    realtime.opened[0].status!('CLOSED')
    view.unmount()
    await vi.advanceTimersByTimeAsync(120_000)
    expect(realtime.opened).toHaveLength(1)
  })
})
