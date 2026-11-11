import { describe, it, expect, vi, beforeEach } from 'vitest'

// Channel Add/Update reach instances of members who can view the channel; a
// category reaches instances whose members view a channel in it. A channel in a
// category carries an Update of that category ahead of its own activity.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/ActivityProcessor.js', () => ({ ActivityProcessor: {} }))
vi.mock('../services/LinkPreviewService.js', () => ({ linkPreviewService: {} }))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(async () => undefined) },
}))

/** channel_host_flags and category_host_flags answers; undefined fails the read. */
let flagRows: Record<string, unknown>[] | undefined = []

const rpc = vi.fn(async (name: string) => {
  if (name === 'channel_host_flags' || name === 'category_host_flags') {
    return flagRows ? { data: flagRows, error: null } : { data: null, error: { message: 'flags down' } }
  }
  if (name === 'federation_channel_recipients') {
    return { data: [{ instance: 'viewer.test', member_ap_ids: ['https://viewer.test/users/v'], member_count: 1, shared_inbox: null }], error: null }
  }
  if (name === 'federation_category_recipients') {
    return { data: [{ instance: 'viewer.test', member_ap_ids: ['https://viewer.test/users/v'], member_count: 1, shared_inbox: null }], error: null }
  }
  if (name === 'get_server_members_by_instance') {
    return {
      data: [
        { instance: 'viewer.test', member_ap_ids: ['https://viewer.test/users/v'], member_count: 1 },
        { instance: 'blind.test', member_ap_ids: ['https://blind.test/users/b'], member_count: 1 },
      ],
      error: null,
    }
  }
  return { data: null, error: { message: `unexpected ${name}` } }
})

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc,
    from: (table: string) => {
      const q: any = {
        select: () => q,
        eq: () => q,
        single: () => Promise.resolve({
          data: { id: 's1', owner: 'alice', federation_enabled: true, is_local_server: true },
          error: null,
        }),
        maybeSingle: () => Promise.resolve({
          data: table === 'channel_categories' ? { id: 'cat1', name: 'staff', order: 4 } : null,
          error: null,
        }),
      }
      return q
    },
  }),
}))

const { handleChannelCreated, handleChannelUpdated } = await import('../listeners/DatabaseListener.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const enqueue = vi.mocked(DeliveryQueue.enqueue)

beforeEach(() => {
  rpc.mockClear()
  enqueue.mockClear()
  flagRows = []
})

describe('channel structure fan-out', () => {
  it.each([
    ['created', handleChannelCreated],
    ['updated', (c: any) => handleChannelUpdated(c, c)],
  ])('a %s channel reaches only instances that can view it', async (_label, handler) => {
    await handler({ id: 'c1', server_id: 's1', name: 'secret', type: 0 })
    expect(rpc).toHaveBeenCalledWith('federation_channel_recipients', { p_channel_id: 'c1' })
    expect(enqueue.mock.calls.map(c => c[1])).toEqual(['https://viewer.test/inbox'])
  })

  it('is the Group\'s activity, signed with the Group key', async () => {
    await handleChannelUpdated({ id: 'c1', server_id: 's1', name: 'secret', type: 0 }, {})
    expect(enqueue.mock.calls.map(c => [(c[0] as any).actor, c[2]])).toEqual([
      ['https://harmony.test/servers/s1', { serverId: 's1' }],
    ])
  })

  it('a category reaches only instances whose members view a channel in it', async () => {
    await handleChannelCreated({ id: 'cat1', server_id: 's1', name: 'cat', type: 2 })
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['federation_category_recipients', 'category_host_flags'])
    expect(enqueue.mock.calls.map(c => c[1])).toEqual(['https://viewer.test/inbox'])
  })

  it.each([
    ['created', handleChannelCreated, 'Add'],
    ['updated', (c: any) => handleChannelUpdated(c, c), 'Update'],
  ])('a %s channel in a category sends the category first, to the same instances', async (_label, handler, type) => {
    await handler({ id: 'c1', server_id: 's1', name: 'secret', type: 0, category: 'cat1' })
    expect(enqueue.mock.calls.map(c => [(c[0] as any).type, (c[0] as any).object.type, c[1]])).toEqual([
      ['Update', 'harmony:Category', 'https://viewer.test/inbox'],
      [type, 'harmony:TextChannel', 'https://viewer.test/inbox'],
    ])
    expect((enqueue.mock.calls[0][0] as any).object).toMatchObject({
      id: 'https://harmony.test/servers/s1/channels/cat1',
      name: 'staff',
      position: 4,
    })
    expect((enqueue.mock.calls[1][0] as any).object.category).toBe('https://harmony.test/servers/s1/channels/cat1')
  })

  it.each([
    ['Add', handleChannelCreated],
    ['Update', (c: any) => handleChannelUpdated(c, c)],
  ])('a channel\'s %s carries its flags', async (_label, handler) => {
    flagRows = [{ channel_id: 'c1', messages: true, voice: true, is_private: true }]
    await handler({ id: 'c1', server_id: 's1', name: 'secret', type: 1 })
    expect((enqueue.mock.calls[0][0] as any).object).toMatchObject({
      'harmony:encryption': { messages: true, voice: true },
      'harmony:private': true,
    })
  })

  it.each([
    ['Add', handleChannelCreated],
    ['Update', (c: any) => handleChannelUpdated(c, c)],
  ])('a plain channel\'s %s has neither key', async (_label, handler) => {
    flagRows = [{ channel_id: 'c1', messages: false, voice: false, is_private: false }]
    await handler({ id: 'c1', server_id: 's1', name: 'open', type: 0 })
    const object = (enqueue.mock.calls[0][0] as any).object
    expect(object).not.toHaveProperty(['harmony:encryption'])
    expect(object).not.toHaveProperty(['harmony:private'])
  })

  it('a category\'s Update carries harmony:private alone', async () => {
    flagRows = [{ category_id: 'cat1', is_private: true }]
    await handleChannelUpdated({ id: 'cat1', server_id: 's1', name: 'cat', type: 2 }, {})
    const object = (enqueue.mock.calls[0][0] as any).object
    expect(object['harmony:private']).toBe(true)
    expect(object).not.toHaveProperty(['harmony:encryption'])
  })

  it('sends nothing when the flags cannot be read: an absent property would clear them on the copy', async () => {
    flagRows = undefined
    await handleChannelUpdated({ id: 'c1', server_id: 's1', name: 'secret', type: 0 }, {})
    expect(enqueue).not.toHaveBeenCalled()
  })
})
