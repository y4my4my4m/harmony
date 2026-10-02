import { describe, it, expect, vi, beforeEach } from 'vitest'

// Inbound federated writes into server channels: messages, edits, deletes,
// reactions and threads, on the shared inbox (ActivityProcessor,
// ThreadActivityHandler) and on server inboxes (ServerInboxHandler).
// `activity.actor` is the verified signer; both routes enforce the match.

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    REQUIRE_VALID_SIGNATURES: true,
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichMessageLinkPreviews: vi.fn().mockResolvedValue(false),
  enrichPostLinkPreviews: vi.fn().mockResolvedValue(false),
}))
vi.mock('../utils/mentionResolver.js', () => ({
  resolveMentionUserIds: vi.fn(async (content: any) => content),
}))
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue: vi.fn(), sendToInbox: vi.fn() },
}))

type Row = Record<string, any>
let tables: Record<string, Row[] | undefined> = {}
let grants: Record<string, Set<string>> = {}
let channelReaders: Record<string, Row[]> = {}
let inviteRefusals: Record<string, string | null> = {}
let rpcCalls: Array<{ fn: string; args: any }> = []
let nextId = 1

const read = (row: Row, col: string) => {
  const [base, key] = col.split('->>')
  return key ? row[base]?.[key] : row[base]
}

// `alias:fk(cols)` joins profiles on the fk column; `alias:table!<table>_<fk>_fkey(cols)` names both.
function withEmbeds(table: string, select: string, row: Row): Row {
  const out = { ...row }
  for (const m of select.matchAll(/(\w+):(\w+)(?:!(\w+))?\(([^)]*)\)/g)) {
    const [, alias, second, fkName] = m
    const target = fkName ? second : 'profiles'
    const fk = fkName ? fkName.replace(`${table}_`, '').replace(/_fkey$/, '') : second
    out[alias] = (tables[target] ?? []).find((r) => r.id === row[fk]) ?? null
  }
  return out
}

