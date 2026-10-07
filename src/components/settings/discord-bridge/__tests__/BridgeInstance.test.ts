/**
 * The instance bot (bridge v2.1): the mode chooser, Add to Discord and the return from
 * Discord, the instance stepper and status view, instance-specific hints and problems, and
 * Admin → Instance → this instance's Discord bot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DiscordBridgeSetup from '../../DiscordBridgeSetup.vue'
import BridgeSetupStepper from '../BridgeSetupStepper.vue'
import BridgeStatusView from '../BridgeStatusView.vue'
import BridgeSettingsPanel from '../BridgeSettingsPanel.vue'
import BridgeProblemList from '../BridgeProblemList.vue'
import BridgeInstanceBotAdmin from '../BridgeInstanceBotAdmin.vue'
import { discordNavigation } from '../instanceLink'
import { DEFAULT_BRIDGE_SETTINGS, type DiscordBridgeRow } from '@/utils/discordBridgeSetup'
import {
  CATEGORY_ROWS,
  CHANNEL_ROWS,
  GUILD_ID,
  HARMONY_CHANNELS,
  HEALTHY_STATUS,
  NOW,
  SEEN,
  SERVER_ID,
  SNAPSHOT,
  iconStub,
  installBackend,
  makeBridge,
  makeI18n,
  makePair,
  missingKeys,
  rpcCalls,
  spinnerStub,
} from './bridgeTestKit'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const STATE = 'f'.repeat(64)
const APP_ID = '300000000000000091'
const AUTHORIZE = `${window.location.origin}/bot-gateway/bridge/v2/discord/authorize?state=${STATE}`
const REDIRECT_URI = `${window.location.origin}/bot-gateway/bridge/v2/discord/callback`

const confirmStub = {
  name: 'ConfirmationModal',
  props: ['show', 'title', 'message', 'secondaryMessage', 'confirmButtonText'],
  emits: ['confirm', 'close'],
  template: `<div v-if="show" class="confirm-stub"><p class="confirm-secondary">{{ secondaryMessage }}</p>
    <button class="confirm-yes" @click="$emit('confirm')">{{ confirmButtonText }}</button></div>`,
}

const global = () => ({
  plugins: [makeI18n()],
  stubs: { Icon: iconStub, LoadingSpinner: spinnerStub, ConfirmationModal: confirmStub },
})

function instanceBridge(overrides: Partial<DiscordBridgeRow> = {}): DiscordBridgeRow {
  return makeBridge({ mode: 'instance', ...overrides })
}

/** Linked to Town Square, heartbeating, with the guild in its snapshot. */
function linkedBridge(overrides: Partial<DiscordBridgeRow> = {}): DiscordBridgeRow {
  return instanceBridge({
    discord_guild_id: GUILD_ID,
    discord_guild_name: 'Town Square',
    discord_application_id: APP_ID,
    discord_bot_name: 'Harmony Relay',
    status: HEALTHY_STATUS,
    snapshot: SNAPSHOT,
    bridge_version: '2.1.0',
    last_seen_at: SEEN,
    ...overrides,
  })
}

function tables(extra: Record<string, any[]> = {}) {
  return {
    discord_bridges: [],
    discord_bridge_channels: [],
    channels: CHANNEL_ROWS.map((c) => ({ ...c })),
    channel_categories: CATEGORY_ROWS.map((c) => ({ ...c })),
    instance_config: [{ config_key: 'discord_bridge_instance_bot_enabled', config_value: true }],
    discord_bridge_pairings: [],
    ...extra,
  }
}

let navigate: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  missingKeys.length = 0
  localStorage.clear()
  Object.values(toast).forEach((fn) => fn.mockReset())
  navigate = vi.spyOn(discordNavigation, 'open').mockImplementation(() => {})
})

afterEach(() => {
  vi.useRealTimers()
  navigate.mockRestore()
  expect(missingKeys).toEqual([])
})

