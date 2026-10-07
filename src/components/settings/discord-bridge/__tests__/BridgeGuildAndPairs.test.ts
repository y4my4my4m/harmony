/**
 * BridgeGuildPicker.vue, BridgeChannelPairs.vue and BridgeSettingsPanel.vue: guild auto
 * pick and choice, pair add / remove / validation / same-name helper, and the settings
 * toggles with their RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeGuildPicker from '../BridgeGuildPicker.vue'
import BridgeChannelPairs from '../BridgeChannelPairs.vue'
import BridgeSettingsPanel from '../BridgeSettingsPanel.vue'
import {
  GUILD_ID,
  HARMONY_CHANNELS,
  SNAPSHOT,
  healthyBridge,
  iconStub,
  installBackend,
  makeI18n,
  makePair,
  missingKeys,
  rpcCalls,
} from './bridgeTestKit'
import { DEFAULT_BRIDGE_SETTINGS } from '@/utils/discordBridgeSetup'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub } })

beforeEach(() => {
  missingKeys.length = 0
  Object.values(toast).forEach((fn) => fn.mockReset())
  installBackend({}, () => null)
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

const TWO_GUILDS = {
  guilds: [...SNAPSHOT.guilds, { id: '901', name: 'Back Room', icon: null, channels: [] }],
}

describe('BridgeGuildPicker', () => {
  it('picks the only guild by itself', async () => {
    const w = mount(BridgeGuildPicker, { props: { bridge: healthyBridge(), pairCount: 0 }, global: global() })
    await flushPromises()
    expect(rpcCalls('discord_bridge_set_guild')).toEqual([{ p_bridge_id: 'b1', p_guild_id: GUILD_ID }])
    expect(w.find('[data-testid="guild-single"]').text()).toContain('Town Square')
    expect(w.text()).toContain("It's the only Discord server your bot is in")
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('does not re-pick a guild that is already chosen', async () => {
    const w = mount(BridgeGuildPicker, { props: { bridge: healthyBridge({ discord_guild_id: GUILD_ID }), pairCount: 0 }, global: global() })
    await flushPromises()
    expect(rpcCalls('discord_bridge_set_guild')).toEqual([])
    expect(w.find('[data-testid="guild-single"]').text()).toBe('Bridging the Discord server Town Square.')
  })

  it('lets the admin choose among several guilds', async () => {
    const w = mount(BridgeGuildPicker, { props: { bridge: healthyBridge({ snapshot: TWO_GUILDS }), pairCount: 0 }, global: global() })
    await flushPromises()
    expect(rpcCalls('discord_bridge_set_guild')).toEqual([])
    expect(w.find('legend').text()).toContain('several Discord servers')
    expect(w.find('[data-testid="guild-save"]').attributes('disabled')).toBeDefined()
    await w.find('[data-testid="guild-901"] input').setValue(true)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(rpcCalls('discord_bridge_set_guild')).toEqual([{ p_bridge_id: 'b1', p_guild_id: '901' }])
  })

  it('sends the admin to invite the bot when it is in no guild', async () => {
    const w = mount(BridgeGuildPicker, { props: { bridge: healthyBridge({ snapshot: { guilds: [] } }), pairCount: 0 }, global: global() })
    await flushPromises()
    expect(w.find('[data-testid="guild-none"]').text()).toContain('Invite it, then come back')
    expect(w.find('a').attributes('href')).toContain('discord.com/oauth2/authorize')
  })

  it('locks the guild while pairs exist', async () => {
    const w = mount(BridgeGuildPicker, {
      props: { bridge: healthyBridge({ snapshot: TWO_GUILDS, discord_guild_id: GUILD_ID }), pairCount: 2 },
      global: global(),
    })
    await flushPromises()
    expect(w.find('[data-testid="guild-locked"]').text()).toContain('Town Square')
    expect(w.text()).toContain('remove all channel pairs first')
    expect(w.find('input[type="radio"]').exists()).toBe(false)
  })

  it('explains a refused choice', async () => {
    installBackend({}, () => {
      throw new Error('guild not in snapshot')
    })
    const w = mount(BridgeGuildPicker, { props: { bridge: healthyBridge(), pairCount: 0 }, global: global() })
    await flushPromises()
    expect(w.text()).toContain("Couldn't choose that Discord server.")
    expect(w.find('button').text()).toBe('Try again')
  })
})

describe('BridgeChannelPairs', () => {
  const bridge = () => healthyBridge({ discord_guild_id: GUILD_ID })

  function mountPairs(pairs = [makePair()]) {
    return mount(BridgeChannelPairs, { props: { bridge: bridge(), pairs, harmonyChannels: HARMONY_CHANNELS }, global: global() })
  }

  it('lists pairs with direction and health', () => {
    const w = mountPairs([makePair(), makePair({ id: 'p2', harmony_channel_id: 'h-news', discord_channel_id: '13', discord_channel_name: 'announcements', direction: 'to_discord' })])
    const rows = w.findAll('[data-testid="pair-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('#general')
    expect(rows[0].text()).toContain('Both ways')
    expect(rows[0].text()).toContain('Working')
    expect(rows[1].text()).toContain('Harmony → Discord only')
    expect(rows[1].text()).toContain('No webhook permission')
    expect(rows[1].text()).toContain('allow Manage Webhooks for the bot in the permissions of #announcements')
  })

  it('flags a pair whose Discord channel vanished from the snapshot', () => {
    const w = mountPairs([makePair({ discord_channel_id: '999', discord_channel_name: 'old-chat' })])
    expect(w.find('[data-testid="pair-row"]').text()).toContain('Discord channel not found')
    expect(w.find('[data-testid="pair-row"]').text()).toContain('#old-chat')
  })

  it('hides channels already paired from both dropdowns and groups by category', () => {
    const w = mountPairs()
    const harmonyOptions = w.findAll('[data-testid="select-harmony"] option').map((o) => o.text())
    expect(harmonyOptions).toEqual(['Choose…', '#news', '#memes'])
    expect(w.find('[data-testid="select-harmony"] optgroup').attributes('label')).toBe('Community')
    const discordOptions = w.findAll('[data-testid="select-discord"] option').map((o) => o.text())
    expect(discordOptions).toEqual(['Choose…', '#announcements (No webhook permission)', "#secret (Bot can't see it)", '#memes'])
  })

  it('adds a pair through discord_bridge_pair', async () => {
    const w = mountPairs([])
    await w.find('[data-testid="select-harmony"]').setValue('h-memes')
    await w.find('[data-testid="select-discord"]').setValue('14')
    await w.find('[data-testid="select-direction"]').setValue('to_harmony')
    await w.find('[data-testid="pair-form"]').trigger('submit')
    await flushPromises()
    expect(rpcCalls('discord_bridge_pair')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_id: 'h-memes', p_discord_channel_id: '14', p_direction: 'to_harmony' },
    ])
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('requires both channels', async () => {
    const w = mountPairs([])
    await w.find('[data-testid="select-harmony"]').setValue('h-memes')
    await w.find('[data-testid="pair-form"]').trigger('submit')
    expect(w.find('[data-testid="pair-error"]').text()).toBe('Choose a Harmony channel and a Discord channel.')
    expect(rpcCalls('discord_bridge_pair')).toEqual([])
  })

  it('refuses a Discord channel the bot cannot see and says how to fix it', async () => {
    const w = mountPairs([])
    await w.find('[data-testid="select-harmony"]').setValue('h-memes')
    await w.find('[data-testid="select-discord"]').setValue('12')
    expect(w.find('[data-testid="pair-issues"]').text()).toContain('Edit Channel → Permissions')
    await w.find('[data-testid="pair-form"]').trigger('submit')
    expect(w.find('[data-testid="pair-error"]').text()).toContain("The bot can't use #secret yet.")
    expect(rpcCalls('discord_bridge_pair')).toEqual([])
  })

  it('allows a channel without webhook permission, with a warning', async () => {
    const w = mountPairs([])
    await w.find('[data-testid="select-harmony"]').setValue('h-news')
    await w.find('[data-testid="select-discord"]').setValue('13')
    expect(w.find('[data-testid="pair-issues"] .warning').exists()).toBe(true)
    await w.find('[data-testid="pair-form"]').trigger('submit')
    await flushPromises()
    expect(rpcCalls('discord_bridge_pair')).toHaveLength(1)
  })

  it('removes a pair through discord_bridge_unpair', async () => {
    const w = mountPairs()
    const remove = w.find('[data-testid="pair-remove"]')
    expect(remove.attributes('aria-label')).toBe('Remove the pair #general and #general')
    await remove.trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_unpair')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_id: 'h-general' }])
  })

  it('pairs every channel with a matching name at once', async () => {
    const w = mountPairs([])
    const box = w.find('[data-testid="name-matches"]')
    expect(box.text()).toContain('#general ⇄ #general')
    expect(box.text()).toContain('#memes ⇄ #memes')
    await w.find('[data-testid="pair-matches"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_pair').map((a) => [a.p_harmony_channel_id, a.p_discord_channel_id, a.p_direction])).toEqual([
      ['h-general', '11', 'both'],
      ['h-memes', '14', 'both'],
    ])
    expect(toast.success).toHaveBeenCalledWith('Paired 2 channels')
  })

  it('explains how to pair from Discord', () => {
    const w = mountPairs()
    expect(w.text()).toContain('/bridge link')
    expect(w.text()).toContain('Copy channel ID')
  })

  it('asks for a guild before showing channels', () => {
    const w = mount(BridgeChannelPairs, {
      props: { bridge: healthyBridge(), pairs: [], harmonyChannels: HARMONY_CHANNELS },
      global: global(),
    })
    expect(w.text()).toContain('Choose the Discord server to bridge first.')
    expect(w.find('[data-testid="pair-form"]').exists()).toBe(false)
  })
})

describe('BridgeSettingsPanel', () => {
  it('saves every whitelisted key when one toggle changes', async () => {
    const w = mount(BridgeSettingsPanel, { props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS } }, global: global() })
    const presence = w.find('[data-testid="setting-sync_presence"] [role="switch"]')
    expect(presence.attributes('aria-checked')).toBe('false')
    expect(w.find('[data-testid="setting-sync_presence"]').text()).toContain('Off by default')
    await presence.trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_update_settings')).toEqual([
      { p_bridge_id: 'b1', p_settings: { ...DEFAULT_BRIDGE_SETTINGS, sync_presence: true } },
    ])
    expect(w.find('[data-testid="setting-sync_presence"]').text()).toContain('Needs the Presence Intent')
    expect(w.emitted('changed')?.[0]).toEqual([{ ...DEFAULT_BRIDGE_SETTINGS, sync_presence: true }])
  })

  it('labels each switch', () => {
    const w = mount(BridgeSettingsPanel, { props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS } }, global: global() })
    for (const sw of w.findAll('[role="switch"]')) {
      const label = w.find(`#${sw.attributes('aria-labelledby')!.replace(/:/g, '\\:')}`)
      expect(label.text().length).toBeGreaterThan(0)
    }
    expect(w.findAll('[role="switch"]')).toHaveLength(5)
  })

  it('reverts and reports a failed save', async () => {
    installBackend({}, () => {
      throw new Error('nope')
    })
    const w = mount(BridgeSettingsPanel, { props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS } }, global: global() })
    const edits = w.find('[data-testid="setting-sync_edits"] [role="switch"]')
    await edits.trigger('click')
    await flushPromises()
    expect(edits.attributes('aria-checked')).toBe('true')
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the option. Try again.")
  })

  it('shows only the requested keys', () => {
    const w = mount(BridgeSettingsPanel, {
      props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS }, keys: ['sync_member_list', 'sync_presence'] },
      global: global(),
    })
    expect(w.findAll('[role="switch"]')).toHaveLength(2)
  })
})