function fakeSupabase() {
  return {
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args })
      if (fn === 'consume_invite') {
        const refusal = args.p_code in inviteRefusals ? inviteRefusals[args.p_code] : 'not_found'
        return Promise.resolve({ data: refusal, error: null })
      }
      if (fn === 'has_permission') {
        const granted = grants[`${args.p_user_id}:${args.p_channel_id}`]?.has(args.p_permission) ?? false
        return Promise.resolve({ data: granted, error: null })
      }
      if (fn === 'federation_channel_recipients') {
        return Promise.resolve({ data: channelReaders[args.p_channel_id] ?? [], error: null })
      }
      return Promise.resolve({ data: null, error: null })
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = []
      let op: 'select' | 'delete' | 'update' = 'select'
      let patch: Row = {}
      let selectStr = '*'
      const missing = tables[table] === undefined

      const run = () => {
        const rows = tables[table] ?? []
        const matched = rows.filter((row) => filters.every((f) => f(row)))
        if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched.map((row) => withEmbeds(table, selectStr, row))
      }
      const result = (pick: (rows: Row[]) => any) =>
        missing
          ? Promise.resolve({ data: null, error: { code: 'PGRST205', message: `relation ${table} not found` } })
          : Promise.resolve({ data: pick(run()), error: null })

      const builder: any = {
        select(s?: string) { selectStr = s ?? '*'; return builder },
        delete() { op = 'delete'; return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, ...row }
          ;(tables[table] ??= []).push(stored)
          const res = { data: stored, error: null }
          // PostgREST: insert().select() resolves to an array; .single() to the row.
          const rows = { data: [stored], error: null }
          return {
            select: () => ({
              single: () => Promise.resolve(res),
              maybeSingle: () => Promise.resolve(res),
              then: (resolve: any) => resolve(rows),
            }),
            then: (resolve: any) => resolve(res),
          }
        },
        upsert(row: Row) {
          ;(tables[table] ??= []).push({ id: `row-${nextId++}`, ...row })
          return Promise.resolve({ data: null, error: null })
        },
        eq(col: string, val: any) { filters.push((row) => read(row, col) === val); return builder },
        is(col: string, val: any) { filters.push((row) => (read(row, col) ?? null) === val); return builder },
        not(col: string, o: string, val: any) {
          if (o === 'is') filters.push((row) => (read(row, col) ?? null) !== val)
          return builder
        },
        gt(col: string, val: any) { filters.push((row) => read(row, col) > val); return builder },
        neq(col: string, val: any) { filters.push((row) => read(row, col) !== val); return builder },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(read(row, col))); return builder },
        limit() { return builder },
        order() { return builder },
        overrideTypes() { return builder },
        maybeSingle() { return result((rows) => rows[0] ?? null) },
        single() {
          if (missing) return result(() => null)
          const rows = run()
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } })
        },
        then(resolve: any) { return result((rows) => rows).then(resolve) },
      }
      return builder
    },
  }
}

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: () => fakeSupabase() }))

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js')
const { processServerInboxActivity } = await import('../activitypub/ServerInboxHandler.js')
const { handleThreadActivity } = await import('../activitypub/ThreadActivityHandler.js')
const { authorizeChannelWrite } = await import('../activitypub/channelWriteAuthz.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const P = ActivityProcessor as any

const FRESH = new Date().toISOString()
const FUTURE = new Date(Date.now() + 3600_000).toISOString()

const S1 = '00000000-0000-4000-8000-0000000000a1'
const S2 = '00000000-0000-4000-8000-0000000000a2'
const R = '00000000-0000-4000-8000-0000000000a3'
const C1 = '00000000-0000-4000-8000-0000000000c1'
const C1B = '00000000-0000-4000-8000-0000000000cb'
const C2 = '00000000-0000-4000-8000-0000000000c2'
const CR = '00000000-0000-4000-8000-0000000000c3'
const T1 = '00000000-0000-4000-8000-0000000000e1'
const T2 = '00000000-0000-4000-8000-0000000000e2'
const LOCAL_THREAD = '00000000-0000-4000-8000-0000000000e3'
const M1 = '00000000-0000-4000-8000-0000000000f1'
const M2 = '00000000-0000-4000-8000-0000000000f2'
const DM_MSG = '00000000-0000-4000-8000-0000000000f3'
const CONV = '00000000-0000-4000-8000-0000000000d1'

const EVE = 'https://peer.test/users/eve'        // accepted member of S1 and S2
const BAN = 'https://peer.test/users/ban'        // accepted row on S1, plus a server_bans row
const OUT = 'https://peer.test/users/out'        // no membership
const HOSTU = 'https://remote.test/users/hostu'  // member of mirror R, on R's host
const STRAY = 'https://peer.test/users/stray'    // member of mirror R, not on R's host

const SEND = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'ADD_REACTIONS', 'CREATE_PUBLIC_THREADS']

function grant(user: string, channel: string, perms: string[]) {
  grants[`${user}:${channel}`] = new Set(perms)
}