describe('DiscordBridgeSetup with the instance bot', () => {
  function mountSetup(linkReturn: { linked: boolean; error: string | null } | null = null) {
    return mount(DiscordBridgeSetup, {
      props: { serverId: SERVER_ID, serverName: 'Town Hall', linkReturn: linkReturn as never },
      global: global(),
    })
  }

  it('offers the instance bot first, recommended, with the operator privacy note', async () => {
    installBackend(tables({ instance_config: [
      { config_key: 'discord_bridge_instance_bot_enabled', config_value: true },
      { config_key: 'discord_bridge_hosting_enabled', config_value: true },
    ] }))
    const w = mountSetup()
    await flushPromises()

    const options = w.findAll('[data-testid^="mode-"]').map((o) => o.attributes('data-testid'))
    expect(options).toEqual(['mode-instance', 'mode-hosted', 'mode-self'])
    const instance = w.find('[data-testid="mode-instance"]')
    expect(instance.text()).toContain("Use harmony.test's bot")
    expect(instance.text()).toContain('Recommended')
    expect(instance.text()).toContain('can read every Discord channel the bot has access to')
    expect(w.find('[data-testid="choose-instance"]').classes()).toContain('btn-primary')
    expect(w.find('[data-testid="choose-hosted"]').classes()).toContain('btn-secondary')
    expect(w.text()).toContain('Or use a Discord bot of your own')
  })

  it('leaves the instance bot out while it is not offered', async () => {
    installBackend(tables({ instance_config: [] }))
    const w = mountSetup()
    await flushPromises()

    expect(w.find('[data-testid="mode-instance"]').exists()).toBe(false)
    expect(w.find('[data-testid="choose-self"]').classes()).toContain('btn-primary')
  })

  it('creates the instance bridge and opens the Add to Discord step', async () => {
    const backend = installBackend(tables(), (name) => {
      if (name === 'discord_bridge_instance_link') {
        backend.tables.discord_bridges.push(instanceBridge())
        return { bridge_id: 'b1', state: STATE }
      }
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="choose-instance"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('discord_bridge_instance_link')).toEqual([{ p_server_id: SERVER_ID }])
    expect(rpcCalls('discord_bridge_create')).toEqual([])
    expect(navigate).not.toHaveBeenCalled()
    expect(w.findAll('.step-link').map((b) => b.attributes('data-testid'))).toEqual(['nav-link', 'nav-channels', 'nav-options'])
    expect(w.find('.step-panel').attributes('data-step')).toBe('link')
    expect(w.find('[data-testid="instance-link"]').text()).toContain('click Authorize')
    expect(w.find('[data-testid="step-next"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="next-hint"]').text()).toBe('Add the bot to your Discord server to continue.')
  })

  it('Add to Discord takes a new state and leaves for the gateway\'s authorize route', async () => {
    installBackend(tables({ discord_bridges: [instanceBridge()] }), (name) =>
      name === 'discord_bridge_instance_link' ? { bridge_id: 'b1', state: STATE } : null,
    )
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="add-to-discord"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('discord_bridge_instance_link')).toEqual([{ p_server_id: SERVER_ID }])
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE)
  })

  it('explains a server that already runs another kind of bridge', async () => {
    installBackend(tables({ discord_bridges: [instanceBridge()] }), (name) => {
      if (name === 'discord_bridge_instance_link') throw Object.assign(new Error('bridge_exists'), { code: '23505' })
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="add-to-discord"]').trigger('click')
    await flushPromises()

    const error = w.find('[data-testid="instance-link-error"]')
    expect(error.text()).toContain('already has a Discord bridge set up another way')
    expect(error.text()).not.toContain('bridge_exists')
    expect(navigate).not.toHaveBeenCalled()
  })

  it('refuses the mode plainly once the instance bot is full', async () => {
    installBackend(tables(), (name) => {
      if (name === 'discord_bridge_instance_link') throw Object.assign(new Error('limit_reached'), { code: '54000' })
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="choose-instance"]').trigger('click')
    await flushPromises()

    expect(w.find('[data-testid="bridge-action-error"]').text()).toContain('already in as many Discord servers as it allows')
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
  })

  it('returns from Discord linked: confirms, continues at the channel pairs and waits for the channels', async () => {
    installBackend(tables({
      discord_bridges: [instanceBridge({ discord_guild_id: GUILD_ID, discord_guild_name: 'Town Square' })],
    }))
    const w = mountSetup({ linked: true, error: null })
    await flushPromises()

    expect(toast.success).toHaveBeenCalledWith('Linked to Town Square. Now pair the channels.')
    expect(w.find('.step-panel').attributes('data-step')).toBe('channels')
    expect(w.find('[data-testid="pairs-waiting-instance"]').text()).toContain(
      'Connecting to Town Square… this takes up to a minute',
    )
    expect(w.find('[data-testid="pair-form"]').exists()).toBe(false)
    expect(w.find('[data-testid="bridge-link-error"]').exists()).toBe(false)
  })

  it('returns from Discord with an error: says what happened and offers a retry', async () => {
    installBackend(tables({ discord_bridges: [instanceBridge()] }), (name) =>
      name === 'discord_bridge_instance_link' ? { bridge_id: 'b1', state: STATE } : null,
    )
    const w = mountSetup({ linked: false, error: 'guild_linked_elsewhere' })
    await flushPromises()

    const banner = w.find('[data-testid="bridge-link-error"]')
    expect(banner.attributes('role')).toBe('alert')
    expect(banner.text()).toContain('already bridged to another server on this instance')
    await w.find('[data-testid="link-retry"]').trigger('click')
    await flushPromises()
    expect(navigate).toHaveBeenCalledWith(AUTHORIZE)
    expect(w.find('[data-testid="bridge-link-error"]').exists()).toBe(false)
  })

  const messages: Array<[string, string]> = [
    ['state_invalid', 'That link expired or was already used'],
    ['discord_denied', 'the request was cancelled in Discord'],
    ['exchange_failed', "Discord didn't confirm the link"],
    ['limit_reached', 'already in as many Discord servers as it allows'],
  ]
  for (const [code, text] of messages) {
    it(`explains link_error=${code}`, async () => {
      installBackend(tables({ discord_bridges: [instanceBridge()] }))
      const w = mountSetup({ linked: false, error: code })
      await flushPromises()

      expect(w.find('[data-testid="bridge-link-error"]').text()).toContain(text)
      expect(w.find('[data-testid="link-retry"]').exists()).toBe(code !== 'limit_reached')
    })
  }

  it('tells the owner the bot leaves Discord by itself when disconnecting', async () => {
    installBackend(tables({
      discord_bridges: [linkedBridge()],
      discord_bridge_channels: [makePair()],
    }), () => null)
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="disconnect"]').trigger('click')

    expect(w.find('.confirm-secondary').text()).toBe(
      "This instance's bot leaves your Discord server by itself within about ten minutes. There is nothing to remove in Discord.",
    )
  })
})

