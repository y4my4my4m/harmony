// OIDC provider that keeps the scope claims for userinfo, as OIDC Core 5.4 allows when an access
// token is issued: the ID token carries sub and no email, name or picture. Better Auth's
// oauth-provider plugin (1.7) and Authelia 4.39+ answer this way.
//
// Authorization code flow with PKCE (S256, plain), client_secret_basic or client_secret_post,
// RS256 ID tokens. GET <issuer>/_requests lists the requests served, newest last.
//
// Environment: ISSUER, PORT, TLS_CERT, TLS_KEY, CLIENT_ID, CLIENT_SECRET, REDIRECT_URIS
// (comma-separated), PASSWORD, USERS (comma-separated email|name|preferred_username).

import crypto from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'

const env = (k) => {
  const v = process.env[k]
  if (!v) throw new Error(`${k} is not set`)
  return v
}
const ISSUER = env('ISSUER')
const BASE = new URL(ISSUER).pathname.replace(/\/$/, '')
const CLIENT_ID = env('CLIENT_ID')
const CLIENT_SECRET = env('CLIENT_SECRET')
const REDIRECT_URIS = env('REDIRECT_URIS').split(',')
const PASSWORD = env('PASSWORD')
const USERS = new Map(env('USERS').split(',').map((u) => {
  const [email, name, username] = u.split('|')
  return [email, { email, name, username, sub: crypto.createHash('sha256').update(email).digest('hex').slice(0, 24) }]
}))

const { privateKey, publicKey } = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })
const KID = crypto.randomBytes(8).toString('hex')
const codes = new Map()
const tokens = new Map()
const requests = []

const b64url = (buf) => Buffer.from(buf).toString('base64url')
function sign(payload) {
  const head = b64url(JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID }))
  const body = b64url(JSON.stringify(payload))
  return `${head}.${body}.${b64url(crypto.sign('sha256', Buffer.from(`${head}.${body}`), privateKey))}`
}