beforeEach(() => {
  nextId = 1
  grants = {}
  channelReaders = {}
  inviteRefusals = {}
  rpcCalls = []
  vi.mocked(DeliveryQueue.enqueue).mockClear()
  vi.mocked(DeliveryQueue.sendToInbox).mockClear()
  tables = {
    profiles: [
      { id: 'eve', username: 'eve', federated_id: EVE, is_local: false, updated_at: FRESH },
      { id: 'ban', username: 'ban', federated_id: BAN, is_local: false, updated_at: FRESH },
      { id: 'out', username: 'out', federated_id: OUT, is_local: false, updated_at: FRESH },
      { id: 'hostu', username: 'hostu', federated_id: HOSTU, is_local: false, updated_at: FRESH },
      { id: 'stray', username: 'stray', federated_id: STRAY, is_local: false, updated_at: FRESH },
      { id: 'alice', username: 'alice', federated_id: 'https://harmony.test/users/alice', is_local: true, updated_at: FRESH },
    ],
    servers: [
      { id: S1, is_local_server: true, federation_enabled: true, owner: 'alice', ap_id: null, host_domain: null, federation_domain: null },
      { id: S2, is_local_server: true, federation_enabled: true, owner: 'alice', ap_id: null, host_domain: null, federation_domain: null },
      { id: R, is_local_server: false, federation_enabled: true, owner: 'alice', ap_id: `https://remote.test/servers/${R}`, host_domain: 'remote.test', federation_domain: 'remote.test' },
    ],
    channels: [
      { id: C1, server_id: S1, name: 'general', ap_id: null },
      { id: C1B, server_id: S1, name: 'other', ap_id: `https://harmony.test/servers/${S1}/channels/${C1B}` },
      { id: C2, server_id: S2, name: 'private', ap_id: null },
      { id: CR, server_id: R, name: 'mirror', ap_id: `https://remote.test/servers/${R}/channels/${CR}` },
    ],
    user_servers: [
      { server_id: S1, user_id: 'eve', status: 'accepted' },
      { server_id: S2, user_id: 'eve', status: 'accepted' },
      { server_id: S1, user_id: 'ban', status: 'accepted' },
      { server_id: R, user_id: 'hostu', status: 'accepted' },
      { server_id: R, user_id: 'stray', status: 'accepted' },
    ],
    server_bans: [{ id: 'b1', server_id: S1, user_id: 'ban' }],
    server_member_timeouts: [],
    threads: [
      { id: T1, channel_id: C1, ap_id: `https://peer.test/threads/${T1}`, created_by: 'eve', name: 'eve thread' },
      { id: T2, channel_id: C2, ap_id: `https://peer.test/threads/${T2}`, created_by: 'eve', name: 'elsewhere' },
      { id: LOCAL_THREAD, channel_id: C1, ap_id: null, created_by: 'alice', name: 'local' },
    ],
    messages: [
      { id: M1, channel_id: C1, user_id: 'eve', content: [{ type: 'text', text: 'in S1' }], metadata: { ap_id: `https://peer.test/messages/${M1}` } },
      { id: M2, channel_id: C2, user_id: 'eve', content: [{ type: 'text', text: 'in S2' }], metadata: { ap_id: `https://peer.test/messages/${M2}` } },
      { id: DM_MSG, conversation_id: CONV, channel_id: null, user_id: 'alice', content: [{ type: 'text', text: 'dm' }], metadata: {} },
    ],
    conversation_participants: [{ conversation_id: CONV, user_id: 'alice', left_at: null }],
    reactions: [],
    thread_members: [],
    emojis: [],
    posts: [],
    ap_activities: [],
  }
  for (const user of ['eve', 'ban']) {
    for (const ch of [C1, C1B]) grant(user, ch, SEND)
  }
  grant('eve', C2, SEND)
})

let seq = 0
const note = (actor: string, serverId: string, channelId: string, extra: Row = {}) => ({
  type: 'Create',
  actor,
  object: {
    type: 'Note',
    id: `${new URL(actor).origin}/messages/00000000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
    content: '<p>hello</p>',
    context: `https://harmony.test/servers/${serverId}/channels/${channelId}`,
    'harmony:serverId': serverId,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    ...extra,
  },
})

const newMessages = () => (tables.messages ?? []).filter((m) => ![M1, M2, DM_MSG].includes(m.id))

describe('authorizeChannelWrite', () => {
  const sb = fakeSupabase() as any

  it('allows an accepted, unbanned member holding the permissions', async () => {
    expect((await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S1, channelId: C1, kind: 'message' })).ok).toBe(true)
  })

  it('refuses a member whose ban lookup fails', async () => {
    tables.server_bans = undefined
    const r = await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S1, channelId: C1, kind: 'message' })
    expect(r).toEqual({ ok: false, reason: 'ban lookup failed' })
  })

  it('refuses a channel of another server', async () => {
    const r = await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S1, channelId: C2, kind: 'message' })
    expect(r.ok).toBe(false)
  })

  it('refuses a member under an active timeout', async () => {
    const author = (tables.profiles as any[]).find((p) => p.federated_id === EVE)
    tables.server_member_timeouts = [{ server_id: S1, user_id: author.id, until: new Date(Date.now() + 60_000).toISOString() }]
    const r = await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S1, channelId: C1, kind: 'message' })
    expect(r).toEqual({ ok: false, reason: 'timed out' })
  })

  it('allows a member whose timeout has lapsed', async () => {
    const author = (tables.profiles as any[]).find((p) => p.federated_id === EVE)
    tables.server_member_timeouts = [{ server_id: S1, user_id: author.id, until: new Date(Date.now() - 60_000).toISOString() }]
    expect((await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S1, channelId: C1, kind: 'message' })).ok).toBe(true)
  })
})