describe('BridgeSetupStepper — instance bridge', () => {
  function mountStepper(bridge: DiscordBridgeRow, pairs = [] as ReturnType<typeof makePair>[]) {
    return mount(BridgeSetupStepper, {
      props: { bridge, pairs, harmonyChannels: HARMONY_CHANNELS, now: NOW, harmonyUrl: 'https://harmony.example', serverName: 'Town Hall' },
      global: global(),
    })
  }

  beforeEach(() => {
    installBackend({}, (name) => (name === 'discord_bridge_instance_link' ? { bridge_id: 'b1', state: STATE } : null))
  })

  it('pairs channels once the bridge reports its guild', () => {
    const w = mountStepper(linkedBridge())
    expect(w.find('.step-panel').attributes('data-step')).toBe('channels')
    expect(w.find('[data-testid="nav-link"]').classes()).toContain('step-link--done')
    expect(w.find('[data-testid="pair-form"]').exists()).toBe(true)
    expect(w.find('[data-testid="bridge-problems"]').exists()).toBe(false)
  })

  it('says the bot left the Discord server and sends the admin back to Add to Discord', async () => {
    const w = mountStepper(linkedBridge({ snapshot: { guilds: [] } }))

    expect(w.find('[data-testid="pairs-instance-gone"]').text()).toContain("The bot isn't in Town Square anymore")
    const problem = w.find('[data-code="bot_not_in_guild"]')
    expect(problem.text()).toContain('The bot was removed from Town Square')
    expect(w.find('[data-testid="problem-invite"]').exists()).toBe(false)
    await w.find('[data-testid="problem-go-connect"]').trigger('click')
    await flushPromises()
    expect(w.find('.step-panel').attributes('data-step')).toBe('link')
    expect(w.find('[data-testid="instance-linked"]').text()).toBe(
      'The bridge is linked to Town Square. Adding the bot to another Discord server moves the bridge there and removes the channel pairs; the bot leaves Town Square by itself within about ten minutes.',
    )
    expect(w.find('[data-testid="add-to-discord"]').text()).toContain('Add to another Discord server')
  })

  it('opens the link step for a requested step it does not have', () => {
    const w = mount(BridgeSetupStepper, {
      props: {
        bridge: instanceBridge(), pairs: [], harmonyChannels: HARMONY_CHANNELS, now: NOW,
        harmonyUrl: 'https://harmony.example', serverName: 'Town Hall', initialStep: 'guild',
      },
      global: global(),
    })
    expect(w.find('.step-panel').attributes('data-step')).toBe('link')
  })
})

