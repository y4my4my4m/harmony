import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { FakeDb, type Row } from '../../__tests__/fakeSupabase.js'

const SERVER_ID = '00000000-0000-0000-0000-00000000005a'
const OWNER_ID = '00000000-0000-0000-0000-0000000000a1'
const OPEN_BOT = '00000000-0000-0000-0000-0000000000b1'
const SCOPED_BOT = '00000000-0000-0000-0000-0000000000b2'
const GENERAL = '00000000-0000-0000-0000-0000000000c1'
const BRIDGED = '00000000-0000-0000-0000-0000000000c3'
const MODS_ONLY = '00000000-0000-0000-0000-0000000000c2'
const EVERYONE_ROLE = '00000000-0000-0000-0000-0000000000e0'
const VIEW_CHANNEL = 2

const mocks = vi.hoisted(() => ({
  rpc: vi.fn(),
  from: vi.fn(),
}))

vi.mock('../../config/supabase.js', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from },
  config: {},
}))

import { EventDispatcher, timestampMicros } from '../EventDispatcher.js'

let db: FakeDb
let sent: Array<{ botIds: string[]; event: any }>
let dispatcher: EventDispatcher

// Database clock for channel_message_changes, in ms; rendered as Postgres renders timestamptz.
const T0 = Date.parse('2026-10-08T12:00:00Z')
let dbClock = T0
const at = (ms: number) => new Date(ms).toISOString().replace('Z', '+00:00')
let feedCalls: Array<{ p_after_at: string | null; p_after_id: string | null; p_limit: number }>
let feedFailure: { message: string } | null

// channel_message_changes over db.rows('messages'), as migration 20261009000001 defines it.
function channelMessageChanges(args: { p_after_at: string | null; p_after_id: string | null; p_limit: number }) {
  feedCalls.push(args)
  if (feedFailure) return { data: null, error: feedFailure }
  const key = (m: Row): [number, string] => [timestampMicros(m.updated_at), m.id]
  const after: [number, string] | null = args.p_after_at === null ? null : [timestampMicros(args.p_after_at), args.p_after_id!]
  const cmp = (a: [number, string], b: [number, string]) => (a[0] - b[0]) || (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)
  const rows = after === null
    ? []
    : db.rows('messages')
        .filter((m) => m.channel_id != null && timestampMicros(m.updated_at) > timestampMicros(m.created_at))
        .filter((m) => cmp(key(m), after) > 0)
        .sort((a, b) => cmp(key(a), key(b)))
        .slice(0, Math.min(Math.max(args.p_limit, 1), 1000))
  return { data: { now: at(dbClock), messages: rows.map((r) => ({ ...r })) }, error: null }
}

function installRow(botId: string, extra: Row = {}): Row {
  return {
    id: `${botId}-install`,
    bot_id: botId,
    server_id: SERVER_ID,
    installed_by: OWNER_ID,
    is_active: true,
    read_messages: true,
    send_messages: true,
    ...extra,
  }
}

function message(channelId: string, text: string): Row {
  return {
    id: `${channelId.slice(-2)}-${text}`,
    channel_id: channelId,
    user_id: OWNER_ID,
    bot_id: null,
    content: [{ type: 'text', text }],
    metadata: {},
    encrypted: false,
    created_at: '2026-10-02T00:00:00Z',
    updated_at: '2026-10-02T00:00:00Z',
  }
}

/** Bot ids that received an event of the given type for the given channel. */
function recipients(type: string, channelId: string): string[] {
  return sent
    .filter((s) => s.event.t === type && s.event.d.channel_id === channelId)
    .flatMap((s) => s.botIds)
}

