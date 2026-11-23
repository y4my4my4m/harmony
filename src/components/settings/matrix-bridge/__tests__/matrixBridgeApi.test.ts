/** matrixBridgeApi.ts: RPC names, arguments and the shapes accepted back. */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  configureMatrixBridge,
  fetchOwnedBotInstalls,
  fetchServerMatrixBridges,
  matrixBotBlock,
  matrixBridgeErrorKey,
  setMatrixBridgeSenderMode,
  unconfigureMatrixBridge,
  type MatrixBotInstall,
} from '../matrixBridgeApi'

const rpc = vi.mocked(supabase.rpc)
const from = vi.mocked(supabase.from)
const pair = {
  bot_id: 'bot', bot_display_name: 'Matrix Bridge', channel_id: 'channel', channel_name: 'general',
  room_id: '!room:hs', sender_mode: 'ghost', active: true,
}

/** A supabase-js query chain that records its calls and answers `result` per table. */
function chain(results: Record<string, { data: unknown; error: unknown }>) {
  const calls: { table: string; ops: [string, ...unknown[]][] }[] = []
  from.mockImplementation(((table: string) => {
    const call = { table, ops: [] as [string, ...unknown[]][] }
    calls.push(call)
    const builder: Record<string, unknown> = {}
    for (const op of ['select', 'eq', 'in']) {
      builder[op] = (...args: unknown[]) => { call.ops.push([op, ...args]); return builder }
    }
    builder.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(results[table] ?? { data: [], error: null }).then(resolve, reject)
    return builder
  }) as never)
  return calls
}

beforeEach(() => { rpc.mockReset(); from.mockReset() })

describe('matrixBridgeApi', () => {
  it('lists pairs and keeps only their known fields', async () => {
    rpc.mockResolvedValueOnce({ data: [{ ...pair, bot_username: 'mx', sender_mode_set_by_manager: true, extra: 'x' }], error: null } as never)
    expect(await fetchServerMatrixBridges('s1')).toEqual([pair])
    expect(rpc).toHaveBeenCalledWith('get_server_matrix_bridges', { p_server_id: 's1' })
  })

  it.each([
    null,
    {},
    [{ ...pair, room_id: '' }],
    [{ ...pair, bot_id: '' }],
    [{ ...pair, bot_display_name: '' }],
    [{ ...pair, sender_mode: 'both' }],
    [{ ...pair, active: undefined }],
    [{ ...pair, active: 'true' }],
  ])('refuses the listing %j', async (data) => {
    rpc.mockResolvedValueOnce({ data, error: null } as never)
    await expect(fetchServerMatrixBridges('s1')).rejects.toThrow()
  })

  it('takes the saved pair only for the bot and channel it changed', async () => {
    rpc.mockResolvedValueOnce({ data: pair, error: null } as never)
    expect(await setMatrixBridgeSenderMode('bot', 'channel', 'ghost')).toEqual(pair)
    expect(rpc).toHaveBeenCalledWith('set_matrix_bridge_sender_mode', { p_bot_id: 'bot', p_channel_id: 'channel', p_sender_mode: 'ghost' })
    rpc.mockResolvedValueOnce({ data: { ...pair, channel_id: 'other' }, error: null } as never)
    await expect(setMatrixBridgeSenderMode('bot', 'channel', 'ghost')).rejects.toThrow()
  })

  it('configures and unconfigures a bot on a server', async () => {
    rpc.mockResolvedValueOnce({ data: true, error: null } as never)
    expect(await configureMatrixBridge('bot', 's1', ['c1', 'c2'])).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('configure_matrix_bridge', { p_bot_id: 'bot', p_server_id: 's1', p_channel_ids: ['c1', 'c2'] })
    rpc.mockResolvedValueOnce({ data: true, error: null } as never)
    expect(await unconfigureMatrixBridge('bot', 's1')).toBe(true)
    expect(rpc).toHaveBeenLastCalledWith('unconfigure_matrix_bridge', { p_bot_id: 'bot', p_server_id: 's1' })
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'MANAGE_SERVER required', code: '42501' } } as never)
    await expect(unconfigureMatrixBridge('bot', 's1')).rejects.toMatchObject({ code: '42501' })
  })
})

