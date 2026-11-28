/** MatrixConnectSelf.vue: the setup code, the fields the commands take in, the three ways to start, the registration. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { forgetIssuedSetupCodes } from '../../discord-bridge/bridgeApi'
import { NOW, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import { MATRIX_PLACEHOLDERS } from '@/utils/matrixBridgeSetup'
import MatrixConnectSelf, { forgetMatrixConnectFields } from '../MatrixConnectSelf.vue'
import { BRIDGE_ID } from './matrixTestKit'

vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))

let codes: string[]
let w: VueWrapper
const open = async (props: Record<string, unknown> = {}) => {
  w = mount(MatrixConnectSelf, {
    props: { bridgeId: BRIDGE_ID, harmonyUrl: 'https://harmony.example', ...props },
    attachTo: document.body,
    global: { plugins: [makeI18n()], stubs: { Icon: iconStub } },
  })
  await flushPromises()
  return w
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const command = (id: string) => w.find(`[data-testid="${id}"] pre`).text()

beforeEach(() => {
  missingKeys.length = 0
  forgetIssuedSetupCodes()
  forgetMatrixConnectFields()
  codes = ['MX-AAAA-BBBB-CCCC', 'MX-DDDD-EEEE-FFFF']
  installBackend({}, (name) => (name === 'matrix_bridge_setup_code' ? { code: codes.shift(), expires_at: '2026-11-25T12:30:00Z' } : null))
})
afterEach(() => {
  w?.unmount()
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('MatrixConnectSelf', () => {
  it('shows a code and the command that carries it', async () => {
    await open()
    expect(rpcCalls('matrix_bridge_setup_code')).toEqual([{ p_bridge_id: BRIDGE_ID }])
    expect(byTest('setup-code').text()).toContain('MX-AAAA-BBBB-CCCC')
    expect(byTest('code-expiry').text()).toBe('expires in 30 minutes')
    expect(command('docker-run')).toContain('-e HARMONY_SETUP_CODE=MX-AAAA-BBBB-CCCC')
    expect(command('docker-run')).toContain('-p 9009:9009')
  })

  it('replaces an expired code, in the command too', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    await open()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000)
    expect(byTest('code-expired').attributes('role')).toBe('alert')
    await byTest('new-code').trigger('click')
    await flushPromises()
    expect(byTest('setup-code').text()).toContain('MX-DDDD-EEEE-FFFF')
    expect(byTest('code-expired').exists()).toBe(false)
    expect(command('docker-run')).toContain('HARMONY_SETUP_CODE=MX-DDDD-EEEE-FFFF')
  })

  it('takes valid entries into the command and keeps the placeholder of an invalid one, saying why', async () => {
    await open()
    expect(byTest('matrix-fields-missing').exists()).toBe(true)
    expect(command('docker-run')).toContain(`MATRIX_HOMESERVER_URL=${MATRIX_PLACEHOLDERS.homeserverUrl}`)
    const homeserver = byTest('matrix-field-homeserverUrl')
    expect(w.find(`label[for="${homeserver.attributes('id')}"]`).text()).toBe('Homeserver address')
    expect(homeserver.attributes('aria-describedby')).toBe(byTest('matrix-field-homeserverUrl-help').attributes('id'))

    await homeserver.setValue('matrix.example.org')
    expect(homeserver.attributes('aria-invalid')).toBe('true')
    expect(byTest('matrix-field-homeserverUrl-help').text()).toBe('Enter an address such as https://matrix.example.org.')
    expect(command('docker-run')).toContain(`MATRIX_HOMESERVER_URL=${MATRIX_PLACEHOLDERS.homeserverUrl}`)

    await homeserver.setValue('https://matrix.example.org/')
    await byTest('matrix-field-serverName').setValue('@sam:example.org')
    await byTest('matrix-field-appserviceUrl').setValue('http://10.0.0.2:9009')
    expect(homeserver.attributes('aria-invalid')).toBeUndefined()
    expect(byTest('matrix-fields-missing').exists()).toBe(false)
    expect(command('docker-run')).toContain(
      '-e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_SERVER_NAME=example.org -e MATRIX_APPSERVICE_URL=http://10.0.0.2:9009 ',
    )
  })

  it('keeps the entries and the code when the step is shown again', async () => {
    await open()
    await byTest('matrix-field-serverName').setValue('example.org')
    w.unmount()
    await open()
    expect((byTest('matrix-field-serverName').element as HTMLInputElement).value).toBe('example.org')
    expect(rpcCalls('matrix_bridge_setup_code')).toHaveLength(1)
  })

  it('offers Docker, Compose and the source, and says where the registration is in each', async () => {
    await open()
    expect(w.findAll('[role="tab"]').map((tab) => tab.text())).toEqual(['Docker command', 'Docker Compose', 'From source'])
    expect(w.text()).toContain('Docker Desktop')
    expect(command('matrix-registration-copy')).toBe('docker cp harmony-matrix-bridge:/data/registration.json .')
    expect(byTest('matrix-registration').text()).toContain('app_service_config_files')

    await byTest('variant-compose').trigger('click')
    expect(command('docker-compose')).toContain('HARMONY_SETUP_CODE: "MX-AAAA-BBBB-CCCC"')

    ;(byTest('variant-compose').element as HTMLElement).focus()
    await byTest('variant-compose').trigger('keydown', { key: 'ArrowRight' })
    expect(byTest('variant-source').attributes('aria-selected')).toBe('true')
    expect(document.activeElement).toBe(byTest('variant-source').element)
    expect(command('matrix-source-install')).toContain('npm run build')
    expect(command('matrix-source-env')).toContain('HARMONY_SETUP_CODE=MX-AAAA-BBBB-CCCC')
    expect(command('matrix-source-run')).toBe('node --env-file=.env dist/index.js')
    expect(byTest('matrix-registration').text()).toContain('data/registration.json')
    expect(byTest('matrix-registration-copy').exists()).toBe(false)
    expect(w.text()).not.toContain('Docker Desktop')
  })

  it('never tells anyone to delete the data volume', async () => {
    await open()
    expect(w.text()).not.toContain('volume rm')
    expect(byTest('matrix-keep-data').text()).toContain('harmony-matrix-bridge-data')
  })

  it('offers both ways to sign in, the application service first, and no choice where one is offered', async () => {
    await open()
    expect(byTest('matrix-connection').find('legend').text()).toBe('How the bridge signs in to Matrix')
    expect((byTest('matrix-connection-application_service').element as HTMLInputElement).checked).toBe(true)
    expect(byTest('matrix-login').exists()).toBe(false)
    w.unmount()
    forgetMatrixConnectFields()
    await open({ connections: ['application_service'] })
    expect(byTest('matrix-connection').exists()).toBe(false)
    expect(byTest('matrix-field-serverName').exists()).toBe(true)
  })

  it('asks for less with a Matrix account, and hands out a command that signs in from the terminal', async () => {
    await open()
    await byTest('matrix-connection-account').setValue()
    expect(byTest('matrix-field-serverName').exists()).toBe(false)
    expect(byTest('matrix-field-appserviceUrl').exists()).toBe(false)
    expect(byTest('matrix-registration').exists()).toBe(false)
    expect(byTest('matrix-token-note').text()).toBe("A token copied from a Matrix app's settings works only where tokens do not expire; on matrix.org they do, within minutes.")
    await byTest('matrix-field-homeserverUrl').setValue('https://matrix.example.org')
    expect(command('matrix-login')).toBe(
      'docker run --rm -it -e MATRIX_HOMESERVER_URL=https://matrix.example.org ghcr.io/y4my4my4m/harmony-matrix-bridge:latest node dist/index.js --login',
    )
    expect(w.text()).toContain(`Replace ${MATRIX_PLACEHOLDERS.accessToken}`)
    expect(command('docker-run')).toContain(`-e MATRIX_ACCESS_TOKEN=${MATRIX_PLACEHOLDERS.accessToken}`)
    expect(command('docker-run')).not.toContain('-p 9009')
    expect(byTest('matrix-keep-data').text()).not.toContain('registration')
    await byTest('variant-source').trigger('click')
    expect(command('matrix-login')).toBe('node --env-file=.env dist/index.js --login')
  })

  it('opens on the way the bridge signs in now', async () => {
    await open({ connection: 'account' })
    expect((byTest('matrix-connection-account').element as HTMLInputElement).checked).toBe(true)
  })

  it('waits for a click when a code is optional', async () => {
    await open({ autoIssue: false })
    expect(rpcCalls('matrix_bridge_setup_code')).toEqual([])
    await byTest('issue-code').trigger('click')
    await flushPromises()
    expect(byTest('setup-code').text()).toContain('MX-AAAA-BBBB-CCCC')
  })

  it('offers a retry when issuing fails', async () => {
    installBackend({}, () => { throw new Error('boom') })
    await open()
    expect(w.text()).toContain("Couldn't get a setup code. Try again.")
  })
})
