/**
 * BridgeConnectSelf.vue and BridgeConnectHosted.vue: the copy-paste command with a fresh
 * setup code, its expiry and refresh; the hosted token field, its checks and the RPC.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeConnectSelf from '../BridgeConnectSelf.vue'
import BridgeConnectHosted from '../BridgeConnectHosted.vue'
import { forgetIssuedSetupCodes } from '../bridgeApi'
import { DISCORD_TOKEN_PLACEHOLDER } from '@/utils/discordBridgeSetup'
import { NOW, iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from './bridgeTestKit'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub } })
const TOKEN = ['MTIzNDU2Nzg5MDEyMzQ1Njc4OQ', 'GaBcDe', 'abcdefghijklmnopqrstuvwxyz0123456789AB'].join('.')

beforeEach(() => {
  missingKeys.length = 0
  forgetIssuedSetupCodes()
})

afterEach(() => {
  vi.useRealTimers()
  expect(missingKeys).toEqual([])
})

describe('BridgeConnectSelf', () => {
  let codes: string[]
  beforeEach(() => {
    codes = ['HB-AAAA-BBBB-CCCC', 'HB-DDDD-EEEE-FFFF']
    installBackend({}, (name) => (name === 'discord_bridge_setup_code' ? codes.shift() : null))
  })

  it('issues a setup code and shows the exact command with it', async () => {
    const w = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://harmony.example' }, global: global() })
    await flushPromises()
    expect(rpcCalls('discord_bridge_setup_code')).toEqual([{ p_bridge_id: 'b1' }])
    expect(w.find('[data-testid="setup-code"]').text()).toContain('HB-AAAA-BBBB-CCCC')
    const command = w.find('[data-testid="docker-run"] pre').text()
    expect(command).toBe(
      'docker run -d --name harmony-discord-bridge --restart unless-stopped -e HARMONY_URL=https://harmony.example ' +
        `-e HARMONY_SETUP_CODE=HB-AAAA-BBBB-CCCC -e DISCORD_TOKEN=${DISCORD_TOKEN_PLACEHOLDER} ` +
        '-v harmony-bridge-data:/data ghcr.io/y4my4my4m/harmony-discord-bridge:latest',
    )
    expect(w.text()).toContain('Docker Desktop')
    expect(w.text()).toContain('PowerShell (Windows)')
    expect(w.find('[data-testid="code-expiry"]').text()).toBe('expires in 30 minutes')
  })

  it('copies the command', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    const w = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    await w.find('[data-testid="docker-run"] [data-testid="copy-button"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining('HARMONY_SETUP_CODE=HB-AAAA-BBBB-CCCC'))
    expect(w.find('[data-testid="docker-run"] [data-testid="copy-button"]').text()).toBe('Copied')
  })

  it('switches to the compose variant', async () => {
    const w = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    await w.find('[data-testid="variant-compose"]').trigger('click')
    const compose = w.find('[data-testid="docker-compose"] pre').text()
    expect(compose).toContain('HARMONY_SETUP_CODE: "HB-AAAA-BBBB-CCCC"')
    expect(compose).toContain('image: ghcr.io/y4my4my4m/harmony-discord-bridge:latest')
    expect(w.text()).toContain('docker compose up -d')
  })

  it('marks the code expired after 30 minutes and issues a new one on request', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const w = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    await vi.advanceTimersByTimeAsync(29 * 60 * 1000)
    expect(w.find('[data-testid="code-expiry"]').text()).toBe('expires in 1 minute')
    await vi.advanceTimersByTimeAsync(60 * 1000)
    expect(w.find('[data-testid="code-expired"]').text()).toContain('has expired')
    await w.find('[data-testid="new-code"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_setup_code')).toHaveLength(2)
    expect(w.find('[data-testid="setup-code"]').text()).toContain('HB-DDDD-EEEE-FFFF')
    expect(w.find('[data-testid="code-expired"]').exists()).toBe(false)
    expect(w.find('[data-testid="docker-run"] pre').text()).toContain('HB-DDDD-EEEE-FFFF')
  })

  it('reuses the unexpired code when the step is shown again', async () => {
    const first = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    first.unmount()
    const second = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    expect(rpcCalls('discord_bridge_setup_code')).toHaveLength(1)
    expect(second.find('[data-testid="setup-code"]').text()).toContain('HB-AAAA-BBBB-CCCC')
  })

  it('waits for a click when auto issuing is off', async () => {
    const w = mount(BridgeConnectSelf, {
      props: { bridgeId: 'b1', harmonyUrl: 'https://h.example', autoIssue: false },
      global: global(),
    })
    await flushPromises()
    expect(rpcCalls('discord_bridge_setup_code')).toEqual([])
    await w.find('[data-testid="issue-code"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-testid="setup-code"]').text()).toContain('HB-AAAA-BBBB-CCCC')
  })

  it('offers a retry when issuing fails', async () => {
    installBackend({}, () => {
      throw new Error('boom')
    })
    const w = mount(BridgeConnectSelf, { props: { bridgeId: 'b1', harmonyUrl: 'https://h.example' }, global: global() })
    await flushPromises()
    expect(w.text()).toContain("Couldn't get a setup code. Try again.")
    expect(w.find('button').text()).toBe('Try again')
  })
})

describe('BridgeConnectHosted', () => {
  beforeEach(() => {
    installBackend({}, () => null)
  })

  function mountHosted() {
    return mount(BridgeConnectHosted, { props: { bridgeId: 'b1' }, global: global() })
  }

  it('uses a labelled password field that is not echoed back after saving', async () => {
    const w = mountHosted()
    const input = w.find('[data-testid="hosted-token"]')
    expect(input.attributes('type')).toBe('password')
    expect(w.find(`label[for="${input.attributes('id')}"]`).text()).toBe('Discord bot token')
    await input.setValue(`  ${TOKEN} `)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(rpcCalls('discord_bridge_set_hosted_token')).toEqual([{ p_bridge_id: 'b1', p_discord_token: TOKEN }])
    expect((w.find('[data-testid="hosted-token"]').element as HTMLInputElement).value).toBe('')
    expect(w.find('[data-testid="token-saved"]').exists()).toBe(true)
    expect(w.emitted('saved')).toHaveLength(1)
    expect(w.text()).not.toContain(TOKEN)
  })

  it.each([
    ['', 'Paste the token first.'],
    ['111111111111111111', "That's the Application ID."],
    ['a'.repeat(64), "That's the Public Key."],
    ['not a token', "That doesn't look like a Discord bot token."],
  ])('rejects %j with a pointed message', async (value, message) => {
    const w = mountHosted()
    await w.find('[data-testid="hosted-token"]').setValue(value)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.find('[data-testid="token-error"]').text()).toContain(message)
    expect(w.find('[data-testid="hosted-token"]').attributes('aria-invalid')).toBe('true')
    expect(rpcCalls('discord_bridge_set_hosted_token')).toEqual([])
  })

  it('reveals the token on request', async () => {
    const w = mountHosted()
    await w.findAll('button').find((b) => b.text() === 'Show')!.trigger('click')
    expect(w.find('[data-testid="hosted-token"]').attributes('type')).toBe('text')
  })

  it('explains a failed save', async () => {
    installBackend({}, () => {
      throw Object.assign(new Error('only hosted bridges take a token'), { code: 'P0001' })
    })
    const w = mountHosted()
    await w.find('[data-testid="hosted-token"]').setValue(TOKEN)
    await w.find('form').trigger('submit')
    await flushPromises()
    expect(w.text()).toContain("Couldn't save the token. Try again.")
    expect(w.emitted('saved')).toBeUndefined()
  })
})
