/**
 * harmony auth add-provider and providers: the node programs of self-host/admin.sh
 * (NODE_PROVIDER_ADD, NODE_PROVIDER_LIST), run as fed_node runs them, against a stand-in for
 * GoTrue's custom provider admin API, PostgREST's instance_config and an issuer's discovery
 * document.
 *
 * GoTrue 2.197.0's OIDC type reads the person from the ID token alone (CustomOIDCProvider.GetUserData);
 * a provider that keeps email for userinfo (OIDC Core 5.4: Better Auth, Authelia 4.39+) fails there
 * with "Error getting user email from external provider". An --issuer provider is stored as GoTrue's
 * OAuth 2.0 type with the discovery document's endpoints; --id-token keeps the OIDC type.
 */
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { resolve } from 'node:path'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'

const ADMIN = readFileSync(resolve(__dirname, '../../self-host/admin.sh'), 'utf8')

/** The body of a single-quoted NAME='...' program in admin.sh. */
function program(name: string): string {
  const m = new RegExp(`^${name}='\\n([\\s\\S]*?)\\n'$`, 'm').exec(ADMIN)
  if (!m) throw new Error(`${name} is not in admin.sh`)
  return m[1]
}

type Json = Record<string, any>

const PROVIDERS = '/auth/v1/admin/custom-providers'
let base = ''
let providers: Map<string, Json>
let secrets: Map<string, string>
let shown: Json[]
let calls: string[]
let discovery: { status: number; body: unknown }
/** A message makes the stand-in refuse that POST with HTTP 400. */
let refuse: (body: Json) => string | null

function reply(res: http.ServerResponse, status: number, body?: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(body === undefined ? '' : JSON.stringify(body))
}

const server = http.createServer(async (req, res) => {
  const chunks: Buffer[] = []
  for await (const c of req) chunks.push(c as Buffer)
  const text = Buffer.concat(chunks).toString('utf8')
  const body = text ? JSON.parse(text) : {}
  const url = new URL(req.url ?? '/', 'http://x')
  calls.push(`${req.method} ${url.pathname}`)

  if (url.pathname.endsWith('/.well-known/openid-configuration')) {
    res.writeHead(discovery.status, { 'Content-Type': 'application/json' })
    return res.end(typeof discovery.body === 'string' ? discovery.body : JSON.stringify(discovery.body))
  }
  if (url.pathname === '/rest/v1/instance_config') {
    if (req.method === 'GET') return reply(res, 200, [{ config_value: shown }])
    shown = body.config_value
    return reply(res, 201)
  }
  if (url.pathname === PROVIDERS && req.method === 'GET') return reply(res, 200, { providers: [...providers.values()] })
  if (url.pathname === PROVIDERS && req.method === 'POST') {
    const why = refuse(body)
      ?? (providers.has(body.identifier) ? 'provider exists' : null)
      ?? (!body.name || !body.client_id || !body.client_secret ? 'name, client_id and client_secret are required' : null)
      ?? (body.provider_type === 'oidc' && !body.issuer ? 'issuer is required for OIDC providers' : null)
      ?? (body.provider_type === 'oauth2' && !(body.authorization_url && body.token_url && body.userinfo_url)
        ? 'authorization_url, token_url and userinfo_url are required' : null)
    if (why) return reply(res, 400, { msg: why })
    const { client_secret: secret, ...rest } = body
    const scopes = rest.provider_type === 'oidc' && !rest.scopes?.includes('openid') ? ['openid', ...(rest.scopes ?? [])] : rest.scopes ?? []
    const stored = { pkce_enabled: true, enabled: true, email_optional: false, ...rest, scopes }
    providers.set(body.identifier, stored)
    secrets.set(body.identifier, secret)
    return reply(res, 201, stored)
  }
  const id = decodeURIComponent(url.pathname.slice(PROVIDERS.length + 1))
  const stored = providers.get(id)
  if (!url.pathname.startsWith(`${PROVIDERS}/`) || !stored) return reply(res, 404, { msg: 'not found' })
  if (req.method === 'DELETE') {
    providers.delete(id)
    secrets.delete(id)
    return reply(res, 204)
  }
  if (req.method === 'PUT') {
    const { client_secret: secret, ...rest } = body
    if (secret) secrets.set(id, secret)
    Object.assign(stored, rest)
    return reply(res, 200, stored)
  }
  return reply(res, 405)
})

