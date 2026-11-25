import { beforeEach, describe, expect, it, vi } from 'vitest'

const db = vi.hoisted(() => ({
  bots: [] as Array<{ id: string; bot_type: string | null; bridge_platform: string | null }>,
  threads: [] as Array<{ id: string; created_by: string | null; parent_message_id: string | null }>,
  messages: [] as Array<Record<string, unknown> & { id: string }>,
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
          if (db.fail.has(table)) return { data: null, error: { message: 'offline' } }
          const rows: Array<{ id: string }> = db[table as 'bots' | 'threads' | 'messages']
          return { data: rows.filter(row => ids.includes(row.id)), error: null }
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

import {
  consentSubjects,
  consentingReaders,
  forgetBridgeConsent,
  namedThreadId,
  relayAllowed,
  threadNameSubjects,
  threadNameWithheldFrom,
  withoutThreadName,
} from './memberConsent.js'

beforeEach(() => {
  forgetBridgeConsent()
  db.bots = [
    { id: 'plain', bot_type: null, bridge_platform: null },
    { id: 'discord', bot_type: 'bridge', bridge_platform: null },
    { id: 'matrix', bot_type: null, bridge_platform: 'matrix' },
  ]
  db.platform = { 'discord:c1': 'discord', 'matrix:c1': 'matrix' }
  db.optouts = { 'server:matrix': ['alice'], 'server:discord': ['bob'] }
  db.threads = []
  db.messages = []
  db.fail.clear()
  db.calls = []
})

describe('consentSubjects', () => {
  it('are the author of a member message and the invoker of a bot interaction reply', () => {
    expect(consentSubjects({ user_id: 'alice', bot_id: null, metadata: {} })).toEqual(['alice'])
    expect(consentSubjects({ user_id: null, bot_id: 'b', metadata: { interaction: { user_id: 'bob' } } })).toEqual(['bob'])
    expect(consentSubjects({ user_id: null, bot_id: 'b', metadata: { matrix_user: { id: '@x:y' } } })).toEqual([])
    expect(consentSubjects(null)).toEqual([])
  })

  it('are every member a system row names, which has no author', () => {
    const row = (metadata: unknown, is_system = true) => consentSubjects({ user_id: null, bot_id: null, is_system, metadata })
    expect(row({ type: 'thread_created', actor_id: 'alice', thread_name: 'secret' })).toEqual(['alice'])
    expect(row({ type: 'member_kick', actor_id: 'alice', subject_id: 'bob' })).toEqual(['alice', 'bob'])
    expect(row({ type: 'member_ban', actor_id: 'alice', subject_id: 'alice' })).toEqual(['alice'])
    expect(row({ type: 'member_leave', subject_id: 'bob' })).toEqual(['bob'])
    expect(row({ type: 'automod_alert', automod: { user_id: 'bob', excerpt: 'secret' } })).toEqual(['bob'])
    expect(row({ type: 'automod_alert', automod: null })).toEqual([])
    expect(row({ type: 'thread_created', actor_bot_id: 'b', discord_user: { id: '1' } })).toEqual([])
    expect(row({ actor_id: 7 })).toEqual([])
    expect(row(null)).toEqual([])
    // Only a system row's metadata is the server's statement of who acted.
    expect(row({ actor_id: 'alice' }, false)).toEqual([])
    expect(consentSubjects({ user_id: null, bot_id: 'b', metadata: { actor_id: 'alice' } })).toEqual([])
  })
})

describe('consentingReaders', () => {
  it('withholds from a bridge of the platform the member opted out of, and only from it', async () => {
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['alice'])).toEqual(['plain', 'discord'])
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['bob'])).toEqual(['plain', 'matrix'])
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['carol'])).toEqual(['plain', 'discord', 'matrix'])
  })

  it('withholds a row that speaks for several members when one of them opted out', async () => {
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['carol', 'alice'])).toEqual(['plain', 'discord'])
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['bob', 'alice'])).toEqual(['plain'])
  })

  it('keeps a bridge that does not relay the channel', async () => {
    expect(await consentingReaders(['matrix'], 'server', 'c2', ['alice'])).toEqual(['matrix'])
  })

  it('reads nothing for a row without a member subject or for ordinary bots alone', async () => {
    expect(await consentingReaders(['plain', 'matrix'], 'server', 'c1', [])).toEqual(['plain', 'matrix'])
    expect(db.calls).toEqual([])
    expect(await consentingReaders(['plain'], 'server', 'c1', ['alice'])).toEqual(['plain'])
    expect(db.calls).toEqual(['bots:plain'])
  })

  it('caches candidacy, platforms and opt-outs across events', async () => {
    await consentingReaders(['plain', 'matrix'], 'server', 'c1', ['alice'])
    await consentingReaders(['plain', 'matrix'], 'server', 'c1', ['carol'])
    expect(db.calls).toEqual(['bots:plain,matrix', 'bridge_channel_platform', 'bridge_member_optout_ids'])
  })

  it('withholds from bridges only when the opt-outs cannot be read', async () => {
    db.fail.add('bridge_member_optout_ids')
    expect(await consentingReaders(['plain', 'discord', 'matrix'], 'server', 'c1', ['carol'])).toEqual(['plain'])
  })

  it('withholds from every bot not known to be ordinary when candidacy cannot be read', async () => {
    await consentingReaders(['plain'], 'server', 'c1', ['carol'])
    db.fail.add('bots')
    expect(await consentingReaders(['plain', 'unknown'], 'server', 'c1', ['carol'])).toEqual(['plain'])
  })

  it('takes an opt-out made after the cache expired', async () => {
    vi.useFakeTimers()
    try {
      expect(await relayAllowed('matrix', 'server', 'c1', ['carol'])).toBe(true)
      db.optouts['server:matrix'] = ['alice', 'carol']
      expect(await relayAllowed('matrix', 'server', 'c1', ['carol'])).toBe(true)
      vi.advanceTimersByTime(5_001)
      expect(await relayAllowed('matrix', 'server', 'c1', ['carol'])).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('thread names', () => {
  const T1 = '00000000-0000-4000-8000-0000000000a1'
  const T2 = '00000000-0000-4000-8000-0000000000a2'
  const READERS = ['plain', 'discord', 'matrix']
  const withheld = async (threadIds: string[], channel = 'c1') => Object.fromEntries(
    [...await threadNameWithheldFrom(READERS, 'server', channel, threadIds)].map(([id, readers]) => [id, [...readers]]))

  // T1 is started by `creator` on a message of `author`.
  const thread = (creator: string | null, author: string | null) => {
    db.threads = [{ id: T1, created_by: creator, parent_message_id: 'starter' }]
    db.messages = [{ id: 'starter', user_id: author, bot_id: author ? null : 'b', is_system: false, metadata: {} }]
  }

  it('are withheld for the creator and for the author of the starter message, per platform', async () => {
    thread('alice', 'carol')
    expect(await withheld([T1])).toEqual({ [T1]: ['matrix'] })
    thread('carol', 'bob')
    expect(await withheld([T1])).toEqual({ [T1]: ['discord'] })
    thread('alice', 'bob')
    expect(await withheld([T1])).toEqual({ [T1]: ['discord', 'matrix'] })
    thread('carol', 'carol')
    expect(await withheld([T1])).toEqual({ [T1]: [] })
    thread(null, null)
    expect(await withheld([T1])).toEqual({ [T1]: [] })
  })

  it('are withheld for the invoker of a bot reply a thread starts on, and for its notice of a standalone thread', async () => {
    db.threads = [{ id: T1, created_by: null, parent_message_id: 'reply' }, { id: T2, created_by: null, parent_message_id: 'notice' }]
    db.messages = [
      { id: 'reply', user_id: null, bot_id: 'b', is_system: false, metadata: { interaction: { user_id: 'alice' } } },
      { id: 'notice', user_id: null, bot_id: null, is_system: true, metadata: { type: 'thread_created', actor_id: 'bob' } },
    ]
    expect(await withheld([T1, T2])).toEqual({ [T1]: ['matrix'], [T2]: ['discord'] })
    expect(db.calls.filter(call => /^(threads|messages):/.test(call))).toEqual([`threads:${T1},${T2}`, 'messages:reply,notice'])
  })

  it('are withheld from every bridge, and from no other bot, when the thread or its starter cannot be read', async () => {
    thread('carol', 'carol')
    expect(await withheld([T2, 'not-a-uuid', ''])).toEqual({ [T2]: ['discord', 'matrix'], 'not-a-uuid': ['discord', 'matrix'], '': ['discord', 'matrix'] })
    db.messages = []
    expect(await withheld([T1])).toEqual({ [T1]: ['discord', 'matrix'] })
    thread('carol', 'carol')
    for (const table of ['threads', 'messages']) {
      db.fail = new Set([table])
      expect(await withheld([T1])).toEqual({ [T1]: ['discord', 'matrix'] })
    }
    db.fail = new Set(['bridge_member_optout_ids'])
    expect(await withheld([T1])).toEqual({ [T1]: ['discord', 'matrix'] })
    db.fail = new Set(['bridge_channel_platform'])
    forgetBridgeConsent()
    expect(await withheld([T1])).toEqual({ [T1]: ['discord', 'matrix'] })
  })

  it('reads no thread for ordinary bots, or for a bridge of another channel', async () => {
    thread('alice', 'bob')
    expect(await withheld([T1], 'c2')).toEqual({ [T1]: [] })
    expect([...await threadNameWithheldFrom(['plain'], 'server', 'c1', [T1])]).toEqual([[T1, new Set()]])
    expect(await withheld([])).toEqual({})
    expect(db.calls.filter(call => /^(threads|messages):/.test(call))).toEqual([])
  })

  it('throws from threadNameSubjects when the starters cannot be read', async () => {
    thread('carol', 'carol')
    expect(await threadNameSubjects(db.threads)).toEqual(new Map([[T1, ['carol']]]))
    expect(await threadNameSubjects([])).toEqual(new Map())
    db.fail.add('messages')
    await expect(threadNameSubjects(db.threads)).rejects.toThrow('offline')
  })

  it('belong to thread_created notices that carry one', () => {
    expect(namedThreadId({ metadata: { type: 'thread_created', thread_id: T1, thread_name: 'x' } })).toBe(T1)
    expect(namedThreadId({ metadata: { type: 'thread_created', thread_name: 'x' } })).toBe('')
    expect(namedThreadId({ metadata: { type: 'thread_created', thread_id: T1 } })).toBeNull()
    expect(namedThreadId({ metadata: { type: 'member_join', thread_id: T1, thread_name: 'x' } })).toBeNull()
    expect(namedThreadId({ metadata: null })).toBeNull()
    expect(withoutThreadName({ user_id: null, metadata: { type: 'thread_created', thread_id: T1, thread_name: 'x' } }))
      .toEqual({ user_id: null, metadata: { type: 'thread_created', thread_id: T1, thread_name: 'Thread' } })
  })
})
