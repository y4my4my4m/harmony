/**
 * '/' lists the built-ins, then the commands of the server's bots for the channel or thread:
 * subcommands flat, names in any script. Never in DMs, draft threads or message edits, and
 * never on an instance without the capability. A bot command named like a built-in is its own
 * item: picking it opens the bot's options, not the built-in.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises } from '@vue/test-utils'
import { effectScope, ref } from 'vue'
import type { Ref } from 'vue'

const capability = vi.hoisted(() => ({ on: true }))
vi.mock('@/services/instanceCapabilities', () => ({
  hasCapability: (name: string) => name === 'bot-commands' && capability.on,
}))

vi.mock('@/stores/useEmojiCache', () => ({
  useEmojiCacheStore: () => ({ resolvedEmojis: {}, isInitialized: true, serverCaches: new Map() }),
}))
vi.mock('@/stores/useServerChannel', () => ({
  useServerChannelStore: () => ({ currentServerId: 'server-1', currentChannelId: 'channel-1', servers: [], channels: [] }),
}))
vi.mock('@/stores/useInstanceSettings', () => ({
  useInstanceSettingsStore: () => ({ gifClipsEnabled: true, gifMemesEnabled: true, gifAiEmojisEnabled: true, settings: {} }),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: { getUsersInContext: () => [], getAllUsers: () => [] },
}))
vi.mock('@/services/activityPubService', () => ({ activityPubService: { searchUsers: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/services/RoleService', () => ({ roleService: { getRolesForServer: vi.fn().mockResolvedValue([]) } }))
vi.mock('@/composables/useChannelMessagePermissions', () => ({
  useChannelMessagePermissions: () => ({ canMentionEveryone: ref(false) }),
}))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    hasCurrentUserPermission: () => false,
    Permission: { KICK_MEMBERS: 'KICK_MEMBERS', BAN_MEMBERS: 'BAN_MEMBERS' },
    isCurrentUserServerOwner: ref(false),
  }),
}))
vi.mock('@/composables/useEmojiLoader', () => ({ ensureEmojiDataLoaded: vi.fn().mockResolvedValue(undefined) }))
vi.mock('@/services/unifiedEmojiService', () => ({
  useUnifiedEmoji: () => ({ isLoaded: ref(false), isNativePack: ref(true), getTwemojiUrl: () => null, searchEmojiHits: () => [] }),
}))
vi.mock('@/services/bridgedChannelUsersService', () => ({
  clearBridgedUsersCache: vi.fn(),
  fetchBridgedChannelUsers: vi.fn().mockResolvedValue({ users: [] }),
}))

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => {
  const builder: any = new Proxy(() => builder, {
    get: (_target, prop) =>
      prop === 'then'
        ? (resolve: (value: unknown) => void) => resolve({ data: [], error: null })
        : prop === 'rpc' ? rpc : builder,
    apply: () => builder,
  })
  return { supabase: builder }
})

import { useAutoSuggest, type BotCommandTarget } from '../useAutoSuggest'
import { clearBotCommandCache } from '@/services/botCommandService'

const CHANNEL = '11111111-1111-4111-8111-111111111111'
const THREAD = '22222222-2222-4222-8222-222222222222'
const weatherbot = { id: 'b0000000-0000-4000-8000-000000000001', username: 'weatherbot', display_name: 'Weatherbot', avatar_url: 'https://cdn.test/w.png' }
const giphybot = { id: 'b0000000-0000-4000-8000-000000000002', username: 'giphy', display_name: null, avatar_url: null }

const COMMANDS = [
  { id: 'c1', name: 'weather', description: 'Forecast', options: [{ type: 3, name: 'city', required: true }], bot: weatherbot },
  { id: 'c2', name: '天気', description: '天気予報', options: [], bot: weatherbot },
  { id: 'c3', name: 'gif', description: 'A bot GIF', options: [{ type: 3, name: 'tag' }], bot: giphybot },
  {
    id: 'c4', name: 'bridge', description: 'Bridge', bot: weatherbot,
    options: [{ type: 1, name: 'clone-server', description: 'Copy a server', options: [{ type: 3, name: 'guild', required: true }] }],
  },
]

function setup(target: BotCommandTarget | null, extra: Record<string, unknown> = {}) {
  const text = ref('')
  const auto = effectScope().run(() => useAutoSuggest(
    ref(null) as Ref<any>,
    () => text.value,
    (next: string) => { text.value = next },
    { mode: 'chat', botCommandTarget: () => target, ...extra },
  ))!
  const type = async (value: string) => {
    text.value = value
    auto.handleInput(value, value.length)
    await flushPromises()
  }
  return { auto, text, type }
}

describe('useAutoSuggest bot commands', () => {
  let events: string[]
  const onCommand = (e: Event) => events.push((e as CustomEvent).detail.command)

  beforeEach(() => {
    setActivePinia(createPinia())
    capability.on = true
    clearBotCommandCache()
    rpc.mockReset()
    rpc.mockResolvedValue({ data: COMMANDS, error: null })
    events = []
    window.addEventListener('harmony-command', onCommand)
  })

  afterEach(() => {
    window.removeEventListener('harmony-command', onCommand)
  })

  it('lists bot commands after the built-ins, subcommands flat, each with its bot', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/')
    const items = auto.suggestions.value
    const builtIn = items.filter((s) => !s.isBotCommand).map((s) => s.name)
    const bots = items.filter((s) => s.isBotCommand)
    expect(builtIn).toContain('gif')
    expect(items.findIndex((s) => s.isBotCommand)).toBe(builtIn.length)
    expect(bots.map((s) => s.name)).toEqual(['weather', '天気', 'gif', 'bridge clone-server'])
    expect(bots[0]).toMatchObject({
      id: 'botcmd:c1:',
      display_name: '/weather',
      description: 'Forecast',
      botName: 'Weatherbot',
      botId: weatherbot.id,
      avatar: 'https://cdn.test/w.png',
    })
    expect(bots[2]).toMatchObject({ botName: 'giphy', avatar: '/default_avatar.webp' })
    expect(bots[3].id).toBe('botcmd:c4:clone-server')
    expect(rpc).toHaveBeenCalledWith('get_channel_bot_commands', { p_channel_id: CHANNEL, p_thread_id: null })
  })

  it('matches names in any script', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/天')
    expect(auto.state.value.triggerType).toBe('command')
    expect(auto.suggestions.value.map((s) => s.name)).toEqual(['天気'])
    await type('/brid')
    expect(auto.suggestions.value.map((s) => s.name)).toEqual(['bridge clone-server'])
  })

  it('asks for the thread in a thread', async () => {
    const { type } = setup({ channelId: CHANNEL, threadId: THREAD })
    await type('/')
    expect(rpc).toHaveBeenCalledWith('get_channel_bot_commands', { p_channel_id: CHANNEL, p_thread_id: THREAD })
  })

  it('offers none in a DM, a draft thread or an optimistic thread', async () => {
    for (const target of [null, { channelId: CHANNEL, threadId: 'draft:33333333-3333-4333-8333-333333333333' }, { channelId: CHANNEL, threadId: 'optimistic-thread-1' }]) {
      const { auto, type } = setup(target)
      await type('/')
      expect(auto.suggestions.value.some((s) => s.isBotCommand)).toBe(false)
    }
    expect(rpc).not.toHaveBeenCalled()
  })

  it('offers none in a message edit: commands are off there', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null }, { enableCommands: false })
    await type('/')
    expect(auto.state.value.isActive).toBe(false)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('makes no call without the capability', async () => {
    capability.on = false
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/')
    expect(auto.suggestions.value.some((s) => s.isBotCommand)).toBe(false)
    expect(auto.suggestions.value.length).toBeGreaterThan(0)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('a bot /gif opens its options, never the built-in GIF search', async () => {
    const { auto, text, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/gif')
    const both = auto.suggestions.value.filter((s) => s.name === 'gif')
    expect(both).toHaveLength(2)
    const botGif = both.find((s) => s.isBotCommand)!
    auto.selectSuggestion(botGif)
    expect(auto.activeCommand.value).toBeNull()
    expect(events).toEqual([])
    expect(text.value).toBe('')
    expect(auto.activeBotCommand.value).toMatchObject({
      fullName: 'gif',
      path: [],
      channelId: CHANNEL,
      threadId: null,
      bot: giphybot,
      options: [{ type: 3, name: 'tag' }],
    })
    expect(auto.activeBotCommand.value!.command.id).toBe('c3')

    auto.dismissBotCommand()
    expect(auto.activeBotCommand.value).toBeNull()
  })

  it('the built-in /gif keeps its own handling beside a bot /gif', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/gif')
    const builtIn = auto.suggestions.value.find((s) => s.name === 'gif' && !s.isBotCommand)!
    auto.selectSuggestion(builtIn)
    expect(auto.activeCommand.value?.name).toBe('gif')
    expect(auto.activeBotCommand.value).toBeNull()
  })

  it('a subcommand carries its path and leaf options', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: THREAD })
    await type('/bridge')
    auto.selectSuggestion(auto.suggestions.value.find((s) => s.isBotCommand)!)
    expect(auto.activeBotCommand.value).toMatchObject({
      fullName: 'bridge clone-server',
      path: ['clone-server'],
      threadId: THREAD,
      options: [{ name: 'guild', required: true }],
    })
  })

  it('names the list header through i18n', async () => {
    const { auto, type } = setup({ channelId: CHANNEL, threadId: null })
    await type('/')
    expect(auto.headerText.value).toBe('bots.commands.header')
  })
})