describe('BridgeStatusView — instance bridge', () => {
  it('names the instance bot, offers no invite link, and re-links from maintenance', async () => {
    installBackend({}, () => null)
    const w = mount(BridgeStatusView, {
      props: { bridge: linkedBridge(), pairs: [makePair()], harmonyChannels: HARMONY_CHANNELS, now: NOW, harmonyUrl: 'https://harmony.example' },
      global: global(),
    })

    expect(w.text()).toContain("With this instance's Discord bot")
    expect(w.find('a[href*="discord.com/oauth2/authorize"]').exists()).toBe(false)
    expect(w.text()).toContain('The bot leaves your Discord server by itself within about ten minutes.')
    const details = w.find('details')
    expect(details.find('summary').text()).toBe('Link a different Discord server')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    expect(w.find('[data-testid="instance-link"]').exists()).toBe(true)
  })
})

describe('instance hints and problems', () => {
  it('ties member list and presence sync to the instance bot\'s intents and its admin', async () => {
    installBackend({}, () => null)
    const w = mount(BridgeSettingsPanel, {
      props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS, sync_presence: true }, mode: 'instance' },
      global: global(),
    })
    const presence = w.find('[data-testid="setting-sync_presence"]').text()
    expect(presence).toContain('Only changes of status are sent')
    expect(presence).toContain("Works only while this instance's bot has the Presence Intent.")
    expect(presence).toContain('Discord grants the Presence intent to bots in more than 100 servers only after a review')
    expect(presence).not.toContain('Developer Portal')
    expect(w.find('[data-testid="setting-sync_member_list"]').text()).toContain('Server Members Intent')
  })

  it('keeps the Developer Portal hint for a bot of your own', () => {
    installBackend({}, () => null)
    const w = mount(BridgeSettingsPanel, {
      props: { bridgeId: 'b1', settings: { ...DEFAULT_BRIDGE_SETTINGS, sync_presence: true }, mode: 'hosted' },
      global: global(),
    })
    expect(w.find('[data-testid="setting-sync_presence"]').text()).toContain('Needs the Presence Intent in the Developer Portal.')
  })

  it('offers to turn off an option the instance bot lacks the intent for, not the Developer Portal', async () => {
    installBackend({}, () => null)
    const bridge = linkedBridge({ settings: { ...DEFAULT_BRIDGE_SETTINGS, sync_presence: true } })
    const w = mount(BridgeProblemList, {
      props: {
        bridge,
        problems: [{ code: 'intent_missing', params: { intent: 'presence' } }, { code: 'discord_token_invalid', params: {} }],
        harmonyChannels: HARMONY_CHANNELS,
        harmonyUrl: 'https://harmony.example',
      },
      global: global(),
    })

    expect(w.find('[data-code="intent_missing"]').text()).toContain("This instance's bot doesn't have the Presence Intent.")
    expect(w.find('[data-code="discord_token_invalid"]').text()).toContain("its bot needs a new token")
    expect(w.find('a[href="https://discord.com/developers/applications"]').exists()).toBe(false)
    expect(w.find('[data-testid="problem-go-connect"]').exists()).toBe(false)
    await w.find('[data-testid="turn-off-sync_presence"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_update_settings')[0].p_settings).toMatchObject({ sync_presence: false })
  })
})