beforeEach(() => {
  db = new FakeDb({
    servers: [{ id: SERVER_ID, owner: OWNER_ID }],
    server_roles: [
      { id: EVERYONE_ROLE, server_id: SERVER_ID, position: 0, permissions: 122646786, is_default: true },
    ],
    channels: [
      { id: GENERAL, server_id: SERVER_ID },
      { id: BRIDGED, server_id: SERVER_ID },
      { id: MODS_ONLY, server_id: SERVER_ID },
    ],
    channel_permission_overrides: [
      { id: 'ov1', channel_id: MODS_ONLY, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: VIEW_CHANNEL },
    ],
    bot_server_permissions: [
      installRow(OPEN_BOT),
      installRow(SCOPED_BOT, { allowed_channel_ids: [BRIDGED] }),
    ],
    profiles: [{ id: OWNER_ID, username: 'alice', display_name: 'Alice', avatar_url: null }],
    emojis: [],
  })
  mocks.from.mockReset()
  mocks.from.mockImplementation((table: string) => db.from(table))
  dbClock = T0
  feedCalls = []
  feedFailure = null
  mocks.rpc.mockReset()
  mocks.rpc.mockImplementation(async (fn: string, args: any) => {
    if (fn === 'channel_message_changes') return channelMessageChanges(args)
    throw new Error(`test called unmocked rpc: ${fn}`)
  })

  sent = []
  const gateway = {
    sendToMultipleBots: (botIds: string[], event: any) => {
      sent.push({ botIds: [...botIds], event })
    },
  }
  dispatcher = new EventDispatcher(gateway as any)

  vi.spyOn(console, 'log').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(async () => {
  await dispatcher.shutdown()
  vi.restoreAllMocks()
})

describe('event fan-out follows channel visibility', () => {
  // gw.log of the audit: a read_messages bot received MESSAGE_CREATE from a mods-only channel.
  it('withholds MESSAGE_CREATE of a channel hidden from @everyone', async () => {
    await dispatcher.handleMessageCreate({ new: message(MODS_ONLY, 'private mod note') })
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'hello') })

    expect(recipients('MESSAGE_CREATE', MODS_ONLY)).toEqual([])
    expect(recipients('MESSAGE_CREATE', GENERAL)).toEqual([OPEN_BOT])
    expect(JSON.stringify(sent)).not.toContain('private mod note')
  })

  it('delivers only the channels in an install\'s allowed_channel_ids', async () => {
    await dispatcher.handleMessageCreate({ new: message(BRIDGED, 'bridged') })
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'general') })

    expect(recipients('MESSAGE_CREATE', BRIDGED).sort()).toEqual([OPEN_BOT, SCOPED_BOT].sort())
    expect(recipients('MESSAGE_CREATE', GENERAL)).toEqual([OPEN_BOT])
  })

  it('withholds MESSAGE_UPDATE, MESSAGE_DELETE and reaction events of a hidden channel', async () => {
    const d = dispatcher as any
    await d.handleMessageUpdate({ new: message(MODS_ONLY, 'edited') })
    await d.handleMessageDelete({ old: { id: 'm', channel_id: MODS_ONLY, metadata: {} } })
    await d.handleReactionEvent('MESSAGE_REACTION_ADD', {
      id: 'r', message_id: 'm', channel_id: MODS_ONLY, user_id: OWNER_ID, custom_emoji_content: '👍',
    })
    await d.handleMessageUpdate({ new: message(GENERAL, 'edited') })

    expect(sent.map((s) => [s.event.t, s.event.d.channel_id])).toEqual([['MESSAGE_UPDATE', GENERAL]])
  })

  it('delivers a hidden channel to a bot whose allowed_channel_ids names it', async () => {
    db.rows('bot_server_permissions').push(
      installRow('00000000-0000-0000-0000-0000000000b3', { allowed_channel_ids: [GENERAL, MODS_ONLY] }),
    )
    await dispatcher.handleMessageCreate({ new: message(MODS_ONLY, 'bridged mod note') })

    expect(recipients('MESSAGE_CREATE', MODS_ONLY)).toEqual(['00000000-0000-0000-0000-0000000000b3'])
  })

  it('delivers nothing when visibility cannot be established', async () => {
    db.failures.channel_permission_overrides = { message: 'connection reset' }
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'hello') })

    expect(sent).toEqual([])
  })

  it('stops delivering a newly hidden channel within the layer cache bound', async () => {
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'before') })
    expect(recipients('MESSAGE_CREATE', GENERAL)).toEqual([OPEN_BOT])

    db.rows('channel_permission_overrides').push({
      id: 'ov2', channel_id: GENERAL, target_type: 'role', role_id: EVERYONE_ROLE, user_id: null, allow_permissions: 0, deny_permissions: VIEW_CHANNEL,
    })
    clock += 10_001
    sent = []
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'after') })

    expect(sent).toEqual([])
  })
})

