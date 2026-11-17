import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const BOT_A = '00000000-0000-0000-0000-0000000000b0'
const BOT_B = '00000000-0000-0000-0000-0000000000b1'
const ALICE = '00000000-0000-0000-0000-0000000000a1'
const BOB = '00000000-0000-0000-0000-0000000000a2'
const CAROL = '00000000-0000-0000-0000-0000000000a3'

const mocks = vi.hoisted(() => ({ rpc: vi.fn() }))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc },
  config: {},
}))

import { INTERACTION_CLAIM_LIMIT, INTERACTION_POLL_MS, InteractionPoller, interactionEvent } from '../InteractionPoller.js'
import type { WebSocketGateway } from '../WebSocketGateway.js'

type Sent = { botId: string; event: any }

let connected: string[]
let sockets: Record<string, number>
let sent: Sent[]
const env = { ...process.env }

function gateway(): Pick<WebSocketGateway, 'getConnectedBots' | 'sendToBot'> {
  return {
    getConnectedBots: () => connected.map((botId, i) => ({
      botId, username: 'bot', scopes: [], lastHeartbeat: 0, sessionId: `s${i}`, tokenHash: 'h',
    })),
    sendToBot: (botId: string, event: any) => {
      sent.push({ botId, event })
      return sockets[botId] ?? 0
    },
  }
}

/** A claim_bot_interactions row as the contract shapes it. */
function claimed(id: string, botId: string, extra: Record<string, unknown> = {}) {
  return {
    id, bot_id: botId, type: 2, server_id: 's', channel_id: 'c', thread_id: null,
    user: { id: ALICE, username: 'alice', display_name: 'Alice', avatar_url: 'alice/a.png', bot: false },
    member: { nickname: null, roles: [], permissions: ['SEND_MESSAGES'] },
    data: { id: 'cmd', name: 'weather', type: 1, options: [{ name: 'city', type: 3, value: 'Tokyo' }], resolved: {} },
    created_at: 't0', respond_by: 't5', expires_at: 't900',
    ...extra,
  }
}