function send(res, status, body, headers = {}) {
  const json = typeof body !== 'string'
  res.writeHead(status, { 'Content-Type': json ? 'application/json' : 'text/html; charset=utf-8', 'Cache-Control': 'no-store', ...headers })
  res.end(json ? JSON.stringify(body) : body)
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

async function form(req) {
  const chunks = []
  for await (const c of req) chunks.push(c)
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

function loginPage(params, error = '') {
  const hidden = [...params].filter(([k]) => k !== 'login' && k !== 'password')
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`).join('')
  return `<!doctype html><title>Userinfo IdP</title><form method="post" action="${BASE}/oauth2/authorize">${hidden}
<p>${esc(error)}</p><input name="login" type="email"><input name="password" type="password"><button type="submit">Sign in</button></form>`
}

function clientOf(req, params) {
  const basic = /^Basic (.+)$/.exec(req.headers.authorization || '')
  if (basic) {
    const [id, secret] = Buffer.from(basic[1], 'base64').toString('utf8').split(':').map(decodeURIComponent)
    return id === CLIENT_ID && secret === CLIENT_SECRET
  }
  return params.get('client_id') === CLIENT_ID && params.get('client_secret') === CLIENT_SECRET
}

function verifier(entry, codeVerifier) {
  if (!entry.challenge) return true
  if (!codeVerifier) return false
  const computed = entry.method === 'S256' ? b64url(crypto.createHash('sha256').update(codeVerifier).digest()) : codeVerifier
  return computed === entry.challenge
}

const server = https.createServer({ cert: fs.readFileSync(env('TLS_CERT')), key: fs.readFileSync(env('TLS_KEY')) }, async (req, res) => {
  const url = new URL(req.url ?? '/', ISSUER)
  const path = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : url.pathname
  if (path !== '/_requests') requests.push(`${req.method} ${path}`)

  if (path === '/_requests') return send(res, 200, requests)
  if (path === '/.well-known/openid-configuration') {
    return send(res, 200, {
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/oauth2/authorize`,
      token_endpoint: `${ISSUER}/oauth2/token`,
      userinfo_endpoint: `${ISSUER}/oauth2/userinfo`,
      jwks_uri: `${ISSUER}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      scopes_supported: ['openid', 'email', 'profile'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'client_secret_post'],
      code_challenge_methods_supported: ['S256', 'plain'],
      claims_supported: ['sub', 'email', 'email_verified', 'name', 'preferred_username'],
    })
  }
  if (path === '/jwks') {
    return send(res, 200, { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: KID, alg: 'RS256', use: 'sig' }] })
  }
  if (path === '/oauth2/authorize' && req.method === 'GET') {
    const p = url.searchParams
    if (p.get('client_id') !== CLIENT_ID || !REDIRECT_URIS.includes(p.get('redirect_uri') ?? '') || p.get('response_type') !== 'code') {
      return send(res, 400, '<p>invalid client, redirect_uri or response_type</p>')
    }
    return send(res, 200, loginPage(p))
  }
  if (path === '/oauth2/authorize' && req.method === 'POST') {
    const p = await form(req)
    const user = USERS.get(p.get('login') ?? '')
    if (!user || p.get('password') !== PASSWORD) return send(res, 200, loginPage(p, 'Wrong address or password'))
    if (p.get('client_id') !== CLIENT_ID || !REDIRECT_URIS.includes(p.get('redirect_uri') ?? '')) return send(res, 400, '<p>invalid client</p>')
    const code = crypto.randomBytes(24).toString('base64url')
    codes.set(code, {
      user, scope: p.get('scope') ?? '', nonce: p.get('nonce'), redirect: p.get('redirect_uri'),
      challenge: p.get('code_challenge'), method: p.get('code_challenge_method') || 'plain', exp: Date.now() + 60_000,
    })
    const to = new URL(p.get('redirect_uri'))
    to.searchParams.set('code', code)
    if (p.get('state')) to.searchParams.set('state', p.get('state'))
    res.writeHead(302, { Location: to.toString() })
    return res.end()
  }
  if (path === '/oauth2/token' && req.method === 'POST') {
    const p = await form(req)
    if (!clientOf(req, p)) return send(res, 401, { error: 'invalid_client' }, { 'WWW-Authenticate': 'Basic' })
    const entry = codes.get(p.get('code') ?? '')
    codes.delete(p.get('code') ?? '')
    if (p.get('grant_type') !== 'authorization_code' || !entry || entry.exp < Date.now() ||
        entry.redirect !== p.get('redirect_uri') || !verifier(entry, p.get('code_verifier'))) {
      return send(res, 400, { error: 'invalid_grant' })
    }
    const now = Math.floor(Date.now() / 1000)
    const accessToken = crypto.randomBytes(24).toString('base64url')
    tokens.set(accessToken, { user: entry.user, scope: entry.scope, exp: Date.now() + 600_000 })
    const idToken = sign({
      iss: ISSUER, sub: entry.user.sub, aud: CLIENT_ID, iat: now, exp: now + 600, auth_time: now,
      ...(entry.nonce ? { nonce: entry.nonce } : {}),
    })
    return send(res, 200, { access_token: accessToken, token_type: 'Bearer', expires_in: 600, id_token: idToken, scope: entry.scope })
  }
  if (path === '/oauth2/userinfo') {
    const t = tokens.get(/^Bearer (.+)$/.exec(req.headers.authorization || '')?.[1] ?? '')
    if (!t || t.exp < Date.now()) return send(res, 401, { error: 'invalid_token' }, { 'WWW-Authenticate': 'Bearer error="invalid_token"' })
    const scopes = t.scope.split(' ')
    return send(res, 200, {
      sub: t.user.sub,
      ...(scopes.includes('email') ? { email: t.user.email, email_verified: true } : {}),
      ...(scopes.includes('profile') ? { name: t.user.name, preferred_username: t.user.username } : {}),
    })
  }
  return send(res, 404, { error: 'not_found' })
})

server.listen(Number(env('PORT')), '0.0.0.0', () => console.log(`userinfo IdP at ${ISSUER}`))
