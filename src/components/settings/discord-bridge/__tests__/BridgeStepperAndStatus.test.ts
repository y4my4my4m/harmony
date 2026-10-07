/**
 * BridgeSetupStepper.vue and BridgeStatusView.vue: step derivation and resume, intents
 * driven by the settings, following progress, finishing; the status view online and
 * offline, its problems, pairs, settings, maintenance and disconnect.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeSetupStepper from '../BridgeSetupStepper.vue'
import BridgeStatusView from '../BridgeStatusView.vue'
import { forgetIssuedSetupCodes } from '../bridgeApi'
import {
  GUILD_ID,
  HARMONY_CHANNELS,
  HEALTHY_STATUS,
  NOW,
  STALE,
  healthyBridge,
  iconStub,
  installBackend,
  makeBridge,
  makeI18n,
  makePair,
  missingKeys,
  rpcCalls,
} from './bridgeTestKit'
import type { BridgePairRow, DiscordBridgeRow } from '@/utils/discordBridgeSetup'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub } })

beforeEach(() => {
  missingKeys.length = 0
  localStorage.clear()
  forgetIssuedSetupCodes()
  installBackend({}, (name) => (name === 'discord_bridge_setup_code' ? 'HB-AAAA-BBBB-CCCC' : null))
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

function mountStepper(bridge: DiscordBridgeRow, pairs: BridgePairRow[] = [], extra: Record<string, unknown> = {}) {
  return mount(BridgeSetupStepper, {
    props: {
      bridge,
      pairs,
      harmonyChannels: HARMONY_CHANNELS,
      now: NOW,
      harmonyUrl: 'https://harmony.example',
      serverName: 'Town Hall',
      ...extra,
    },
    global: global(),
  })
}

const step = (w: ReturnType<typeof mountStepper>) => w.find('.step-panel').attributes('data-step')

describe('BridgeSetupStepper', () => {
  it('starts with the Discord bot guide, naming the exact portal controls', () => {
    const w = mountStepper(makeBridge())
    expect(step(w)).toBe('bot')
    const text = w.find('[data-testid="step-bot"]').text()
    for (const control of ['Discord Developer Portal', 'New Application', 'Create', 'Bot', 'Privileged Gateway Intents', 'Save Changes', 'Reset Token', 'Yes, do it!', 'Copy']) {
      expect(text).toContain(control)
    }
    expect(text).toContain('Town Hall Bridge')
    expect(w.find('a[href="https://discord.com/developers/applications"]').attributes('target')).toBe('_blank')
  })

  it('lists the intents to switch on from the current settings', async () => {
    const w = mountStepper(makeBridge({ settings: { sync_member_list: false, sync_presence: false } }))
    const needed = () =>
      Object.fromEntries(w.findAll('[data-testid="intent-list"] li').map((li) => [li.attributes('data-intent'), li.attributes('data-needed')]))
    expect(needed()).toEqual({ message_content: 'true', members: 'false', presence: 'false' })
    expect(w.find('[data-intent="members"]').text()).toContain('Leave off')
    await w.find('[data-testid="setting-sync_presence"] [role="switch"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_update_settings')).toHaveLength(1)
    expect(needed()).toEqual({ message_content: 'true', members: 'false', presence: 'true' })
    expect(w.find('[data-intent="presence"]').text()).toContain('Switch on')
  })

  it('remembers reaching the connect step so a returning admin resumes there', async () => {
    const w = mountStepper(makeBridge())
    await w.find('[data-testid="step-next"]').trigger('click')
    await flushPromises()
    expect(step(w)).toBe('connect')
    expect(w.find('[data-testid="connect-self"]').exists()).toBe(true)
    expect(rpcCalls('discord_bridge_setup_code')).toEqual([{ p_bridge_id: 'b1' }])
    w.unmount()
    const again = mountStepper(makeBridge())
    expect(step(again)).toBe('connect')
  })

  it('moves a hosted bridge to the checklist after the token is saved', async () => {
    localStorage.setItem('harmony.discordBridge.reached.b1', 'connect')
    const w = mountStepper(makeBridge({ mode: 'hosted' }))
    expect(step(w)).toBe('connect')
    await w.find('[data-testid="hosted-token"]').setValue(['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.'))
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(step(w)).toBe('check')
    expect(w.find('[data-testid="check-waiting"]').text()).toContain('this instance to start your bridge')
    expect(w.emitted('changed')).toBeTruthy()
  })

  it('follows the bridge from the checklist to the guild step when it connects', async () => {
    localStorage.setItem('harmony.discordBridge.reached.b1', 'check')
    const w = mountStepper(makeBridge())
    expect(step(w)).toBe('check')
    expect(w.find('[data-testid="step-next"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="next-hint"]').text()).toContain('green check')
    await w.setProps({ bridge: healthyBridge() })
    await flushPromises()
    expect(step(w)).toBe('guild')
  })

  it('stays on the checklist while a check fails', () => {
    const w = mountStepper(healthyBridge({ status: { ...HEALTHY_STATUS, problems: [{ code: 'discord_token_invalid' }] } }))
    expect(step(w)).toBe('check')
    expect(w.find('[data-check="token"]').attributes('data-state')).toBe('fail')
  })

  it('stays on the pairing step after the first pair, and finishes from the options step', async () => {
    const bridge = healthyBridge({ discord_guild_id: GUILD_ID })
    const w = mountStepper(bridge)
    expect(step(w)).toBe('channels')
    expect(w.find('[data-testid="step-next"]').attributes('disabled')).toBeDefined()
    await w.setProps({ pairs: [makePair()] })
    await flushPromises()
    expect(step(w)).toBe('channels')
    await w.find('[data-testid="step-next"]').trigger('click')
    await flushPromises()
    expect(step(w)).toBe('options')
    expect(w.findAll('[data-testid="bridge-settings"] [role="switch"]')).toHaveLength(5)
    await w.find('[data-testid="step-finish"]').trigger('click')
    expect(w.emitted('finish')).toHaveLength(1)
  })

  it('locks steps whose prerequisites are missing', () => {
    const w = mountStepper(makeBridge())
    expect(w.find('[data-testid="nav-guild"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="nav-channels"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-testid="nav-connect"]').attributes('disabled')).toBeUndefined()
    expect(w.find('[data-testid="nav-bot"]').attributes('aria-current')).toBe('step')
    expect(w.find('[data-testid="nav-bot"]').attributes('aria-label')).toBe('Step 1: Create your Discord bot')
  })

  it('marks completed steps', () => {
    const w = mountStepper(healthyBridge({ discord_guild_id: GUILD_ID }))
    expect(w.find('[data-testid="nav-check"]').classes()).toContain('step-link--done')
    expect(w.find('[data-testid="nav-guild"]').classes()).toContain('step-link--done')
    expect(w.find('[data-testid="nav-channels"]').classes()).not.toContain('step-link--done')
  })

  it('opens a requested step and jumps to the token step from a problem', async () => {
    const w = mountStepper(healthyBridge({ status: { ...HEALTHY_STATUS, problems: [{ code: 'discord_token_invalid' }] } }), [], {
      initialStep: 'check',
    })
    await w.find('[data-testid="problem-go-connect"]').trigger('click')
    await flushPromises()
    expect(step(w)).toBe('connect')
  })

  it('offers to start over', async () => {
    const w = mountStepper(makeBridge())
    await w.find('[data-testid="start-over"]').trigger('click')
    expect(w.emitted('start-over')).toHaveLength(1)
  })
})

describe('BridgeStatusView', () => {
  function mountStatus(bridge: DiscordBridgeRow, pairs: BridgePairRow[] = [makePair()]) {
    return mount(BridgeStatusView, {
      props: { bridge, pairs, harmonyChannels: HARMONY_CHANNELS, now: NOW, harmonyUrl: 'https://harmony.example' },
      global: global(),
    })
  }

  it('shows an online bridge with its facts, pairs and settings', () => {
    const w = mountStatus(healthyBridge({ discord_guild_id: GUILD_ID }))
    expect(w.find('[data-testid="status-title"]').text()).toBe('Bridge is online')
    expect(w.find('[data-testid="status-seen"]').text()).toBe('Last heard from 10 seconds ago.')
    expect(w.find('[data-testid="status-version"]').text()).toBe('2.0.0')
    expect(w.text()).toContain('On your computer')
    expect(w.text()).toContain('Town Square')
    expect(w.text()).toContain('Town Bridge')
    expect(w.find('[data-testid="bridge-problems"]').exists()).toBe(false)
    expect(w.findAll('[data-testid="pair-row"]')).toHaveLength(1)
    expect(w.findAll('[data-testid="bridge-settings"] [role="switch"]')).toHaveLength(5)
  })

  it('shows an offline bridge with when it was last heard from and the fix', () => {
    const w = mountStatus(healthyBridge({ discord_guild_id: GUILD_ID, last_seen_at: STALE }))
    expect(w.find('[data-testid="status-title"]').text()).toBe('Bridge is offline')
    expect(w.find('[data-testid="status-seen"]').text()).toBe('Last heard from 3 hours ago.')
    expect(w.find('[data-code="bridge_offline"]').text()).toContain('docker start harmony-discord-bridge')
  })

  it('shows problems with fixes while online', () => {
    const w = mountStatus(
      healthyBridge({
        discord_guild_id: GUILD_ID,
        status: { ...HEALTHY_STATUS, problems: [{ code: 'cannot_send', params: { discord_channel_id: '11' } }] },
      }),
    )
    expect(w.find('[data-testid="status-title"]').text()).toBe('Bridge is online, with problems')
    expect(w.find('[data-code="cannot_send"]').text()).toContain("The bot can't post in #general.")
    expect(w.text()).toContain('1 problem to fix')
  })

  it('says when a bridge never connected', () => {
    const w = mountStatus(makeBridge({ discord_guild_id: GUILD_ID }))
    expect(w.find('[data-testid="status-title"]').text()).toBe("Bridge hasn't connected yet")
    expect(w.find('[data-testid="status-seen"]').text()).toBe("It hasn't reported in yet.")
    expect(w.find('[data-testid="status-version"]').text()).toBe('Not reported yet')
  })

  it('offers a fresh command for a self-run bridge without issuing a code up front', async () => {
    const w = mountStatus(healthyBridge({ discord_guild_id: GUILD_ID }))
    expect(w.text()).toContain('Move the bridge to another computer, or reinstall it')
    const details = w.find('details')
    ;(details.element as HTMLDetailsElement).open = true
    await details.trigger('toggle')
    await flushPromises()
    expect(rpcCalls('discord_bridge_setup_code')).toEqual([])
    expect(w.find('[data-testid="issue-code"]').exists()).toBe(true)
  })

  it('offers to replace the token of a hosted bridge', async () => {
    const w = mountStatus(healthyBridge({ mode: 'hosted', discord_guild_id: GUILD_ID }))
    expect(w.text()).toContain('On this instance')
    expect(w.text()).toContain('Replace the Discord bot token')
    expect(w.text()).toContain('deletes the stored Discord token')
  })

  it('asks the parent to disconnect and to show the setup steps', async () => {
    const w = mountStatus(healthyBridge({ discord_guild_id: GUILD_ID }))
    await w.find('[data-testid="disconnect"]').trigger('click')
    expect(w.emitted('delete')).toHaveLength(1)
    await w.find('[data-testid="show-setup"]').trigger('click')
    expect(w.emitted('show-setup')).toEqual([[null]])
  })
})
