/**
 * MatrixBridgeSetup.vue: Server settings → Bridges → Matrix. The chooser, a bridge program with a bot
 * of someone's own as 1.9.8 had it, an instance without the managed bridge, creating, resuming,
 * polling, and disconnecting.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { forgetIssuedSetupCodes } from '../../discord-bridge/bridgeApi'
import { CATEGORY_ROWS, CHANNEL_ROWS, NOW, SERVER_ID, iconStub, installBackend, makeI18n, missingKeys, rpcCalls, spinnerStub } from '../../discord-bridge/__tests__/bridgeTestKit'
import { resolveInstanceName } from '@/utils/discordBridgeSetup'
import MatrixBridgeSetup from '../MatrixBridgeSetup.vue'
import { forgetMatrixConnectFields } from '../MatrixConnectSelf.vue'
import { BOT_ID, BRIDGE_ID, rawPair, rawReady, rawState } from './matrixTestKit'

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() } }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const confirmStub = {
  name: 'ConfirmationModal',
  props: ['show', 'title', 'message', 'secondaryMessage', 'confirmButtonText'],
  emits: ['confirm', 'close'],
  template: `<div v-if="show" class="confirm-stub">
    <p class="confirm-title">{{ title }}</p><p class="confirm-secondary">{{ secondaryMessage }}</p>
    <button class="confirm-yes" @click="$emit('confirm')">{{ confirmButtonText }}</button>
    <button class="confirm-no" @click="$emit('close')">no</button>
  </div>`,
}
const CustomStub = { name: 'MatrixCustomBridge', props: ['serverId', 'managedBotId', 'hidePrivacy'], template: '<div class="custom-stub" />' }
const PrivacyPanel = { name: 'BridgePrivacyPanel', props: ['serverId', 'platform'], template: '<div class="privacy-stub" />' }

const customPair = {
  bot_id: 'own', bot_display_name: 'Own Bridge', channel_id: 'h-news', channel_name: 'news', room_id: '!n:hs', sender_mode: 'relay', active: true,
}

let offers: Record<string, unknown> | null
let state: Record<string, unknown> | null
let custom: unknown[]
let fails: Record<string, Error>
let w: VueWrapper
const failure = (code: string, message = 'refused') => Object.assign(new Error(message), { code })

function tables(extra: Record<string, any[]> = {}) {
  return {
    channels: CHANNEL_ROWS.map((c) => ({ ...c })),
    channel_categories: CATEGORY_ROWS.map((c) => ({ ...c })),
    server_encryption_settings: [],
    channel_encryption_settings: [],
    ...extra,
  }
}
function backend(extra: Record<string, any[]> = {}) {
  installBackend(tables(extra), (name, args) => {
    if (fails[name]) throw fails[name]
    switch (name) {
      case 'matrix_bridge_state': return state
      case 'get_server_matrix_bridges': return custom
      case 'matrix_bridge_offers': return offers
      case 'matrix_bridge_create': return (state = rawState({ mode: args.p_mode }))
      case 'matrix_bridge_setup_code': return { code: 'MX-AAAA-BBBB-CCCC', expires_at: '2026-11-25T12:30:00Z' }
      case 'matrix_bridge_delete': state = null; return null
      default: return null
    }
  })
}
async function open() {
  w = mount(MatrixBridgeSetup, {
    props: { serverId: SERVER_ID },
    attachTo: document.body,
    global: {
      plugins: [makeI18n()],
      stubs: { Icon: iconStub, LoadingSpinner: spinnerStub, ConfirmationModal: confirmStub, MatrixCustomBridge: CustomStub, BridgePrivacyPanel: PrivacyPanel },
    },
  })
  await flushPromises()
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const customView = () => w.findComponent(CustomStub)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  setActivePinia(createPinia())
  missingKeys.length = 0
  localStorage.clear()
  forgetIssuedSetupCodes()
  forgetMatrixConnectFields()
  Object.values(toast).forEach((fn) => fn.mockReset())
  offers = null
  state = null
  custom = []
  fails = {}
  backend()
})
afterEach(() => {
  w?.unmount()
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('without a bridge', () => {
  it('heads the tab and offers to run one, or a program of your own', async () => {
    await open()
    expect(byTest('matrix-bridge').find('h3').text()).toBe('Matrix bridge')
    const chooser = byTest('bridge-mode-chooser')
    expect(chooser.attributes('data-platform')).toBe('matrix')
    expect(chooser.findAll('article').map((a) => a.attributes('data-testid'))).toEqual(['mode-self', 'mode-custom'])
    expect(chooser.text()).toContain('Where should the bridge run?')
    expect(chooser.text()).toContain("doesn't run Matrix bridges")
    expect(chooser.text()).toContain('You need a Matrix account for the bridge on any homeserver')
    expect(chooser.text()).not.toContain('Discord')
    expect(byTest('choose-self').classes()).toContain('btn-primary')
    for (const article of chooser.findAll('article')) {
      expect(w.find(`[id="${article.attributes('aria-labelledby')}"]`).exists()).toBe(true)
    }
    expect(customView().exists()).toBe(false)
  })

  it('reads nothing while there is no bridge to follow', async () => {
    await open()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(rpcCalls('matrix_bridge_state')).toHaveLength(1)
  })

  it('creates a self-run bridge and shows its command', async () => {
    await open()
    await byTest('choose-self').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_create')).toEqual([{ p_server_id: SERVER_ID, p_mode: 'self' }])
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
    expect(w.find('.step-panel').attributes('data-step')).toBe('connect')
    expect(byTest('setup-code').text()).toContain('MX-AAAA-BBBB-CCCC')
  })

  it.each([
    [failure('23505', 'This server already has a Matrix bridge'), 'This server already has a Matrix bridge. Reload the page to see it.'],
    [failure('42501', 'Missing permission: MANAGE_SERVER'), 'You need the Manage Server permission on this server to do that.'],
    [new Error('secret'), "Couldn't create the bridge. Try again."],
  ])('says why creating failed', async (error, text) => {
    fails.matrix_bridge_create = error
    await open()
    await byTest('choose-self').trigger('click')
    await flushPromises()
    expect(byTest('bridge-action-error').attributes('role')).toBe('alert')
    expect(byTest('bridge-action-error').text()).toBe(text)
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
  })

  it('opens the program of your own, and the chooser again, with focus on the heading', async () => {
    await open()
    await byTest('choose-custom').trigger('click')
    await flushPromises()
    expect(customView().props()).toMatchObject({ serverId: SERVER_ID, managedBotId: undefined })
    expect(document.activeElement?.textContent?.trim()).toBe('Matrix bridge')
    await byTest('matrix-other-ways').trigger('click')
    await flushPromises()
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
    expect(document.activeElement?.textContent?.trim()).toBe('Matrix bridge')
    expect(rpcCalls('matrix_bridge_create')).toEqual([])
  })
})

describe('what the instance offers', () => {
  const modes = () => byTest('bridge-mode-chooser').findAll('article').map((a) => a.attributes('data-testid'))

  it('leads with its own bridge, recommended, then hosting, then the rest', async () => {
    offers = { hosted: true, instance: true, instance_user: '@harmony:example.org' }
    await open()
    expect(modes()).toEqual(['mode-instance', 'mode-hosted', 'mode-self', 'mode-custom'])
    expect(byTest('mode-instance').find('h4').text()).toBe(`Use ${resolveInstanceName()}'s bridge`)
    expect(byTest('mode-instance').text()).toContain('Recommended')
    expect(byTest('mode-instance').text()).toContain('who can read every room you link')
    expect(byTest('mode-hosted').text()).toContain('can read every room the account is in')
    expect(byTest('bridge-mode-chooser').text()).toContain('Or bridge another way:')
    expect(byTest('hosting-unavailable').exists()).toBe(false)
    expect(byTest('choose-instance').classes()).toContain('btn-primary')
    expect(byTest('choose-hosted').classes()).toContain('btn-secondary')
    expect(byTest('choose-self').classes()).toContain('btn-secondary')
  })

  it.each([
    [{ hosted: true, instance: false }, ['mode-hosted', 'mode-self', 'mode-custom'], false],
    [{ hosted: false, instance: true }, ['mode-instance', 'mode-self', 'mode-custom'], false],
    [{ hosted: false, instance: false }, ['mode-self', 'mode-custom'], true],
  ])('is all that is shown: %j', async (offered, shown, unavailable) => {
    offers = offered
    await open()
    expect(modes()).toEqual(shown)
    expect(byTest('hosting-unavailable').exists()).toBe(unavailable)
  })

  it('is nothing where it cannot be read', async () => {
    fails.matrix_bridge_offers = failure('PGRST202')
    await open()
    expect(modes()).toEqual(['mode-self', 'mode-custom'])
  })

  it('is created as it is chosen: a hosted bridge starts at its account', async () => {
    offers = { hosted: true, instance: true }
    await open()
    await byTest('choose-hosted').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_create')).toEqual([{ p_server_id: SERVER_ID, p_mode: 'hosted' }])
    expect(w.find('.step-panel').attributes('data-step')).toBe('connect')
    expect(byTest('matrix-connect-hosted').exists()).toBe(true)
    expect(byTest('step-next').attributes('disabled')).toBeDefined()
    await byTest('start-over').trigger('click')
    expect(w.find('.confirm-secondary').text()).toBe('')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    await byTest('choose-instance').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_create')[1]).toEqual({ p_server_id: SERVER_ID, p_mode: 'instance' })
    expect(w.find('.step-panel').attributes('data-step')).toBe('check')
    expect(w.findAll('.step-link')).toHaveLength(2)
  })

  it.each([
    ['0A000', "This instance doesn't offer that at the moment."],
    ['54000', 'already runs as many Matrix bridges as it allows'],
  ])('can be refused: %s', async (code, text) => {
    offers = { hosted: true, instance: true }
    fails.matrix_bridge_create = failure(code)
    await open()
    await byTest('choose-instance').trigger('click')
    await flushPromises()
    expect(byTest('bridge-action-error').text()).toContain(text)
  })
})

describe('a bridge program of your own', () => {
  it('shows at once where it is in use, as 1.9.8 did, with the way to the others below it', async () => {
    custom = [customPair]
    await open()
    expect(customView().exists()).toBe(true)
    expect(customView().props()).toMatchObject({ serverId: SERVER_ID, hidePrivacy: undefined })
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
    expect(byTest('matrix-other-ways').exists()).toBe(true)
  })

  it('is all there is on an instance before 1.9.9', async () => {
    fails.matrix_bridge_state = failure('PGRST202', 'Could not find the function')
    await open()
    expect(customView().exists()).toBe(true)
    expect(byTest('matrix-other-ways').exists()).toBe(false)
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
    expect(byTest('matrix-bridge-load-error').exists()).toBe(false)
  })

  it('still shows on such an instance when its pairs cannot be read: it reports that itself', async () => {
    fails.matrix_bridge_state = failure('42883')
    fails.get_server_matrix_bridges = new Error('down')
    await open()
    expect(customView().exists()).toBe(true)
  })

  it('stays reachable beside a managed bridge, without its bot, and opens when it has pairs', async () => {
    state = rawReady({ pairs: [rawPair()] })
    await open()
    const details = byTest('matrix-custom-more')
    expect((details.element as HTMLDetailsElement).open).toBe(false)
    expect(customView().exists()).toBe(false)
    w.unmount()
    custom = [customPair]
    await open()
    expect((byTest('matrix-custom-more').element as HTMLDetailsElement).open).toBe(true)
    expect(customView().props()).toEqual({ serverId: SERVER_ID, managedBotId: BOT_ID, hidePrivacy: true })
  })
})

describe('with a bridge', () => {
  it('resumes the steps without pairs and shows the status with them', async () => {
    state = rawState()
    await open()
    expect(byTest('bridge-stepper').exists()).toBe(true)
    w.unmount()
    state = rawReady({ pairs: [rawPair()] })
    await open()
    expect(byTest('matrix-managed-status').exists()).toBe(true)
    expect(byTest('bridge-stepper').exists()).toBe(false)
  })

  it('greys the encrypted channels of the server', async () => {
    backend({
      server_encryption_settings: [{ server_id: SERVER_ID, encryption_mode: 'optional', voice_encryption_mode: 'disabled' }],
      channel_encryption_settings: [{ channel_id: 'h-memes', messages_encrypted: true, voice_encrypted: false }],
    })
    state = rawReady({ pairs: [rawPair()] })
    await open()
    const options = byTest('select-harmony').findAll('option')
    expect(options.find((o) => o.text() === '#memes (end-to-end encrypted)')!.attributes('disabled')).toBeDefined()
    expect(options.find((o) => o.text() === '#news')!.attributes('disabled')).toBeUndefined()
    expect(options.map((o) => o.text())).not.toContain('#Lounge')
  })

  it('reads the state every 5 s and follows it, and stops on unmount', async () => {
    state = rawState()
    await open()
    state = rawReady()
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(w.find('.step-panel').attributes('data-step')).toBe('channels')
    const reads = rpcCalls('matrix_bridge_state').length
    w.unmount()
    await vi.advanceTimersByTimeAsync(20_000)
    expect(rpcCalls('matrix_bridge_state')).toHaveLength(reads)
  })

  it('reads as offline once the last report is older than 90 s, without a new one', async () => {
    state = rawReady({ pairs: [rawPair()] })
    await open()
    expect(byTest('status-title').text()).toBe('Bridge is online')
    await vi.advanceTimersByTimeAsync(85_000)
    await flushPromises()
    expect(byTest('status-title').text()).toBe('Bridge is offline')
  })

  it('keeps what it shows when a poll fails, and leaves a bridge removed elsewhere', async () => {
    state = rawReady({ pairs: [rawPair()] })
    await open()
    fails.matrix_bridge_state = new Error('down')
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(byTest('matrix-managed-status').exists()).toBe(true)
    fails = {}
    state = null
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
  })

  it('leaves a bridge removed elsewhere for the program of your own when one is in use', async () => {
    state = rawReady({ pairs: [rawPair()] })
    custom = [customPair]
    await open()
    state = null
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    expect(byTest('matrix-other-ways').exists()).toBe(true)
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
  })

  it('drops a poll that started before a write', async () => {
    state = rawReady({ pairs: [rawPair()] })
    await open()
    let release!: (value: unknown) => void
    const held = new Promise((resolve) => { release = resolve })
    const { supabase } = await import('@/supabase')
    vi.mocked(supabase.rpc).mockImplementation((async (name: string) => {
      if (name === 'matrix_bridge_state') { await held; return { data: rawReady({ pairs: [rawPair()] }), error: null } }
      return { data: rawReady({ pairs: [] }), error: null }
    }) as never)
    await vi.advanceTimersByTimeAsync(5000)
    await byTest('pair-remove').trigger('click')
    await flushPromises()
    expect(byTest('pairs-empty').exists()).toBe(true)
    release(null)
    await flushPromises()
    expect(byTest('pairs-empty').exists()).toBe(true)
  })

  it('finishes the setup into the status view', async () => {
    state = rawReady()
    await open()
    state = rawReady({ pairs: [rawPair()] })
    await vi.advanceTimersByTimeAsync(5000)
    await flushPromises()
    await byTest('step-finish').trigger('click')
    expect(byTest('matrix-managed-status').exists()).toBe(true)
    expect(toast.success).toHaveBeenCalledWith('The bridge is set up.')
    await byTest('show-setup').trigger('click')
    expect(byTest('bridge-stepper').exists()).toBe(true)
  })

  it('disconnects after asking, and returns to the chooser', async () => {
    state = rawReady({ pairs: [rawPair()] })
    await open()
    await byTest('disconnect').trigger('click')
    expect(w.find('.confirm-title').text()).toBe('Disconnect the bridge?')
    expect(w.find('.confirm-secondary').text()).toContain('docker rm -f harmony-matrix-bridge')
    await w.find('.confirm-no').trigger('click')
    expect(rpcCalls('matrix_bridge_delete')).toEqual([])
    await byTest('disconnect').trigger('click')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(rpcCalls('matrix_bridge_delete')).toEqual([{ p_bridge_id: BRIDGE_ID }])
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
    expect(toast.success).toHaveBeenCalledWith('Bridge disconnected')
  })

  it('returns to the program of your own when one is in use', async () => {
    state = rawReady({ pairs: [rawPair()] })
    custom = [customPair]
    await open()
    await byTest('disconnect').trigger('click')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(customView().exists()).toBe(true)
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
  })

  it('starts over from the steps, and reports a failed delete', async () => {
    state = rawState()
    fails.matrix_bridge_delete = new Error('secret')
    await open()
    await byTest('start-over').trigger('click')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(byTest('bridge-action-error').text()).toBe("Couldn't disconnect the bridge. Try again.")
    expect(byTest('bridge-stepper').exists()).toBe(true)
    fails = {}
    await byTest('start-over').trigger('click')
    await w.find('.confirm-yes').trigger('click')
    await flushPromises()
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
    expect(toast.success).not.toHaveBeenCalled()
  })
})

describe('loading', () => {
  it.each(['matrix_bridge_state', 'get_server_matrix_bridges'])('offers a retry when %s fails', async (name) => {
    fails[name] = new Error('secret')
    await open()
    expect(byTest('matrix-bridge-load-error').attributes('role')).toBe('alert')
    expect(w.text()).not.toContain('secret')
    expect(byTest('bridge-mode-chooser').exists()).toBe(false)
    fails = {}
    await byTest('matrix-bridge-load-error').find('button').trigger('click')
    await flushPromises()
    expect(byTest('bridge-mode-chooser').exists()).toBe(true)
  })

  it('shows a managed bridge even when the other pairs cannot be read', async () => {
    state = rawReady({ pairs: [rawPair()] })
    fails.get_server_matrix_bridges = new Error('down')
    await open()
    expect(byTest('matrix-managed-status').exists()).toBe(true)
  })
})
