/**
 * botCommandService: P0001 refusals map to typed errors, lists are cached 60 s per channel and
 * thread and dropped on a server bot change, subcommands flatten to their paths, and an
 * instance without the 'bot-commands' capability gets no call.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const capability = vi.hoisted(() => ({ on: true }))
vi.mock('@/services/instanceCapabilities', () => ({
  hasCapability: (name: string) => name === 'bot-commands' && capability.on,
}))

import { supabase } from '@/supabase'
import {
  BotCommandError,
  BotOptionType,
  clearBotCommandCache,
  flattenBotCommands,
  getChannelBotCommands,
  getMyBotInteractions,
  invokeBotCommand,
  toBotCommandError,
  type ChannelBotCommand,
} from '@/services/botCommandService'
import { SERVER_BOT_CHANGE_EVENT } from '@/services/serverBotsService'

const rpc = supabase.rpc as unknown as ReturnType<typeof vi.fn>

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const bot = { id: 'b0000000-0000-4000-8000-000000000001', username: 'weatherbot', display_name: 'Weatherbot', avatar_url: null }

const weather: ChannelBotCommand = {
  id: 'c0000000-0000-4000-8000-000000000001',
  name: 'weather',
  description: 'Forecast',
  options: [{ type: BotOptionType.STRING, name: 'city', description: 'City', required: true }],
  bot,
}

beforeEach(() => {
  capability.on = true
  clearBotCommandCache()
  rpc.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('toBotCommandError', () => {
  it('maps every BOT_COMMAND_* code and its detail', () => {
    const cases: Array<[string, string, Record<string, unknown>]> = [
      ['BOT_COMMAND_UNAVAILABLE', 'unavailable', {}],
      ['BOT_COMMAND_FORBIDDEN', 'forbidden', {}],
      ['BOT_COMMAND_TIMED_OUT', 'timed_out', {}],
      ['BOT_COMMAND_THREAD_LOCKED', 'thread_locked', {}],
      ['BOT_COMMAND_SLOWMODE:12', 'slowmode', { seconds: 12 }],
      ['BOT_COMMAND_RATE_LIMITED:7', 'rate_limited', { seconds: 7 }],
      ['BOT_COMMAND_INVALID_OPTION:都市', 'invalid_option', { option: '都市' }],
      ['BOT_COMMAND_BOT_OFFLINE', 'bot_offline', {}],
    ]
    for (const [message, code, detail] of cases) {
      const error = toBotCommandError({ code: 'P0001', message })
      expect(error).toBeInstanceOf(BotCommandError)
      expect(error.code).toBe(code)
      expect(error).toMatchObject(detail)
    }
  })

  it('reads the code anywhere in the message; anything else is failed', () => {
    expect(toBotCommandError({ message: 'ERROR: BOT_COMMAND_SLOWMODE:3' }).seconds).toBe(3)
    expect(toBotCommandError({ message: 'permission denied for function invoke_bot_command' }).code).toBe('failed')
    expect(toBotCommandError(new Error('network')).code).toBe('failed')
    expect(toBotCommandError({ message: 'BOT_COMMAND_FORBIDDEN' }).seconds).toBeNull()
  })
})

describe('invokeBotCommand', () => {
  it('passes the contract arguments and returns the row timers', async () => {
    rpc.mockResolvedValueOnce({ data: { id: 'i-1', respond_in_ms: 5000, expires_in_ms: 900000 }, error: null })
    const result = await invokeBotCommand({
      channelId: CHANNEL, threadId: THREAD, commandId: weather.id, path: ['now'], options: { city: 'Tokyo' },
    })
    expect(result).toEqual({ id: 'i-1', respond_in_ms: 5000, expires_in_ms: 900000 })
    expect(rpc).toHaveBeenCalledWith('invoke_bot_command', {
      p_channel_id: CHANNEL, p_thread_id: THREAD, p_command_id: weather.id, p_path: ['now'], p_options: { city: 'Tokyo' },
    })
  })

  it('throws the typed refusal', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { code: 'P0001', message: 'BOT_COMMAND_RATE_LIMITED:9' } })
    await expect(invokeBotCommand({ channelId: CHANNEL, threadId: null, commandId: weather.id, path: [], options: {} }))
      .rejects.toMatchObject({ code: 'rate_limited', seconds: 9 })
  })

  it('makes no call without the capability', async () => {
    capability.on = false
    await expect(invokeBotCommand({ channelId: CHANNEL, threadId: null, commandId: weather.id, path: [], options: {} }))
      .rejects.toMatchObject({ code: 'unavailable' })
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('getChannelBotCommands', () => {
  it('caches per channel and thread for 60 s', async () => {
    vi.useFakeTimers()
    rpc.mockResolvedValue({ data: [weather], error: null })
    expect(await getChannelBotCommands(CHANNEL, null)).toEqual([weather])
    expect(await getChannelBotCommands(CHANNEL, null)).toEqual([weather])
    expect(rpc).toHaveBeenCalledTimes(1)
    expect(rpc).toHaveBeenCalledWith('get_channel_bot_commands', { p_channel_id: CHANNEL, p_thread_id: null })

    await getChannelBotCommands(CHANNEL, THREAD)
    expect(rpc).toHaveBeenCalledTimes(2)
    expect(rpc).toHaveBeenLastCalledWith('get_channel_bot_commands', { p_channel_id: CHANNEL, p_thread_id: THREAD })

    vi.advanceTimersByTime(59_000)
    await getChannelBotCommands(CHANNEL, null)
    expect(rpc).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(2_000)
    await getChannelBotCommands(CHANNEL, null)
    expect(rpc).toHaveBeenCalledTimes(3)
  })

  it('shares one request between concurrent callers', async () => {
    let answer!: (value: unknown) => void
    rpc.mockReturnValueOnce(new Promise((resolve) => { answer = resolve }))
    const a = getChannelBotCommands(CHANNEL, null)
    const b = getChannelBotCommands(CHANNEL, null)
    answer({ data: [weather], error: null })
    expect(await a).toEqual([weather])
    expect(await b).toEqual([weather])
    expect(rpc).toHaveBeenCalledTimes(1)
  })

  it('drops the cache on a server bot change', async () => {
    rpc.mockResolvedValue({ data: [weather], error: null })
    await getChannelBotCommands(CHANNEL, null)
    window.dispatchEvent(new CustomEvent(SERVER_BOT_CHANGE_EVENT, { detail: { server_id: 's', bot_id: bot.id } }))
    await getChannelBotCommands(CHANNEL, null)
    expect(rpc).toHaveBeenCalledTimes(2)
  })

  it('reads as empty on an error, uncached', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect(await getChannelBotCommands(CHANNEL, null)).toEqual([])
    rpc.mockResolvedValueOnce({ data: [weather], error: null })
    expect(await getChannelBotCommands(CHANNEL, null)).toEqual([weather])
  })

  it('makes no call without the capability', async () => {
    capability.on = false
    expect(await getChannelBotCommands(CHANNEL, null)).toEqual([])
    expect(await getMyBotInteractions(['i-1'])).toEqual([])
    expect(rpc).not.toHaveBeenCalled()
  })
})

describe('getMyBotInteractions', () => {
  it('reads in pages of 50 and is null on an error', async () => {
    const ids = Array.from({ length: 60 }, (_, i) => `i-${i}`)
    rpc.mockResolvedValueOnce({ data: [{ id: 'i-0' }], error: null }).mockResolvedValueOnce({ data: [{ id: 'i-55' }], error: null })
    const rows = await getMyBotInteractions(ids)
    expect(rows?.map((r) => r.id)).toEqual(['i-0', 'i-55'])
    expect(rpc.mock.calls[0]).toEqual(['get_my_bot_interactions', { p_ids: ids.slice(0, 50) }])
    expect(rpc.mock.calls[1]).toEqual(['get_my_bot_interactions', { p_ids: ids.slice(50) }])

    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect(await getMyBotInteractions(['i-1'])).toBeNull()
  })
})

describe('flattenBotCommands', () => {
  it('lists a command, its subcommands and its grouped subcommands by path', () => {
    const bridge: ChannelBotCommand = {
      id: 'c2', name: 'bridge', description: 'Bridge tools', bot,
      options: [
        { type: BotOptionType.SUB_COMMAND, name: 'clone-server', description: 'Copy a server', options: [
          { type: BotOptionType.STRING, name: 'guild', required: true },
        ] },
        { type: BotOptionType.SUB_COMMAND_GROUP, name: 'link', description: 'Links', options: [
          { type: BotOptionType.SUB_COMMAND, name: 'add', options: [{ type: BotOptionType.CHANNEL, name: 'channel' }] },
          { type: BotOptionType.SUB_COMMAND, name: 'remove', description: 'Remove a link' },
        ] },
      ],
    }
    const flat = flattenBotCommands([weather, bridge])
    expect(flat.map((f) => [f.fullName, f.path, f.options.map((o) => o.name), f.description])).toEqual([
      ['weather', [], ['city'], 'Forecast'],
      ['bridge clone-server', ['clone-server'], ['guild'], 'Copy a server'],
      ['bridge link add', ['link', 'add'], ['channel'], 'Links'],
      ['bridge link remove', ['link', 'remove'], [], 'Remove a link'],
    ])
  })
})
