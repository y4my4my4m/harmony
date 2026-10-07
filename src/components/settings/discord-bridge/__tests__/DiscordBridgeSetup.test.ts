/**
 * DiscordBridgeSetup.vue: start screen with and without hosting, bridge creation, the v1
 * upgrade card, the unavailable-schema state, resuming into the stepper or the status
 * view, polling, and disconnect / start over through the confirmation dialog.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import DiscordBridgeSetup from '../../DiscordBridgeSetup.vue'
import { forgetIssuedSetupCodes } from '../bridgeApi'
import {
  CATEGORY_ROWS,
  CHANNEL_ROWS,
  NOW,
  SERVER_ID,
  STALE,
  healthyBridge,
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

const confirmStub = {
  name: 'ConfirmationModal',
  props: ['show', 'title', 'message', 'secondaryMessage', 'confirmButtonText'],
  emits: ['confirm', 'close'],
  template: `<div v-if="show" class="confirm-stub">
    <p class="confirm-title">{{ title }}</p><p class="confirm-message">{{ message }}</p>
    <p class="confirm-secondary">{{ secondaryMessage }}</p>
    <button class="confirm-yes" @click="$emit('confirm')">{{ confirmButtonText }}</button>
    <button class="confirm-no" @click="$emit('close')">no</button>
  </div>`,
}

function tables(extra: Record<string, any[]> = {}) {
  return {
    discord_bridges: [],
    discord_bridge_channels: [],
    channels: CHANNEL_ROWS.map((c) => ({ ...c })),
    channel_categories: CATEGORY_ROWS.map((c) => ({ ...c })),
    instance_config: [],
    discord_bridge_pairings: [],
    ...extra,
  }
}

function mountSetup() {
  return mount(DiscordBridgeSetup, {
    props: { serverId: SERVER_ID, serverName: 'Town Hall' },
    global: {
      plugins: [makeI18n()],
      stubs: { Icon: iconStub, LoadingSpinner: spinnerStub, ConfirmationModal: confirmStub },
    },
  })
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
  missingKeys.length = 0
  forgetIssuedSetupCodes()
  localStorage.clear()
  Object.values(toast).forEach((fn) => fn.mockReset())
})

afterEach(() => {
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('DiscordBridgeSetup — no bridge', () => {
  it('offers only "run it yourself" when the instance does not host bridges', async () => {
    installBackend(tables())
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
    expect(w.find('[data-testid="mode-hosted"]').exists()).toBe(false)
    expect(w.find('[data-testid="mode-self"]').exists()).toBe(true)
    expect(w.find('[data-testid="hosting-unavailable"]').text()).toContain("doesn't run bridges")
    expect(w.text()).toContain('Presence sync (Discord online status) starts off')
    expect(w.find('[data-testid="upgrade-card"]').exists()).toBe(false)
  })

  it('offers both ways, with the operator trade-off, when hosting is enabled', async () => {
    installBackend(tables({ instance_config: [{ config_key: 'discord_bridge_hosting_enabled', config_value: true }] }))
    const w = mountSetup()
    await flushPromises()
    const hosted = w.find('[data-testid="mode-hosted"]')
    expect(hosted.exists()).toBe(true)
    expect(hosted.find('h4').text()).toBe('Use your own bot, run on this instance')
    expect(hosted.find('[data-testid="hosted-lead"]').text()).toBe(
      'Create a Discord bot with your own name and avatar and paste its token here; this instance runs it.',
    )
    expect(hosted.text()).toContain('could read any Discord channel the bot can see')
    expect(w.find('[data-testid="hosting-unavailable"]').exists()).toBe(false)
    expect(w.text()).toContain('Either way, messages in bridged channels pass through this instance')
  })

  it('creates a self-run bridge and opens the first setup step', async () => {
    const backend = installBackend(tables(), (name, args) => {
      if (name === 'discord_bridge_create') {
        backend.tables.discord_bridges.push(makeBridge({ mode: args.p_mode as 'self' }))
        return 'b1'
      }
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="choose-self"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_create')).toEqual([{ p_server_id: SERVER_ID, p_mode: 'self' }])
    expect(w.find('[data-testid="bridge-stepper"]').exists()).toBe(true)
    expect(w.find('[data-testid="step-bot"]').exists()).toBe(true)
  })

  it('creates a hosted bridge', async () => {
    const backend = installBackend(
      tables({ instance_config: [{ config_key: 'discord_bridge_hosting_enabled', config_value: 'true' }] }),
      (name, args) => {
        if (name === 'discord_bridge_create') {
          backend.tables.discord_bridges.push(makeBridge({ mode: args.p_mode as 'hosted' }))
          return 'b1'
        }
        return null
      },
    )
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="choose-hosted"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_create')).toEqual([{ p_server_id: SERVER_ID, p_mode: 'hosted' }])
    expect(w.find('[data-testid="nav-connect"]').text()).toContain('Give this instance the token')
  })

  it('explains a full hosting quota instead of failing silently', async () => {
    installBackend(tables({ instance_config: [{ config_key: 'discord_bridge_hosting_enabled', config_value: true }] }), (name) => {
      if (name === 'discord_bridge_create') throw new Error('discord bridge hosting limit reached')
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="choose-hosted"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="bridge-action-error"]').text()).toContain('Choose “Run it yourself” instead')
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
  })

  it('shows the upgrade card and the old setup collapsed for a v1 pairing', async () => {
    installBackend(tables({ discord_bridge_pairings: [{ server_id: SERVER_ID, pairing_code: 'HRM-ABCD-EFGH', created_at: '2026-01-01' }] }))
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="upgrade-card"]').text()).toContain('Upgrade to the new Discord bridge')
    const legacy = w.find('[data-testid="legacy-info"]')
    expect(legacy.element.tagName).toBe('DETAILS')
    expect((legacy.element as HTMLDetailsElement).open).toBe(false)
    expect(legacy.find('[data-testid="legacy-code"]').text()).toBe('HRM-ABCD-EFGH')
    expect(legacy.text()).toContain('Message Content is required')
    expect(legacy.text()).not.toMatch(/optional/i)
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
  })

  it('says the instance lacks the new bridge when its tables are absent', async () => {
    installBackend(tables())
    const { supabase } = await import('@/supabase')
    const from = vi.mocked(supabase.from).getMockImplementation()!
    vi.mocked(supabase.from).mockImplementation(((table: string) => {
      if (table !== 'discord_bridges') return from(table)
      const builder: any = {
        select: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: null, error: { code: 'PGRST205', message: 'relation not found' } }),
      }
      return builder
    }) as never)
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="bridge-unavailable"]').text()).toContain("isn't available on this instance yet")
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(false)
  })
})

describe('DiscordBridgeSetup — existing bridge', () => {
  it('resumes in the stepper while no channel is paired', async () => {
    installBackend(tables({ discord_bridges: [healthyBridge()] }))
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="bridge-stepper"]').exists()).toBe(true)
    expect(w.find('.step-panel').attributes('data-step')).toBe('guild')
  })

  it('opens the status view once a pair exists', async () => {
    installBackend(
      tables({ discord_bridges: [healthyBridge({ discord_guild_id: '900' })], discord_bridge_channels: [makePair()] }),
    )
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="bridge-status"]').exists()).toBe(true)
    expect(w.find('[data-testid="status-title"]').text()).toBe('Bridge is online')
  })

  it('warns that an old v1 bridge would relay twice alongside the new one', async () => {
    installBackend(
      tables({
        discord_bridges: [healthyBridge({ discord_guild_id: '900' })],
        discord_bridge_channels: [makePair()],
        discord_bridge_pairings: [{ server_id: SERVER_ID, pairing_code: 'HRM-ABCD-EFGH', created_at: null }],
      }),
    )
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="upgrade-card"]').exists()).toBe(false)
    expect(w.find('[data-testid="legacy-still-there"]').text()).toContain('copied twice')
  })

  it('polls the row every few seconds while open', async () => {
    vi.useRealTimers()
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const backend = installBackend(tables({ discord_bridges: [makeBridge()] }))
    const w = mountSetup()
    await vi.advanceTimersByTimeAsync(0)
    await flushPromises()
    expect(w.find('[data-testid="check-waiting"]').exists()).toBe(false)
    const before = vi.mocked((await import('@/supabase')).supabase.from).mock.calls.filter(([t]) => t === 'discord_bridges').length
    Object.assign(backend.tables.discord_bridges[0], { last_seen_at: new Date(NOW + 4000).toISOString(), status: { discord: { connected: true } } })
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    const after = vi.mocked((await import('@/supabase')).supabase.from).mock.calls.filter(([t]) => t === 'discord_bridges').length
    expect(after).toBeGreaterThan(before)
    w.unmount()
  })

  it('disconnects after confirmation and returns to the start screen', async () => {
    const backend = installBackend(
      tables({ discord_bridges: [healthyBridge({ discord_guild_id: '900', last_seen_at: STALE })], discord_bridge_channels: [makePair()] }),
      (name) => {
        if (name === 'discord_bridge_delete') {
          backend.tables.discord_bridges.length = 0
          backend.tables.discord_bridge_channels.length = 0
        }
        return null
      },
    )
    const w = mountSetup()
    await flushPromises()
    expect(w.find('[data-testid="status-title"]').text()).toBe('Bridge is offline')
    await w.find('[data-testid="disconnect"]').trigger('click')
    const dialog = w.find('.confirm-stub')
    expect(dialog.find('.confirm-title').text()).toBe('Disconnect the bridge?')
    expect(dialog.find('.confirm-secondary').text()).toContain('docker rm -f harmony-discord-bridge')
    await dialog.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_delete')).toEqual([{ p_bridge_id: 'b1' }])
    expect(toast.success).toHaveBeenCalledWith('Bridge disconnected')
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
  })

  it('keeps the bridge when the confirmation is cancelled', async () => {
    installBackend(tables({ discord_bridges: [healthyBridge({ discord_guild_id: '900' })], discord_bridge_channels: [makePair()] }))
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="disconnect"]').trigger('click')
    await w.find('.confirm-no').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_delete')).toEqual([])
    expect(w.find('[data-testid="bridge-status"]').exists()).toBe(true)
  })

  it('starts over from the stepper', async () => {
    const backend = installBackend(tables({ discord_bridges: [makeBridge({ mode: 'hosted' })] }), (name) => {
      if (name === 'discord_bridge_delete') backend.tables.discord_bridges.length = 0
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="start-over"]').trigger('click')
    expect(w.find('.confirm-title').text()).toBe('Start over?')
    expect(w.find('.confirm-secondary').text()).toBe('')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_delete')).toEqual([{ p_bridge_id: 'b1' }])
    expect(w.find('[data-testid="bridge-mode-chooser"]').exists()).toBe(true)
  })

  it('reports a failed disconnect with what to do', async () => {
    installBackend(tables({ discord_bridges: [healthyBridge({ discord_guild_id: '900' })], discord_bridge_channels: [makePair()] }), (name) => {
      if (name === 'discord_bridge_delete') throw Object.assign(new Error('permission denied'), { code: '42501' })
      return null
    })
    const w = mountSetup()
    await flushPromises()
    await w.find('[data-testid="disconnect"]').trigger('click')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="bridge-action-error"]').text()).toContain('Manage Server permission')
    expect(w.find('[data-testid="bridge-status"]').exists()).toBe(true)
  })
})