describe('author.nickname', () => {
  const OTHER_SERVER = '00000000-0000-0000-0000-00000000005b'
  const OTHER_CHANNEL = '00000000-0000-0000-0000-0000000000c9'
  const BRIDGE_BOT = '00000000-0000-0000-0000-0000000000b9'

  const authorOf = (type: string) => sent.filter((s) => s.event.t === type).map((s) => s.event.d.author)
  const nicknameQueries = () => mocks.from.mock.calls.filter(([table]) => table === 'user_servers').length

  beforeEach(() => {
    db.rows('user_servers').push(
      { user_id: OWNER_ID, server_id: SERVER_ID, nickname: 'Al' },
      { user_id: OWNER_ID, server_id: OTHER_SERVER, nickname: 'Big Al' },
    )
    db.rows('servers').push({ id: OTHER_SERVER, owner: OWNER_ID })
    db.rows('channels').push({ id: OTHER_CHANNEL, server_id: OTHER_SERVER })
    db.rows('server_roles').push({
      id: '00000000-0000-0000-0000-0000000000e9', server_id: OTHER_SERVER, position: 0, permissions: 122646786, is_default: true,
    })
    db.rows('bot_server_permissions').push(installRow(OPEN_BOT, { id: 'other-install', server_id: OTHER_SERVER }))
  })

  it("carries the author's nickname in the channel's server on MESSAGE_CREATE and MESSAGE_UPDATE", async () => {
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'hello') })
    await (dispatcher as any).handleMessageUpdate({ new: message(GENERAL, 'hello, edited') })
    await dispatcher.handleMessageCreate({ new: message(OTHER_CHANNEL, 'elsewhere') })

    expect(authorOf('MESSAGE_CREATE').map((a) => a.nickname)).toEqual(['Al', 'Big Al'])
    expect(authorOf('MESSAGE_UPDATE')).toMatchObject([{ id: OWNER_ID, username: 'alice', nickname: 'Al' }])
  })

  it('is null without a nickname, for a blank one and for a non-member', async () => {
    db.rows('user_servers')[0].nickname = null
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'unset') })
    db.rows('user_servers').splice(0)
    db.rows('user_servers').push({ user_id: OWNER_ID, server_id: OTHER_SERVER, nickname: '   ' })
    await dispatcher.handleMessageCreate({ new: message(OTHER_CHANNEL, 'blank') })

    expect(authorOf('MESSAGE_CREATE').map((a) => a.nickname)).toEqual([null, null])
  })

  it('is null for a bot and for a relayed Discord author', async () => {
    db.rows('bots').push({ id: BRIDGE_BOT, username: 'discord-bridge-1', display_name: 'Discord Bridge', avatar_url: null })
    await dispatcher.handleMessageCreate({ new: { ...message(GENERAL, 'from a bot'), user_id: null, bot_id: BRIDGE_BOT } })
    await dispatcher.handleMessageCreate({
      new: {
        ...message(GENERAL, 'from discord'),
        user_id: null,
        bot_id: BRIDGE_BOT,
        metadata: { discord_user: { id: '80351110224678912', username: 'dana', display_name: 'Dana', avatar_url: null } },
      },
    })

    expect(authorOf('MESSAGE_CREATE')).toMatchObject([
      { id: BRIDGE_BOT, bot: true, nickname: null },
      { id: '80351110224678912', discord_user: true, nickname: null },
    ])
    expect(nicknameQueries()).toBe(0)
  })

  it('names a webhook message by the name and avatar it was posted under', async () => {
    await dispatcher.handleMessageCreate({
      new: {
        ...message(GENERAL, 'deploy finished'),
        user_id: null,
        bot_id: BRIDGE_BOT,
        metadata: { bot: true, created_via: 'webhook', webhook: { id: 'w1', name: 'Deployer', avatar_url: 'https://cdn.test/d.png' } },
      },
    })

    expect(authorOf('MESSAGE_CREATE')).toEqual([{
      id: BRIDGE_BOT, username: 'Deployer', display_name: 'Deployer', avatar: 'https://cdn.test/d.png',
      nickname: null, bot: true, webhook: true,
    }])
    expect(nicknameQueries()).toBe(0)
  })

  it('shows a nickname change within 60 s and reads it once per server and user meanwhile', async () => {
    let clock = Date.now()
    vi.spyOn(Date, 'now').mockImplementation(() => clock)

    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'one') })
    db.rows('user_servers')[0].nickname = 'Alice the Great'
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'two') })
    expect(nicknameQueries()).toBe(1)

    clock += 60_001
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'three') })

    expect(authorOf('MESSAGE_CREATE').map((a) => a.nickname)).toEqual(['Al', 'Al', 'Alice the Great'])
  })

  it('does not cache a failed lookup', async () => {
    db.failures.user_servers = { message: 'connection reset' }
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'one') })
    delete db.failures.user_servers
    await dispatcher.handleMessageCreate({ new: message(GENERAL, 'two') })

    expect(authorOf('MESSAGE_CREATE').map((a) => a.nickname)).toEqual([null, 'Al'])
  })
})