describe('BridgeInstanceBotAdmin', () => {
  const STATUS = {
    enabled: false,
    configured: false,
    application_id: null,
    has_client_secret: false,
    has_bot_token: false,
    bot_user_name: null,
    linked_count: 0,
    limit: 100,
    presence: false,
  }
  const CONFIGURED = {
    ...STATUS,
    configured: true,
    application_id: APP_ID,
    has_client_secret: true,
    has_bot_token: true,
    bot_user_name: 'Harmony Relay',
    linked_count: 3,
  }
  const TOKEN = 'MTAxMDEwMTAxMDEwMTAxMDEw' + '.GabcDE.' + 'abcdefghijklmnopqrstuvwxyz0123456789AB'
  const SECRET = 'abcdefghijklmnopqrstuvwxyz012345'

  function mountAdmin() {
    return mount(BridgeInstanceBotAdmin, { global: global() })
  }

  it('walks through the Developer Portal with the exact redirect URI and nothing stored', async () => {
    installBackend({}, (name) => (name === 'discord_bridge_instance_bot_status' ? STATUS : null))
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mountAdmin()
    await flushPromises()

    const steps = w.find('[data-testid="instance-bot-portal-steps"]')
    expect((steps.element as HTMLDetailsElement).open).toBe(true)
    for (const control of ['New Application', 'General Information', 'Application ID', 'Public Bot', 'Requires OAuth2 Code Grant',
      'Message Content Intent', 'Server Members Intent', 'Presence Intent', 'Reset Token', 'OAuth2', 'Redirects', 'Add Redirect',
      'Reset Secret', 'Client Secret']) {
      expect(steps.text()).toContain(control)
    }
    expect(steps.text()).toContain('Discord limits a bot to 100 servers until it is verified')
    expect(w.find('[data-testid="instance-bot-redirect"] code').text()).toBe(REDIRECT_URI)
    await w.find('[data-testid="instance-bot-redirect"] [data-testid="copy-button"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(REDIRECT_URI)

    expect(w.find('[data-testid="instance-bot-summary"]').text()).toContain('No bot set up yet.')
    expect(w.find('[data-testid="instance-bot-count"]').text()).toBe('Linked Discord servers: 0 of 100.')
    expect(w.find('[data-testid="instance-bot-secret-state"]').text()).toBe('Not set')
    expect(w.find('[data-testid="instance-bot-enabled"]').attributes('aria-disabled')).toBe('true')
    expect(w.text()).toContain('Save the Application ID, client secret and bot token first.')
  })

  it('shows what is stored without ever showing a secret', async () => {
    installBackend({}, (name) => (name === 'discord_bridge_instance_bot_status' ? CONFIGURED : null))
    const w = mountAdmin()
    await flushPromises()

    expect(w.find('[data-testid="instance-bot-summary"]').text()).toContain('Bot set up: Harmony Relay.')
    expect(w.find('[data-testid="instance-bot-count"]').text()).toBe('Linked Discord servers: 3 of 100.')
    expect((w.find('[data-testid="instance-bot-app-id"]').element as HTMLInputElement).value).toBe(APP_ID)
    for (const field of ['instance-bot-client-secret', 'instance-bot-token']) {
      const input = w.find(`[data-testid="${field}"]`).element as HTMLInputElement
      expect(input.type).toBe('password')
      expect(input.value).toBe('')
      expect(input.placeholder).toBe('Stored. Leave empty to keep it.')
    }
    expect(w.find('[data-testid="instance-bot-secret-state"]').text()).toBe('Stored')
    expect(w.find('[data-testid="instance-bot-token-state"]').text()).toBe('Stored')
    expect((w.find('[data-testid="instance-bot-portal-steps"]').element as HTMLDetailsElement).open).toBe(false)
    expect(w.find('[data-testid="instance-bot-save-credentials"]').attributes('disabled')).toBeDefined()
  })

  it('saves the credentials write-only and clears the fields', async () => {
    installBackend({}, (name) => {
      if (name === 'discord_bridge_instance_bot_status') return STATUS
      if (name === 'discord_bridge_instance_bot_set') return CONFIGURED
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    await w.find('[data-testid="instance-bot-app-id"]').setValue(` ${APP_ID} `)
    await w.find('[data-testid="instance-bot-client-secret"]').setValue(SECRET)
    await w.find('[data-testid="instance-bot-token"]').setValue(TOKEN)
    await w.find('[data-testid="instance-bot-credentials"]').trigger('submit')
    await flushPromises()

    expect(rpcCalls('discord_bridge_instance_bot_set')).toEqual([
      { p_application_id: APP_ID, p_client_secret: SECRET, p_bot_token: TOKEN },
    ])
    expect((w.find('[data-testid="instance-bot-client-secret"]').element as HTMLInputElement).value).toBe('')
    expect((w.find('[data-testid="instance-bot-token"]').element as HTMLInputElement).value).toBe('')
    expect(w.text()).not.toContain(SECRET)
    expect(toast.success).toHaveBeenCalledWith('Discord bot credentials saved')
    expect(w.find('[data-testid="instance-bot-enabled"]').attributes('aria-disabled')).toBeUndefined()
  })

  it('replaces the token alone, keeping the stored client secret', async () => {
    installBackend({}, (name) => {
      if (name === 'discord_bridge_instance_bot_status' || name === 'discord_bridge_instance_bot_set') return CONFIGURED
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    await w.find('[data-testid="instance-bot-token"]').setValue(TOKEN)
    await w.find('[data-testid="instance-bot-credentials"]').trigger('submit')
    await flushPromises()

    expect(rpcCalls('discord_bridge_instance_bot_set')).toEqual([
      { p_application_id: APP_ID, p_client_secret: null, p_bot_token: TOKEN },
    ])
  })

  it('names a value pasted into the wrong field', async () => {
    installBackend({}, (name) => (name === 'discord_bridge_instance_bot_status' ? CONFIGURED : null))
    const w = mountAdmin()
    await flushPromises()
    await w.find('[data-testid="instance-bot-client-secret"]').setValue(TOKEN)
    await w.find('[data-testid="instance-bot-token"]').setValue(SECRET)
    await w.find('[data-testid="instance-bot-app-id"]').setValue('12345')

    expect(w.text()).toContain("That's the bot token. The client secret is under OAuth2 → Client Secret.")
    expect(w.text()).toContain('That looks like the Client Secret.')
    expect(w.text()).toContain('An Application ID is a number of 17 to 20 digits.')
    expect(w.find('[data-testid="instance-bot-save-credentials"]').attributes('disabled')).toBeDefined()
  })

  it('saves the switches and the limit through batch_set_instance_config', async () => {
    installBackend({}, (name) => {
      if (name === 'discord_bridge_instance_bot_status') return CONFIGURED
      if (name === 'batch_set_instance_config') return true
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    expect(w.text()).toContain('past 100 servers, Discord has to approve it')
    await w.find('[data-testid="instance-bot-enabled"]').trigger('click')
    await w.find('[data-testid="instance-bot-presence"]').trigger('click')
    await w.find('[data-testid="instance-bot-limit"]').setValue('250')
    await w.find('[data-testid="instance-bot-save-settings"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('batch_set_instance_config')).toEqual([{
      p_keys: ['discord_bridge_instance_bot_enabled', 'discord_bridge_instance_presence', 'discord_bridge_instance_bot_limit'],
      p_values: [true, true, 250],
    }])
    expect(toast.success).toHaveBeenCalledWith('Discord bot settings saved')
  })

  it('removes the bot after a confirmation', async () => {
    let configured = true
    installBackend({}, (name) => {
      if (name === 'discord_bridge_instance_bot_status') return configured ? CONFIGURED : STATUS
      if (name === 'discord_bridge_instance_bot_clear') {
        configured = false
        return null
      }
      return null
    })
    const w = mountAdmin()
    await flushPromises()
    await w.find('[data-testid="instance-bot-clear"]').trigger('click')
    expect(rpcCalls('discord_bridge_instance_bot_clear')).toEqual([])
    expect(w.text()).toContain('Linked communities stop bridging until a bot is set up again.')
    await w.find('[data-testid="instance-bot-clear-confirm"]').trigger('click')
    await flushPromises()

    expect(rpcCalls('discord_bridge_instance_bot_clear')).toHaveLength(1)
    expect(w.find('[data-testid="instance-bot-summary"]').text()).toContain('No bot set up yet.')
    expect(toast.success).toHaveBeenCalledWith('Discord bot removed')
  })

  it('reports a status it cannot load', async () => {
    installBackend({}, (name) => {
      if (name === 'discord_bridge_instance_bot_status') throw Object.assign(new Error('Unauthorized'), { code: '42501' })
      return null
    })
    const w = mountAdmin()
    await flushPromises()

    expect(w.find('[role="alert"]').text()).toBe("Couldn't load the Discord bot settings.")
    expect(w.find('[data-testid="instance-bot-credentials"]').exists()).toBe(false)
  })
})