beforeEach(() => {
  connected = [BOT_A]
  sockets = { [BOT_A]: 1 }
  sent = []
  process.env.PUBLIC_URL = 'https://harmony.test'
  mocks.rpc.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  process.env = { ...env }
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('InteractionPoller', () => {
  it('claims for the connected bots only, once each, and sends INTERACTION_CREATE without bot_id', async () => {
    connected = [BOT_A, BOT_B, BOT_A]
    mocks.rpc.mockImplementation(async (fn, args) => ({ data: fn === 'bridge_member_recipients' ? args.p_bot_ids : [claimed('i1', BOT_A)], error: null }))
    await new InteractionPoller(gateway()).poll()

    expect(mocks.rpc).toHaveBeenCalledTimes(2)
    expect(mocks.rpc).toHaveBeenCalledWith('claim_bot_interactions', { p_bot_ids: [BOT_A, BOT_B], p_limit: INTERACTION_CLAIM_LIMIT })
    expect(INTERACTION_CLAIM_LIMIT).toBe(50)
    expect(sent).toHaveLength(1)
    expect(sent[0].botId).toBe(BOT_A)
    expect(sent[0].event.op).toBe(0)
    expect(sent[0].event.t).toBe('INTERACTION_CREATE')
    expect(sent[0].event.d).not.toHaveProperty('bot_id')
    expect(sent[0].event.d).toMatchObject({ id: 'i1', type: 2, data: { name: 'weather' } })
  })

  it('claims nothing while no bot is identified', async () => {
    connected = []
    await new InteractionPoller(gateway()).poll()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('fails a claimed interaction that reached no socket as offline', async () => {
    connected = [BOT_A, BOT_B]
    mocks.rpc.mockImplementation(async (fn: string, args: any) => {
      if (fn === 'claim_bot_interactions') return { data: [claimed('i1', BOT_B), claimed('i2', BOT_A)], error: null }
      if (fn === 'bridge_member_recipients') return { data: args.p_bot_ids, error: null }
      return { data: null, error: null }
    })
    await new InteractionPoller(gateway()).poll()

    expect(sent.map((s) => s.event.d.id)).toEqual(['i1', 'i2'])
    expect(mocks.rpc.mock.calls.filter(([fn]) => fn === 'bot_interaction_fail')).toEqual([
      ['bot_interaction_fail', { p_bot_id: BOT_B, p_id: 'i1', p_error: 'offline' }],
    ])
  })

  it.each(['invoker', 'resolved-user', 'resolved-member', 'unavailable', 'malformed'])('fails closed on %s privacy without disclosing an invocation', async kind => {
    const extra = kind.startsWith('resolved-') ? { data: { resolved: { [kind === 'resolved-user' ? 'users' : 'members']: { [BOB]: { id: BOB, username: 'private' } } } } } : {}
    mocks.rpc.mockImplementation(async (fn, args) => {
      if (fn === 'claim_bot_interactions') return { data: [claimed('i1', BOT_A, extra)], error: null }
      if (fn === 'bridge_member_recipients') {
        if (kind === 'unavailable') throw new Error('offline')
        if (kind === 'malformed') return { data: true, error: null }
        return { data: kind === 'invoker' || args.p_user_id === BOB ? [] : [BOT_A], error: null }
      }
      return { data: null, error: null }
    })
    await new InteractionPoller(gateway()).poll()
    expect(sent).toEqual([])
    expect(mocks.rpc).toHaveBeenCalledWith('bot_interaction_fail', { p_bot_id: BOT_A, p_id: 'i1', p_error: 'failed' })
  })

  it('never overlaps polls', async () => {
    let release!: () => void
    mocks.rpc.mockImplementation(() => new Promise((resolve) => {
      release = () => resolve({ data: [], error: null })
    }))
    const poller = new InteractionPoller(gateway())
    const first = poller.poll()
    await poller.poll()
    await poller.poll()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)

    release()
    await first
    mocks.rpc.mockResolvedValue({ data: [], error: null })
    await poller.poll()
    expect(mocks.rpc).toHaveBeenCalledTimes(2)
  })

  it('polls every 250 ms once started and stops on stop()', async () => {
    vi.useFakeTimers()
    mocks.rpc.mockResolvedValue({ data: [], error: null })
    const poller = new InteractionPoller(gateway())
    poller.start()
    await vi.advanceTimersByTimeAsync(INTERACTION_POLL_MS * 4)
    expect(INTERACTION_POLL_MS).toBe(250)
    expect(mocks.rpc).toHaveBeenCalledTimes(4)

    poller.stop()
    await vi.advanceTimersByTimeAsync(INTERACTION_POLL_MS * 4)
    expect(mocks.rpc).toHaveBeenCalledTimes(4)
  })

  it('logs a failed claim or delivery and keeps going', async () => {
    connected = [BOT_A, BOT_B]
    mocks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'claim_bot_interactions does not exist' } })
    const poller = new InteractionPoller(gateway())
    await poller.poll()
    expect(sent).toEqual([])

    mocks.rpc.mockImplementation(async (fn: string, args: any) => {
      if (fn === 'claim_bot_interactions') return { data: [claimed('i1', BOT_B), claimed('i2', BOT_A)], error: null }
      if (fn === 'bridge_member_recipients') return { data: args.p_bot_ids, error: null }
      throw new Error('network down')
    })
    await poller.poll()
    expect(sent.map((s) => s.event.d.id)).toEqual(['i1', 'i2'])
    expect(console.error).toHaveBeenCalled()
  })
})

describe('interactionEvent', () => {
  it('makes user avatars absolute in user and resolved.users, and omits unset ones', () => {
    const event = interactionEvent(claimed('i1', BOT_A, {
      data: {
        id: 'cmd', name: 'hug', type: 1,
        options: [{ name: 'who', type: 6, value: BOB }],
        resolved: {
          users: {
            [BOB]: { id: BOB, username: 'bob', display_name: 'Bob', avatar_url: null, bot: false },
            [CAROL]: { id: CAROL, username: 'carol', display_name: 'Carol', avatar_url: 'https://cdn.test/c.png', bot: false },
          },
          members: { [BOB]: { nickname: 'B', roles: [] } },
        },
      },
    }))

    expect(event.user).toEqual({
      id: ALICE, username: 'alice', display_name: 'Alice',
      avatar: 'https://harmony.test/storage/v1/render/image/public/avatars/alice/a.png?width=256&height=256&resize=contain&quality=80',
      bot: false,
    })
    expect((event.data as any).resolved).toEqual({
      users: {
        [BOB]: { id: BOB, username: 'bob', display_name: 'Bob', bot: false },
        [CAROL]: { id: CAROL, username: 'carol', display_name: 'Carol', avatar: 'https://cdn.test/c.png', bot: false },
      },
      members: { [BOB]: { nickname: 'B', roles: [] } },
    })
    expect(event).not.toHaveProperty('bot_id')
    expect(JSON.stringify(event)).not.toContain('avatar_url')
  })

  it('omits a user avatar when no base URL is configured', () => {
    delete process.env.PUBLIC_URL
    delete process.env.SUPABASE_URL
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(interactionEvent(claimed('i1', BOT_A)).user).toEqual({ id: ALICE, username: 'alice', display_name: 'Alice', bot: false })
  })
})
