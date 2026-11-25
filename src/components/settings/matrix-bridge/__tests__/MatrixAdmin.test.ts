/** MatrixAdminSection.vue: Instance admin → Config → General → Matrix bridge, and the bridge service on both cards. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { NOW, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import BridgeServiceStatus from '../../discord-bridge/BridgeServiceStatus.vue'
import MatrixAdminSection from '../MatrixAdminSection.vue'
import MatrixInstanceAdmin from '../MatrixInstanceAdmin.vue'

const { toast, saveBlob } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
  saveBlob: vi.fn(),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/AccountSecurityService', () => ({ saveBlob }))

const EMPTY = {
  enabled: false, configured: false, connection: null, homeserver_url: null, server_name: null, sender_localpart: null,
  appservice_url: null, has_access_token: false, has_service_tokens: false, linked_count: 0, limit: 100,
  hosting_enabled: false, hosting_limit: 25, hosted_count: 3, host: null,
}
const SERVICE = {
  ...EMPTY, connection: 'application_service', homeserver_url: 'https://matrix.example.org', server_name: 'example.org',
  sender_localpart: 'harmony_relay', appservice_url: 'https://harmony.example/matrix-appservice',
}
const REGISTRATION = { id: 'harmony-matrix-relay', as_token: 'as-secret', hs_token: 'hs-secret', url: SERVICE.appservice_url }
const seen = (secondsAgo: number) => new Date(NOW - secondsAgo * 1000).toISOString()

let w: VueWrapper
let status: Record<string, unknown>
let hosts: unknown
let fail: string | null
let config: { config_key: string; config_value: unknown }[]

function backend() {
  installBackend({ instance_config: config }, (name, args) => {
    if (name === fail) throw Object.assign(new Error('secret detail'), { code: 'XX000' })
    switch (name) {
      case 'matrix_bridge_instance_status': return status
      case 'matrix_bridge_instance_set': {
        // As the database: another homeserver forgets the stored tokens.
        const moved = args.p_homeserver_url && args.p_homeserver_url !== status.homeserver_url
        const token = (!moved && status.has_access_token) || !!args.p_access_token
        const service = !moved && !!status.has_service_tokens
        return (status = {
          ...status,
          connection: args.p_connection,
          homeserver_url: args.p_homeserver_url ?? status.homeserver_url,
          server_name: args.p_server_name ?? status.server_name,
          sender_localpart: args.p_sender_localpart ?? status.sender_localpart ?? 'harmony_relay',
          appservice_url: args.p_appservice_url ?? status.appservice_url ?? 'https://harmony.example/matrix-appservice',
          has_access_token: token,
          has_service_tokens: service,
          configured: args.p_connection === 'account' ? token : service,
        })
      }
      case 'matrix_bridge_instance_registration':
        status = { ...status, has_service_tokens: true, configured: true }
        return REGISTRATION
      case 'matrix_bridge_instance_clear': status = { ...EMPTY }; return null
      case 'bridge_hosts_status': return hosts
      case 'batch_set_instance_config': return true
      default: return null
    }
  })
}
async function open(component: unknown = MatrixInstanceAdmin, props: Record<string, unknown> = {}) {
  w = mount(component as typeof MatrixInstanceAdmin, { props, attachTo: document.body, global: { plugins: [makeI18n()], stubs: { Icon: iconStub } } })
  await flushPromises()
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const disabled = (id: string) => byTest(id).attributes('disabled') !== undefined
const click = async (id: string) => { await byTest(id).trigger('click'); await flushPromises() }
const save = async () => { await byTest('matrix-instance-form').trigger('submit'); await flushPromises() }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] })
  vi.setSystemTime(NOW)
  missingKeys.length = 0
  saveBlob.mockReset()
  Object.values(toast).forEach((fn) => fn.mockReset())
  status = { ...EMPTY }
  hosts = []
  fail = null
  config = []
  backend()
})
afterEach(() => {
  w?.unmount()
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('the card', () => {
  it("is named Matrix bridge: the service, the instance's bridge, then communities' own accounts with their count", async () => {
    await open(MatrixAdminSection)
    expect(w.find('h3').text()).toBe('Matrix bridge')
    expect(w.findAll('h4').map((h) => h.text())).toEqual(['Bridge service', "This instance's Matrix bridge", 'Let communities bring their own account'])
    expect(byTest('hosting-count').text()).toBe('Hosted bridges now: 3 of 25.')
    expect(byTest('hosting-note').exists()).toBe(false)
    expect(w.text()).not.toContain('Discord')
  })

  it("reads communities' own accounts from Matrix's keys", async () => {
    config = [
      { config_key: 'matrix_bridge_hosting_enabled', config_value: true },
      { config_key: 'matrix_bridge_hosting_limit', config_value: 7 },
      { config_key: 'discord_bridge_hosting_limit', config_value: 9 },
    ]
    backend()
    await open(MatrixAdminSection)
    expect(byTest('hosting-toggle').attributes('aria-checked')).toBe('true')
    expect((byTest('hosting-limit').element as HTMLInputElement).value).toBe('7')
  })

  it("saves communities' own accounts under Matrix's keys", async () => {
    await open(MatrixAdminSection)
    await byTest('hosting-toggle').trigger('click')
    await flushPromises()
    await byTest('hosting-limit').setValue('7')
    await click('hosting-save')
    expect(rpcCalls('batch_set_instance_config')).toEqual([
      { p_keys: ['matrix_bridge_hosting_enabled'], p_values: [true] },
      { p_keys: ['matrix_bridge_hosting_limit'], p_values: [7] },
    ])
  })
})

describe("this instance's bridge", () => {
  it('is set up as an application service, with what the instance defaults left empty', async () => {
    await open()
    expect(byTest('matrix-instance-summary').text()).toContain('No bridge set up yet.')
    expect(byTest('matrix-instance-count').text()).toBe('Servers that chose it: 0 of 100.')
    expect(disabled('matrix-instance-save')).toBe(true)
    expect(byTest('matrix-instance-token').exists()).toBe(false)
    await byTest('matrix-instance-homeserverUrl').setValue('http://synapse:8008')
    expect(disabled('matrix-instance-save')).toBe(true)
    await byTest('matrix-instance-serverName').setValue('example.org')
    await byTest('matrix-instance-homeserverUrl').setValue('')
    expect(disabled('matrix-instance-save')).toBe(true)
    await byTest('matrix-instance-homeserverUrl').setValue('http://synapse:8008')
    await save()
    expect(byTest('matrix-instance-registration-stale').exists()).toBe(false)
    expect(rpcCalls('matrix_bridge_instance_set')).toEqual([{
      p_connection: 'application_service', p_homeserver_url: 'http://synapse:8008', p_access_token: null, p_server_name: 'example.org',
      p_sender_localpart: null, p_appservice_url: null,
    }])
    expect((byTest('matrix-instance-appserviceUrl').element as HTMLInputElement).value).toBe('https://harmony.example/matrix-appservice')
    expect(byTest('matrix-instance-registration-state').text()).toBe('Not made yet')
    expect(byTest('matrix-instance-summary').text()).toContain('No bridge set up yet.')
    expect(byTest('matrix-instance-enabled').attributes('aria-disabled')).toBe('true')
  })

  it('is set up as an account, whose token is written and never read', async () => {
    await open()
    await byTest('matrix-instance-account').setValue()
    expect(byTest('matrix-instance-serverName').exists()).toBe(false)
    await byTest('matrix-instance-homeserverUrl').setValue('https://matrix.example.org')
    expect(disabled('matrix-instance-save')).toBe(true)
    expect(byTest('matrix-instance-token').attributes('type')).toBe('password')
    await byTest('matrix-instance-token').setValue('harmony_bot_x')
    expect(w.text()).toContain("That's a Harmony bot token.")
    expect(disabled('matrix-instance-save')).toBe(true)
    await byTest('matrix-instance-token').setValue('Bearer syt_instance_token')
    expect(byTest('matrix-instance-login').find('pre').text()).toContain('MATRIX_HOMESERVER_URL=https://matrix.example.org')
    await save()
    expect(rpcCalls('matrix_bridge_instance_set')[0]).toMatchObject({ p_connection: 'account', p_access_token: 'syt_instance_token' })
    expect((byTest('matrix-instance-token').element as HTMLInputElement).value).toBe('')
    expect(byTest('matrix-instance-token-state').text()).toBe('Stored')
    expect(disabled('matrix-instance-save')).toBe(true)
    await byTest('matrix-instance-homeserverUrl').setValue('https://other.example.org')
    expect(disabled('matrix-instance-save'), 'the stored token is the other homeserver\'s').toBe(true)
    expect(byTest('matrix-instance-token-state').text()).toBe('Not set')
    expect(byTest('matrix-instance-token').attributes('placeholder')).toBe('')
    await byTest('matrix-instance-token').setValue('syt_other_token')
    expect(disabled('matrix-instance-save')).toBe(false)
    await byTest('matrix-instance-token').setValue('')
    await byTest('matrix-instance-homeserverUrl').setValue('https://matrix.example.org')
    expect(byTest('matrix-instance-token-state').text()).toBe('Stored')
    expect(w.html()).not.toContain('syt_instance_token')
    expect(byTest('matrix-instance-summary').text()).toContain('Bridge set up: https://matrix.example.org.')
    expect(byTest('matrix-instance-registration').exists()).toBe(false)
  })

  it.each([
    ['homeserverUrl', 'matrix.example.org', 'Enter an address such as https://matrix.example.org.'],
    ['serverName', 'https://example.org', 'Enter a name such as example.org.'],
    ['senderLocalpart', 'Harmony Relay', 'Use a to z, 0 to 9 and . _ = - only.'],
    ['appserviceUrl', 'harmony.example', 'Enter an address such as http://192.168.1.20:9009.'],
    ['senderLocalpart', 'a'.repeat(210), 'Too long together with the server name.'],
  ])('refuses %s %j', async (name, value, text) => {
    status = { ...SERVICE }
    await open()
    await byTest(`matrix-instance-${name}`).setValue(value)
    const input = byTest(`matrix-instance-${name}`)
    expect(input.attributes('aria-invalid')).toBe('true')
    expect(w.find(`[id="${input.attributes('aria-describedby')}"]`).text()).toBe(text)
    expect(disabled('matrix-instance-save')).toBe(true)
  })

  it('counts the default account name where none is entered', async () => {
    status = { ...SERVICE, sender_localpart: null, server_name: `${'a'.repeat(202)}.org` }
    await open()
    expect(w.text()).toContain('Too long together with the server name.')
    await byTest('matrix-instance-serverName').setValue(`${'a'.repeat(201)}.org`)
    expect(w.text()).not.toContain('Too long together with the server name.')
  })

  it('reports an answer that is no registration, and saves no file', async () => {
    status = { ...SERVICE }
    installBackend({ instance_config: [] }, (name) => (name === 'matrix_bridge_instance_status' ? status : null))
    await open()
    await click('matrix-instance-make-registration')
    expect(saveBlob).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the Matrix bridge settings")
    expect(byTest('matrix-instance-downloaded').exists()).toBe(false)
  })

  it('downloads the registration once, keeping nothing of it in the page', async () => {
    status = { ...SERVICE }
    await open()
    expect(byTest('matrix-instance-make-registration').text()).toBe('Make the registration file')
    await click('matrix-instance-make-registration')
    expect(byTest('matrix-instance-confirm').exists()).toBe(false)
    expect(rpcCalls('matrix_bridge_instance_registration')).toHaveLength(1)
    const [blob, name] = saveBlob.mock.calls[0] as [Blob, string]
    expect(name).toBe('registration.json')
    expect(JSON.parse(await blob.text())).toEqual(REGISTRATION)
    expect(w.html()).not.toContain('as-secret')
    expect(byTest('matrix-instance-downloaded').attributes('role')).toBe('status')
    expect(byTest('matrix-instance-registration-state').text()).toBe('Made')
    expect(byTest('matrix-instance-summary').text()).toContain('Bridge set up: example.org.')
  })

  it('warns before a new one, which replaces the tokens', async () => {
    status = { ...SERVICE, has_service_tokens: true, configured: true }
    await open()
    await click('matrix-instance-make-registration')
    expect(byTest('matrix-instance-confirm').attributes('role')).toBe('alertdialog')
    expect(byTest('matrix-instance-confirm').text()).toContain('The bridge stops until the homeserver has the new file.')
    await click('matrix-instance-confirm-no')
    expect(saveBlob).not.toHaveBeenCalled()
    await click('matrix-instance-make-registration')
    await click('matrix-instance-confirm-yes')
    expect(saveBlob).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['homeserverUrl', 'https://other.example.org', 'Not made yet'],
    ['serverName', 'other.example.org', 'Made'],
    ['senderLocalpart', 'bridge', 'Made'],
    ['appserviceUrl', 'https://bridge.example.org', 'Made'],
  ])('asks for a new one once %s changed', async (field, value, made) => {
    status = { ...SERVICE, has_service_tokens: true, configured: true }
    await open()
    expect(byTest('matrix-instance-registration-stale').exists()).toBe(false)
    await byTest(`matrix-instance-${field}`).setValue(value)
    await save()
    expect(byTest('matrix-instance-registration-stale').attributes('role')).toBe('alert')
    expect(byTest('matrix-instance-registration-state').text()).toBe(made)
    await click('matrix-instance-make-registration')
    if (made === 'Made') await click('matrix-instance-confirm-yes')
    expect(byTest('matrix-instance-registration-stale').exists()).toBe(false)
  })

  it('is offered once it is set up, with its limit, and removed after asking', async () => {
    status = { ...SERVICE, has_service_tokens: true, configured: true, linked_count: 4 }
    await open()
    await click('matrix-instance-enabled')
    expect(byTest('matrix-instance-count').text()).toBe('Servers that chose it: 4 of 100.')
    await byTest('matrix-instance-limit').setValue('-1')
    expect(disabled('matrix-instance-save-limit')).toBe(true)
    await byTest('matrix-instance-limit').setValue('12')
    await click('matrix-instance-save-limit')
    expect(rpcCalls('batch_set_instance_config')).toEqual([
      { p_keys: ['matrix_bridge_instance_enabled'], p_values: [true] },
      { p_keys: ['matrix_bridge_instance_limit'], p_values: [12] },
    ])
    await click('matrix-instance-clear')
    expect(byTest('matrix-instance-confirm').text()).toContain("Remove the bridge's tokens?")
    await click('matrix-instance-confirm-yes')
    expect(rpcCalls('matrix_bridge_instance_clear')).toHaveLength(1)
    expect(byTest('matrix-instance-summary').text()).toContain('No bridge set up yet.')
    expect(byTest('matrix-instance-clear').exists()).toBe(false)
  })

  it.each(['matrix_bridge_instance_set', 'batch_set_instance_config'])('reports a failed %s without its detail', async (name) => {
    status = { ...SERVICE, has_service_tokens: true, configured: true }
    await open()
    fail = name
    if (name === 'matrix_bridge_instance_set') {
      await byTest('matrix-instance-serverName').setValue('other.org')
      await save()
    } else await click('matrix-instance-enabled')
    expect(toast.error).toHaveBeenCalledWith("Couldn't save the Matrix bridge settings")
    expect(w.text()).not.toContain('secret detail')
    expect(byTest('matrix-instance-enabled').attributes('aria-checked')).toBe('false')
  })

  it('says that it could not be read', async () => {
    fail = 'matrix_bridge_instance_status'
    await open()
    expect(w.find('[role="alert"]').text()).toBe("Couldn't load the Matrix bridge settings.")
    expect(byTest('matrix-instance-form').exists()).toBe(false)
  })
})

describe('the bridge service', () => {
  const matrixHost = (over: Record<string, unknown> = {}) => ({ platform: 'matrix', last_seen_at: seen(20), version: '0.3.0', status: { instance: null, hosted: 2 }, ...over })

  it.each([
    ['matrix', 'harmony bridges add matrix', 'https://docs.mony.lol/self-host/matrix-bridges'],
    ['discord', 'harmony bridges add discord', 'https://docs.mony.lol/self-host/discord-bridges'],
  ])('that was never seen shows the command that starts it: %s', async (platform, command, docs) => {
    await open(BridgeServiceStatus, { platform })
    expect(byTest('bridge-service').attributes('data-state')).toBe('never')
    expect(byTest('service-seen').text()).toBe("The service hasn't connected yet.")
    expect(byTest('service-command').find('pre').text()).toBe(command)
    expect(byTest('service-command').find('[data-testid="copy-button"]').exists()).toBe(true)
    expect(w.find('a').attributes('href')).toBe(docs)
  })

  it('that was seen within five minutes shows when and its version, and no command', async () => {
    hosts = [matrixHost(), { platform: 'discord', last_seen_at: seen(400), version: null, status: {} }]
    await open(BridgeServiceStatus, { platform: 'matrix' })
    expect(byTest('bridge-service').attributes('data-state')).toBe('running')
    expect(byTest('service-seen').text()).toBe('Last heard from 20 seconds ago.')
    expect(byTest('service-version').text()).toBe('version 0.3.0')
    expect(byTest('service-command').exists()).toBe(false)
    expect(byTest('service-problems').exists()).toBe(false)
    w.unmount()
    await open(BridgeServiceStatus, { platform: 'discord' })
    expect(byTest('bridge-service').attributes('data-state')).toBe('absent')
    expect(byTest('service-command').exists()).toBe(true)
  })

  it('turns absent after five minutes and is read again every 30 s', async () => {
    hosts = [matrixHost()]
    await open(BridgeServiceStatus, { platform: 'matrix' })
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await flushPromises()
    expect(byTest('service-command').exists()).toBe(true)
    hosts = [matrixHost({ last_seen_at: new Date(NOW + 5 * 60_000).toISOString() })]
    await vi.advanceTimersByTimeAsync(30_000)
    await flushPromises()
    expect(byTest('service-command').exists()).toBe(false)
  })

  it('lists the problems of its last report, its own words for one unknown here', async () => {
    hosts = [null, { platform: 'other' }, matrixHost({ status: { hosted: 0, instance: { ready: false, problems: [{ code: 'matrix_registration_missing' }, { code: 'odd', detail: '<b>odd</b>' }] } } })]
    await open(BridgeServiceStatus, { platform: 'matrix' })
    const items = byTest('service-problems').findAll('li')
    expect(items.map((li) => li.attributes('data-code'))).toEqual(['matrix_registration_missing', 'odd'])
    expect(items[0].text()).toContain('Give it the registration file and restart it.')
    expect(items[1].text()).toContain('The bridge reported a problem (odd).')
    expect(items[1].text()).toContain('<b>odd</b>')
    expect(w.find('b').exists()).toBe(false)
  })

  it('shows nothing on an instance that does not report its services, or that could not be asked', async () => {
    installBackend({}, () => { throw Object.assign(new Error('missing'), { code: 'PGRST202' }) })
    await open(BridgeServiceStatus, { platform: 'matrix' })
    expect(byTest('bridge-service').exists()).toBe(false)
    w.unmount()
    fail = 'bridge_hosts_status'
    backend()
    await open(BridgeServiceStatus, { platform: 'matrix' })
    expect(byTest('bridge-service').exists()).toBe(false)
  })
})
