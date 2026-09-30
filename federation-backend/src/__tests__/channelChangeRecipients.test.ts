import { describe, it, expect, vi, beforeEach } from 'vitest'

// Channel Add/Update reach instances of members who can view the channel; a
// category, which carries no permissions, reaches every accepted member.

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

const rpc = vi.fn(async (name: string) => {
  if (name === 'federation_channel_recipients') {
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
    from: () => {
      const q: any = {
        select: () => q,
        eq: () => q,
        single: () => Promise.resolve({
          data: { id: 's1', owner: 'alice', federation_enabled: true, is_local_server: true },
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

  it('a category reaches every accepted remote member', async () => {
    await handleChannelCreated({ id: 'cat1', server_id: 's1', name: 'cat', type: 2 })
    expect(rpc.mock.calls.map(c => c[0])).toEqual(['get_server_members_by_instance'])
    expect(enqueue.mock.calls.map(c => c[1])).toEqual(['https://viewer.test/inbox', 'https://blind.test/inbox'])
  })
})