const b64 = (s: string) => Buffer.from(s).toString('base64')

/** run_node: PARAMS_B64, NODE_LIB, then the program, on node --input-type=module. */
function run(names: string[], params: Record<string, string>): Promise<Json> {
  const json = JSON.stringify(Object.fromEntries(Object.entries(params).map(([k, v]) => [k, b64(v)])))
  const source = [`const PARAMS_B64 = "${b64(json)}";`, program('NODE_LIB'), ...names.map(program)].join('\n')
  return new Promise((done, failed) => {
    const child = spawn(process.execPath, ['--input-type=module', '-'], {
      env: { PATH: process.env.PATH, SUPABASE_URL: base, SUPABASE_SERVICE_ROLE_KEY: 'service', SUPABASE_ANON_KEY: 'anon' },
    })
    let out = ''
    let err = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { err += d })
    child.on('error', failed)
    child.on('close', () => {
      const line = out.trim().split('\n').pop() ?? ''
      try { done(JSON.parse(line)) } catch { failed(new Error(`no JSON from the program: ${out}${err}`)) }
    })
    child.stdin.end(source)
  })
}

const ISSUER = () => `${base}/idp`
const DOC = () => ({
  issuer: ISSUER(),
  authorization_endpoint: 'https://idp.test/oauth2/authorize',
  token_endpoint: 'https://idp.test/oauth2/token',
  userinfo_endpoint: 'https://idp.test/oauth2/userinfo',
  jwks_uri: 'https://idp.test/jwks',
})

function add(params: Record<string, string>) {
  return run(['NODE_PROVIDER_LIB', 'NODE_PROVIDER_ADD'], { id: 'custom:auth', name: '', client_id: '', client_secret: '', ...params })
}
const newIssuer = (extra: Record<string, string> = {}) =>
  add({ source: 'issuer', issuer: ISSUER(), name: 'Auth', client_id: 'harmony', client_secret: 's3cret', ...extra })

/** A provider GoTrue already has, as 1.9.1 to 1.9.7 stored an --issuer one. */
function storedOidc(extra: Json = {}) {
  providers.set('custom:auth', {
    provider_type: 'oidc', identifier: 'custom:auth', name: 'Auth', client_id: 'harmony', issuer: ISSUER(),
    scopes: ['openid', 'email', 'profile'], pkce_enabled: false, email_optional: true, enabled: true,
    skip_nonce_check: false, acceptable_client_ids: [], attribute_mapping: {}, authorization_params: {},
    custom_claims_allowlist: [], ...extra,
  })
  secrets.set('custom:auth', 'old-secret')
  shown = [{ id: 'custom:auth', name: 'Auth' }]
}

beforeAll(async () => {
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})
afterAll(async () => { await new Promise((done) => server.close(done)) })
beforeEach(() => {
  providers = new Map()
  secrets = new Map()
  shown = []
  calls = []
  discovery = { status: 200, body: DOC() }
  refuse = () => null
})

