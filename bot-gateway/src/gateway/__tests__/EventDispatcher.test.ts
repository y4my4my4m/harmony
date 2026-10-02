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
