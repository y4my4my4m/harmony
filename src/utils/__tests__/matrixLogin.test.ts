/** matrixLogin.ts: discovery, sign-in and token checks against a homeserver played by fetch. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  MatrixSignInError,
  checkMatrixToken,
  checkTokenWithHomeserver,
  homeserverOrigin,
  requirePasswordLogin,
  resolveClientApi,
  signInWithPassword,
  signOut,
} from '../matrixLogin'

type Reply = { status?: number; body?: unknown; text?: string; headers?: Record<string, string> } | Error
let replies: Record<string, Reply>
const calls: { url: string; init: RequestInit }[] = []

beforeEach(() => {
  replies = {}
  calls.length = 0
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init })
    const reply = replies[`${init.method ?? 'GET'} ${url}`] ?? new TypeError('Failed to fetch')
    if (reply instanceof Error) throw reply
    return new Response(reply.text ?? JSON.stringify(reply.body ?? {}), { status: reply.status ?? 200, headers: reply.headers })
  }))
})
afterEach(() => vi.unstubAllGlobals())

const HS = 'https://hs.org'
const LOGIN = `${HS}/_matrix/client/v3/login`
const issue = async (promise: Promise<unknown>) => promise.then(() => null, (e: MatrixSignInError) => e.issue)

describe('homeserverOrigin', () => {
  it.each([
    ['matrix.org', 'https://matrix.org'],
    ['@sam:matrix.org', 'https://matrix.org'],
    [' https://Matrix.Example.org/ ', 'https://matrix.example.org'],
    ['example.org:8448', 'https://example.org:8448'],
    ['http://example.org', null],
    ['https://user:pw@example.org', null],
    ['https://example.org/path', null],
    ['https://example.org/?a=b', null],
    ['two words', null],
    ['', null],
  ])('reads %j as %j', (text, origin) => {
    expect(homeserverOrigin(text)).toBe(origin)
  })
})

describe('resolveClientApi', () => {
  it('takes the base URL the server name gives', async () => {
    replies[`GET ${HS}/.well-known/matrix/client`] = { body: { 'm.homeserver': { base_url: 'https://matrix.hs.org/' } } }
    expect(await resolveClientApi(HS)).toBe('https://matrix.hs.org')
    expect(calls[0].init).toMatchObject({ credentials: 'omit', referrerPolicy: 'no-referrer', redirect: 'follow' })
    replies[`GET ${HS}/.well-known/matrix/client`] = { body: { 'm.homeserver': { base_url: 'https://hs.org/matrix/' } } }
    expect(await resolveClientApi(HS)).toBe('https://hs.org/matrix')
  })

  it.each([
    ['nothing answers', undefined],
    ['there is none', { status: 404, text: '<html>' }],
    ['it names none', { body: { 'm.homeserver': {} } }],
  ])('takes the address itself when %s', async (_why, reply) => {
    if (reply) replies[`GET ${HS}/.well-known/matrix/client`] = reply
    expect(await resolveClientApi(HS)).toBe(HS)
  })

  it.each(['http://matrix.hs.org', 'https://user:pw@matrix.hs.org', 'not a url'])('refuses %s: a password is sent there', async (base_url) => {
    replies[`GET ${HS}/.well-known/matrix/client`] = { body: { 'm.homeserver': { base_url } } }
    expect(await issue(resolveClientApi(HS))).toBe('not_matrix')
  })
})

describe('requirePasswordLogin', () => {
  it('accepts a homeserver that signs people in with a password', async () => {
    replies[`GET ${LOGIN}`] = { body: { flows: [{ type: 'm.login.sso' }, { type: 'm.login.password' }] } }
    await requirePasswordLogin(HS)
  })

  it.each([
    ['no_password', { body: { flows: [{ type: 'm.login.sso' }, null] } }],
    ['not_matrix', { text: '<html>' }],
    ['not_matrix', { status: 404, text: 'not found' }],
    ['refused', { status: 403, body: { errcode: 'M_FORBIDDEN' } }],
    ['limited', { status: 429, body: { errcode: 'M_LIMIT_EXCEEDED' } }],
    ['unreachable', new TypeError('CORS')],
  ])('reads %s', async (expected, reply) => {
    replies[`GET ${LOGIN}`] = reply as Reply
    expect(await issue(requirePasswordLogin(HS))).toBe(expected)
  })
})

describe('signInWithPassword', () => {
  it('asks for a session that does not expire, and follows no redirect', async () => {
    replies[`POST ${LOGIN}`] = { body: { access_token: 'syt_token_123', user_id: '@b:hs.org' } }
    expect(await signInWithPassword(HS, 'bridge', 'p"w\\')).toBe('syt_token_123')
    expect(JSON.parse(calls[0].init.body as string)).toEqual({
      type: 'm.login.password',
      identifier: { type: 'm.id.user', user: 'bridge' },
      password: 'p"w\\',
      initial_device_display_name: 'Harmony bridge',
    })
    expect(calls[0].init.redirect).toBe('error')
  })

  it.each([
    ['wrong_password', 403, { errcode: 'M_FORBIDDEN' }],
    ['deactivated', 403, { errcode: 'M_USER_DEACTIVATED' }],
    ['refused', 400, { errcode: 'M_UNKNOWN' }],
    ['limited', 429, {}],
    ['limited', 400, { errcode: 'M_LIMIT_EXCEEDED' }],
    ['not_matrix', 500, {}],
    ['not_matrix', 200, { access_token: 'bad token' }],
  ])('reads %s', async (expected, status, body) => {
    replies[`POST ${LOGIN}`] = { status, body }
    expect(await issue(signInWithPassword(HS, 'a', 'b'))).toBe(expected)
  })

  it.each([
    [{ errcode: 'M_LIMIT_EXCEEDED', retry_after_ms: 4200 }, {}, 5],
    [{ errcode: 'M_LIMIT_EXCEEDED' }, { 'Retry-After': '30' }, 30],
    [{ errcode: 'M_LIMIT_EXCEEDED' }, {}, 0],
  ])('says how long to wait: %j %j', async (body, headers, seconds) => {
    replies[`POST ${LOGIN}`] = { status: 429, body, headers: headers as Record<string, string> }
    const error = await signInWithPassword(HS, 'a', 'b').catch((e: MatrixSignInError) => e)
    expect(error).toMatchObject({ issue: 'limited', retryAfterSeconds: seconds })
  })

  it('takes a token whose lifetime fields are null', async () => {
    replies[`POST ${LOGIN}`] = { body: { access_token: 'syt_token_123', expires_in_ms: null, refresh_token: null } }
    expect(await signInWithPassword(HS, 'a', 'b')).toBe('syt_token_123')
  })

  it.each([{ expires_in_ms: 300_000 }, { refresh_token: 'syr_1' }])('ends and refuses a session that expires: %j', async (lifetime) => {
    replies[`POST ${LOGIN}`] = { body: { access_token: 'syt_token_123', ...lifetime } }
    replies[`POST ${HS}/_matrix/client/v3/logout`] = { body: {} }
    expect(await issue(signInWithPassword(HS, 'a', 'b'))).toBe('expires')
    expect(calls.at(-1)).toMatchObject({ url: `${HS}/_matrix/client/v3/logout`, init: { headers: { Authorization: 'Bearer syt_token_123' } } })
  })

  it('never carries the password in an error', async () => {
    replies[`POST ${LOGIN}`] = { status: 403, body: { errcode: 'M_FORBIDDEN', error: 'hunter2' } }
    const error = await signInWithPassword(HS, 'a', 'hunter2').catch((e: Error) => e)
    expect(`${(error as Error).message} ${(error as Error).stack}`).not.toContain('hunter2')
  })
})

describe('tokens', () => {
  it.each([
    ['  syt_abcdefgh ', 'syt_abcdefgh', null],
    ['Bearer "syt_abcdefgh"', 'syt_abcdefgh', null],
    ['', '', 'empty'],
    ['harmony_bot_0123456789', 'harmony_bot_0123456789', 'harmonyToken'],
    ['short', 'short', 'notToken'],
    ['two words here', 'two words here', 'notToken'],
  ])('reads %j', (input, token, expected) => {
    expect(checkMatrixToken(input)).toEqual({ token, issue: expected })
  })

  it('refuses a token the homeserver does not know, and lets one pass it cannot ask about', async () => {
    const whoami = `GET ${HS}/_matrix/client/v3/account/whoami`
    replies[whoami] = { status: 401, body: { errcode: 'M_UNKNOWN_TOKEN' } }
    expect(await issue(checkTokenWithHomeserver(HS, 'syt_abcdefgh'))).toBe('token_refused')
    replies[whoami] = { body: { user_id: '@b:hs.org' } }
    expect(await issue(checkTokenWithHomeserver(HS, 'syt_abcdefgh'))).toBeNull()
    replies[whoami] = new TypeError('CORS')
    expect(await issue(checkTokenWithHomeserver(HS, 'syt_abcdefgh'))).toBeNull()
  })

  it('does not fail when a session cannot be ended', async () => {
    await signOut(HS, 'syt_abcdefgh')
    expect(calls).toHaveLength(1)
  })
})