describe('harmony auth add-provider --issuer', () => {
  it('stores a new provider as OAuth 2.0 with the discovered endpoints: GoTrue then reads userinfo', async () => {
    const r = await newIssuer()
    expect(r).toMatchObject({ ok: true, reads: 'userinfo', created: true, replaced: false })
    expect(providers.get('custom:auth')).toMatchObject({
      provider_type: 'oauth2',
      authorization_url: 'https://idp.test/oauth2/authorize',
      token_url: 'https://idp.test/oauth2/token',
      userinfo_url: 'https://idp.test/oauth2/userinfo',
      scopes: ['openid', 'email', 'profile'],
    })
    expect(providers.get('custom:auth')).not.toHaveProperty('issuer')
    expect(secrets.get('custom:auth')).toBe('s3cret')
    expect(shown).toEqual([{ id: 'custom:auth', name: 'Auth' }])
    expect(calls).toContain('GET /idp/.well-known/openid-configuration')
  })

  it('fetches the document from --discovery-url, and still holds it to --issuer', async () => {
    const r = await newIssuer({ discovery_url: `${base}/elsewhere/.well-known/openid-configuration` })
    expect(r.ok, r.error).toBe(true)
    expect(calls).toContain('GET /elsewhere/.well-known/openid-configuration')
    expect(calls).not.toContain('GET /idp/.well-known/openid-configuration')
  })

  it('takes the trailing slash off the issuer for the document, as GoTrue does', async () => {
    discovery.body = { ...DOC(), issuer: `${ISSUER()}/` }
    const r = await newIssuer({ issuer: `${ISSUER()}/` })
    expect(r.ok, r.error).toBe(true)
    expect(calls).toContain('GET /idp/.well-known/openid-configuration')
  })

  it('keeps openid among scopes given with --scopes', async () => {
    await newIssuer({ scopes: 'email profile' })
    expect(providers.get('custom:auth')?.scopes).toEqual(['openid', 'email', 'profile'])
  })

  it('stores the OIDC type with --id-token, without fetching the document itself', async () => {
    const r = await newIssuer({ claims: 'id_token' })
    expect(r).toMatchObject({ ok: true, reads: 'id_token', created: true })
    expect(providers.get('custom:auth')).toMatchObject({ provider_type: 'oidc', issuer: ISSUER() })
    expect(calls).not.toContain('GET /idp/.well-known/openid-configuration')
  })

  it('stores the OIDC type when the document names no userinfo endpoint, and says so', async () => {
    const { userinfo_endpoint: _, ...doc } = DOC()
    discovery.body = doc
    const r = await newIssuer()
    expect(r).toMatchObject({ ok: true, reads: 'id_token', noUserinfo: true })
    expect(providers.get('custom:auth')?.provider_type).toBe('oidc')
  })

  it('refuses --userinfo when the document names no userinfo endpoint', async () => {
    const { userinfo_endpoint: _, ...doc } = DOC()
    discovery.body = doc
    const r = await newIssuer({ claims: 'userinfo' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('--id-token')
    expect(providers.size).toBe(0)
  })

  it('refuses an issuer that differs from the document, in GoTrue words and without double quotes', async () => {
    discovery.body = { ...DOC(), issuer: 'https://other.test' }
    const r = await newIssuer()
    expect(r.ok).toBe(false)
    expect(r.error).toBe(`oidc: issuer mismatch, expected ${ISSUER()} got https://other.test`)
    expect(providers.size).toBe(0)
  })

  it('refuses when there is no document', async () => {
    discovery = { status: 404, body: 'nope' }
    const r = await newIssuer()
    expect(r.error).toBe(`oidc: discovery request to ${ISSUER()}/.well-known/openid-configuration returned 404 Not Found`)
    discovery = { status: 200, body: '<html>' }
    expect((await newIssuer()).error).toContain('oidc: failed to decode discovery document from')
    expect(providers.size).toBe(0)
  })

  it('turns double quotes in GoTrue messages into single ones, which json_field reads whole', async () => {
    refuse = () => 'oidc: issuer mismatch, expected "a" got "b"'
    const r = await newIssuer()
    expect(r.error).toBe(`adding the provider failed (HTTP 400: oidc: issuer mismatch, expected 'a' got 'b')`)
  })
})

describe('harmony auth add-provider on an existing provider', () => {
  it('keeps an ID token provider as it is when no option names the source', async () => {
    storedOidc()
    const r = await add({ source: 'issuer', issuer: ISSUER(), name: 'Renamed' })
    expect(r).toMatchObject({ ok: true, reads: 'id_token', created: false, replaced: false })
    expect(providers.get('custom:auth')).toMatchObject({ provider_type: 'oidc', name: 'Renamed' })
    expect(calls.filter((c) => c.startsWith('DELETE'))).toEqual([])
    expect(calls).not.toContain('GET /idp/.well-known/openid-configuration')
  })

  it('switches it to userinfo with --userinfo: made again under its identifier with its settings', async () => {
    storedOidc({ acceptable_client_ids: ['mobile'], attribute_mapping: { name: 'nickname' } })
    const r = await add({ claims: 'userinfo', client_secret: 'given' })
    expect(r).toMatchObject({ ok: true, reads: 'userinfo', created: false, replaced: true })
    expect(providers.get('custom:auth')).toMatchObject({
      provider_type: 'oauth2', identifier: 'custom:auth', name: 'Auth', client_id: 'harmony',
      scopes: ['openid', 'email', 'profile'], pkce_enabled: false, email_optional: true, enabled: true,
      acceptable_client_ids: ['mobile'], attribute_mapping: { name: 'nickname' },
      userinfo_url: 'https://idp.test/oauth2/userinfo',
    })
    expect(providers.get('custom:auth')).not.toHaveProperty('issuer')
    expect(secrets.get('custom:auth')).toBe('given')
    expect(shown).toEqual([{ id: 'custom:auth', name: 'Auth' }])
    expect(calls.filter((c) => !c.includes('instance_config'))).toEqual([
      'GET /auth/v1/admin/custom-providers',
      'GET /idp/.well-known/openid-configuration',
      'DELETE /auth/v1/admin/custom-providers/custom:auth',
      'POST /auth/v1/admin/custom-providers',
    ])
  })

  it('needs the client secret to switch, and changes nothing without it', async () => {
    storedOidc()
    const r = await add({ claims: 'userinfo' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('needs the client secret')
    expect(providers.get('custom:auth')?.provider_type).toBe('oidc')
    expect(calls.filter((c) => c.startsWith('DELETE') || c.startsWith('POST'))).toEqual([])
  })

  it('puts the old provider back when the auth service refuses the new one', async () => {
    storedOidc()
    refuse = (body) => (body.provider_type === 'oauth2' ? 'URL cannot resolve to private network addresses' : null)
    const r = await add({ claims: 'userinfo', client_secret: 'given' })
    expect(r.ok).toBe(false)
    expect(r.error).toContain('it is back as it was, reading from the ID token')
    expect(r.error).toContain('URL cannot resolve to private network addresses')
    expect(providers.get('custom:auth')).toMatchObject({
      provider_type: 'oidc', issuer: ISSUER(), name: 'Auth', client_id: 'harmony', pkce_enabled: false, email_optional: true,
    })
    expect(secrets.get('custom:auth')).toBe('given')
  })

  it('says the provider is gone when the old one is refused too', async () => {
    storedOidc()
    refuse = () => 'down'
    const r = await add({ claims: 'userinfo', client_secret: 'given' })
    expect(r.error).toContain('it has no custom:auth now')
    expect(providers.size).toBe(0)
  })

  it('switches a userinfo provider back with --issuer and --id-token, and needs --issuer for it', async () => {
    await newIssuer()
    expect((await add({ claims: 'id_token', client_secret: 'x' })).error).toContain('give --issuer with --id-token')
    const r = await add({ source: 'issuer', issuer: ISSUER(), claims: 'id_token', client_secret: 'again' })
    expect(r).toMatchObject({ ok: true, reads: 'id_token', replaced: true })
    expect(providers.get('custom:auth')).toMatchObject({ provider_type: 'oidc', issuer: ISSUER(), name: 'Auth' })
  })

  it('updates the endpoints of a userinfo provider from the document on --issuer', async () => {
    await newIssuer()
    discovery.body = { ...DOC(), token_endpoint: 'https://idp.test/v2/token' }
    const r = await add({ source: 'issuer', issuer: ISSUER() })
    expect(r).toMatchObject({ ok: true, reads: 'userinfo', replaced: false })
    expect(providers.get('custom:auth')?.token_url).toBe('https://idp.test/v2/token')
  })
})

describe('harmony auth providers', () => {
  it('names where each provider takes the address from', async () => {
    storedOidc()
    providers.set('custom:other', {
      provider_type: 'oauth2', identifier: 'custom:other', name: 'Other', enabled: true,
      authorization_url: 'https://other.test/authorize',
    })
    const r = await run(['NODE_PROVIDER_LIB', 'NODE_PROVIDER_LIST'], {})
    expect(Buffer.from(r.rows, 'base64').toString('utf8').split('\n')).toEqual([
      `custom:auth\tAuth\tID token\tshown\t${ISSUER()}`,
      'custom:other\tOther\tuserinfo\tno button\thttps://other.test/authorize',
    ])
  })
})