describe('message change feed', () => {
  const BRIDGE_METADATA = { discord_message_id: '1300000000000000001', bridge_source: 'discord', discord_user: { id: '8' } }
  const d = () => dispatcher as any
  const events = (type: string) => sent.filter((s) => s.event.t === type).map((s) => s.event.d)
  const poll = () => d().pollMessageChanges()

  /** A channel message as the insert trigger leaves it: updated_at = created_at. */
  function seedMessage(id: string, createdMs: number, extra: Row = {}): Row {
    const row = { ...message(GENERAL, id), id, created_at: at(createdMs), updated_at: at(createdMs), is_deleted: false, ...extra }
    db.rows('messages').push(row)
    return row
  }

  /** handle_messages_updated_at: a content change or a soft delete stamps updated_at with the clock. */
  function edit(id: string, text: string) {
    const row = db.rows('messages').find((m) => m.id === id)!
    row.content = [{ type: 'text', text }]
    row.updated_at = at(dbClock)
  }
  function softDelete(id: string) {
    const row = db.rows('messages').find((m) => m.id === id)!
    row.is_deleted = true
    row.updated_at = at(dbClock)
  }

  async function startFeed() {
    expect(await d().initializeChangeFeed()).toBe(true)
  }

  it('dispatches an edit of a message created before startup', async () => {
    seedMessage('m-old', T0 - 60 * 60 * 1000)
    await startFeed()
    dbClock += 5_000
    edit('m-old', 'fixed a typo')
    await poll()

    expect(events('MESSAGE_UPDATE')).toMatchObject([{
      id: 'm-old',
      channel_id: GENERAL,
      content: 'fixed a typo',
      content_raw: [{ type: 'text', text: 'fixed a typo' }],
      author: { id: OWNER_ID, username: 'alice' },
      timestamp: at(T0 - 60 * 60 * 1000),
      edited_timestamp: at(dbClock),
      metadata: {},
    }])
    expect(recipients('MESSAGE_UPDATE', GENERAL)).toEqual([OPEN_BOT])
  })

  it('dispatches an edit of an old message after more than 100 newer messages', async () => {
    seedMessage('m-first', T0 - 1_000)
    await startFeed()
    for (let i = 0; i < 150; i++) seedMessage(`m-new-${i}`, T0 + 1_000 + i)
    dbClock += 10_000
    await poll()
    edit('m-first', 'edited much later')
    await poll()

    expect(events('MESSAGE_UPDATE').map((e) => [e.id, e.content])).toEqual([['m-first', 'edited much later']])
  })

  it('sends no MESSAGE_UPDATE for a metadata merge', async () => {
    seedMessage('m-bridged', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    // PATCH /messages/:id/metadata: updated_at stays where the trigger left it.
    db.rows('messages').find((m) => m.id === 'm-bridged')!.metadata = BRIDGE_METADATA
    await poll()
    await poll()

    expect(sent).toEqual([])
  })

  it('dispatches a soft delete once, with the message metadata', async () => {
    seedMessage('m-soft', T0 - 1_000, { metadata: BRIDGE_METADATA })
    await startFeed()
    dbClock += 1_000
    softDelete('m-soft')
    await poll()
    await poll()
    dbClock += 1_000
    db.rows('messages').find((m) => m.id === 'm-soft')!.updated_at = at(dbClock)
    await poll()

    expect(events('MESSAGE_DELETE')).toEqual([{ id: 'm-soft', channel_id: GENERAL, metadata: BRIDGE_METADATA }])
    expect(events('MESSAGE_UPDATE')).toEqual([])
  })

  it('dispatches a hard delete through the REST API once, with the metadata read before it', async () => {
    seedMessage('m-hard', T0 - 1_000, { metadata: BRIDGE_METADATA })
    await startFeed()
    db.rows('messages').splice(0)
    await dispatcher.messageHardDeleted({ id: 'm-hard', channel_id: GENERAL, metadata: BRIDGE_METADATA })
    await dispatcher.messageHardDeleted({ id: 'm-hard', channel_id: GENERAL, metadata: BRIDGE_METADATA })
    await poll()

    expect(events('MESSAGE_DELETE')).toEqual([{ id: 'm-hard', channel_id: GENERAL, metadata: BRIDGE_METADATA }])
  })

  it('withholds edits and deletes of a channel hidden from @everyone', async () => {
    seedMessage('m-mods', T0 - 1_000, { channel_id: MODS_ONLY })
    seedMessage('m-mods-2', T0 - 1_000, { channel_id: MODS_ONLY })
    await startFeed()
    dbClock += 1_000
    edit('m-mods', 'private, edited')
    softDelete('m-mods-2')
    await poll()

    expect(sent).toEqual([])
  })

  it('replays nothing on start: changes stamped before the database clock are not sent', async () => {
    seedMessage('m-edited-before', T0 - 60_000)
    seedMessage('m-deleted-before', T0 - 60_000)
    dbClock = T0 - 10_000
    edit('m-edited-before', 'edited while the gateway was down')
    softDelete('m-deleted-before')
    dbClock = T0
    await dispatcher.start()
    await poll()
    await poll()

    expect(sent).toEqual([])
    expect(feedCalls[0]).toMatchObject({ p_after_at: null, p_after_id: null })
  })

  it('starts from the database clock, not the gateway clock', async () => {
    vi.spyOn(Date, 'now').mockImplementation(() => T0 + 3_600_000)
    seedMessage('m-skew', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    edit('m-skew', 'edited one second after start')
    await poll()

    expect(events('MESSAGE_UPDATE').map((e) => e.id)).toEqual(['m-skew'])
  })

  it('sends each edit once although the overlap window re-reads it', async () => {
    seedMessage('m-a', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    edit('m-a', 'one')
    await poll()
    await poll()
    dbClock += 1_000
    edit('m-a', 'two')
    await poll()
    await poll()

    expect(events('MESSAGE_UPDATE').map((e) => e.content)).toEqual(['one', 'two'])
  })

  it('reads a row committed behind the cursor, and the cursor never moves back', async () => {
    seedMessage('m-early', T0 - 1_000)
    seedMessage('m-late', T0 - 1_000)
    await startFeed()
    dbClock += 60_000
    edit('m-late', 'committed first')
    await poll()
    const cursor = d().changeCursor
    // A transaction that began 5 s earlier commits now; its rows carry the earlier stamp.
    const row = db.rows('messages').find((m) => m.id === 'm-early')!
    row.content = [{ type: 'text', text: 'long transaction' }]
    row.updated_at = at(dbClock - 5_000)
    await poll()

    expect(events('MESSAGE_UPDATE').map((e) => e.content)).toEqual(['committed first', 'long transaction'])
    expect(d().changeCursor).toEqual(cursor)
    expect(timestampMicros(feedCalls.at(-1)!.p_after_at!)).toBe(timestampMicros(cursor.at) - 30_000_000)
  })

  it('keeps the cursor at or before the database clock', async () => {
    seedMessage('m-future', T0 - 1_000)
    seedMessage('m-now', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    const future = db.rows('messages').find((m) => m.id === 'm-future')!
    future.content = [{ type: 'text', text: 'stamped by a privileged writer' }]
    future.updated_at = at(dbClock + 365 * 24 * 3600 * 1000)
    await poll()
    dbClock += 1_000
    edit('m-now', 'a later ordinary edit')
    await poll()

    expect(timestampMicros(d().changeCursor.at)).toBeLessThanOrEqual(timestampMicros(at(dbClock)))
    expect(events('MESSAGE_UPDATE').map((e) => e.id)).toEqual(['m-future', 'm-now'])
  })

  it('drains a backlog in pages of 500', async () => {
    for (let i = 0; i < 1_200; i++) seedMessage(`m-${String(i).padStart(4, '0')}`, T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    for (let i = 0; i < 1_200; i++) edit(`m-${String(i).padStart(4, '0')}`, `edit ${i}`)
    feedCalls = []
    await poll()

    expect(feedCalls.map((c) => c.p_limit)).toEqual([500, 500, 500])
    expect(events('MESSAGE_UPDATE')).toHaveLength(1_200)
    expect(new Set(events('MESSAGE_UPDATE').map((e) => e.id)).size).toBe(1_200)
  })

  it('stops a tick after ten pages and resumes from the same position', async () => {
    for (let i = 0; i < 5_200; i++) seedMessage(`m-${String(i).padStart(4, '0')}`, T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    for (let i = 0; i < 5_200; i++) edit(`m-${String(i).padStart(4, '0')}`, `edit ${i}`)
    feedCalls = []
    await poll()
    expect(feedCalls).toHaveLength(10)
    expect(events('MESSAGE_UPDATE')).toHaveLength(5_000)

    feedCalls = []
    await poll()
    expect(feedCalls[0]).toMatchObject({ p_after_id: 'm-4999' })
    expect(events('MESSAGE_UPDATE')).toHaveLength(5_200)
    expect(new Set(events('MESSAGE_UPDATE').map((e) => e.id)).size).toBe(5_200)
  })

  it('loses nothing across a failed query', async () => {
    seedMessage('m-retry', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    edit('m-retry', 'after the outage')
    feedFailure = { message: 'connection reset' }
    await poll()
    expect(sent).toEqual([])

    feedFailure = null
    await poll()
    expect(events('MESSAGE_UPDATE').map((e) => e.id)).toEqual(['m-retry'])
  })

  it('reads the database clock on a later tick when start could not', async () => {
    feedFailure = { message: 'connection reset' }
    await dispatcher.start()
    expect(d().changeCursor).toBeNull()
    seedMessage('m-x', T0 - 1_000)
    feedFailure = null
    await poll()
    dbClock += 1_000
    edit('m-x', 'after recovery')
    await poll()

    expect(events('MESSAGE_UPDATE').map((e) => e.id)).toEqual(['m-x'])
  })

  it('bounds the overlap dedupe to the window', async () => {
    seedMessage('m-1', T0 - 1_000)
    seedMessage('m-2', T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    edit('m-1', 'early')
    await poll()
    dbClock += 60_000
    edit('m-2', 'a minute later')
    await poll()

    expect([...d().changeSeen.keys()]).toEqual(['m-2'])
  })

  it('moves the cursor to the database clock once drained, so a burst is re-read for one overlap only', async () => {
    for (let i = 0; i < 300; i++) seedMessage(`m-${String(i).padStart(3, '0')}`, T0 - 1_000)
    await startFeed()
    dbClock += 1_000
    for (let i = 0; i < 300; i++) softDelete(`m-${String(i).padStart(3, '0')}`)
    await poll()
    expect(events('MESSAGE_DELETE')).toHaveLength(300)

    dbClock += 40_000
    await poll()
    feedCalls = []
    await poll()

    expect(d().changeCursor.at).toBe(at(dbClock))
    expect(timestampMicros(feedCalls[0].p_after_at!)).toBe((dbClock - 30_000) * 1000)
    expect(channelMessageChanges(feedCalls[0]).data!.messages).toEqual([])
    expect(events('MESSAGE_DELETE')).toHaveLength(300)
  })

  it('keeps every row the next read returns in the dedupe, to the microsecond', () => {
    d().changeFloorMicros = 0
    const cursor = { at: '2026-10-08T12:01:00.000500+00:00', id: '00000000-0000-0000-0000-000000000000' }
    d().changeSeen.set('m-edge', '2026-10-08T12:00:30.000200+00:00')
    d().changeSeen.set('m-old', '2026-10-08T12:00:29.999900+00:00')
    const start = d().changeWindowStart(cursor)
    d().pruneChangeSeen(start.micros)

    expect(start.position.at).toBe('2026-10-08T12:00:30.000Z')
    expect([...d().changeSeen.keys()]).toEqual(['m-edge'])
  })
})

describe('reaction removal', () => {
  const EMOJI_ID = '00000000-0000-0000-0000-0000000000f1'
  const BLOBCAT = { id: EMOJI_ID, name: 'blobcat', url: 'https://harmony.test/emoji/blobcat.png' }

  function reaction(id: string, extra: Row): Row {
    return {
      id,
      message_id: 'm1',
      channel_id: GENERAL,
      user_id: OWNER_ID,
      bot_id: null,
      emoji_id: null,
      custom_emoji_content: null,
      metadata: {},
      ...extra,
    }
  }

  const events = (type: string) => sent.filter((s) => s.event.t === type).map((s) => s.event.d)

  beforeEach(() => {
    db.rows('emojis').push(BLOBCAT)
  })

  // A bridge started after the add never saw it; the removal alone must name the emoji and user.
  it('describes a reaction known only from startup by its emoji and user', async () => {
    db.rows('reactions').push(reaction('r1', {
      emoji_id: EMOJI_ID,
      metadata: { source: 'harmony' },
      created_at: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }))
    const d = dispatcher as any
    await d.initializeKnownReactions()
    db.rows('reactions').splice(0)
    await d.pollReactions()

    expect(events('MESSAGE_REACTION_REMOVE')).toEqual([{
      reaction_id: 'r1',
      message_id: 'm1',
      channel_id: GENERAL,
      user_id: OWNER_ID,
      bot_id: null,
      emoji: { id: EMOJI_ID, name: 'blobcat', url: 'https://harmony.test/emoji/blobcat.png', animated: false },
      metadata: { source: 'harmony' },
    }])
  })

  it('describes a removal exactly as its add', async () => {
    const d = dispatcher as any
    db.rows('reactions').push(reaction('r2', {
      custom_emoji_content: '👍',
      created_at: new Date(Date.now() + 1_000).toISOString(),
    }))
    await d.pollReactions()
    db.rows('reactions').splice(0)
    await d.pollReactions()

    const [added] = events('MESSAGE_REACTION_ADD')
    expect(added).toMatchObject({ reaction_id: 'r2', user_id: OWNER_ID, emoji: { id: null, name: '👍', url: null, animated: false } })
    expect(events('MESSAGE_REACTION_REMOVE')).toEqual([added])
  })

  it('carries an animated custom emoji\'s url, and a bridged reaction\'s Discord CDN url', async () => {
    db.rows('emojis').push({ id: '00000000-0000-0000-0000-0000000000f2', name: 'party', url: 'https://harmony.test/emoji/party.gif' })
    const d = dispatcher as any
    await d.handleReactionEvent('MESSAGE_REACTION_ADD', reaction('r4', { emoji_id: '00000000-0000-0000-0000-0000000000f2' }))
    await d.handleReactionEvent('MESSAGE_REACTION_ADD', reaction('r5', {
      user_id: null,
      bot_id: '00000000-0000-0000-0000-0000000000b9',
      custom_emoji_content: 'discord:wave:1234567890',
      metadata: { remote_emoji_url: 'https://cdn.discordapp.com/emojis/1234567890.gif', discord_user: { id: '8' } },
    }))
    await d.handleReactionEvent('MESSAGE_REACTION_ADD', reaction('r6', {
      custom_emoji_content: 'discord:wave:1234567890',
      metadata: { remote_emoji_url: 'https://tracker.example/pixel.gif' },
    }))

    expect(events('MESSAGE_REACTION_ADD').map((e) => e.emoji)).toEqual([
      { id: '00000000-0000-0000-0000-0000000000f2', name: 'party', url: 'https://harmony.test/emoji/party.gif', animated: true },
      { id: null, name: 'discord:wave:1234567890', url: 'https://cdn.discordapp.com/emojis/1234567890.gif', animated: true },
      { id: null, name: 'discord:wave:1234567890', url: null, animated: false },
    ])
  })

  it('dispatches no removal when the presence lookup fails', async () => {
    db.rows('reactions').push(reaction('r3', {
      custom_emoji_content: '👍',
      created_at: new Date(Date.now() - 60_000).toISOString(),
    }))
    const d = dispatcher as any
    await d.initializeKnownReactions()
    let calls = 0
    const from = mocks.from.getMockImplementation()!
    mocks.from.mockImplementation((table: string) => {
      if (table === 'reactions' && ++calls === 2) {
        const failing = new FakeDb({})
        failing.failures.reactions = { message: 'connection reset' }
        return failing.from(table)
      }
      return from(table)
    })
    await d.pollReactions()

    expect(events('MESSAGE_REACTION_REMOVE')).toEqual([])
    mocks.from.mockImplementation(from)
    await d.pollReactions()
    expect(events('MESSAGE_REACTION_REMOVE')).toEqual([])
  })
})

describe('install changes reach the permission cache within the refresh bound', () => {
  const permissionQueries = () => mocks.from.mock.calls.filter(([table]) => table === 'bot_server_permissions').length

  async function deliveredTo(text: string): Promise<string[]> {
    sent = []
    await dispatcher.handleMessageCreate({ new: message(GENERAL, text) })
    return recipients('MESSAGE_CREATE', GENERAL)
  }

  it('stops delivering to a removed bot', async () => {
    expect(await deliveredTo('before')).toEqual([OPEN_BOT])
    const installs = db.rows('bot_server_permissions')
    installs.splice(installs.findIndex((r) => r.bot_id === OPEN_BOT), 1)
    await dispatcher.refreshBotPermissions()

    expect(await deliveredTo('after')).toEqual([])
  })

  it('stops delivering when read_messages is revoked', async () => {
    expect(await deliveredTo('before')).toEqual([OPEN_BOT])
    db.rows('bot_server_permissions').find((r) => r.bot_id === OPEN_BOT)!.read_messages = false
    await dispatcher.refreshBotPermissions()

    expect(await deliveredTo('after')).toEqual([])
  })

  it('applies a narrowed allowed_channel_ids', async () => {
    expect(await deliveredTo('before')).toEqual([OPEN_BOT])
    db.rows('bot_server_permissions').find((r) => r.bot_id === OPEN_BOT)!.allowed_channel_ids = [BRIDGED]
    await dispatcher.refreshBotPermissions()

    expect(await deliveredTo('after')).toEqual([])
  })

  it('picks up a new install', async () => {
    db.rows('bot_server_permissions').splice(0)
    expect(await deliveredTo('before')).toEqual([])
    db.rows('bot_server_permissions').push(installRow(OPEN_BOT))
    await dispatcher.refreshBotPermissions()

    expect(await deliveredTo('after')).toEqual([OPEN_BOT])
  })

  it('keeps the cache through a failed refresh', async () => {
    expect(await deliveredTo('before')).toEqual([OPEN_BOT])
    db.rows('bot_server_permissions').splice(0)
    db.failures.bot_server_permissions = { message: 'connection reset' }
    await dispatcher.refreshBotPermissions()
    delete db.failures.bot_server_permissions

    expect(await deliveredTo('cached')).toEqual([OPEN_BOT])
    await dispatcher.refreshBotPermissions()
    expect(await deliveredTo('refreshed')).toEqual([])
  })

  it('keeps unchanged entries, whatever their column order', async () => {
    const d = dispatcher as any
    const reordered = db.rows('bot_server_permissions').map((r) => Object.fromEntries(Object.entries(r).reverse()))
    d.botPermissionsCache.set(SERVER_ID, reordered)
    await dispatcher.refreshBotPermissions()

    const before = permissionQueries()
    expect(await deliveredTo('cached')).toEqual([OPEN_BOT])
    expect(permissionQueries()).toBe(before)
  })

  it('refreshes every cached server, 100 per query', async () => {
    const d = dispatcher as any
    const servers = Array.from({ length: 250 }, (_, i) => `00000000-0000-0000-0001-${i.toString(16).padStart(12, '0')}`)
    for (const id of servers) d.botPermissionsCache.set(id, [])
    db.rows('bot_server_permissions').push(installRow(OPEN_BOT, { id: 'late', server_id: servers[230] }))

    const before = permissionQueries()
    await dispatcher.refreshBotPermissions()

    expect(permissionQueries() - before).toBe(3)
    expect(d.botPermissionsCache.get(servers[230])).toBeUndefined()
    expect(d.botPermissionsCache.get(servers[0])).toEqual([])
  })

  it('runs on a timer from start() until shutdown()', async () => {
    vi.useFakeTimers()
    try {
      const refresh = vi.spyOn(dispatcher, 'refreshBotPermissions')
      await dispatcher.start()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(refresh).toHaveBeenCalledTimes(1)

      await dispatcher.shutdown()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(refresh).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
