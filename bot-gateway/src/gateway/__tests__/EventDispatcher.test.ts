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

import { EventDispatcher } from '../EventDispatcher.js'

let db: FakeDb
let sent: Array<{ botIds: string[]; event: any }>
let dispatcher: EventDispatcher

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

describe('MESSAGE_DELETE', () => {
  const BRIDGE_METADATA = { discord_message_id: '1300000000000000001', bridge_source: 'discord', discord_user: { id: '8' } }

  const deletes = () => sent.filter((s) => s.event.t === 'MESSAGE_DELETE').map((s) => s.event.d)

  function track(id: string) {
    const d = dispatcher as any
    d.knownMessageIds.add(id)
    d.messageVersions.set(id, { updated_at: 't', content: [], channel_id: GENERAL, metadata: BRIDGE_METADATA })
  }

  it('carries the message metadata for a soft delete', async () => {
    track('m-soft')
    db.rows('messages').push({ ...message(GENERAL, 'gone'), id: 'm-soft', metadata: BRIDGE_METADATA, is_deleted: true })
    await (dispatcher as any).pollEditsAndDeletes()

    expect(deletes()).toEqual([{ id: 'm-soft', channel_id: GENERAL, metadata: BRIDGE_METADATA }])
  })

  it('carries the last known metadata for a hard delete', async () => {
    track('m-hard')
    await (dispatcher as any).pollEditsAndDeletes()

    expect(deletes()).toEqual([{ id: 'm-hard', channel_id: GENERAL, metadata: BRIDGE_METADATA }])
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
