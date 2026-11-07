import { describe, it, expect, vi, beforeEach } from 'vitest'

// refreshVoicePresence: one voice_presence_refresh_targets call per run, one VoiceChannelJoin per
// caller, delivered once to each of that caller's instances, never to this instance.

vi.mock('../config/index.js', () => ({ default: { INSTANCE_DOMAIN: 'host.test' } }))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => ({}) }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({ DeliveryQueue: { deliverOnce: vi.fn() } }))
vi.mock('../services/FederationSwitches.js', () => ({ federationSwitches: vi.fn(async () => ({ inbound: true, outbound: true })) }))
vi.mock('../services/voiceParticipantSweep.js', () => ({ voiceRosterUnverified: () => false }))
vi.mock('../activitypub/VoiceActivityHandler.js', () => ({
  VoiceActivityHandler: {
    createVoiceChannelJoin: vi.fn((actor: string, channelId: string, channelName: string, serverId: string, serverName: string) => ({
      type: 'VoiceChannelJoin', actor, object: { id: channelId, name: channelName, serverId, serverName },
    })),
  },
}))

const { refreshVoicePresence } = await import('../services/voicePresenceRefresh.js')
const { VoiceActivityHandler } = await import('../activitypub/VoiceActivityHandler.js')

const target = (over: Record<string, unknown>) => ({
  channel_id: 'c1', channel_name: 'voice', server_id: 's1', server_name: 'Hall',
  user_id: 'u1', username: 'ann', federated_id: 'https://host.test/users/ann',
  instance: 'a.test', shared_inbox: 'https://a.test/inbox', ...over,
})

function deps(rows: unknown[] | null, error: { message: string } | null = null) {
  const rpc = vi.fn(async () => ({ data: rows, error }))
  const deliver = vi.fn(async () => undefined)
  return { rpc, deliver, deps: { supabase: { rpc } as any, instanceDomain: 'host.test', deliver } }
}

beforeEach(() => {
  vi.mocked(VoiceActivityHandler.createVoiceChannelJoin).mockClear()
})

describe('refreshVoicePresence', () => {
  it('sends each caller one VoiceChannelJoin per instance from a single read', async () => {
    const rows = [
      target({}),
      target({ instance: 'b.test', shared_inbox: 'https://b.test/inbox' }),
      target({ instance: 'b.test', shared_inbox: 'https://b.test/inbox' }),
      target({ user_id: 'u2', username: 'bob', federated_id: null, instance: 'a.test' }),
      target({ instance: 'host.test', shared_inbox: 'https://host.test/inbox' }),
      target({ user_id: 'u3', username: null, federated_id: null }),
    ]
    const { rpc, deliver, deps: d } = deps(rows)

    expect(await refreshVoicePresence(d)).toEqual({ ok: true, callers: 2, deliveries: 3 })
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('voice_presence_refresh_targets')
    expect(VoiceActivityHandler.createVoiceChannelJoin).toHaveBeenCalledTimes(2)
    expect(deliver).toHaveBeenCalledTimes(2)

    const [annItems, annSigner] = deliver.mock.calls[0] as unknown as [Array<{ inbox: string; activity: any }>, string]
    expect(annSigner).toBe('u1')
    expect(annItems.map((i) => i.inbox)).toEqual(['https://a.test/inbox', 'https://b.test/inbox'])
    expect(annItems[0].activity).toBe(annItems[1].activity)
    expect(annItems[0].activity).toMatchObject({
      actor: 'https://host.test/users/ann', object: { id: 'c1', serverId: 's1' }, 'harmony:refresh': true,
    })

    const [bobItems, bobSigner] = deliver.mock.calls[1] as unknown as [Array<{ inbox: string; activity: any }>, string]
    expect(bobSigner).toBe('u2')
    expect(bobItems[0].activity.actor).toBe('https://host.test/users/bob')
  })

  it('falls back to the instance inbox', async () => {
    const { deliver, deps: d } = deps([target({ shared_inbox: null })])
    await refreshVoicePresence(d)
    expect((deliver.mock.calls[0] as unknown as [Array<{ inbox: string }>])[0][0].inbox).toBe('https://a.test/inbox')
  })

  it('sends nothing when the read fails or finds no caller', async () => {
    const failed = deps(null, { message: 'boom' })
    expect(await refreshVoicePresence(failed.deps)).toEqual({ ok: false, reason: 'boom' })
    expect(failed.deliver).not.toHaveBeenCalled()

    const empty = deps([])
    expect(await refreshVoicePresence(empty.deps)).toEqual({ ok: true, callers: 0, deliveries: 0 })
    expect(empty.deliver).not.toHaveBeenCalled()
  })
})
