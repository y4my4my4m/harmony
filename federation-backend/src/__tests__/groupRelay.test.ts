import { describe, it, expect, vi, beforeEach } from 'vitest'

// Group relay (groupRelay.ts), both sides.
//
// Host: a member's activity accepted on a local server's inbox reaches every other instance
// with readers of the channel as the Group's Announce, signed with the Group's key, at that
// instance's copy of the server; never the sender's instance, never a non-Harmony one.
//
// Receiver: an Announce from the Group of a remote server copied here, on the copy's inbox
// or the shared inbox, applies the inner activity when the Group signed it, the inner actor
// is a member (the copy's row, or the Group's members collection) and the target is in
// that server. A copy blocked on this instance takes nothing.

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
  BlockedInstancesCache: { isBlocked: vi.fn((host: string) => host === 'blocked.test') },
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
vi.mock('../services/ServerDiscoveryService.js', () => ({
  ServerDiscoveryService: { pickSigningMember: vi.fn(async () => 'bob'), syncRemoteServer: vi.fn() },
}))
const software: Record<string, string | null> = {}
vi.mock('../activitypub/instanceSoftware.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/instanceSoftware.js')
  return { ...actual, instanceSoftware: vi.fn(async (host: string) => software[host] ?? null), noteDocumentSoftware: vi.fn() }
})
// The Group's members collection, as signedApFetch reads it.
const memberPages: Record<string, unknown[]> = {}
const memberFetches: Array<{ url: string; signAs?: string }> = []
vi.mock('../activitypub/SignatureService.js', async () => {
  const actual = await vi.importActual<any>('../activitypub/SignatureService.js')
  actual.SignatureService.signedApFetch = vi.fn(async (url: string, opts: any = {}) => {
    memberFetches.push({ url, signAs: opts.signAs })
    const items = memberPages[url]
    if (!items) return new Response('{}', { status: 404 })
    return new Response(JSON.stringify({ type: 'OrderedCollectionPage', orderedItems: items }), {
      status: 200,
      headers: { 'Content-Type': 'application/activity+json' },
    })
  })
  return actual
})

type Row = Record<string, any>
let tables: Record<string, Row[] | undefined> = {}
let grants: Record<string, Set<string>> = {}
let channelReaders: Record<string, Row[]> = {}
let nextId = 1

const read = (row: Row, col: string) => {
  const [base, key] = col.split('->>')
  return key ? row[base]?.[key] : row[base]
}

