/** MatrixConnectHosted.vue: signing in from the browser, pasting a token, and what never leaves the page. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { iconStub, installBackend, makeI18n, missingKeys, rpcCalls } from '../../discord-bridge/__tests__/bridgeTestKit'
import { debug } from '@/utils/debug'
import MatrixConnectHosted from '../MatrixConnectHosted.vue'
import { BRIDGE_ID, rawState } from './matrixTestKit'

const PASSWORD = 'correct horse battery'
let w: VueWrapper
let replies: Record<string, { status?: number; body?: unknown } | Error>
const calls: { method: string; url: string; body?: string; auth?: string }[] = []
let fail: Error | null

beforeEach(() => {
  missingKeys.length = 0
  fail = null
  calls.length = 0
  replies = {
    'GET https://example.org/.well-known/matrix/client': { body: { 'm.homeserver': { base_url: 'https://matrix.example.org' } } },
    'GET https://matrix.example.org/_matrix/client/v3/login': { body: { flows: [{ type: 'm.login.password' }] } },
    'POST https://matrix.example.org/_matrix/client/v3/login': { body: { access_token: 'syt_secret_token' } },
    'POST https://matrix.example.org/_matrix/client/v3/logout': { body: {} },
    'GET https://matrix.example.org/_matrix/client/v3/account/whoami': { body: { user_id: '@b:example.org' } },
  }
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? 'GET'
    calls.push({ method, url, body: init.body as string, auth: (init.headers as Record<string, string> | undefined)?.Authorization })
    const reply = replies[`${method} ${url}`] ?? new TypeError('Failed to fetch')
    if (reply instanceof Error) throw reply
    return new Response(JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200 })
  }))
  installBackend({}, (name) => {
    if (fail) throw fail
    return name === 'matrix_bridge_set_account' ? rawState({ mode: 'hosted', homeserver_url: 'https://example.org', has_account: true }) : null
  })
})
afterEach(() => {
  w?.unmount()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  expect(missingKeys).toEqual([])
})

function open(props: Record<string, unknown> = {}) {
  w = mount(MatrixConnectHosted, { props: { bridgeId: BRIDGE_ID, ...props }, attachTo: document.body, global: { plugins: [makeI18n()], stubs: { Icon: iconStub } } })
}
const byTest = (id: string) => w.find(`[data-testid="${id}"]`)
const value = (id: string) => (byTest(id).element as HTMLInputElement).value
const submit = async () => { await w.find('form').trigger('submit'); await flushPromises() }
async function fill() {
  await byTest('matrix-hosted-homeserver').setValue('example.org')
  await byTest('matrix-hosted-user').setValue('bridge')
  await byTest('matrix-hosted-password').setValue(PASSWORD)
}

describe('signing in', () => {
  it('says who can read the rooms, that a separate account is best, and where the password goes', () => {
    open()
    expect(byTest('matrix-hosted-access').text()).toContain('can read every room the account is in')
    expect(byTest('matrix-hosted-access').text()).toContain('Use an account made for the bridge')
    expect(byTest('matrix-hosted-access').text()).toContain("End-to-end encrypted rooms aren't relayed")
    expect(byTest('matrix-hosted-password-help').text()).toBe("The password goes from your browser to the homeserver alone. Harmony never gets it, and it isn't kept.")
    expect(byTest('matrix-hosted-password').attributes('aria-describedby')).toBe(byTest('matrix-hosted-password-help').attributes('id'))
    expect(byTest('matrix-hosted-password').attributes('type')).toBe('password')
  })

  it('signs in at the homeserver and sends Harmony the token alone', async () => {
    const spies = (['error', 'warn', 'log', 'info'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
    open()
    await fill()
    await submit()
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual([
      'GET https://example.org/.well-known/matrix/client',
      'GET https://matrix.example.org/_matrix/client/v3/login',
      'POST https://matrix.example.org/_matrix/client/v3/login',
    ])
    expect(calls.filter((c) => c.body?.includes(PASSWORD))).toHaveLength(1)
    expect(rpcCalls('matrix_bridge_set_account')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_homeserver_url: 'https://example.org', p_access_token: 'syt_secret_token' },
    ])
    expect(JSON.stringify(rpcCalls('matrix_bridge_set_account'))).not.toContain(PASSWORD)
    expect(value('matrix-hosted-password')).toBe('')
    expect(w.html()).not.toContain(PASSWORD)
    expect(w.html()).not.toContain('syt_secret_token')
    expect(byTest('matrix-hosted-saved').attributes('role')).toBe('status')
    expect((w.emitted('saved')![0][0] as { has_account: boolean }).has_account).toBe(true)
    expect(JSON.stringify(spies.flatMap((spy) => spy.mock.calls))).not.toContain(PASSWORD)
    expect({ ...localStorage, ...sessionStorage }).toEqual({})
  })

  it.each([
    ['wrong_password', 'POST https://matrix.example.org/_matrix/client/v3/login', { status: 403, body: { errcode: 'M_FORBIDDEN' } }, 'The homeserver refused the user name or the password.'],
    ['limited', 'POST https://matrix.example.org/_matrix/client/v3/login', { status: 429, body: { errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 2000 } }, 'Too many tries. Try again in 2 seconds.'],
    ['unreachable', 'GET https://matrix.example.org/_matrix/client/v3/login', new TypeError('CORS'), "The homeserver can't be reached from this browser."],
    ['not_matrix', 'GET https://matrix.example.org/_matrix/client/v3/login', { status: 404 }, 'No Matrix homeserver answered there.'],
    ['expires', 'POST https://matrix.example.org/_matrix/client/v3/login', { body: { access_token: 'syt_secret_token', expires_in_ms: 1 } }, 'access tokens that expire'],
  ])('explains %s, forgets the password and saves nothing', async (issue, at, reply, text) => {
    replies[at] = reply as Error
    open()
    await fill()
    await submit()
    expect(byTest('matrix-hosted-issue').attributes()).toMatchObject({ role: 'alert', 'data-issue': issue })
    expect(byTest('matrix-hosted-issue').text()).toContain(text)
    expect(value('matrix-hosted-password')).toBe('')
    expect(value('matrix-hosted-user')).toBe('bridge')
    expect(rpcCalls('matrix_bridge_set_account')).toEqual([])
    await byTest('matrix-hosted-password').setValue('x')
    expect(byTest('matrix-hosted-issue').exists()).toBe(false)
  })

  it('turns to pasting a token where no password sign-in is offered', async () => {
    replies['GET https://matrix.example.org/_matrix/client/v3/login'] = { body: { flows: [{ type: 'm.login.sso' }] } }
    open()
    await fill()
    await submit()
    expect(byTest('matrix-hosted-issue').text()).toContain('Paste an access token instead.')
    expect(byTest('matrix-hosted-token').exists()).toBe(true)
    expect(byTest('matrix-hosted-password').exists()).toBe(false)
    expect(calls.some((c) => c.method === 'POST')).toBe(false)
  })

  it('asks for a homeserver and for both values before asking anyone', async () => {
    open()
    await submit()
    expect(byTest('matrix-hosted-homeserver').attributes('aria-invalid')).toBe('true')
    expect(byTest('matrix-hosted-homeserver-help').text()).toBe('Enter a server name such as matrix.org, or an https address.')
    await byTest('matrix-hosted-homeserver').setValue('http://example.org')
    await submit()
    expect(byTest('matrix-hosted-homeserver').attributes('aria-invalid')).toBe('true')
    await byTest('matrix-hosted-homeserver').setValue('example.org')
    await submit()
    expect(byTest('matrix-hosted-issue').text()).toBe('Enter the user name and the password.')
    expect(calls).toEqual([])
  })

  it('ends the session when Harmony does not take the token, without printing anything of it', async () => {
    const logged = vi.spyOn(debug, 'error').mockImplementation(() => {})
    fail = Object.assign(new Error('syt_secret_token is refused'), { code: '0A000' })
    open()
    await fill()
    await submit()
    expect(byTest('matrix-hosted-error').text()).toContain("doesn't offer that at the moment")
    expect(calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://matrix.example.org/_matrix/client/v3/logout', auth: 'Bearer syt_secret_token' })
    expect(JSON.stringify(logged.mock.calls)).not.toContain('syt_secret_token')
    expect(w.emitted('saved')).toBeUndefined()
  })
})

describe('pasting a token', () => {
  async function paste(token: string) {
    await byTest('matrix-hosted-method-token').setValue()
    await byTest('matrix-hosted-homeserver').setValue('example.org')
    await byTest('matrix-hosted-token').setValue(token)
    await submit()
  }

  it('saves one the homeserver knows', async () => {
    open()
    await paste(' Bearer syt_pasted_token ')
    expect(rpcCalls('matrix_bridge_set_account')).toEqual([
      { p_bridge_id: BRIDGE_ID, p_homeserver_url: 'https://example.org', p_access_token: 'syt_pasted_token' },
    ])
    expect(value('matrix-hosted-token')).toBe('')
    expect(w.text()).toContain('works only where tokens do not expire')
  })

  it('refuses one it does not know, and one that is no token', async () => {
    replies['GET https://matrix.example.org/_matrix/client/v3/account/whoami'] = { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN' } }
    open()
    await paste('syt_pasted_token')
    expect(byTest('matrix-hosted-issue').text()).toContain("The homeserver doesn't know this token.")
    await paste('harmony_bot_abc')
    expect(byTest('matrix-hosted-issue').text()).toContain("That's a Harmony bot token.")
    await paste('')
    expect(byTest('matrix-hosted-issue').text()).toBe('Paste the token first.')
    expect(rpcCalls('matrix_bridge_set_account')).toEqual([])
  })

  it('saves one this browser cannot ask the homeserver about', async () => {
    replies = {}
    open({ homeserverUrl: 'https://example.org' })
    expect(value('matrix-hosted-homeserver')).toBe('https://example.org')
    await paste('syt_pasted_token')
    expect(rpcCalls('matrix_bridge_set_account')).toHaveLength(1)
  })
})