describe('shared inbox: channel messages', () => {
  it('stores a message from an accepted member holding SEND_MESSAGES', async () => {
    await P.processCreate(note(EVE, S1, C1))
    expect(newMessages()).toHaveLength(1)
    expect(newMessages()[0].user_id).toBe('eve')
  })

  it('refuses a member with a banned status', async () => {
    tables.user_servers!.find((m) => m.user_id === 'eve' && m.server_id === S1)!.status = 'banned'
    await P.processCreate(note(EVE, S1, C1))
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses an accepted member with a server ban', async () => {
    await P.processCreate(note(BAN, S1, C1))
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses a non-member', async () => {
    grant('out', C1, SEND)
    await P.processCreate(note(OUT, S1, C1))
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses a channel that is not in the named server', async () => {
    await P.processCreate(note(EVE, S1, C2))
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses a member without SEND_MESSAGES', async () => {
    grant('eve', C1, ['VIEW_CHANNEL'])
    await P.processCreate(note(EVE, S1, C1))
    expect(newMessages()).toHaveLength(0)
  })

  it('requires SEND_MESSAGES_IN_THREADS for a thread message', async () => {
    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES'])
    await P.processCreate(note(EVE, S1, C1, { 'harmony:threadId': `https://peer.test/threads/${T1}` }))
    expect(newMessages()).toHaveLength(0)

    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS'])
    await P.processCreate(note(EVE, S1, C1, { 'harmony:threadId': `https://peer.test/threads/${T1}` }))
    expect(newMessages().map((m) => m.thread_id)).toEqual([T1])
  })

  it('refuses a thread that belongs to another channel', async () => {
    await P.processCreate(note(EVE, S1, C1, { 'harmony:threadId': `https://peer.test/threads/${T2}` }))
    expect(newMessages()).toHaveLength(0)
  })

  it('requires a thread-creation permission to open a stub thread', async () => {
    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES_IN_THREADS'])
    await P.processCreate(note(EVE, S1, C1, { 'harmony:threadId': 'https://peer.test/threads/00000000-0000-4000-8000-00000000ffff' }))
    expect(newMessages()).toHaveLength(0)
  })

  it('drops a reply target in another channel', async () => {
    await P.processCreate(note(EVE, S1, C1, { inReplyTo: `https://peer.test/messages/${M2}` }))
    expect(newMessages()).toHaveLength(1)
    expect(newMessages()[0].reply_to).toBeNull()
  })

  it('clamps a future timestamp to now', async () => {
    await P.processCreate(note(EVE, S1, C1, { published: FUTURE }))
    expect(Date.parse(newMessages()[0].created_at)).toBeLessThanOrEqual(Date.now())
  })

  it('accepts a remote server copy\'s message from a member on its host', async () => {
    await P.processCreate(note(HOSTU, R, CR))
    expect(newMessages()).toHaveLength(1)
  })

  it('refuses a remote server copy\'s message from a member on another host', async () => {
    await P.processCreate(note(STRAY, R, CR))
    expect(newMessages()).toHaveLength(0)
  })
})

describe('shared inbox: reactions', () => {
  const like = (actor: string, target: string) =>
    P.processLike({ type: 'Like', actor, id: `${new URL(actor).origin}/likes/${++seq}`, object: target })

  it('refuses a member without ADD_REACTIONS', async () => {
    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES'])
    await like(EVE, `https://harmony.test/messages/${M1}`)
    expect(tables.reactions).toHaveLength(0)
  })

  it('refuses a banned member', async () => {
    await like(BAN, `https://harmony.test/messages/${M1}`)
    expect(tables.reactions).toHaveLength(0)
  })

  it('stores a reaction from a member holding ADD_REACTIONS', async () => {
    await like(EVE, `https://harmony.test/messages/${M1}`)
    expect(tables.reactions).toHaveLength(1)
  })

  it('refuses a reaction to a DM from a non-participant', async () => {
    await like(EVE, `https://harmony.test/messages/${DM_MSG}`)
    expect(tables.reactions).toHaveLength(0)
  })
})