describe('fetchOwnedBotInstalls', () => {
  const install = (botId: string, fields: Record<string, unknown> = {}, bot: Record<string, unknown> = {}) => ({
    bot_id: botId, is_active: true, read_messages: true, send_messages: true, allowed_channel_ids: ['c1'],
    bot: { id: botId, username: `u_${botId}`, display_name: `Bot ${botId}`, owner_id: 'me', is_active: true, ...bot },
    ...fields,
  })

  it('reads the caller\'s installs in the server and leaves out Discord bridge bots', async () => {
    const calls = chain({
      bot_server_permissions: {
        data: [
          install('b2', { allowed_channel_ids: null, read_messages: false }, { display_name: null }),
          install('b1'),
          install('dc'),
          install('theirs', {}, { owner_id: 'someone' }),
        ],
        error: null,
      },
      discord_bridges: { data: [{ bot_id: 'dc' }], error: null },
    })
    expect(await fetchOwnedBotInstalls('s1', 'me')).toEqual([
      { bot_id: 'b1', bot_display_name: 'Bot b1', bot_active: true, install_active: true, read_send: true, allowed_channel_ids: ['c1'] },
      { bot_id: 'b2', bot_display_name: 'u_b2', bot_active: true, install_active: true, read_send: false, allowed_channel_ids: null },
    ])
    expect(calls[0].table).toBe('bot_server_permissions')
    expect(calls[0].ops).toEqual([
      ['select', 'bot_id, is_active, read_messages, send_messages, allowed_channel_ids, bot:bots!inner(id, username, display_name, owner_id, is_active)'],
      ['eq', 'server_id', 's1'],
      ['eq', 'bot.owner_id', 'me'],
    ])
    expect(calls[1]).toEqual({ table: 'discord_bridges', ops: [['select', 'bot_id'], ['in', 'bot_id', ['b2', 'b1', 'dc']]] })
  })

  it('asks nothing more when the caller has no bot in the server', async () => {
    const calls = chain({ bot_server_permissions: { data: [], error: null } })
    expect(await fetchOwnedBotInstalls('s1', 'me')).toEqual([])
    expect(calls).toHaveLength(1)
  })

  it.each([
    [{ bot_server_permissions: { data: null, error: { message: 'denied' } } }],
    [{ bot_server_permissions: { data: [install('b1', { allowed_channel_ids: [''] })], error: null } }],
    [{ bot_server_permissions: { data: [install('b1')], error: null }, discord_bridges: { data: null, error: { message: 'denied' } } }],
  ])('fails rather than guess: %j', async (results) => {
    chain(results)
    await expect(fetchOwnedBotInstalls('s1', 'me')).rejects.toBeTruthy()
  })
})

describe('matrixBotBlock', () => {
  const ok: MatrixBotInstall = {
    bot_id: 'b', bot_display_name: 'B', bot_active: true, install_active: true, read_send: true, allowed_channel_ids: ['c1', 'voice'],
  }

  it('names the first check configure_matrix_bridge would fail', () => {
    expect(matrixBotBlock(ok, ['c1', 'c2'])).toBeNull()
    expect(matrixBotBlock({ ...ok, bot_active: false, install_active: false }, ['c1'])).toBe('bot_inactive')
    expect(matrixBotBlock({ ...ok, install_active: false, read_send: false }, ['c1'])).toBe('install_inactive')
    expect(matrixBotBlock({ ...ok, read_send: false, allowed_channel_ids: null }, ['c1'])).toBe('read_send')
    expect(matrixBotBlock({ ...ok, allowed_channel_ids: null }, ['c1'])).toBe('all_channels')
    // An allowlist of a voice channel only holds no text channel.
    expect(matrixBotBlock({ ...ok, allowed_channel_ids: ['voice'] }, ['c1', 'c2'])).toBe('no_channels')
  })
})

describe('matrixBridgeErrorKey', () => {
  it.each([
    [{ code: '22023', message: 'A Discord bridge bot cannot bridge Matrix' }, 'discordBot'],
    [{ code: '22023', message: 'Channels must be text channels of the server in the install allowlist' }, 'allowlist'],
    [{ code: '42501', message: 'Active scoped read and send install required' }, 'install'],
    [{ code: '22023', message: 'Active bot required' }, 'install'],
    [{ code: '42501', message: 'Only the bot\'s owner configures its Matrix bridge' }, 'permission'],
    [{ code: '42501', message: 'MANAGE_SERVER required' }, 'permission'],
    [new Error('fetch failed'), 'save'],
    [null, 'save'],
  ])('%j → %s', (error, key) => {
    expect(matrixBridgeErrorKey(error)).toBe(key)
  })
})