// `alias:fk(cols)` joins profiles on the fk column; `alias:table!<table>_<fk>_fkey(cols)` names
// both. Embeds nest.
function embeds(select: string): Array<{ alias: string; second: string; fkName?: string; inner: string }> {
  const out: Array<{ alias: string; second: string; fkName?: string; inner: string }> = []
  const re = /(\w+):(\w+)(?:!(\w+))?\(/g
  let m: RegExpExecArray | null
  while ((m = re.exec(select)) !== null) {
    let depth = 1
    let i = re.lastIndex
    for (; i < select.length && depth > 0; i++) {
      if (select[i] === '(') depth++
      else if (select[i] === ')') depth--
    }
    out.push({ alias: m[1], second: m[2], fkName: m[3], inner: select.slice(re.lastIndex, i - 1) })
    re.lastIndex = i
  }
  return out
}

function withEmbeds(table: string, select: string, row: Row): Row {
  const out = { ...row }
  for (const e of embeds(select)) {
    const target = e.fkName ? e.second : 'profiles'
    const fk = e.fkName ? e.fkName.replace(`${table}_`, '').replace(/_fkey$/, '') : e.second
    const found = (tables[target] ?? []).find((r) => r.id === row[fk])
    out[e.alias] = found ? withEmbeds(target, e.inner, found) : null
  }
  return out
}

function fakeSupabase() {
  return {
    rpc(fn: string, args: any) {
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

      const run = () => {
        const rows = tables[table] ?? []
        const matched = rows.filter((row) => filters.every((f) => f(row)))
        if (op === 'delete') tables[table] = rows.filter((row) => !matched.includes(row))
        if (op === 'update') matched.forEach((row) => Object.assign(row, patch))
        return matched.map((row) => withEmbeds(table, selectStr, row))
      }
      const result = (pick: (rows: Row[]) => any) => Promise.resolve({ data: pick(run()), error: null })

      const builder: any = {
        select(s?: string) { selectStr = s ?? '*'; return builder },
        delete() { op = 'delete'; return builder },
        update(p: Row) { op = 'update'; patch = p; return builder },
        insert(row: Row) {
          const stored = { id: `row-${nextId++}`, ...row }
          ;(tables[table] ??= []).push(stored)
          const res = { data: stored, error: null }
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
        upsert(row: Row, opts: { onConflict?: string; ignoreDuplicates?: boolean } = {}) {
          const keys = (opts.onConflict ?? 'id').split(',')
          const existing = (tables[table] ?? []).find((r) => keys.every((k) => r[k] === row[k]))
          if (existing && !opts.ignoreDuplicates) Object.assign(existing, row)
          if (!existing) (tables[table] ??= []).push({ id: `row-${nextId++}`, ...row })
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
        maybeSingle() { return result((rows) => rows[0] ?? null) },
        single() {
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
const { authorizeChannelWrite } = await import('../activitypub/channelWriteAuthz.js')
const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { relayRefusal, groupAnnounce, copyInboxUrl, __resetRelayMembershipCache } = await import('../activitypub/groupRelay.js')
const { handleChannelMessageUpdate } = await import('../listeners/ChannelMessageHandler.js')
const { handleChannelReactionFederation } = await import('../listeners/ChannelReactionHandler.js')

const FRESH = new Date().toISOString()
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

// Hosted here.
const S = uuid(0xa1)
const C = uuid(0xc1)
const HOSTED_GROUP = `https://harmony.test/servers/${S}`
const EVE = 'https://peer.test/users/eve'
const EVE_NOTE = `https://peer.test/messages/${uuid(0xf1)}`
const M_EVE = uuid(0xf2) // eve's note as stored here: a row id of its own

// Copied from host.test.
const R = uuid(0xb1)
const R2 = uuid(0xb2)
const CR = uuid(0xd1)
const CR2 = uuid(0xd2)
const GROUP = `https://host.test/servers/${R}`
const GROUP2 = `https://host.test/servers/${R2}`
const BEE = 'https://b.test/users/bee'
const LISTED = 'https://b.test/users/listed'
const STRANGER = 'https://b.test/users/stranger'
const BANNED = 'https://b.test/users/banned'
const HOSTU = 'https://host.test/users/hostu'
const MB = uuid(0xe1) // bee's, in CR
const MA = uuid(0xe2) // the host user's, in CR
const MOWN = uuid(0xe3) // bob's, in CR
const MR2 = uuid(0xe4) // bee's, in CR2
const SEND = ['VIEW_CHANNEL', 'SEND_MESSAGES', 'SEND_MESSAGES_IN_THREADS', 'ADD_REACTIONS']

const profile = (id: string, federated_id: string, extra: Row = {}) =>
  ({ id, username: id, federated_id, is_local: federated_id.startsWith('https://harmony.test/'), updated_at: FRESH, ...extra })

beforeEach(() => {
  nextId = 1
  grants = { [`eve:${C}`]: new Set(SEND) }
  channelReaders = {}
  for (const key of Object.keys(software)) delete software[key]
  for (const key of Object.keys(memberPages)) delete memberPages[key]
  memberFetches.length = 0
  __resetRelayMembershipCache()
  vi.mocked(DeliveryQueue.enqueue).mockClear()
  tables = {
    profiles: [
      profile('alice', 'https://harmony.test/users/alice'),
      profile('bob', 'https://harmony.test/users/bob'),
      profile('eve', EVE),
      profile('bee', BEE),
      profile('listed', LISTED),
      profile('stranger', STRANGER),
      profile('banned', BANNED),
      profile('hostu', HOSTU),
    ],
    servers: [
      { id: S, is_local_server: true, federation_enabled: true, owner: 'alice', ap_id: null, host_domain: null, federation_domain: null },
      { id: R, is_local_server: false, federation_enabled: true, owner: null, ap_id: GROUP, host_domain: 'host.test', federation_domain: 'host.test', federation_metadata: {} },
      { id: R2, is_local_server: false, federation_enabled: true, owner: null, ap_id: GROUP2, host_domain: 'host.test', federation_domain: 'host.test', federation_metadata: {} },
    ],
    channels: [
      { id: C, server_id: S, name: 'general', ap_id: null },
      { id: CR, server_id: R, name: 'mirror', ap_id: `${GROUP}/channels/${CR}` },
      { id: CR2, server_id: R2, name: 'other', ap_id: `${GROUP2}/channels/${CR2}` },
    ],
    user_servers: [
      { server_id: S, user_id: 'eve', status: 'accepted' },
      { server_id: R, user_id: 'bob', status: 'accepted' },
      { server_id: R, user_id: 'bee', status: 'accepted' },
      { server_id: R, user_id: 'hostu', status: 'accepted' },
      { server_id: R, user_id: 'banned', status: 'banned' },
      { server_id: R2, user_id: 'bee', status: 'accepted' },
    ],
    server_bans: [],
    server_member_timeouts: [],
    threads: [],
    messages: [
      { id: M_EVE, channel_id: C, user_id: 'eve', content: [{ type: 'text', text: 'hi' }], metadata: { ap_id: EVE_NOTE } },
      { id: MB, channel_id: CR, user_id: 'bee', content: [{ type: 'text', text: 'bee wrote' }], metadata: { ap_id: `https://b.test/messages/${MB}`, federated: true } },
      { id: MA, channel_id: CR, user_id: 'hostu', content: [{ type: 'text', text: 'host wrote' }], metadata: { ap_id: `https://host.test/messages/${MA}`, federated: true } },
      { id: MOWN, channel_id: CR, user_id: 'bob', content: [{ type: 'text', text: 'bob wrote' }], metadata: {} },
      { id: MR2, channel_id: CR2, user_id: 'bee', content: [{ type: 'text', text: 'elsewhere' }], metadata: { ap_id: `https://b.test/messages/${MR2}`, federated: true } },
    ],
    reactions: [],
    emojis: [],
    posts: [],
    ap_activities: [],
  }
})

const announce = (group: string, inner: Row, id = `${group}/relays/${nextId++}`) => ({ id, type: 'Announce', actor: group, object: inner })
const note = (actor: string, n: number, extra: Row = {}) => ({
  type: 'Note',
  id: `${new URL(actor).origin}/messages/${uuid(n)}`,
  attributedTo: actor,
  content: '<p>relayed</p>',
  context: `${GROUP}/channels/${CR}`,
  'harmony:serverId': R,
  ...extra,
})
const create = (actor: string, n: number, extra: Row = {}) => ({ id: `${actor}/activities/${n}`, type: 'Create', actor, object: note(actor, n, extra) })
const atCopy = (serverId: string, activity: Row, signer: string | null = activity.actor) =>
  processServerInboxActivity(serverId, activity, { verifiedSigner: signer })
const stored = (n: number) => tables.messages!.find((m) => m.metadata?.ap_id?.endsWith(`/messages/${uuid(n)}`))
const membership = (userId: string) => tables.user_servers!.find((m) => m.server_id === R && m.user_id === userId)

describe('relayRefusal', () => {
  const server = { id: R, ap_id: GROUP, is_local_server: false }
  const refuse = (inner: Row, actor = GROUP) => relayRefusal(server, announce(actor, inner), 'harmony.test')

  it('passes a member\'s Note in a channel of the Group', () => {
    expect(refuse(create(BEE, 1))).toBeNull()
  })

  it.each([
    ['an actor other than the Group', create(BEE, 2), GROUP2],
    ['an inner actor on this instance', create('https://harmony.test/users/alice', 3), GROUP],
    ['the Group as inner actor', { type: 'Delete', actor: GROUP, object: `https://b.test/messages/${MB}` }, GROUP],
    ['a Note naming another server', create(BEE, 4, { 'harmony:serverId': R2 }), GROUP],
    ['a Note in a channel of another Group', create(BEE, 5, { context: `${GROUP2}/channels/${CR2}` }), GROUP],
    ['a Note not on its author\'s host', { type: 'Create', actor: BEE, object: note(BEE, 6, { id: `https://elsewhere.test/messages/${uuid(6)}` }) }, GROUP],
    ['a Note attributed to someone else', create(BEE, 7, { attributedTo: LISTED }), GROUP],
    ['an Undo of another actor\'s reaction', { type: 'Undo', actor: BEE, object: { type: 'Like', actor: LISTED, object: `https://b.test/messages/${MB}` } }, GROUP],
    ['an Undo of a Follow', { type: 'Undo', actor: BEE, object: { type: 'Follow', actor: BEE, object: GROUP } }, GROUP],
  ])('refuses %s', (_label, inner, actor) => {
    expect(refuse(inner as Row, actor as string)).not.toBeNull()
  })

  it('refuses a local server', () => {
    expect(relayRefusal({ id: S, ap_id: HOSTED_GROUP, is_local_server: true }, announce(HOSTED_GROUP, create(BEE, 8)), 'harmony.test'))
      .not.toBeNull()
  })
})

describe('host: the Group relays a member\'s activity', () => {
  const readers = () => {
    channelReaders[C] = [
      { instance: 'peer.test', member_ap_ids: [EVE], member_count: 1, shared_inbox: 'https://peer.test/inbox' },
      { instance: 'reader.test', member_ap_ids: ['https://reader.test/users/r'], member_count: 1, shared_inbox: 'https://reader.test/inbox' },
      { instance: 'masto.test', member_ap_ids: ['https://masto.test/users/m'], member_count: 1, shared_inbox: 'https://masto.test/inbox' },
    ]
    software['masto.test'] = 'mastodon'
    software['reader.test'] = 'harmony'
  }
  const enqueued = () => vi.mocked(DeliveryQueue.enqueue).mock.calls.map(([activity, inbox, signer]) => ({ activity, inbox, signer }))

  it('sends a Create as the Group\'s Announce to each Harmony reader instance but the sender\'s', async () => {
    readers()
    const activity = {
      id: 'https://peer.test/activities/1',
      type: 'Create',
      actor: EVE,
      object: {
        type: 'Note', id: `https://peer.test/messages/${uuid(0xf9)}`, content: '<p>hello</p>',
        context: `${HOSTED_GROUP}/channels/${C}`, 'harmony:serverId': S,
      },
    }
    await processServerInboxActivity(S, activity)
    const sent = enqueued()
    expect(sent.map((s) => s.inbox)).toEqual([`https://reader.test/servers/${S}/inbox`])
    expect(sent[0].signer).toEqual({ serverId: S })
    expect(sent[0].activity).toMatchObject({
      type: 'Announce',
      actor: HOSTED_GROUP,
      object: activity,
      to: ['https://reader.test/users/r'],
      cc: [`${HOSTED_GROUP}/members`],
    })
    expect(sent[0].activity.id).toBe(groupAnnounce(S, activity, []).id)
  })

  it('relays an edit, a reaction, its Undo and a delete; the Undo removes the reaction here', async () => {
    readers()
    await processServerInboxActivity(S, { id: 'e1', type: 'Update', actor: EVE, object: { type: 'Note', id: EVE_NOTE, content: '<p>edited</p>' } })
    expect(tables.messages!.find((m) => m.id === M_EVE)!.content).toEqual([{ type: 'text', text: 'edited' }])

    const like = { id: 'https://peer.test/likes/1', type: 'Like', actor: EVE, object: EVE_NOTE, content: '🎉' }
    await processServerInboxActivity(S, like)
    expect(tables.reactions).toHaveLength(1)
    await processServerInboxActivity(S, { id: 'u1', type: 'Undo', actor: EVE, object: like })
    expect(tables.reactions).toHaveLength(0)

    await processServerInboxActivity(S, { id: 'd1', type: 'Delete', actor: EVE, object: EVE_NOTE })
    expect(tables.messages!.find((m) => m.id === M_EVE)!.is_deleted).toBe(true)

    expect(enqueued().map((s) => [s.activity.object.type, s.inbox])).toEqual([
      ['Update', `https://reader.test/servers/${S}/inbox`],
      ['Like', `https://reader.test/servers/${S}/inbox`],
      ['Undo', `https://reader.test/servers/${S}/inbox`],
      ['Delete', `https://reader.test/servers/${S}/inbox`],
    ])
  })

  it('removes only the emoji an Undo names', async () => {
    readers()
    await processServerInboxActivity(S, { id: 'l1', type: 'Like', actor: EVE, object: EVE_NOTE, content: '🎉' })
    await processServerInboxActivity(S, { id: 'l2', type: 'Like', actor: EVE, object: EVE_NOTE, content: '👍' })
    await processServerInboxActivity(S, { id: 'u2', type: 'Undo', actor: EVE, object: { type: 'Like', actor: EVE, object: EVE_NOTE, content: '🎉' } })
    expect(tables.reactions!.map((r) => r.custom_emoji_content)).toEqual(['👍'])
  })

  it('relays nothing it refused', async () => {
    readers()
    grants[`eve:${C}`] = new Set(['VIEW_CHANNEL'])
    await processServerInboxActivity(S, {
      id: 'x', type: 'Create', actor: EVE,
      object: { type: 'Note', id: `https://peer.test/messages/${uuid(0xfa)}`, content: '<p>no</p>', context: `${HOSTED_GROUP}/channels/${C}`, 'harmony:serverId': S },
    })
    expect(enqueued()).toHaveLength(0)
  })

  it('addresses an instance\'s copy on the origin of its shared inbox', () => {
    expect(copyInboxUrl({ instance: 'a.test', member_ap_ids: [], member_count: 0, shared_inbox: 'https://ap.a.test/inbox' }, S))
      .toBe(`https://ap.a.test/servers/${S}/inbox`)
    expect(copyInboxUrl({ instance: 'a.test', member_ap_ids: [], member_count: 0 }, S)).toBe(`https://a.test/servers/${S}/inbox`)
  })
})

describe('receiver: a relay on the copy\'s inbox', () => {
  it('stores a member\'s message', async () => {
    await atCopy(R, announce(GROUP, create(BEE, 1)))
    const row = stored(1)
    expect(row?.channel_id).toBe(CR)
    expect(row?.user_id).toBe('bee')
    expect(row?.metadata).toMatchObject({ federated: true, ap_id: `https://b.test/messages/${uuid(1)}` })
  })

  it('takes a member the copy lacks once the Group lists it, and records the membership', async () => {
    memberPages[`${GROUP}/members?page=1`] = [BEE, LISTED]
    await atCopy(R, announce(GROUP, create(LISTED, 2)))
    expect(stored(2)?.user_id).toBe('listed')
    expect(membership('listed')?.status).toBe('accepted')
    expect(memberFetches).toEqual([{ url: `${GROUP}/members?page=1`, signAs: 'bob' }])
  })

  it('refuses an actor the Group does not list, and does not ask again at once', async () => {
    memberPages[`${GROUP}/members?page=1`] = [BEE]
    await atCopy(R, announce(GROUP, create(STRANGER, 3)))
    await atCopy(R, announce(GROUP, create(STRANGER, 4)))
    expect(stored(3)).toBeUndefined()
    expect(stored(4)).toBeUndefined()
    expect(membership('stranger')).toBeUndefined()
    expect(memberFetches).toHaveLength(1)
  })

  it('refuses a member banned on the copy without asking the Group', async () => {
    memberPages[`${GROUP}/members?page=1`] = [BANNED]
    await atCopy(R, announce(GROUP, create(BANNED, 5)))
    expect(stored(5)).toBeUndefined()
    expect(memberFetches).toHaveLength(0)
  })

  it('refuses a relay signed by anyone but the copy\'s Group', async () => {
    await atCopy(R, announce(GROUP, create(BEE, 6)), BEE)
    await atCopy(R, announce(GROUP, create(BEE, 7)), null)
    await atCopy(R, announce(GROUP2, create(BEE, 8)), GROUP2)
    expect([stored(6), stored(7), stored(8)]).toEqual([undefined, undefined, undefined])
  })

  it('refuses the Group of another server relaying into this one', async () => {
    // GROUP2's own copy, a Note in GROUP's channel.
    await atCopy(R2, announce(GROUP2, create(BEE, 9)))
    // GROUP2's copy, a Note naming R2 but placed in GROUP's channel.
    await atCopy(R2, announce(GROUP2, create(BEE, 10, { 'harmony:serverId': R2 })))
    expect(stored(9)).toBeUndefined()
    expect(stored(10)).toBeUndefined()
  })

  it('refuses an inner actor on a blocked instance', async () => {
    tables.profiles!.push(profile('blocked', 'https://blocked.test/users/x'))
    tables.user_servers!.push({ server_id: R, user_id: 'blocked', status: 'accepted' })
    await atCopy(R, announce(GROUP, create('https://blocked.test/users/x', 11)))
    expect(stored(11)).toBeUndefined()
  })

  it('applies the author\'s edit and refuses another member\'s', async () => {
    tables.user_servers!.push({ server_id: R, user_id: 'listed', status: 'accepted' })
    const edit = (actor: string, text: string) => ({
      id: `${actor}/edits/${text}`, type: 'Update', actor,
      object: { type: 'Note', id: `https://b.test/messages/${MB}`, attributedTo: actor, content: `<p>${text}</p>`, 'harmony:serverId': R },
    })
    await atCopy(R, announce(GROUP, edit(LISTED, 'hijack')))
    expect(tables.messages!.find((m) => m.id === MB)!.content).toEqual([{ type: 'text', text: 'bee wrote' }])
    await atCopy(R, announce(GROUP, edit(BEE, 'edited')))
    expect(tables.messages!.find((m) => m.id === MB)!.content).toEqual([{ type: 'text', text: 'edited' }])
  })

  it('stores a reaction and removes it on the Undo, on a message of this instance\'s user too', async () => {
    const like = { id: 'https://b.test/likes/1', type: 'Like', actor: BEE, object: `https://harmony.test/messages/${MOWN}`, content: '🎉' }
    await atCopy(R, announce(GROUP, like))
    expect(tables.reactions!.map((r) => [r.message_id, r.user_id, r.custom_emoji_content])).toEqual([[MOWN, 'bee', '🎉']])
    await atCopy(R, announce(GROUP, { id: 'https://b.test/undo/1', type: 'Undo', actor: BEE, object: like }))
    expect(tables.reactions).toHaveLength(0)
  })

  it('deletes a message of the server and nothing outside it', async () => {
    await atCopy(R, announce(GROUP, { id: 'del1', type: 'Delete', actor: BEE, object: `https://host.test/messages/${MA}` }))
    expect(tables.messages!.find((m) => m.id === MA)!.is_deleted).toBe(true)
    await atCopy(R, announce(GROUP, { id: 'del2', type: 'Delete', actor: BEE, object: `https://b.test/messages/${MR2}` }))
    expect(tables.messages!.find((m) => m.id === MR2)!.is_deleted).toBeUndefined()
  })

  it('ignores anything but a relay on a copy\'s inbox', async () => {
    await atCopy(R, create(BEE, 12))
    expect(stored(12)).toBeUndefined()
  })
})

describe('receiver: a relay on the shared inbox', () => {
  it('applies a relay from the Group of a copied server', async () => {
    await ActivityProcessor.processIncomingActivity(announce(GROUP, create(BEE, 20)))
    expect(stored(20)?.user_id).toBe('bee')
  })

  it('reads an Announce of an activity from any other actor as a FEP-1b12 relay, never a channel relay', async () => {
    const fep1b12 = vi.spyOn(ActivityProcessor as any, 'processGroupAnnounce').mockResolvedValue(undefined)
    await ActivityProcessor.processIncomingActivity(announce('https://b.test/users/bee', create(BEE, 21)))
    expect(fep1b12).toHaveBeenCalledTimes(1)
    expect(stored(21)).toBeUndefined()
    fep1b12.mockRestore()
  })
})

describe('receiver: an edit sent by the host directly', () => {
  it('applies the host user\'s edit of their message', async () => {
    await ActivityProcessor.processIncomingActivity({
      id: 'h1', type: 'Update', actor: HOSTU,
      object: { type: 'Note', id: `https://host.test/messages/${MA}`, attributedTo: HOSTU, content: '<p>host edit</p>', 'harmony:serverId': R },
    })
    expect(tables.messages!.find((m) => m.id === MA)!.content).toEqual([{ type: 'text', text: 'host edit' }])
  })

  it('refuses an unrelayed edit by an author off the server\'s host', async () => {
    await ActivityProcessor.processIncomingActivity({
      id: 'h2', type: 'Update', actor: BEE,
      object: { type: 'Note', id: `https://b.test/messages/${MB}`, attributedTo: BEE, content: '<p>direct</p>', 'harmony:serverId': R },
    })
    expect(tables.messages!.find((m) => m.id === MB)!.content).toEqual([{ type: 'text', text: 'bee wrote' }])
  })
})

describe('receiver: a server blocked on this instance', () => {
  beforeEach(() => {
    tables.instance_server_blocks = [{ server_id: R, blocked: true, media_hidden: false }]
  })

  it('drops its relays on the copy\'s inbox and on the shared inbox', async () => {
    await atCopy(R, announce(GROUP, create(BEE, 30)))
    await ActivityProcessor.processIncomingActivity(announce(GROUP, create(BEE, 31)))
    await atCopy(R, announce(GROUP, { id: 'del30', type: 'Delete', actor: BEE, object: `https://host.test/messages/${MA}` }))
    expect([stored(30), stored(31)]).toEqual([undefined, undefined])
    expect(tables.messages!.find((m) => m.id === MA)!.is_deleted).toBeUndefined()
  })

  it('refuses what its host sends directly', async () => {
    await ActivityProcessor.processIncomingActivity({
      id: 'h30', type: 'Update', actor: HOSTU,
      object: { type: 'Note', id: `https://host.test/messages/${MA}`, attributedTo: HOSTU, content: '<p>host edit</p>', 'harmony:serverId': R },
    })
    expect(tables.messages!.find((m) => m.id === MA)!.content).toEqual([{ type: 'text', text: 'host wrote' }])
    expect(await authorizeChannelWrite(fakeSupabase() as any, { actorUrl: HOSTU, serverId: R, channelId: CR, kind: 'message' }))
      .toEqual({ ok: false, reason: 'server is blocked on this instance' })
  })

  it('leaves other copies alone, and takes relays again once allowed', async () => {
    await atCopy(R2, announce(GROUP2, create(BEE, 32, { context: `${GROUP2}/channels/${CR2}`, 'harmony:serverId': R2 })))
    expect(stored(32)?.channel_id).toBe(CR2)
    tables.instance_server_blocks![0].blocked = false
    await atCopy(R, announce(GROUP, create(BEE, 33)))
    expect(stored(33)?.user_id).toBe('bee')
  })
})

describe('authorizeChannelWrite relayedBy', () => {
  const sb = fakeSupabase() as any

  it('passes the copy\'s own Group for an actor off the host', async () => {
    expect((await authorizeChannelWrite(sb, { actorUrl: BEE, serverId: R, channelId: CR, kind: 'message', relayedBy: GROUP })).ok).toBe(true)
  })

  it('refuses another Group and a local server', async () => {
    expect(await authorizeChannelWrite(sb, { actorUrl: BEE, serverId: R, channelId: CR, kind: 'message', relayedBy: GROUP2 }))
      .toEqual({ ok: false, reason: 'relayed by a Group that does not host the server' })
    expect((await authorizeChannelWrite(sb, { actorUrl: EVE, serverId: S, channelId: C, kind: 'message', relayedBy: HOSTED_GROUP })).ok)
      .toBe(false)
  })
})

describe('senders', () => {
  it('leaves a remote author\'s edit of a hosted message to the Group\'s relay', async () => {
    channelReaders[C] = [{ instance: 'reader.test', member_ap_ids: ['https://reader.test/users/r'], member_count: 1, shared_inbox: 'https://reader.test/inbox' }]
    await handleChannelMessageUpdate({ message_id: M_EVE, channel_id: C, server_id: S })
    expect(DeliveryQueue.enqueue).not.toHaveBeenCalled()
  })

  it('sends a reaction on a remote server\'s channel to that server\'s inbox only', async () => {
    tables.servers![1].federation_inbox_url = `${GROUP}/inbox`
    channelReaders[CR] = [{ instance: 'b.test', member_ap_ids: [BEE], member_count: 1, shared_inbox: 'https://b.test/inbox' }]
    tables.reactions = [{ id: 'rx', message_id: MB, user_id: 'bob', custom_emoji_content: '🎉', emoji_id: null }]
    await handleChannelReactionFederation({ reaction_id: 'rx', message_id: MB, user_id: 'bob', emoji_id: '' })
    expect(vi.mocked(DeliveryQueue.enqueue).mock.calls.map((c) => c[1])).toEqual([`${GROUP}/inbox`])
  })
})