describe('shared inbox: threads', () => {
  const threadCreate = (actor: string, id: string, extra: Row = {}) =>
    handleThreadActivity({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${new URL(actor).origin}/activities/${++seq}`,
      type: 'Create',
      actor,
      published: FRESH,
      object: {
        type: 'ChatThread',
        id,
        name: 'new thread',
        context: `https://harmony.test/servers/${S1}/channels/${C1}`,
        inReplyTo: `https://peer.test/messages/${M1}`,
        attributedTo: actor,
        published: FRESH,
        ...extra,
      },
    } as any)

  it('creates a thread for a member holding CREATE_PUBLIC_THREADS', async () => {
    const r = await threadCreate(EVE, 'https://peer.test/threads/00000000-0000-4000-8000-0000000000aa')
    expect(r.success).toBe(true)
    expect(tables.threads!.some((t) => t.id === '00000000-0000-4000-8000-0000000000aa' && t.created_by === 'eve')).toBe(true)
  })

  it('refuses a member without a thread-creation permission', async () => {
    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES'])
    const r = await threadCreate(EVE, 'https://peer.test/threads/00000000-0000-4000-8000-0000000000ab')
    expect(r.success).toBe(false)
  })

  it('refuses attributedTo naming someone other than the signer', async () => {
    const r = await threadCreate(EVE, 'https://peer.test/threads/00000000-0000-4000-8000-0000000000ac', {
      attributedTo: 'https://harmony.test/users/alice',
    })
    expect(r.success).toBe(false)
  })

  it('refuses a thread id on another host', async () => {
    const r = await threadCreate(EVE, 'https://remote.test/threads/00000000-0000-4000-8000-0000000000ad')
    expect(r.success).toBe(false)
  })

  it('does not rewrite a local thread through its UUID', async () => {
    const r = await threadCreate(EVE, `https://peer.test/threads/${LOCAL_THREAD}`, { name: 'hijacked' })
    expect(r.success).toBe(false)
    expect(tables.threads!.find((t) => t.id === LOCAL_THREAD)!.name).toBe('local')
  })

  it('refuses a parent message in another channel', async () => {
    const r = await threadCreate(EVE, 'https://peer.test/threads/00000000-0000-4000-8000-0000000000ae', {
      inReplyTo: `https://peer.test/messages/${M2}`,
    })
    expect(r.success).toBe(false)
  })

  it('lets only the creator update or delete a thread', async () => {
    tables.threads!.push({ id: 'tb', channel_id: C1, ap_id: 'https://peer.test/threads/tb', created_by: 'ban', name: 'ban thread' })
    const update = (actor: string) =>
      handleThreadActivity({ type: 'Update', actor, id: 'u', published: FRESH,
        object: { type: 'ChatThread', id: `https://peer.test/threads/${T1}`, name: 'renamed' } } as any)
    expect((await update(BAN)).success).toBe(false)
    expect(tables.threads!.find((t) => t.id === T1)!.name).toBe('eve thread')
    expect((await update(EVE)).success).toBe(true)
    expect(tables.threads!.find((t) => t.id === T1)!.name).toBe('renamed')

    const del = await handleThreadActivity({ type: 'Delete', actor: BAN, id: 'd', published: FRESH,
      object: { type: 'ChatThread', id: `https://peer.test/threads/${T1}` } } as any)
    expect(del.success).toBe(false)
    expect(tables.threads!.some((t) => t.id === T1)).toBe(true)
  })

  it('a banned creator cannot update their thread', async () => {
    tables.threads!.push({ id: 'tb', channel_id: C1, ap_id: 'https://peer.test/threads/tb', created_by: 'ban', name: 'ban thread' })
    const r = await handleThreadActivity({ type: 'Update', actor: BAN, id: 'u2', published: FRESH,
      object: { type: 'ChatThread', id: 'https://peer.test/threads/tb', name: 'still here' } } as any)
    expect(r.success).toBe(false)
  })

  it('thread membership names the signer as subject', async () => {
    const r = await handleThreadActivity({ type: 'Add', actor: BAN, id: 'm', published: FRESH,
      object: { type: 'Relationship', subject: EVE, object: `https://peer.test/threads/${T1}`, relationship: 'memberOf' } } as any)
    expect(r.success).toBe(false)
    expect(tables.thread_members).toHaveLength(0)
  })
})

