import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bots: [] as Array<{ id: string; bot_type: string | null; bridge_platform: string | null }>,
  platform: {} as Record<string, string | null>,
  optouts: {} as Record<string, string[]>,
  fail: new Set<string>(),
  calls: [] as string[],
}))

vi.mock('../config/supabase.js', () => ({
  supabase: {
    from: (table: string) => ({
      select: () => ({
        in: async (_col: string, ids: string[]) => {
          db.calls.push(`${table}:${ids.join(',')}`)
          if (db.fail.has('bots')) return { data: null, error: { message: 'offline' } }
          return { data: db.bots.filter(b => ids.includes(b.id)), error: null }
        },
        eq: () => ({ maybeSingle: async () => ({ data: { server_id: 'server' }, error: null }) }),
      }),
    }),
    rpc: async (fn: string, args: any) => {
      db.calls.push(fn)
      if (db.fail.has(fn)) return { data: null, error: { message: 'offline' } }
      if (fn === 'bridge_channel_platform') return { data: db.platform[`${args.p_bot_id}:${args.p_channel_id}`] ?? null, error: null }
      if (fn === 'bridge_member_optout_ids') return { data: { user_ids: db.optouts[`${args.p_server_id}:${args.p_platform}`] ?? [] }, error: null }
      throw new Error(`unexpected rpc ${fn}`)
    },
  },
}))

import { consentSubject, consentingReaders, forgetBridgeConsent, relayAllowed } from './memberConsent.js'

beforeEach(() => {
  forgetBridgeConsent()
  db.bots = [
    { id: 'plain', bot_type: null, bridge_platform: null },
    { id: 'discord', bot_type: 'bridge', bridge_platform: null },
    { id: 'matrix', bot_type: null, bridge_platform: 'matrix' },
  ]
  db.platform = { 'discord:c1': 'discord', 'matrix:c1': 'matrix' }
  db.optouts = { 'server:matrix': ['alice'], 'server:discord': ['bob'] }
  db.fail.clear()
  db.calls = []
})

describe('consentSubject', () => {
  it('is the author of a member message and the invoker of a bot interaction reply', () => {
    expect(consentSubject({ user_id: 'alice', bot_id: null, metadata: {} })).toBe('alice')
    expect(consentSubject({ user_id: null, bot_id: 'b', metadata: { interaction: { user_id: 'bob' } } })).toBe('bob')
    expect(consentSubject({ user_id: null, bot_id: 'b', metadata: { matrix_user: { id: '@x:y' } } })).toBeNull()
    expect(consentSubject(null)).toBeNull()
  })

  it('is the acting member of a system row, which has no author', () => {
    const row = (metadata: unknown, is_system = true) => consentSubject({ user_id: null, bot_id: null, is_system, metadata })
    expect(row({ type: 'thread_created', actor_id: 'alice', thread_name: 'secret' })).toBe('alice')
    expect(row({ type: 'member_kick', actor_id: 'alice', subject_id: 'bob' })).toBe('alice')
    expect(row({ type: 'member_leave', subject_id: 'bob' })).toBe('bob')
    expect(row({ type: 'thread_created', actor_bot_id: 'b', discord_user: { id: '1' } })).toBeNull()
    expect(row({ actor_id: 7 })).toBeNull()
    expect(row(null)).toBeNull()
    // Only a system row's metadata is the server's statement of who acted.
    expect(row({ actor_id: 'alice' }, false)).toBeNull()
    expect(consentSubject({ user_id: null, bot_id: 'b', metadata: { actor_id: 'alice' } })).toBeNull()
  })
})

describe('consentingReaders', () => {
  it('withholds from a bridge of the platform the member opted out of, and only from it', async () => {
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', 'alice')).toEqual(['plain', 'discord'])
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', 'bob')).toEqual(['plain', 'matrix'])
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', 'carol')).toEqual(['plain', 'discord', 'matrix'])
  })

  it('keeps a bridge that does not relay the channel', async () => {
    expect(await consentingReaders(['matrix'], 'server', 'c2', 'alice')).toEqual(['matrix'])
  })

  it('reads nothing for a row without a member subject or for ordinary bots alone', async () => {
    expect(await consentingReaders(['plain', 'matrix'], 'server', 'c1', null)).toEqual(['plain', 'matrix'])
    expect(db.calls).toEqual([])
    expect(await consentingReaders(['plain'], 'server', 'c1', 'alice')).toEqual(['plain'])
    expect(db.calls).toEqual(['bots:plain'])
  })

  it('caches candidacy, platforms and opt-outs across events', async () => {
    await consentingReaders(['plain', 'matrix'], 'server', 'c1', 'alice')
    await consentingReaders(['plain', 'matrix'], 'server', 'c1', 'carol')
    expect(db.calls).toEqual(['bots:plain,matrix', 'bridge_channel_platform', 'bridge_member_optout_ids'])
  })

  it('withholds from bridges only when the opt-outs cannot be read', async () => {
    db.fail.add('bridge_member_optout_ids')
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', 'carol')).toEqual(['plain'])
  })

  it('withholds from every bot not known to be ordinary when candidacy cannot be read', async () => {
    await consentingReaders(['plain'], 'server', 'c1', 'carol')
    db.fail.add('bots')
    expect(await consentingReaders(['plain', 'unknown'], 'server', 'c1', 'carol')).toEqual(['plain'])
  })

  it('takes an opt-out made after the cache expired', async () => {
    vi.useFakeTimers()
    try {
      expect(await relayAllowed('matrix', 'server', 'c1', 'carol')).toBe(true)
      db.optouts['server:matrix'] = ['alice', 'carol']
      expect(await relayAllowed('matrix', 'server', 'c1', 'carol')).toBe(true)
      vi.advanceTimersByTime(5_001)
      expect(await relayAllowed('matrix', 'server', 'c1', 'carol')).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