describe('shared inbox: remote structure and featured posts', () => {
  it('does not add channels to a remote server copy for an actor naming its UUID on another host', async () => {
    await P.processAdd({
      type: 'Add',
      actor: `https://evil.test/servers/${R}`,
      target: `https://evil.test/servers/${R}`,
      object: { type: 'harmony:TextChannel', id: `https://evil.test/servers/${R}/channels/00000000-0000-4000-8000-00000000c0de`, name: 'spam' },
    })
    expect(tables.channels!.some((c) => c.name === 'spam')).toBe(false)
  })

  it('accepts structure from the remote server\'s own Group actor', async () => {
    await P.processAdd({
      type: 'Add',
      actor: `https://remote.test/servers/${R}`,
      target: `https://remote.test/servers/${R}`,
      object: { type: 'harmony:TextChannel', id: `https://remote.test/servers/${R}/channels/00000000-0000-4000-8000-00000000c0df`, name: 'announcements' },
    })
    expect(tables.channels!.some((c) => c.name === 'announcements' && c.server_id === R)).toBe(true)
  })

  it('does not rename a local channel by its ap_id', async () => {
    await P.processUpdate({
      type: 'Update',
      actor: `https://remote.test/servers/${R}`,
      object: { type: 'harmony:TextChannel', id: `https://harmony.test/servers/${S1}/channels/${C1B}`, name: 'pwned' },
    })
    expect(tables.channels!.find((c) => c.id === C1B)!.name).toBe('other')
  })

  it('does not feature another actor\'s post', async () => {
    tables.posts!.push({ id: 'p1', ap_id: 'https://peer.test/posts/1', author_id: 'eve', is_pinned: false })
    await P.processAdd({ type: 'Add', actor: BAN, target: 'https://peer.test/users/ban/featured', object: 'https://peer.test/posts/1' })
    expect(tables.posts![0].is_pinned).toBe(false)
    await P.processAdd({ type: 'Add', actor: EVE, target: 'https://peer.test/users/eve/featured', object: 'https://peer.test/posts/1' })
    expect(tables.posts![0].is_pinned).toBe(true)
  })
})

describe('server inbox', () => {
  const create = (actor: string, channelId: string, extra: Row = {}) =>
    processServerInboxActivity(S1, {
      type: 'Create',
      actor,
      object: {
        type: 'Note',
        id: `${new URL(actor).origin}/messages/${++seq}`,
        content: '<p>via server inbox</p>',
        context: `https://harmony.test/servers/${S1}/channels/${channelId}`,
        ...extra,
      },
    })

  it('stores a message from an accepted member', async () => {
    await create(EVE, C1)
    expect(newMessages()).toHaveLength(1)
  })

  it('refuses an accepted member with a server ban', async () => {
    await create(BAN, C1)
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses a channel of another server', async () => {
    await create(EVE, C2)
    expect(newMessages()).toHaveLength(0)
  })

  it('refuses a thread message without SEND_MESSAGES_IN_THREADS', async () => {
    grant('eve', C1, ['VIEW_CHANNEL', 'SEND_MESSAGES'])
    await create(EVE, C1, { 'harmony:threadId': `https://peer.test/threads/${T1}` })
    expect(newMessages()).toHaveLength(0)
  })

  it('does not edit a message of another server', async () => {
    await processServerInboxActivity(S1, {
      type: 'Update',
      actor: EVE,
      object: { type: 'Note', id: `https://peer.test/messages/${M2}`, content: '<p>edited</p>' },
    })
    expect(tables.messages!.find((m) => m.id === M2)!.content).toEqual([{ type: 'text', text: 'in S2' }])
  })

  it('does not let a banned author edit', async () => {
    tables.messages!.push({ id: 'mb', channel_id: C1, user_id: 'ban', content: [{ type: 'text', text: 'old' }], metadata: { ap_id: 'https://peer.test/messages/mb' } })
    await processServerInboxActivity(S1, {
      type: 'Update',
      actor: BAN,
      object: { type: 'Note', id: 'https://peer.test/messages/mb', content: '<p>new</p>' },
    })
    expect(tables.messages!.find((m) => m.id === 'mb')!.content).toEqual([{ type: 'text', text: 'old' }])
  })

  it('does not delete a message of another server, even for that server\'s moderator', async () => {
    // alice owns both servers; her host authority on S1 does not reach S2's messages.
    await processServerInboxActivity(S1, {
      type: 'Delete',
      actor: 'https://harmony.test/users/alice',
      object: `https://peer.test/messages/${M2}`,
    })
    expect(tables.messages!.find((m) => m.id === M2)!.is_deleted).toBeUndefined()
  })

  it('refuses a reaction to a message of another server', async () => {
    await processServerInboxActivity(S1, { type: 'Like', actor: EVE, id: 'l1', object: `https://harmony.test/messages/${M2}` })
    expect(tables.reactions).toHaveLength(0)
  })

  it('refuses a reaction without ADD_REACTIONS and accepts one with it', async () => {
    grant('eve', C1, ['VIEW_CHANNEL'])
    await processServerInboxActivity(S1, { type: 'Like', actor: EVE, id: 'l2', object: `https://harmony.test/messages/${M1}` })
    expect(tables.reactions).toHaveLength(0)
    grant('eve', C1, ['VIEW_CHANNEL', 'ADD_REACTIONS'])
    await processServerInboxActivity(S1, { type: 'Like', actor: EVE, id: 'l3', object: `https://harmony.test/messages/${M1}` })
    expect(tables.reactions).toHaveLength(1)
  })

  it('relays only to instances whose members may view the channel', async () => {
    tables.user_servers!.push(
      { server_id: S1, user_id: 'out', status: 'accepted', member_instance: 'nosy.test' },
    )
    channelReaders[C1] = [
      { instance: 'peer.test', member_ap_ids: [EVE], member_count: 1, shared_inbox: 'https://peer.test/inbox' },
      { instance: 'reader.test', member_ap_ids: ['https://reader.test/users/r'], member_count: 1, shared_inbox: 'https://reader.test/inbox' },
    ]
    await create(EVE, C1)
    const targets = vi.mocked(DeliveryQueue.enqueue).mock.calls.map((c) => c[1])
    expect(targets).toEqual(['https://reader.test/inbox'])
    expect(vi.mocked(DeliveryQueue.enqueue).mock.calls[0][0].to).toEqual(['https://reader.test/users/r'])
  })

  it('refuses a thread in a channel of another server', async () => {
    await processServerInboxActivity(S1, {
      type: 'Create',
      actor: EVE,
      object: {
        type: 'ChatThread',
        id: 'https://peer.test/threads/00000000-0000-4000-8000-0000000000af',
        name: 'cross',
        context: `https://harmony.test/servers/${S2}/channels/${C2}`,
        inReplyTo: `https://peer.test/messages/${M2}`,
        attributedTo: EVE,
      },
    })
    expect(tables.threads!.some((t) => t.id === '00000000-0000-4000-8000-0000000000af')).toBe(false)
  })
})

describe('server inbox: Join of a private server', () => {
  const join = (actor: string, inviteCode?: string) =>
    processServerInboxActivity(S1, {
      type: 'Join',
      id: `${new URL(actor).origin}/activities/${++seq}`,
      actor,
      object: `https://harmony.test/servers/${S1}`,
      ...(inviteCode ? { 'harmony:inviteCode': inviteCode } : {}),
    })
  const answer = () => vi.mocked(DeliveryQueue.sendToInbox).mock.calls.map((c) => [c[1].type, c[1].summary])
  const membership = (userId: string) =>
    tables.user_servers!.find((m) => m.server_id === S1 && m.user_id === userId)

  beforeEach(() => {
    tables.profiles!.find((p) => p.id === 'out')!.inbox_url = 'https://peer.test/users/out/inbox'
  })

  it('rejects a join without an invite', async () => {
    await join(OUT)
    expect(membership('out')).toBeUndefined()
    expect(answer()).toEqual([['Reject', 'Private server requires invite code']])
  })

  it('rejects a revoked invite through consume_invite', async () => {
    inviteRefusals.GONE = 'revoked'
    await join(OUT, 'GONE')
    expect(rpcCalls.filter((c) => c.fn === 'consume_invite')).toEqual([
      { fn: 'consume_invite', args: { p_server_id: S1, p_code: 'GONE' } },
    ])
    expect(membership('out')).toBeUndefined()
    expect(answer()).toEqual([['Reject', 'Invite code has been revoked']])
  })

  it('admits a join whose invite consume_invite accepts', async () => {
    inviteRefusals.GOOD = null
    await join(OUT, 'GOOD')
    expect(membership('out')?.status).toBe('accepted')
    expect(answer()).toEqual([['Accept', undefined]])
  })

  it('spends no invite on an accepted member', async () => {
    inviteRefusals.GOOD = null
    await join(EVE, 'GOOD')
    expect(rpcCalls.some((c) => c.fn === 'consume_invite')).toBe(false)
    expect(answer()).toEqual([['Accept', undefined]])
  })

  it('rejects a banned user before any invite is spent', async () => {
    inviteRefusals.GOOD = null
    tables.profiles!.find((p) => p.id === 'ban')!.inbox_url = 'https://peer.test/users/ban/inbox'
    await join(BAN, 'GOOD')
    expect(rpcCalls.some((c) => c.fn === 'consume_invite')).toBe(false)
    expect(answer()).toEqual([['Reject', 'User is banned from this server']])
  })
})
