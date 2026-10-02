// Federation round trips against a real database.
//
// The local instance is the federation backend's own Express app
// (`createApp()` from federation-backend/src/server.ts) talking to the
// Postgres + PostgREST stack raised by e2e/federation/stack.sh. The remote
// instance is the peer server below: it publishes an actor document with a
// real RSA key and records what is delivered to its inboxes.
//
// Nothing is stubbed. Activities are signed with draft-cavage HTTP
// signatures, the local instance fetches the peer's key over HTTP to verify
// them, and every assertion reads a row back through PostgREST.
//
// Reports cross in both directions: the peer's instance actor sends a signed
// Flag that becomes a report owned by the peer's domain, and a forwarded local
// report reaches the peer as a Flag signed by the local instance actor, which
// the peer checks against the actor document the local instance publishes.
//
// Two paths carry the defects this harness exists to catch:
//   - public.federated_voice_calls, whose column set an inbound
//     harmony:VoiceCallInvite writes directly;
//   - the DM delivery path's choice of inbox URL, asserted from the request
//     the peer actually received.
//
// Posts and DM messages by visibility: unsigned, signed by the peer (a follower and a DM
// participant, its user key and its instance actor, as Mastodon and Misskey fetch on
// receipt) and signed by a second instance with no follower and no participant.
//
// Private servers are exercised from both sides, one real instance each way:
//   - hosting: the local instance serves a private server; the peer reads it
//     with GETs signed by a member, a non-member, its instance actor, or
//     nothing;
//   - reading: the peer hosts a private Group; the local proxy and sync fetch
//     it signed as the requesting local member, which the peer verifies
//     against that member's published key.
// The proxy authenticates its caller with a Supabase JWT; roundtrip.ts signs
// those itself and gateway.conf answers /auth/v1/user (auth-user-shim.sql).
//
// Voice crosses in both directions too, against the stack's LiveKit, which
// stands in for both instances' SFUs:
//   - a DM call the local instance hosts: the peer's user is rung, fetches its
//     token from /api/livekit/federated-token signed with its own key, and
//     accepts; a DM call the peer hosts: fx_bob accepts and the local instance
//     fetches fx_bob's token from the peer, signed with fx_bob's key;
//   - a voice channel of the peer's Group joined by fx_bob, and one of the
//     hosted private server joined by the peer's user.
// Each ends with both sides' tokens joined to the same LiveKit room over its
// signalling WebSocket.
//
// Not covered: the BullMQ worker, Redis (the rate limiters fall back to their
// in-memory store), Realtime delivery (user events stay in realtime.messages
// and are read back through realtime-shim.sql; the voice presence broadcast is
// answered 501) and media. The signed-GET and reading cases fetch the local
// actor's key back over HTTP to verify signatures.
//
// Run: e2e/federation/stack.sh verify
//
// HMFED_BACKEND_ROOT points the run at a copy of federation-backend/ - used to
// mutate backend source without touching the checkout. HMFED_LOG_LEVEL raises
// the backend's log level above the default `error`.

import crypto from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = process.env.HMFED_BACKEND_ROOT ?? path.resolve(__dirname, '../../federation-backend')

const INSTANCE_DOMAIN = 'local.hmfed.test'

// Fixed so a failure names a row.
const ALICE = 'fed00000-0000-0000-0000-000000000001' // local, sends the DM
const BOB = 'fed00000-0000-0000-0000-000000000002' // local, receives calls and DMs
const REMOTE = 'fed00000-0000-0000-0000-000000000003' // mirror of the peer's user
const CAROL = 'fed00000-0000-0000-0000-000000000004' // local, member of nothing
const CONVERSATION = 'fed00000-0000-0000-0000-000000000010'
// fx_bob <-> the peer's user: a federated call rings only a DM partner.
const CALL_CONVERSATION = 'fed00000-0000-0000-0000-000000000011'
// The calling instance's own conversation id, named by its room.
const PEER_CONVERSATION = 'fed00000-0000-0000-0000-0000000000aa'
const PEER_ROOM = `federated-dm-${PEER_CONVERSATION}-1700000000000`

// auth.users rows seeded by auth-user-shim.sql.
const ALICE_AUTH = 'fed0a000-0000-0000-0000-000000000001'
const BOB_AUTH = 'fed0a000-0000-0000-0000-000000000002'
const CAROL_AUTH = 'fed0a000-0000-0000-0000-000000000003'

// Hosted here: a private server whose `secret` channel @everyone cannot view,
// with the peer's user as an accepted member; and a public server.
const PRIV_SERVER = 'fed00000-0000-0000-0000-000000000020'
const PRIV_GENERAL = 'fed00000-0000-0000-0000-000000000021'
const PRIV_SECRET = 'fed00000-0000-0000-0000-000000000022'
const PUB_SERVER = 'fed00000-0000-0000-0000-000000000030'
const PUB_GENERAL = 'fed00000-0000-0000-0000-000000000031'

// Hosted by the peer: a private Group with fx_bob as a member. REMOTE_REF is
// the local reference row, keyed by the Group's UUID as a join would key it.
const REMOTE_REF = 'fed00000-0000-0000-0000-000000000040'
const REMOTE_CHANNEL = 'fed00000-0000-0000-0000-000000000041'
const REMOTE_CHANNEL_NEW = 'fed00000-0000-0000-0000-000000000042'

// A local post the peer reports.
const ALICE_POST = 'fed00000-0000-0000-0000-000000000050'

// Voice channels: one in the peer's Group, two in the hosted private server,
// the second hidden from @everyone.
const REMOTE_VOICE = 'fed00000-0000-0000-0000-000000000043'
const PRIV_VOICE = 'fed00000-0000-0000-0000-000000000023'
const PRIV_VOICE_HIDDEN = 'fed00000-0000-0000-0000-000000000024'

// Posts by fx_alice in each visibility; the peer's user follows fx_alice and is the
// direct post's recipient. DM_MESSAGE is a federated message of CONVERSATION.
const POST_PUBLIC = 'fed00000-0000-0000-0000-000000000060'
const POST_UNLISTED = 'fed00000-0000-0000-0000-000000000061'
const POST_FOLLOWERS = 'fed00000-0000-0000-0000-000000000062'
const POST_DIRECT = 'fed00000-0000-0000-0000-000000000063'
const DM_MESSAGE = 'fed00000-0000-0000-0000-000000000064'

// REPORTING

let failures = 0
function pass(msg: string) {
  console.log(`  ok    ${msg}`)
}
function fail(msg: string, detail?: unknown) {
  failures += 1
  console.log(`  FAIL  ${msg}`)
  if (detail !== undefined) console.log(`        ${detail}`)
}
function assert(cond: unknown, msg: string, detail?: unknown) {
  cond ? pass(msg) : fail(msg, detail)
}
function eq(actual: unknown, expected: unknown, msg: string) {
  assert(actual === expected, msg, `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`)
}

// STACK ENV

function loadStackEnv(): Record<string, string> {
  const file = path.join(__dirname, 'stack.env')
  if (!fs.existsSync(file)) throw new Error('e2e/federation/stack.env missing - run: e2e/federation/stack.sh up')
  const out: Record<string, string> = {}
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const m = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim())
    if (m) out[m[1]] = m[2]
  }
  return out
}

// PEER INSTANCE
//
// Bound on every interface: federation code reaches it through the compose
// network's bridge address, which the SSRF guard treats as external, and
// never through loopback.

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

function rsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

class Peer {
  readonly key = rsaKeyPair()
  // A second user with no membership anywhere, and the instance actor.
  readonly strangerKey = rsaKeyPair()
  readonly instanceKey = rsaKeyPair()

  readonly captured: Captured[] = []
  // GETs to the authorized-fetch object, recorded in arrival order so a case
  // can tell the unsigned attempt from the signed retry.
  readonly secureGetRequests: Captured[] = []
  // GETs to the peer-hosted private Group and its channel, in arrival order.
  readonly groupGetRequests: Captured[] = []
  // POSTs to the peer's /api/livekit/federated-token, and the rooms it hosts:
  // room name -> the local actor it rang there.
  readonly tokenRequests: Captured[] = []
  readonly hostedRooms = new Map<string, string>()
  livekit: LiveKit | null = null
  actorFetches = 0
  private server?: http.Server
  base = ''
  secureNoteUrl = ''
  // The local instance's real listen address, needed to resolve the signing
  // actor's key (the composed https://<domain> URL does not resolve).
  localUrl = ''

  get actorUrl() {
    return `${this.base}/users/fx_remote`
  }
  get personalInbox() {
    return `${this.base}/users/fx_remote/inbox`
  }
  get sharedInbox() {
    return `${this.base}/inbox`
  }
  get strangerUrl() {
    return `${this.base}/users/fx_stranger`
  }
  get instanceActorUrl() {
    return `${this.base}/actor`
  }
  get groupUrl() {
    return `${this.base}/servers/${REMOTE_REF}`
  }
  channelUrl(id: string) {
    return `${this.groupUrl}/channels/${id}`
  }
  get remoteNoteUrl() {
    return `${this.base}/messages/fed00000-0000-0000-0000-0000000000f1`
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        if (req.method === 'GET' && req.url === '/users/fx_remote') {
          this.actorFetches += 1
          res.writeHead(200, { 'Content-Type': 'application/activity+json' })
          res.end(
            JSON.stringify({
              '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
              id: this.actorUrl,
              type: 'Person',
              preferredUsername: 'fx_remote',
              inbox: this.personalInbox,
              endpoints: { sharedInbox: this.sharedInbox },
              publicKey: {
                id: `${this.actorUrl}#main-key`,
                owner: this.actorUrl,
                publicKeyPem: this.key.publicKey,
              },
            }),
          )
          return
        }
        if (req.method === 'GET' && req.url === '/users/fx_stranger') {
          this.sendActor(res, this.strangerUrl, 'Person', 'fx_stranger', this.strangerKey.publicKey)
          return
        }
        if (req.method === 'GET' && req.url === '/actor') {
          this.sendActor(res, this.instanceActorUrl, 'Application', 'remote.test', this.instanceKey.publicKey)
          return
        }
        if (
          req.method === 'GET' &&
          (req.url === `/servers/${REMOTE_REF}` ||
            req.url === `/servers/${REMOTE_REF}/channels/${REMOTE_CHANNEL}/messages?page=1`)
        ) {
          this.groupGetRequests.push({
            method: req.method,
            url: req.url ?? '',
            headers: req.headers as Record<string, string>,
            raw,
          })
          void this.handleGroupGet(req, res)
          return
        }
        if (req.method === 'POST' && req.url === '/api/livekit/federated-token') {
          this.tokenRequests.push({
            method: req.method,
            url: req.url ?? '',
            headers: req.headers as Record<string, string>,
            raw,
          })
          void this.handleTokenRequest(req, raw, res)
          return
        }
        // Authorized-fetch object: 401 unless the request carries a valid
        // HTTP signature from a local actor. This is the endpoint that proves
        // the backend's signed GET retry works against a secure peer.
        if (req.method === 'GET' && req.url === '/objects/secure-note') {
          this.secureGetRequests.push({
            method: req.method,
            url: req.url ?? '',
            headers: req.headers as Record<string, string>,
            raw,
          })
          void this.handleSecureGet(req, res)
          return
        }
        if (req.method === 'POST') {
          this.captured.push({
            method: req.method,
            url: req.url ?? '',
            headers: req.headers as Record<string, string>,
            raw,
          })
          res.writeHead(202, { 'Content-Type': 'application/json' })
          res.end('{"message":"accepted"}')
          return
        }
        res.writeHead(404).end()
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    const port = (this.server!.address() as { port: number }).port
    this.base = `http://${host}:${port}`
    this.secureNoteUrl = `${this.base}/objects/secure-note`
  }

  /**
   * Answer the authorized-fetch object. Reads the signed headers and verifies
   * the signature against the signing actor's published key, fetched back from
   * the local instance. A missing or invalid signature is 401.
   */
  private async handleSecureGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const signature = req.headers.signature as string | undefined
    if (!signature || !(await this.verifyLocalSignature(req, signature))) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end('{"error":"authorized fetch requires a signature"}')
      return
    }

    res.writeHead(200, { 'Content-Type': 'application/activity+json' })
    res.end(
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: this.secureNoteUrl,
        type: 'Note',
        attributedTo: this.actorUrl,
        to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
        published: new Date().toISOString(),
        content: '<p>secure note behind authorized fetch</p>',
      }),
    )
  }

  private async verifyLocalSignature(req: http.IncomingMessage, signature: string): Promise<boolean> {
    return (await this.localSigner(req, signature)) !== null
  }

  /**
   * Actor URL of the local user whose key signed this GET, fetched back from
   * the local instance and checked; null for anything else.
   */
  private async localSigner(req: http.IncomingMessage, signature: string | undefined): Promise<string | null> {
    if (!signature) return null
    try {
      const params = parseSignatureHeader(signature)
      if (!params.keyId || !params.headers || !params.signature) return null
      if (params.headers !== '(request-target) host date') return null
      if (!req.url || !req.headers.host || !req.headers.date) return null

      // keyId minus fragment: https://<domain>/users/<name>#main-key
      const actorUrl = params.keyId.split('#')[0]
      if (!actorUrl.startsWith(`https://${INSTANCE_DOMAIN}/users/`)) return null
      const actor = await getJson(actorUrl.replace(`https://${INSTANCE_DOMAIN}`, this.localUrl))
      const pem = actor?.publicKey?.publicKeyPem
      if (!pem) return null

      const signingString = [
        `(request-target): get ${req.url}`,
        `host: ${req.headers.host}`,
        `date: ${req.headers.date}`,
      ].join('\n')

      return crypto.createVerify('SHA256').update(signingString).verify(pem, params.signature, 'base64')
        ? actorUrl
        : null
    } catch {
      return null
    }
  }

  /**
   * Actor URL of the local user whose key signed this POST, digest included,
   * fetched back from the local instance; null for anything else.
   */
  private async localPostSigner(req: http.IncomingMessage, raw: Buffer): Promise<string | null> {
    try {
      const params = parseSignatureHeader(String(req.headers.signature ?? ''))
      if (params.headers !== '(request-target) host date digest' || !params.keyId || !params.signature) return null
      const digest = `SHA-256=${crypto.createHash('sha256').update(raw).digest('base64')}`
      if (req.headers.digest !== digest || !req.headers.host || !req.headers.date) return null

      const actorUrl = params.keyId.split('#')[0]
      if (!actorUrl.startsWith(`https://${INSTANCE_DOMAIN}/users/`)) return null
      const actor = await getJson(actorUrl.replace(`https://${INSTANCE_DOMAIN}`, this.localUrl))
      const pem = actor?.publicKey?.publicKeyPem
      if (!pem) return null

      const signingString = [
        `(request-target): post ${req.url}`,
        `host: ${req.headers.host}`,
        `date: ${req.headers.date}`,
        `digest: ${digest}`,
      ].join('\n')
      return crypto.createVerify('SHA256').update(signingString).verify(pem, params.signature, 'base64')
        ? actorUrl
        : null
    } catch {
      return null
    }
  }

  /**
   * The peer's /api/livekit/federated-token, with the rules a Harmony caller
   * instance applies: a signed request whose actorId is the signer, for a room
   * this peer rang that actor in.
   */
  private async handleTokenRequest(req: http.IncomingMessage, raw: Buffer, res: http.ServerResponse): Promise<void> {
    const reply = (status: number, body: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify(body))
    }
    const signer = await this.localPostSigner(req, raw)
    let body: any = null
    try {
      body = JSON.parse(raw.toString('utf-8'))
    } catch {
      body = null
    }
    if (!signer) return reply(401, { error: 'signature required' })
    if (body?.actorId !== signer) return reply(403, { error: 'actorId does not match the signing key owner' })
    if (!this.livekit || body?.roomType !== 'dm_call' || this.hostedRooms.get(body?.roomName) !== signer) {
      return reply(403, { error: 'Not authorized for this room' })
    }
    const token = await this.livekit.mint(`federated:${signer}`, body.roomName)
    reply(200, { token, wsUrl: this.livekit.url, roomName: body.roomName, identity: `federated:${signer}` })
  }

  private sendActor(res: http.ServerResponse, id: string, type: string, name: string, publicKeyPem: string) {
    res.writeHead(200, { 'Content-Type': 'application/activity+json' })
    res.end(
      JSON.stringify({
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id,
        type,
        preferredUsername: name,
        inbox: `${id}/inbox`,
        publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
      }),
    )
  }

  /**
   * The peer's private Group, with the rules the local instance applies to
   * its own: fx_bob, the one member, gets the Group with its channels and
   * the channel's messages; any other caller gets the Group stub and 404s.
   */
  private async handleGroupGet(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const signer = await this.localSigner(req, req.headers.signature as string | undefined)
    const member = signer === `https://${INSTANCE_DOMAIN}/users/fx_bob`

    if (req.url === `/servers/${REMOTE_REF}`) {
      const group: Record<string, unknown> = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: this.groupUrl,
        type: 'Group',
        name: 'Peer private',
        inbox: `${this.groupUrl}/inbox`,
        discoverable: false,
      }
      if (member) {
        group.members = `${this.groupUrl}/members`
        group['harmony:channels'] = [
          { id: this.channelUrl(REMOTE_CHANNEL), localId: REMOTE_CHANNEL, name: 'peer-general', type: 'harmony:TextChannel', channelType: 'text', order: 0 },
          { id: this.channelUrl(REMOTE_CHANNEL_NEW), localId: REMOTE_CHANNEL_NEW, name: 'peer-added', type: 'harmony:TextChannel', channelType: 'text', order: 1 },
        ]
      }
      res.writeHead(200, { 'Content-Type': 'application/activity+json' })
      res.end(JSON.stringify(group))
      return
    }

    if (!member) {
      res.writeHead(404, { 'Content-Type': 'application/json' })
      res.end('{"error":"Channel not found"}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'application/activity+json' })
    res.end(
      JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${this.channelUrl(REMOTE_CHANNEL)}/messages?page=1`,
        type: 'OrderedCollectionPage',
        orderedItems: [
          {
            type: 'Note',
            id: this.remoteNoteUrl,
            attributedTo: this.actorUrl,
            content: 'peer private message',
            context: this.channelUrl(REMOTE_CHANNEL),
            published: new Date().toISOString(),
          },
        ],
      }),
    )
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

// SIGNED DELIVERY TO THE LOCAL INSTANCE
//
// Mirrors SignatureService.signRequest: (request-target), host, date and
// digest, draft-cavage parameter form. Written out rather than imported so a
// change to the signer cannot silently change both sides of the round trip.

function signedHeaders(targetUrl: string, bodyString: string, privateKey: string, keyId: string) {
  const u = new URL(targetUrl)
  const date = new Date().toUTCString()
  const digest = `SHA-256=${crypto.createHash('sha256').update(bodyString).digest('base64')}`
  const signingString = [
    `(request-target): post ${u.pathname}${u.search}`,
    `host: ${u.host}`,
    `date: ${date}`,
    `digest: ${digest}`,
  ].join('\n')
  const signature = crypto.createSign('SHA256').update(signingString).sign(privateKey, 'base64')
  return {
    Host: u.host,
    Date: date,
    Digest: digest,
    'Content-Type': 'application/activity+json',
    Signature: [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      'headers="(request-target) host date digest"',
      `signature="${signature}"`,
    ].join(','),
  }
}

// node:http, not fetch: the Host header is signed, and fetch owns it.
function post(
  targetUrl: string,
  headers: Record<string, string>,
  body: string,
): Promise<{ status: number; body: string }> {
  const u = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: u.hostname,
        port: u.port,
        path: `${u.pathname}${u.search}`,
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
      },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf-8') }))
      },
    )
    req.on('error', reject)
    req.end(body)
  })
}

// Signed GET as a remote actor: (request-target), host and date, the set
// SignatureService.signRequest produces for a GET.
function signedGetHeaders(targetUrl: string, privateKey: string, keyId: string): Record<string, string> {
  const u = new URL(targetUrl)
  const date = new Date().toUTCString()
  const signingString = [`(request-target): get ${u.pathname}${u.search}`, `host: ${u.host}`, `date: ${date}`].join('\n')
  const signature = crypto.createSign('SHA256').update(signingString).sign(privateKey, 'base64')
  return {
    Host: u.host,
    Date: date,
    Accept: 'application/activity+json',
    Signature: [
      `keyId="${keyId}"`,
      'algorithm="rsa-sha256"',
      'headers="(request-target) host date"',
      `signature="${signature}"`,
    ].join(','),
  }
}

// node:http GET with caller-controlled headers (Host is signed).
function get(
  targetUrl: string,
  headers: Record<string, string> = { Accept: 'application/activity+json' },
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string; json: any }> {
  const u = new URL(targetUrl)
  return new Promise((resolve, reject) => {
    http
      .get({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf-8')
          let json: any = null
          try {
            json = JSON.parse(body)
          } catch {
            json = null
          }
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body, json })
        })
      })
      .on('error', reject)
  })
}

// HS256 access token for a local user, verified by PostgREST behind /auth/v1/user.
function userToken(authUserId: string, secret: string): string {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url')
  const now = Math.floor(Date.now() / 1000)
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({
    sub: authUserId,
    role: 'authenticated',
    aud: 'authenticated',
    iat: now,
    exp: now + 3600,
  })}`
  return `${body}.${crypto.createHmac('sha256', secret).update(body).digest('base64url')}`
}

// Parse a draft-cavage Signature header. Quoted values may contain commas and
// `=` (keyId is a URI, signature is base64), so a naive split(',') corrupts
// them. Mirrors SignatureService.parseSignatureHeader.
function parseSignatureHeader(signature: string): Record<string, string> {
  const parts: Record<string, string> = {}
  const re = /([A-Za-z0-9]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(signature)) !== null) {
    parts[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? '').trim()
  }
  return parts
}

// GET a JSON document over plain http (node:http, so the ephemeral port and
// path are under our control).
function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    http
      .get(
        {
          host: u.hostname,
          port: u.port,
          path: `${u.pathname}${u.search}`,
          headers: { Accept: 'application/activity+json' },
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => {
            try {
              resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
            } catch (e) {
              reject(e)
            }
          })
        },
      )
      .on('error', reject)
  })
}

// LIVEKIT
//
// One LiveKit server stands in for both instances' SFUs: the local backend
// issues tokens with the stack's key, and the peer mints its own with the same
// key. A token is accepted when LiveKit answers its signalling WebSocket with a
// join naming the token's room and identity.

interface LiveKitJoin {
  room: string
  identity: string
  close: () => void
}

class LiveKit {
  private readonly sdk: any
  private readonly protocol: any

  constructor(
    readonly url: string,
    private readonly key: string,
    private readonly secret: string,
  ) {
    // Resolved from the backend's dependencies, as the backend itself loads them.
    const load = createRequire(path.join(BACKEND_ROOT, 'package.json'))
    this.sdk = load('livekit-server-sdk')
    this.protocol = load('@livekit/protocol')
  }

  mint(identity: string, room: string): Promise<string> {
    const at = new this.sdk.AccessToken(this.key, this.secret, { identity, ttl: '10m' })
    at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true })
    return at.toJwt()
  }

  /** Claims of a token signed with the stack's key; null for any other signature. */
  claims(token: unknown): any {
    if (typeof token !== 'string') return null
    const [header, payload, sig] = token.split('.')
    const expected = crypto.createHmac('sha256', this.secret).update(`${header}.${payload}`).digest('base64url')
    if (!sig || sig !== expected) return null
    return JSON.parse(Buffer.from(payload, 'base64url').toString('utf-8'))
  }

  join(token: string): Promise<LiveKitJoin> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.url}/rtc?access_token=${encodeURIComponent(token)}&auto_subscribe=1&sdk=js&protocol=15`)
      ws.binaryType = 'arraybuffer'
      const timer = setTimeout(() => {
        ws.close()
        reject(new Error('no join response within 10 s'))
      }, 10_000)
      ws.onmessage = (event) => {
        try {
          const msg = this.protocol.SignalResponse.fromBinary(new Uint8Array(event.data as ArrayBuffer))
          if (msg.message?.case !== 'join') return
          clearTimeout(timer)
          const join = msg.message.value
          resolve({ room: join.room?.name ?? '', identity: join.participant?.identity ?? '', close: () => ws.close() })
        } catch (e) {
          clearTimeout(timer)
          ws.close()
          reject(e)
        }
      }
      ws.onerror = () => {
        clearTimeout(timer)
        reject(new Error('LiveKit refused the signalling connection'))
      }
    })
  }

  async participants(room: string): Promise<string[]> {
    const rooms = new this.sdk.RoomServiceClient(this.url.replace(/^ws/, 'http'), this.key, this.secret)
    return (await rooms.listParticipants(room)).map((p: any) => p.identity).sort()
  }
}

interface RoomToken {
  who: string
  token: unknown
  identity: string
}

/**
 * Both tokens carry the stack's signature and name `room`, and LiveKit seats
 * both identities in it at once.
 */
async function bothInRoom(lk: LiveKit, room: string, a: RoomToken, b: RoomToken, label: string) {
  for (const side of [a, b]) {
    const claims = lk.claims(side.token)
    assert(
      claims?.sub === side.identity && claims?.video?.room === room && claims?.video?.roomJoin === true,
      `${side.who}'s token is for ${label} as ${side.identity}`,
      JSON.stringify(claims),
    )
  }
  const joined: LiveKitJoin[] = []
  try {
    for (const side of [a, b]) {
      const join = await lk.join(side.token as string)
      joined.push(join)
      assert(
        join.room === room && join.identity === side.identity,
        `LiveKit admits ${side.who} to ${label}`,
        `${join.identity} in ${join.room}`,
      )
    }
    const seated = await lk.participants(room)
    assert(
      seated.includes(a.identity) && seated.includes(b.identity),
      `LiveKit holds both sides in ${label} at once`,
      JSON.stringify(seated),
    )
  } catch (e) {
    fail(`LiveKit admits both sides to ${label}`, (e as Error)?.message ?? e)
  } finally {
    joined.forEach((j) => j.close())
  }
}

// FIXTURE

async function seed(db: SupabaseClient, peer: Peer) {
  const peerHost = new URL(peer.base).host

  // Delete before insert: ids are fixed and the tables cascade from profiles.
  await db.from('servers').delete().in('id', [PRIV_SERVER, PUB_SERVER, REMOTE_REF])
  await db.from('profiles').delete().in('id', [ALICE, BOB, REMOTE, CAROL])

  const { error } = await db.from('profiles').insert([
    {
      id: ALICE,
      auth_user_id: ALICE_AUTH,
      username: 'fx_alice',
      display_name: 'Alice',
      domain: INSTANCE_DOMAIN,
      federated_id: `https://${INSTANCE_DOMAIN}/users/fx_alice`,
      inbox_url: `https://${INSTANCE_DOMAIN}/users/fx_alice/inbox`,
      is_local: true,
    },
    {
      id: BOB,
      auth_user_id: BOB_AUTH,
      username: 'fx_bob',
      display_name: 'Bob',
      domain: INSTANCE_DOMAIN,
      federated_id: `https://${INSTANCE_DOMAIN}/users/fx_bob`,
      inbox_url: `https://${INSTANCE_DOMAIN}/users/fx_bob/inbox`,
      is_local: true,
    },
    {
      id: CAROL,
      auth_user_id: CAROL_AUTH,
      username: 'fx_carol',
      display_name: 'Carol',
      domain: INSTANCE_DOMAIN,
      federated_id: `https://${INSTANCE_DOMAIN}/users/fx_carol`,
      inbox_url: `https://${INSTANCE_DOMAIN}/users/fx_carol/inbox`,
      is_local: true,
    },
    {
      // public_key is absent: the inbox fetches it from the peer's actor
      // document to verify the first signature.
      id: REMOTE,
      username: 'fx_remote',
      display_name: 'Remote',
      domain: peerHost,
      federated_id: peer.actorUrl,
      inbox_url: peer.personalInbox,
      shared_inbox_url: peer.sharedInbox,
      is_local: false,
    },
  ])
  if (error) throw new Error(`seed profiles: ${error.message}`)

  await db.from('conversations').delete().in('id', [CONVERSATION, CALL_CONVERSATION])
  const conv = await db
    .from('conversations')
    .insert([
      { id: CONVERSATION, type: 'direct', created_by: ALICE },
      { id: CALL_CONVERSATION, type: 'direct', created_by: BOB },
    ])
  if (conv.error) throw new Error(`seed conversation: ${conv.error.message}`)

  const parts = await db.from('conversation_participants').insert([
    { conversation_id: CONVERSATION, user_id: ALICE },
    { conversation_id: CONVERSATION, user_id: REMOTE },
    { conversation_id: CALL_CONVERSATION, user_id: BOB },
    { conversation_id: CALL_CONVERSATION, user_id: REMOTE },
  ])
  if (parts.error) throw new Error(`seed participants: ${parts.error.message}`)
}

async function must(what: string, p: PromiseLike<{ data: any; error: { message: string } | null }>): Promise<any> {
  const { data, error } = await p
  if (error) throw new Error(`${what}: ${error.message}`)
  return data
}

async function seedServers(db: SupabaseClient, peer: Peer) {
  const peerHost = new URL(peer.base).host

  // A bulk insert sends every key of every row: a key absent from a row is
  // NULL there, not the column default.
  await must('seed servers', db.from('servers').insert([
    { id: PRIV_SERVER, name: 'Hosted private', owner: ALICE, public: false, is_local_server: true },
    { id: PUB_SERVER, name: 'Hosted public', owner: ALICE, public: true, is_local_server: true },
    {
      id: REMOTE_REF,
      name: 'Peer private',
      owner: ALICE,
      public: false,
      is_local_server: false,
      federation_enabled: true,
      ap_id: peer.groupUrl,
      federation_inbox_url: `${peer.groupUrl}/inbox`,
      federation_domain: peerHost,
      host_domain: peerHost,
    },
  ]))

  await must('seed channels', db.from('channels').insert([
    { id: PRIV_GENERAL, server_id: PRIV_SERVER, name: 'general', type: 0 },
    { id: PRIV_SECRET, server_id: PRIV_SERVER, name: 'secret', type: 0 },
    { id: PUB_GENERAL, server_id: PUB_SERVER, name: 'general', type: 0 },
    { id: REMOTE_CHANNEL, server_id: REMOTE_REF, name: 'peer-general', type: 0, is_remote: true, ap_id: peer.channelUrl(REMOTE_CHANNEL) },
  ]))

  // @everyone loses VIEW_CHANNEL (bit 1) on `secret`.
  const everyone = await must('everyone role', db
    .from('server_roles').select('id').eq('server_id', PRIV_SERVER).eq('is_default', true).single())
  await must('seed override', db.from('channel_permission_overrides').insert({
    channel_id: PRIV_SECRET,
    target_type: 'role',
    role_id: everyone.id,
    allow_permissions: 0,
    deny_permissions: 2,
  }))

  await must('seed memberships', db.from('user_servers').insert([
    { server_id: PRIV_SERVER, user_id: REMOTE, status: 'accepted', member_instance: peerHost },
    { server_id: REMOTE_REF, user_id: BOB, status: 'accepted', member_instance: INSTANCE_DOMAIN },
  ]))

  await must('seed channel messages', db.from('messages').insert([
    { channel_id: PRIV_GENERAL, user_id: ALICE, content: [{ type: 'text', text: 'private general message' }] },
    { channel_id: PRIV_SECRET, user_id: ALICE, content: [{ type: 'text', text: 'private secret message' }] },
    { channel_id: PUB_GENERAL, user_id: ALICE, content: [{ type: 'text', text: 'public general message' }] },
  ]))
}

// ACTIVITIES

function voiceInvite(peer: Peer, apId: string, published: string) {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://harmony.social/ns/voice'],
    id: apId,
    type: 'harmony:VoiceCallInvite',
    actor: peer.actorUrl,
    to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
    published,
    object: {
      type: 'harmony:VoiceCall',
      id: `${apId}#object`,
      callType: 'video',
      // Minted by the calling instance; this instance stores its own
      // conversation with the caller instead.
      conversationId: 'remote-room-7f3c',
      livekitUrl: 'wss://livekit.remote.example',
      roomName: PEER_ROOM,
    },
  }
}

// CASES

async function caseVoiceInvite(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\ninbound harmony:VoiceCallInvite -> federated_voice_calls')

  const apId = `${peer.actorUrl}#call-${crypto.randomUUID()}`
  const published = new Date().toISOString()
  const activity = voiceInvite(peer, apId, published)
  const body = JSON.stringify(activity)
  const target = `${localUrl}/users/fx_bob/inbox`

  const res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'signed invite is accepted (202)')

  assert(peer.actorFetches >= 1, 'the inbox fetched the peer actor document for its public key', peer.actorFetches)

  const { data: rows, error } = await db.from('federated_voice_calls').select('*').eq('ap_id', apId)
  if (error) {
    fail('federated_voice_calls readable', error.message)
    return apId
  }
  eq(rows?.length, 1, 'exactly one federated_voice_calls row')
  const row = rows?.[0]
  if (!row) return apId

  eq(row.caller_id, REMOTE, 'caller_id is the mirrored profile of the remote caller')
  eq(row.caller_federated_id, peer.actorUrl, 'caller_federated_id is the actor URL')
  eq(row.recipient_id, BOB, 'recipient_id is the addressed local profile')
  eq(row.call_type, 'video', 'call_type comes from object.callType')
  eq(row.conversation_id, CALL_CONVERSATION, 'conversation_id is the local DM shared with the caller')
  eq(row.livekit_url, 'wss://livekit.remote.example', 'livekit_url comes from the invite')
  eq(row.room_name, PEER_ROOM, 'room_name comes from the invite')
  eq(row.status, 'pending', 'status is pending')

  const ringMs = new Date(row.expires_at).getTime() - Date.parse(published)
  assert(ringMs > 30_000 && ringMs <= 120_000, 'expires_at is one ring timeout after the invite', `${ringMs}ms`)

  const { data: stored } = await db.from('ap_activities').select('ap_type, status, is_local').eq('ap_id', apId)
  eq(stored?.[0]?.ap_type, 'harmony:VoiceCallInvite', 'the activity is stored under its own type')
  eq(stored?.[0]?.status, 'completed', 'the activity is marked completed')
  eq(stored?.[0]?.is_local, false, 'the stored activity is not local')

  const { data: cached } = await db.from('ap_actor_cache').select('ap_id').eq('ap_id', peer.actorUrl)
  eq(cached?.length, 1, 'the fetched actor document is cached')

  return apId
}

async function caseRedelivery(db: SupabaseClient, peer: Peer, localUrl: string, apId: string) {
  console.log('\nredelivery of the same invite')

  const activity = voiceInvite(peer, apId, new Date().toISOString())
  const body = JSON.stringify(activity)
  const target = `${localUrl}/users/fx_bob/inbox`

  const res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'redelivery is acknowledged (202)')
  assert(
    JSON.parse(res.body).message === 'Activity already processed',
    'redelivery is refused by the claim guard',
    res.body,
  )

  const { data: rows } = await db.from('federated_voice_calls').select('id').eq('ap_id', apId)
  eq(rows?.length, 1, 'redelivery adds no second call row')
}

async function caseTamperedBody(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\ninvite whose body changed after signing')

  const apId = `${peer.actorUrl}#call-${crypto.randomUUID()}`
  const activity = voiceInvite(peer, apId, new Date().toISOString())
  const signedBody = JSON.stringify(activity)
  activity.object.roomName = 'attacker-room'
  const sentBody = JSON.stringify(activity)
  const target = `${localUrl}/users/fx_bob/inbox`

  const res = await post(
    target,
    signedHeaders(target, signedBody, peer.key.privateKey, `${peer.actorUrl}#main-key`),
    sentBody,
  )
  eq(res.status, 401, 'a digest that does not match the body is rejected (401)')

  const { data: rows } = await db.from('federated_voice_calls').select('id').eq('ap_id', apId)
  eq(rows?.length, 0, 'nothing is written for a rejected activity')

  const { data: stored } = await db.from('ap_activities').select('ap_id').eq('ap_id', apId)
  eq(stored?.length, 0, 'a rejected activity is not stored')
}

async function caseUnsharedInvite(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\ninvite to a user the caller shares no DM with, or naming a channel room')

  const target = `${localUrl}/users/fx_carol/inbox`
  const toCarol = voiceInvite(peer, `${peer.actorUrl}#call-${crypto.randomUUID()}`, new Date().toISOString())
  toCarol.to = [`https://${INSTANCE_DOMAIN}/users/fx_carol`]
  let body = JSON.stringify(toCarol)
  let res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'the invite is acknowledged (202)')
  let { data: rows } = await db.from('federated_voice_calls').select('id').eq('ap_id', toCarol.id)
  eq(rows?.length, 0, 'a user with no DM shared with the caller is not rung')

  const channelRoom = voiceInvite(peer, `${peer.actorUrl}#call-${crypto.randomUUID()}`, new Date().toISOString())
  channelRoom.object.roomName = `channel-${PRIV_GENERAL}`
  const bobTarget = `${localUrl}/users/fx_bob/inbox`
  body = JSON.stringify(channelRoom)
  res = await post(bobTarget, signedHeaders(bobTarget, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'the channel-room invite is acknowledged (202)')
  ;({ data: rows } = await db.from('federated_voice_calls').select('id').eq('ap_id', channelRoom.id))
  eq(rows?.length, 0, 'an invite naming a channel room is not stored')
}

async function caseVoiceAccept(db: SupabaseClient, peer: Peer, localUrl: string, callApId: string) {
  console.log('\ninbound harmony:VoiceCallAccept/End from the caller -> status')

  const send = async (type: string) => {
    const activity = {
      '@context': ['https://www.w3.org/ns/activitystreams', 'https://harmony.social/ns/voice'],
      id: `${peer.actorUrl}#${type}-${crypto.randomUUID()}`,
      type,
      actor: peer.actorUrl,
      to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
      object: callApId,
      published: new Date().toISOString(),
    }
    const body = JSON.stringify(activity)
    const target = `${localUrl}/users/fx_bob/inbox`
    return post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  }
  const status = async () => {
    const { data: rows } = await db.from('federated_voice_calls').select('status').eq('ap_id', callApId)
    return rows?.[0]?.status
  }

  eq((await send('harmony:VoiceCallAccept')).status, 202, 'signed accept is acknowledged (202)')
  eq(await status(), 'pending', 'the caller cannot accept its own call; only the invited recipient does')

  eq((await send('harmony:VoiceCallEnd')).status, 202, 'signed end is acknowledged (202)')
  eq(await status(), 'ended', 'the caller ends its own call')
}

async function caseInboundDM(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\ninbound Create Note (direct) -> messages')

  const noteId = `${peer.base}/notes/${crypto.randomUUID()}`
  const published = new Date().toISOString()
  const activity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${peer.actorUrl}#create-${crypto.randomUUID()}`,
    type: 'Create',
    actor: peer.actorUrl,
    published,
    to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
    cc: [],
    object: {
      id: noteId,
      type: 'Note',
      attributedTo: peer.actorUrl,
      published,
      content: '<p>dm from the peer</p>',
      to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
      cc: [],
      directMessage: true,
    },
  }
  const body = JSON.stringify(activity)
  const target = `${localUrl}/users/fx_bob/inbox`

  const res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'signed DM is accepted (202)')

  const { data: rows, error } = await db
    .from('messages')
    .select('id, user_id, conversation_id, content, metadata')
    .contains('metadata', { ap_id: noteId })
  if (error) {
    fail('messages readable', error.message)
    return
  }
  eq(rows?.length, 1, 'exactly one message row for the note')
  const row = rows?.[0]
  if (!row) return

  eq(row.user_id, REMOTE, 'the message is attributed to the mirrored remote profile')
  assert(row.metadata?.federated === true, 'the message is marked federated', JSON.stringify(row.metadata))
  assert(
    JSON.stringify(row.content).includes('dm from the peer'),
    'the note content reached the message row',
    JSON.stringify(row.content),
  )

  const { data: participants } = await db
    .from('conversation_participants')
    .select('user_id')
    .eq('conversation_id', row.conversation_id)
  const ids = (participants ?? []).map((p) => p.user_id).sort()
  assert(
    ids.length === 2 && ids.includes(REMOTE) && ids.includes(BOB),
    'the DM lands in a conversation holding sender and recipient',
    JSON.stringify(ids),
  )
}

async function caseOutboundDM(db: SupabaseClient, peer: Peer, backend: Backend) {
  console.log('\noutbound DM -> the recipient\'s personal inbox, signed')

  const before = peer.captured.length
  const insert = await db
    .from('messages')
    .insert({
      conversation_id: CONVERSATION,
      user_id: ALICE,
      content: [{ type: 'text', text: 'dm from alice to the peer' }],
    })
    .select('*')
    .single()
  if (insert.error) {
    fail('insert the outbound DM', insert.error.message)
    return
  }

  await backend.handleNewDM(insert.data)

  const delivered = peer.captured.slice(before)
  eq(delivered.length, 1, 'the peer received exactly one delivery')
  const req = delivered[0]
  if (!req) return

  // inbox_url over shared_inbox_url: a DM addresses one actor. Both are set on
  // the seeded profile and they differ, so the wrong precedence shows up here.
  eq(req.url, '/users/fx_remote/inbox', 'delivery goes to the personal inbox, not the shared inbox')

  const sent = JSON.parse(req.raw.toString('utf-8'))
  eq(sent.type, 'Create', 'the delivered activity is a Create')
  eq(sent.actor, `https://${INSTANCE_DOMAIN}/users/fx_alice`, 'the activity is attributed to the local sender')
  eq(sent.object?.type, 'Note', 'the object is a Note')
  assert(sent.object?.directMessage === true, 'the note is flagged as a direct message', JSON.stringify(sent.object))
  assert(
    Array.isArray(sent.to) && sent.to.length === 1 && sent.to[0] === peer.actorUrl,
    'the activity is addressed to the remote actor',
    JSON.stringify(sent.to),
  )
  assert(
    JSON.stringify(sent.object?.content).includes('dm from alice to the peer'),
    'the message text reached the note',
    JSON.stringify(sent.object?.content),
  )

  eq(req.headers.digest, backend.createDigest(req.raw), 'Digest covers the bytes the peer received')

  const verification = await backend.verifySignature(
    req.headers.signature,
    req.headers,
    'POST',
    req.url,
    req.raw,
  )
  assert(verification.verified, 'the delivered signature verifies against the sender key', JSON.stringify(verification))
  eq(
    verification.actorUrl,
    `https://${INSTANCE_DOMAIN}/users/fx_alice`,
    'the signing key belongs to the sender',
  )

  const { data: queued } = await db
    .from('federation_delivery_queue')
    .select('target_inbox_url, status')
    .eq('sender_id', ALICE)
  eq(queued?.length, 0, 'an accepted delivery leaves nothing queued for retry')

  const { data: stored } = await db.from('messages').select('metadata').eq('id', insert.data.id).single()
  eq(
    stored?.metadata?.ap_id,
    `https://${INSTANCE_DOMAIN}/messages/${insert.data.id}`,
    'the sent message records the ap_id it was published under',
  )
}

async function caseSignedGetRetry(peer: Peer, localUrl: string, db: SupabaseClient) {
  console.log('\noutbound GET against authorized fetch -> signed retry')

  peer.localUrl = localUrl
  const before = peer.secureGetRequests.length

  const res = await post(
    `${localUrl}/resolve-post`,
    { 'Content-Type': 'application/json' },
    JSON.stringify({ url: peer.secureNoteUrl }),
  )
  eq(res.status, 200, 'resolve-post succeeds against the secure peer')

  const reqs = peer.secureGetRequests.slice(before)
  eq(reqs.length, 2, 'the peer saw an unsigned attempt and exactly one signed retry')

  const first = reqs[0]
  const second = reqs[1]
  assert(!first?.headers.signature, 'the first attempt carries no Signature header')
  assert(!!second?.headers.signature, 'the retry carries a Signature header')

  const params = second?.headers.signature ? parseSignatureHeader(second.headers.signature) : {}
  eq(params.headers, '(request-target) host date', 'the retry signs (request-target), host and date')
  assert(
    (params.keyId ?? '').startsWith(`https://${INSTANCE_DOMAIN}/users/`),
    'the retry is signed by a local actor key',
    params.keyId,
  )

  const { data: row } = await db
    .from('posts')
    .select('id, ap_id, is_local')
    .eq('ap_id', peer.secureNoteUrl)
    .maybeSingle()
  assert(!!row, 'the resolved note is stored locally')
  eq(row?.is_local, false, 'the stored note is marked remote')
}

async function caseHostedPrivateServer(peer: Peer, localUrl: string) {
  console.log('\nhosted private server -> only a signed member that can view the channel reads it')

  const page = (server: string, channel: string) =>
    `${localUrl}/servers/${server}/channels/${channel}/messages?page=1`
  const signedBy = (privateKey: string, actor: string) => (url: string) =>
    get(url, signedGetHeaders(url, privateKey, `${actor}#main-key`))
  const asMember = signedBy(peer.key.privateKey, peer.actorUrl)
  const asStranger = signedBy(peer.strangerKey.privateKey, peer.strangerUrl)
  const asInstance = signedBy(peer.instanceKey.privateKey, peer.instanceActorUrl)
  const items = (res: { json: any }) => JSON.stringify(res.json?.orderedItems ?? [])

  const general = page(PRIV_SERVER, PRIV_GENERAL)
  const unsigned = await get(general)
  eq(unsigned.status, 404, 'an unsigned read of a private channel is 404')

  const member = await asMember(general)
  eq(member.status, 200, 'the signed member reads the private channel')
  assert(items(member).includes('private general message'), 'the member gets the channel messages', member.body)
  eq(member.headers['cache-control'], 'private, no-store', 'the private page is not cacheable')

  const secret = await asMember(page(PRIV_SERVER, PRIV_SECRET))
  eq(secret.status, 404, 'a member without VIEW_CHANNEL on the channel gets 404')

  eq((await asStranger(general)).status, 404, 'a signed non-member gets 404')
  eq((await asInstance(general)).status, 404, 'the peer instance actor gets 404')

  const unknown = await get(page(PRIV_SERVER, 'fed00000-0000-0000-0000-0000000000ff'))
  assert(
    unknown.status === 404 && unknown.body === unsigned.body,
    'an unknown channel answers exactly as a hidden one',
    `${unknown.status} ${unknown.body} / ${unsigned.body}`,
  )

  const groupUrl = `${localUrl}/servers/${PRIV_SERVER}`
  const stub = await get(groupUrl)
  eq(stub.status, 200, 'the private Group answers an unsigned caller')
  assert(
    stub.json?.type === 'Group' && String(stub.json?.inbox).endsWith(`/servers/${PRIV_SERVER}/inbox`),
    'the stub carries the id and inbox a Join needs',
    stub.body,
  )
  eq(stub.json?.['harmony:channels'], undefined, 'the stub lists no channels')

  const full = await asMember(groupUrl)
  const listed = (full.json?.['harmony:channels'] ?? []).map((c: any) => c.localId)
  assert(
    listed.includes(PRIV_GENERAL) && !listed.includes(PRIV_SECRET),
    'the member\'s Group lists the channels it can view and no other',
    JSON.stringify(listed),
  )

  const outboxUrl = `${localUrl}/servers/${PRIV_SERVER}/outbox?page=1`
  eq((await get(outboxUrl)).status, 404, 'an unsigned read of the private outbox is 404')
  const outbox = await asMember(outboxUrl)
  assert(
    outbox.status === 200 &&
      items(outbox).includes('private general message') &&
      !items(outbox).includes('private secret message'),
    'the member\'s outbox holds only channels it can view',
    outbox.body,
  )

  const pub = await get(page(PUB_SERVER, PUB_GENERAL))
  eq(pub.status, 200, 'a public server\'s public channel still reads unsigned')
  assert(items(pub).includes('public general message'), 'the public page carries its messages', pub.body)
  assert(
    String(pub.headers['cache-control']).startsWith('public'),
    'the public page stays cacheable',
    pub.headers['cache-control'],
  )
}

async function caseProxyReadsAsMember(peer: Peer, localUrl: string, jwtSecret: string) {
  console.log('\nremote private channel -> the proxy signs as the requesting member')

  const proxyUrl = `${localUrl}/channels/${REMOTE_CHANNEL}/messages`
  const as = (authUserId: string) => ({
    Accept: 'application/json',
    Authorization: `Bearer ${userToken(authUserId, jwtSecret)}`,
  })
  const before = peer.groupGetRequests.length

  eq((await get(proxyUrl, { Accept: 'application/json' })).status, 401, 'the proxy refuses a caller with no session')

  const carol = await get(proxyUrl, as(CAROL_AUTH))
  eq(carol.status, 404, 'a local user who is not a member gets nothing')
  eq(peer.groupGetRequests.length, before, 'nothing reached the host for the anonymous or non-member caller')

  const bob = await get(proxyUrl, as(BOB_AUTH))
  eq(bob.status, 200, 'the member reads the remote channel through the proxy')
  eq(bob.json?.source, 'remote', 'the messages come from the host, not the local cache')
  assert(
    JSON.stringify(bob.json?.messages ?? []).includes('peer private message'),
    'the host\'s message reaches the member',
    bob.body,
  )

  const reqs = peer.groupGetRequests.slice(before)
  eq(reqs.length, 1, 'the host saw one request, signed from the start with no unsigned attempt')
  const params = reqs[0]?.headers.signature ? parseSignatureHeader(reqs[0].headers.signature) : {}
  eq(params.keyId, `https://${INSTANCE_DOMAIN}/users/fx_bob#main-key`, 'the request carries the member\'s own key')
}

async function caseSyncSignsAsMember(db: SupabaseClient, peer: Peer, localUrl: string, jwtSecret: string) {
  console.log('\nremote private Group sync -> signed as a member, channels under their remote ids')

  const before = peer.groupGetRequests.length
  const res = await get(`${localUrl}/servers/${REMOTE_REF}/sync`, {
    Accept: 'application/json',
    Authorization: `Bearer ${userToken(BOB_AUTH, jwtSecret)}`,
  })
  eq(res.status, 200, 'the sync answers')

  const reqs = peer.groupGetRequests.slice(before)
  eq(reqs.length, 1, 'the host saw one Group fetch')
  const params = reqs[0]?.headers.signature ? parseSignatureHeader(reqs[0].headers.signature) : {}
  eq(params.keyId, `https://${INSTANCE_DOMAIN}/users/fx_bob#main-key`, 'the Group fetch is signed as the member')

  const { data: added } = await db
    .from('channels')
    .select('id, server_id, is_remote, ap_id')
    .eq('id', REMOTE_CHANNEL_NEW)
    .maybeSingle()
  assert(
    added?.server_id === REMOTE_REF && added?.is_remote === true && added?.ap_id === peer.channelUrl(REMOTE_CHANNEL_NEW),
    'the channel only a member sees is added under its remote UUID',
    JSON.stringify(added),
  )
}

// VOICE

const VOICE_CONTEXT = ['https://www.w3.org/ns/activitystreams', 'https://harmony.social/ns/voice']
const LOCAL_ALICE = `https://${INSTANCE_DOMAIN}/users/fx_alice`
const LOCAL_BOB = `https://${INSTANCE_DOMAIN}/users/fx_bob`

async function seedVoice(db: SupabaseClient, peer: Peer) {
  await must('seed voice channels', db.from('channels').insert([
    { id: PRIV_VOICE, server_id: PRIV_SERVER, name: 'voice', type: 1 },
    { id: PRIV_VOICE_HIDDEN, server_id: PRIV_SERVER, name: 'staff-voice', type: 1 },
    { id: REMOTE_VOICE, server_id: REMOTE_REF, name: 'peer-voice', type: 1, is_remote: true, ap_id: peer.channelUrl(REMOTE_VOICE) },
  ]))
  const everyone = await must('everyone role', db
    .from('server_roles').select('id').eq('server_id', PRIV_SERVER).eq('is_default', true).single())
  await must('hide staff-voice', db.from('channel_permission_overrides').insert({
    channel_id: PRIV_VOICE_HIDDEN,
    target_type: 'role',
    role_id: everyone.id,
    allow_permissions: 0,
    deny_permissions: 2,
  }))
  // authorizeVoiceChannel admits a remote actor only on a federated server.
  await must('federate the hosted server', db.from('servers').update({ federation_enabled: true }).eq('id', PRIV_SERVER))
}

/** A voice activity signed by a peer actor and posted to a local inbox. */
function peerSends(
  peer: Peer,
  target: string,
  activity: Record<string, unknown>,
  signer: { key: string; actor: string } = { key: peer.key.privateKey, actor: peer.actorUrl },
) {
  const body = JSON.stringify({ '@context': VOICE_CONTEXT, published: new Date().toISOString(), ...activity })
  return post(target, signedHeaders(target, body, signer.key, `${signer.actor}#main-key`), body)
}

async function postJson(url: string, headers: Record<string, string>, payload: unknown) {
  const res = await post(url, { 'Content-Type': 'application/json', ...headers }, JSON.stringify(payload))
  let json: any = null
  try {
    json = JSON.parse(res.body)
  } catch {
    json = null
  }
  return { ...res, json }
}

/** Events of one type Realtime would deliver on a profile's private user channel. */
async function userEvents(db: SupabaseClient, profileId: string, type: string): Promise<any[]> {
  const { data, error } = await db.rpc('hmfed_broadcasts', { p_topic: `user:${profileId}` })
  if (error) throw new Error(`hmfed_broadcasts: ${error.message}`)
  return ((data ?? []) as any[]).filter((p) => p?.type === type)
}

/** Requests the peer received at `url` since `before`, with parsed bodies. */
function deliveries(peer: Peer, before: number, url: string) {
  return peer.captured
    .slice(before)
    .filter((c) => c.url === url)
    .map((c) => ({ req: c, body: JSON.parse(c.raw.toString('utf-8')) }))
}

async function callRow(db: SupabaseClient, apId: unknown) {
  const { data } = await db
    .from('federated_voice_calls')
    .select('direction, status, caller_id, recipient_id, conversation_id, room_name')
    .eq('ap_id', apId as string)
    .maybeSingle()
  return data
}

async function caseHostedDmCall(db: SupabaseClient, peer: Peer, localUrl: string, jwtSecret: string, lk: LiveKit, backend: Backend) {
  console.log('\nDM call hosted here -> the peer\'s user takes its token from this instance and joins alice\'s room')

  const room = `federated-dm-${CONVERSATION}-${Date.now()}`
  const asAlice = { Authorization: `Bearer ${userToken(ALICE_AUTH, jwtSecret)}` }
  const before = peer.captured.length

  const invite = await postJson(`${localUrl}/api/livekit/federated-call/invite`, asAlice, {
    calleeFederatedId: peer.actorUrl,
    callType: 'voice',
    conversationId: CONVERSATION,
    roomName: room,
  })
  eq(invite.status, 200, 'alice rings the peer\'s user')
  const inviteId = invite.json?.activityId

  const sent = deliveries(peer, before, '/users/fx_remote/inbox')
  eq(sent.length, 1, 'the invite reaches the callee\'s inbox')
  eq(sent[0]?.body?.type, 'harmony:VoiceCallInvite', 'it is a harmony:VoiceCallInvite')
  eq(sent[0]?.body?.object?.roomName, room, 'it names alice\'s room')
  eq(sent[0]?.body?.object?.livekitUrl, lk.url, 'on this instance\'s LiveKit')
  if (sent[0]) {
    const v = await backend.verifySignature(sent[0].req.headers.signature, sent[0].req.headers, 'POST', sent[0].req.url, sent[0].req.raw)
    eq(v.actorUrl, LOCAL_ALICE, 'the invite is signed with alice\'s key')
  }

  const row = await callRow(db, inviteId)
  assert(
    row?.direction === 'outbound' && row?.status === 'pending' && row?.caller_id === ALICE
      && row?.recipient_id === REMOTE && row?.room_name === room && row?.conversation_id === CONVERSATION,
    'the invite is stored as an outbound call to the peer\'s user for alice\'s room',
    JSON.stringify(row),
  )

  const tokenUrl = `${localUrl}/api/livekit/federated-token`
  const ask = (key: string, actor: string, actorId: string, roomName = room) => {
    const body = JSON.stringify({ actorId, roomName, roomType: 'dm_call' })
    return post(tokenUrl, signedHeaders(tokenUrl, body, key, `${actor}#main-key`), body)
  }
  eq((await ask(peer.strangerKey.privateKey, peer.strangerUrl, peer.strangerUrl)).status, 403,
    'a signed stranger gets no token for the room')
  eq((await ask(peer.strangerKey.privateKey, peer.strangerUrl, peer.actorUrl)).status, 403,
    'a token for the callee signed with another key is refused')
  eq((await ask(peer.key.privateKey, peer.actorUrl, peer.actorUrl, `federated-dm-${CONVERSATION}-1`)).status, 403,
    'the callee gets no token for a room it was not rung to')
  const granted = await ask(peer.key.privateKey, peer.actorUrl, peer.actorUrl)
  eq(granted.status, 200, 'the callee, signing as itself, gets a token for the room while it rings')
  const callee = granted.status === 200 ? JSON.parse(granted.body) : {}
  eq(callee.roomName, room, 'the token answer names the room')
  eq(callee.wsUrl, lk.url, 'and this instance\'s LiveKit')

  const acceptRes = await peerSends(peer, `${localUrl}/users/fx_alice/inbox`, {
    type: 'harmony:VoiceCallAccept',
    id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`,
    actor: peer.actorUrl,
    to: [LOCAL_ALICE],
    object: inviteId,
  })
  eq(acceptRes.status, 202, 'the callee\'s signed accept is acknowledged (202)')
  eq((await callRow(db, inviteId))?.status, 'accepted', 'the outbound call is accepted')
  const accepted = await userEvents(db, ALICE, 'federated_call:accepted')
  assert(
    accepted.some((e) => e.callId === inviteId && e.conversationId === CONVERSATION && e.roomName === room && e.partyId === REMOTE),
    'alice hears of the accept on her private user channel',
    JSON.stringify(accepted),
  )

  const own = await postJson(`${localUrl}/api/livekit/token`, asAlice, { roomName: room, roomType: 'dm_call' })
  eq(own.status, 200, 'alice gets her own token for her room')

  await bothInRoom(
    lk,
    room,
    { who: 'alice', token: own.json?.token, identity: `federated:${LOCAL_ALICE}` },
    { who: 'the peer\'s user', token: callee.token, identity: `federated:${peer.actorUrl}` },
    'the DM call hosted here',
  )

  const endRes = await peerSends(peer, `${localUrl}/users/fx_alice/inbox`, {
    type: 'harmony:VoiceCallEnd',
    id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`,
    actor: peer.actorUrl,
    to: [LOCAL_ALICE],
    object: inviteId,
  })
  eq(endRes.status, 202, 'the callee\'s signed end is acknowledged (202)')
  eq((await callRow(db, inviteId))?.status, 'ended', 'the outbound call is ended')
  const ended = await userEvents(db, ALICE, 'federated_call:ended')
  assert(ended.some((e) => e.callId === inviteId), 'alice hears of the end', JSON.stringify(ended))
  eq((await ask(peer.key.privateKey, peer.actorUrl, peer.actorUrl)).status, 403, 'an ended call grants no further token')
}

async function casePeerHostedDmCall(db: SupabaseClient, peer: Peer, localUrl: string, jwtSecret: string, lk: LiveKit, backend: Backend) {
  console.log('\nDM call hosted by the peer -> fx_bob accepts and this instance fetches his token from the peer')

  const asBob = { Authorization: `Bearer ${userToken(BOB_AUTH, jwtSecret)}` }
  const ring = async (room: string) => {
    const apId = `${peer.actorUrl}/activities/${crypto.randomUUID()}`
    const activity = voiceInvite(peer, apId, new Date().toISOString())
    activity.object.roomName = room
    activity.object.livekitUrl = lk.url
    const body = JSON.stringify(activity)
    const target = `${localUrl}/users/fx_bob/inbox`
    const res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
    return { apId, status: res.status }
  }
  const accept = () => postJson(`${localUrl}/api/livekit/federated-call/accept`, asBob, {
    conversationId: CALL_CONVERSATION,
    callerFederatedId: peer.actorUrl,
  })

  const room = `federated-dm-${PEER_CONVERSATION}-${Date.now()}`
  peer.hostedRooms.set(room, LOCAL_BOB)
  const call = await ring(room)
  eq(call.status, 202, 'the peer rings fx_bob')
  const incoming = await userEvents(db, BOB, 'federated_call:incoming')
  assert(
    incoming.some((e) => e.callId === call.apId && e.conversationId === CALL_CONVERSATION && e.roomName === room),
    'fx_bob is rung on his private user channel with his own conversation',
    JSON.stringify(incoming),
  )

  const tokensBefore = peer.tokenRequests.length
  const before = peer.captured.length
  const res = await accept()
  eq(res.status, 200, 'fx_bob accepts')
  eq(res.json?.roomName, room, 'the answer names the peer\'s room')
  eq(res.json?.livekitUrl, lk.url, 'on the peer\'s LiveKit')

  const asked = peer.tokenRequests.slice(tokensBefore)
  eq(asked.length, 1, 'the peer saw one token request')
  eq(
    asked[0]?.headers.signature ? parseSignatureHeader(asked[0].headers.signature).keyId : undefined,
    `${LOCAL_BOB}#main-key`,
    'signed with fx_bob\'s own key',
  )
  eq((await callRow(db, call.apId))?.status, 'accepted', 'the inbound call is accepted')

  const acks = deliveries(peer, before, '/users/fx_remote/inbox')
  eq(acks.length, 1, 'the accept reaches the caller\'s inbox')
  eq(acks[0]?.body?.type, 'harmony:VoiceCallAccept', 'it is a harmony:VoiceCallAccept')
  eq(acks[0]?.body?.object, call.apId, 'naming the invite')
  if (acks[0]) {
    const v = await backend.verifySignature(acks[0].req.headers.signature, acks[0].req.headers, 'POST', acks[0].req.url, acks[0].req.raw)
    eq(v.actorUrl, LOCAL_BOB, 'signed with fx_bob\'s key')
  }

  await bothInRoom(
    lk,
    room,
    { who: 'fx_bob', token: res.json?.token, identity: `federated:${LOCAL_BOB}` },
    { who: 'the peer\'s caller', token: await lk.mint(`federated:${peer.actorUrl}`, room), identity: `federated:${peer.actorUrl}` },
    'the peer\'s DM call',
  )

  eq((await accept()).status, 404, 'a second accept finds no ringing call')

  const endBefore = peer.captured.length
  eq((await postJson(`${localUrl}/api/livekit/federated-call/end`, asBob, { conversationId: CALL_CONVERSATION })).status, 200,
    'fx_bob hangs up')
  eq((await callRow(db, call.apId))?.status, 'ended', 'the inbound call is ended')
  const ends = deliveries(peer, endBefore, '/users/fx_remote/inbox')
  assert(
    ends.length === 1 && ends[0].body.type === 'harmony:VoiceCallEnd' && ends[0].body.object === call.apId,
    'the end reaches the caller\'s inbox, naming the invite',
    JSON.stringify(ends.map((e) => e.body)),
  )

  const unknownRoom = `federated-dm-${PEER_CONVERSATION}-${Date.now() + 1}`
  const refused = await ring(unknownRoom)
  eq(refused.status, 202, 'the peer rings fx_bob for a room it will not issue')
  eq((await accept()).status, 502, 'with no token from the caller\'s instance the accept fails')
  eq((await callRow(db, refused.apId))?.status, 'pending', 'and the call still rings')
}

async function caseRemoteVoiceJoin(db: SupabaseClient, peer: Peer, localUrl: string, jwtSecret: string, lk: LiveKit, backend: Backend) {
  console.log('\nvoice channel of the peer\'s Group -> fx_bob joins; the peer\'s token reaches his private user channel')

  const asBob = { Authorization: `Bearer ${userToken(BOB_AUTH, jwtSecret)}` }
  const before = peer.captured.length
  const join = await postJson(`${localUrl}/api/federation/voice/join`, asBob, { channelId: REMOTE_VOICE, serverId: REMOTE_REF })
  eq(join.status, 200, 'fx_bob asks to join the peer\'s voice channel')
  const joinId = join.json?.joinId
  eq(join.json?.serverHost, new URL(peer.base).host, 'the join is bound to the peer\'s host')

  const sent = deliveries(peer, before, `/servers/${REMOTE_REF}/inbox`)
  eq(sent.length, 1, 'the join reaches the Group\'s inbox')
  eq(sent[0]?.body?.type, 'harmony:VoiceChannelJoin', 'it is a harmony:VoiceChannelJoin')
  eq(sent[0]?.body?.id, joinId, 'under the join id fx_bob was given')
  eq(sent[0]?.body?.object?.id, peer.channelUrl(REMOTE_VOICE), 'naming the channel by its remote id')
  if (sent[0]) {
    const v = await backend.verifySignature(sent[0].req.headers.signature, sent[0].req.headers, 'POST', sent[0].req.url, sent[0].req.raw)
    eq(v.actorUrl, LOCAL_BOB, 'signed with fx_bob\'s key')
  }

  const room = `channel-${REMOTE_VOICE}`
  const bobToken = await lk.mint(`federated:${LOCAL_BOB}`, room)
  const answer = (object: unknown) => peerSends(peer, `${localUrl}/inbox`, {
    type: 'harmony:VoiceChannelJoinAccept',
    id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`,
    actor: peer.actorUrl,
    to: [LOCAL_BOB],
    object,
    result: { type: 'harmony:VoiceToken', livekitUrl: lk.url, token: bobToken, roomName: room, expiresAt: new Date(Date.now() + 3_600_000).toISOString() },
  })

  const forged = `${LOCAL_BOB}/activities/voice-join/${crypto.randomBytes(9).toString('base64url')}.9999999999999.AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA`
  eq((await answer(forged)).status, 202, 'an answer to a join fx_bob never sent is acknowledged (202)')
  const answering = async (id: unknown) =>
    (await userEvents(db, BOB, 'federated_voice:token')).filter((t) => t.originalJoinId === id)
  eq((await answering(forged)).length, 0, 'and delivers nothing')

  eq((await answer(joinId)).status, 202, 'the peer\'s signed answer is acknowledged (202)')
  const tokens = await answering(joinId)
  assert(
    tokens.length === 1 && tokens[0].serverHost === join.json?.serverHost
      && tokens[0].token === bobToken && tokens[0].roomName === room,
    'the token reaches fx_bob on his private user channel, naming his join and the host',
    JSON.stringify(tokens.map((t) => ({ ...t, token: t.token === bobToken ? '<minted>' : '<other>' }))),
  )

  await bothInRoom(
    lk,
    room,
    { who: 'fx_bob', token: tokens[0]?.token, identity: `federated:${LOCAL_BOB}` },
    { who: 'the peer\'s member', token: await lk.mint(`federated:${peer.actorUrl}`, room), identity: `federated:${peer.actorUrl}` },
    'the peer\'s voice channel',
  )
}

async function caseHostedVoiceJoin(db: SupabaseClient, peer: Peer, localUrl: string, jwtSecret: string, lk: LiveKit, backend: Backend) {
  console.log('\nvoice channel of the hosted private server -> the peer\'s user joins; the token reaches its instance')

  const target = `${localUrl}/servers/${PRIV_SERVER}/inbox`
  const join = (channel: string, signer = { key: peer.key.privateKey, actor: peer.actorUrl }) => {
    const id = `${signer.actor}/activities/voice-join/${crypto.randomUUID()}`
    return peerSends(peer, target, {
      type: 'harmony:VoiceChannelJoin',
      id,
      actor: signer.actor,
      object: { type: 'harmony:VoiceChannel', id: `https://${INSTANCE_DOMAIN}/servers/${PRIV_SERVER}/channels/${channel}`, name: 'voice' },
      target: `https://${INSTANCE_DOMAIN}/servers/${PRIV_SERVER}`,
    }, signer).then((res) => ({ id, status: res.status }))
  }
  const answers = (before: number) =>
    deliveries(peer, before, '/inbox').filter((d) => d.body?.type === 'harmony:VoiceChannelJoinAccept')

  let before = peer.captured.length
  eq((await join(PRIV_VOICE_HIDDEN)).status, 202, 'a join to a voice channel the member cannot view is acknowledged (202)')
  eq(answers(before).length, 0, 'and answered with no token')

  before = peer.captured.length
  eq((await join(PRIV_VOICE, { key: peer.strangerKey.privateKey, actor: peer.strangerUrl })).status, 202,
    'a non-member\'s join is acknowledged (202)')
  eq(answers(before).length, 0, 'and answered with no token')

  before = peer.captured.length
  const member = await join(PRIV_VOICE)
  eq(member.status, 202, 'the member\'s join is acknowledged (202)')
  const got = answers(before)
  eq(got.length, 1, 'the member\'s join is answered once, at its instance\'s shared inbox')
  const accept = got[0]
  eq(accept?.body?.actor, LOCAL_ALICE, 'the answer is the server owner\'s')
  eq(accept?.body?.object, member.id, 'naming the join')
  if (accept) {
    const v = await backend.verifySignature(accept.req.headers.signature, accept.req.headers, 'POST', accept.req.url, accept.req.raw)
    assert(v.verified && v.actorUrl === LOCAL_ALICE, 'signed with the owner\'s key', JSON.stringify(v))
  }
  const room = `channel-${PRIV_VOICE}`
  eq(accept?.body?.result?.roomName, room, 'the token is for the channel\'s room')
  eq(accept?.body?.result?.livekitUrl, lk.url, 'on this instance\'s LiveKit')

  const { data: present } = await db
    .from('voice_channel_participants')
    .select('user_id, is_federated')
    .eq('channel_id', PRIV_VOICE)
  assert(
    (present ?? []).some((p) => p.user_id === REMOTE && p.is_federated === true),
    'the peer\'s user is recorded in the channel',
    JSON.stringify(present),
  )

  const own = await postJson(`${localUrl}/api/livekit/token`, { Authorization: `Bearer ${userToken(ALICE_AUTH, jwtSecret)}` }, {
    roomName: room,
    roomType: 'voice_channel',
  })
  eq(own.status, 200, 'alice gets her token for the channel')

  await bothInRoom(
    lk,
    room,
    { who: 'the peer\'s user', token: accept?.body?.result?.token, identity: `federated:${peer.actorUrl}` },
    { who: 'alice', token: own.json?.token, identity: `federated:${LOCAL_ALICE}` },
    'the hosted voice channel',
  )
}

// POST VISIBILITY

async function casePostVisibility(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\nposts and DM messages by visibility -> only signers that may read them')

  const peerHost = new URL(peer.base).host
  const other = new Peer()
  await other.start(new URL(peer.base).hostname)
  try {
    await db.from('posts').delete().in('id', [POST_PUBLIC, POST_UNLISTED, POST_FOLLOWERS, POST_DIRECT])
    await db.from('follows').delete().eq('follower_id', REMOTE).eq('following_id', ALICE)
    await must('seed visibility posts', db.from('posts').insert([
      { id: POST_PUBLIC, author_id: ALICE, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'public post' }] },
      { id: POST_UNLISTED, author_id: ALICE, visibility: 'unlisted', is_local: true, content: [{ type: 'text', text: 'unlisted post' }] },
      { id: POST_FOLLOWERS, author_id: ALICE, visibility: 'followers', is_local: true, content: [{ type: 'text', text: 'followers post' }] },
      {
        id: POST_DIRECT, author_id: ALICE, visibility: 'direct', is_local: true,
        content: [
          { type: 'mention', userId: REMOTE, username: 'fx_remote', domain: peerHost, isLocal: false },
          { type: 'text', text: ' direct post' },
        ],
      },
    ]))
    await must('seed follow', db.from('follows').insert({ follower_id: REMOTE, following_id: ALICE, status: 'accepted' }))
    await db.from('messages').delete().eq('id', DM_MESSAGE)
    await must('seed DM message', db.from('messages').insert({
      id: DM_MESSAGE, conversation_id: CONVERSATION, user_id: ALICE,
      content: [{ type: 'text', text: 'federated dm' }],
    }))
    // The insert trigger queues the DM; the worker that completes it is not running.
    await must('mark DM federated', db.from('messages').update({ federation_status: 'completed' }).eq('id', DM_MESSAGE))

    const ap = { Accept: 'application/activity+json' }
    const signedBy = (privateKey: string, actor: string) => (url: string) =>
      get(url, signedGetHeaders(url, privateKey, `${actor}#main-key`))
    const asFollower = signedBy(peer.key.privateKey, peer.actorUrl)
    const asPeerInstance = signedBy(peer.instanceKey.privateKey, peer.instanceActorUrl)
    const asOtherInstance = signedBy(other.instanceKey.privateKey, other.instanceActorUrl)
    const post = (id: string) => `${localUrl}/posts/${id}`

    for (const [id, label] of [[POST_PUBLIC, 'public'], [POST_UNLISTED, 'unlisted']]) {
      const res = await get(post(id), ap)
      assert(res.status === 200 && res.json?.id === `https://${INSTANCE_DOMAIN}/posts/${id}`,
        `a ${label} post is served unsigned`, `${res.status} ${res.body.slice(0, 120)}`)
      eq(res.headers['cache-control'], 'public, max-age=300', `the ${label} post stays cacheable`)
      eq((await asOtherInstance(post(id))).status, 200, `a ${label} post is served to any signer`)
    }

    const unknown = await get(post('fed00000-0000-0000-0000-0000000000ff'), ap)
    for (const [id, label] of [[POST_FOLLOWERS, 'followers-only'], [POST_DIRECT, 'direct']]) {
      const unsigned = await get(post(id), ap)
      assert(unsigned.status === 404 && unsigned.body === unknown.body,
        `an unsigned read of a ${label} post answers as an unknown id`, `${unsigned.status} ${unsigned.body}`)
      eq((await asOtherInstance(post(id))).status, 404, `a ${label} post is 404 to an instance without a reader`)
      const html = await get(post(id), { Accept: 'text/html' })
      eq(html.status, 404, `a ${label} post has no HTML page`)
    }

    const followersByUser = await asFollower(post(POST_FOLLOWERS))
    assert(followersByUser.status === 200 && followersByUser.json?.content?.includes('followers post'),
      'the follower fetches the followers-only post with its user key', `${followersByUser.status}`)
    eq(followersByUser.headers['cache-control'], 'private, no-store', 'the followers-only post is not cacheable')
    eq((await asPeerInstance(post(POST_FOLLOWERS))).status, 200,
      'the follower\'s instance actor fetches it, as Mastodon and Misskey fetch on receipt')
    eq((await asPeerInstance(post(POST_DIRECT))).status, 200, 'the recipient\'s instance fetches the direct post')

    eq((await get(`${post(POST_FOLLOWERS)}/replies`, ap)).status, 404, 'an unsigned read of its replies is 404')
    eq((await get(`${post(POST_FOLLOWERS)}/likes`, ap)).status, 404, 'an unsigned read of its likes is 404')
    eq((await asPeerInstance(`${post(POST_FOLLOWERS)}/likes`)).status, 200, 'the follower\'s instance reads its likes')

    const outbox = await get(`${localUrl}/users/fx_alice/outbox?cursor=start&limit=50`, ap)
    const listed = JSON.stringify(outbox.json?.orderedItems ?? [])
    assert(outbox.status === 200 && listed.includes('public post') && listed.includes('unlisted post')
        && !listed.includes('followers post') && !listed.includes('direct post'),
      'the outbox lists public and unlisted posts only', outbox.body.slice(0, 200))
    const signedOutbox = JSON.stringify((await asPeerInstance(`${localUrl}/users/fx_alice/outbox?cursor=start&limit=50`)).json?.orderedItems ?? [])
    assert(!signedOutbox.includes('followers post') && !signedOutbox.includes('direct post'),
      'a signed outbox read lists them neither')

    const dm = `${localUrl}/messages/${DM_MESSAGE}`
    eq((await get(dm, ap)).status, 404, 'an unsigned read of a DM message is 404')
    eq((await asOtherInstance(dm)).status, 404, 'a DM message is 404 to an instance without a participant')
    const dmRead = await asPeerInstance(dm)
    eq(dmRead.status, 200, 'the participant\'s instance reads the DM message')
    eq(dmRead.headers['cache-control'], 'private, no-store', 'the DM message is not cacheable')

    await db.from('follows').delete().eq('follower_id', REMOTE).eq('following_id', ALICE)
    eq((await asPeerInstance(post(POST_FOLLOWERS))).status, 404, 'after the unfollow the followers-only post is 404')
  } finally {
    await other.stop()
  }
}

// REPORTS

async function seedReports(db: SupabaseClient) {
  await must('seed reported post', db.from('posts').insert({
    id: ALICE_POST,
    author_id: ALICE,
    content: [{ type: 'text', text: 'post the peer reports' }],
    visibility: 'public',
    is_local: true,
  }))
}

function flagActivity(peer: Peer, id: string | undefined, object: string[], content: string) {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    ...(id ? { id } : {}),
    type: 'Flag',
    actor: peer.instanceActorUrl,
    object,
    content,
  }
}

async function caseInboundFlag(db: SupabaseClient, peer: Peer, localUrl: string) {
  console.log('\ninbound Flag from the peer instance actor -> report owned by the peer domain')

  const peerDomain = new URL(peer.base).hostname
  const target = `${localUrl}/inbox`
  const keyId = `${peer.instanceActorUrl}#main-key`
  const id = `${peer.base}/flags/${crypto.randomUUID()}`
  const body = JSON.stringify(flagActivity(peer, id, [
    `https://${INSTANCE_DOMAIN}/users/fx_alice`,
    `https://${INSTANCE_DOMAIN}/posts/${ALICE_POST}`,
    `${peer.base}/notes/not-ours`,
  ], 'Spam from your user'))

  const res = await post(target, signedHeaders(target, body, peer.instanceKey.privateKey, keyId), body)
  eq(res.status, 202, 'a Flag signed by the peer instance actor is accepted (202)')

  const { data: rows, error } = await db
    .from('reports')
    .select('reporter_id, reported_user_id, reported_post_id, report_type, source, source_instance, comment, metadata, federation_status, content_snapshot')
    .eq('ap_id', id)
  if (error) {
    fail('reports readable', error.message)
    return
  }
  eq(rows?.length, 1, 'one report for the one local account named')
  const row = rows?.[0]
  if (row) {
    eq(row.reporter_id, null, 'no profile stands in for the reporter')
    eq(row.source, 'federation', 'the report is federated')
    eq(row.source_instance, peerDomain, 'the report belongs to the peer domain')
    eq(row.reported_user_id, ALICE, 'the named local account is reported')
    eq(row.reported_post_id, ALICE_POST, "the account's own post is attached")
    eq(row.report_type, 'post', 'a Flag naming a post files a post report')
    eq(row.comment, 'Spam from your user', 'the Flag content is the comment')
    eq(row.metadata?.actor, peer.instanceActorUrl, 'the sending actor is recorded')
    eq(row.federation_status, 'skipped', 'an inbound report is never forwarded back')
    eq(row.content_snapshot?.posts?.[0]?.content?.[0]?.text, 'post the peer reports', 'the post is snapshotted')
  }

  const { data: actorProfiles } = await db.from('profiles').select('id').eq('federated_id', peer.instanceActorUrl)
  eq(actorProfiles?.length, 0, 'no profile is created for the peer instance actor')

  const again = await post(target, signedHeaders(target, body, peer.instanceKey.privateKey, keyId), body)
  eq(again.status, 202, 'redelivery is acknowledged (202)')
  const { data: afterAgain } = await db.from('reports').select('id').eq('ap_id', id)
  eq(afterAgain?.length, 1, 'redelivery files no second report')

  // Mastodon and Misskey deliver a Flag to the reported account's own inbox.
  const personalId = `${peer.base}/flags/${crypto.randomUUID()}`
  const personalBody = JSON.stringify(flagActivity(peer, personalId, [`https://${INSTANCE_DOMAIN}/users/fx_alice`], 'to her inbox'))
  const personalTarget = `${localUrl}/users/fx_alice/inbox`
  const personal = await post(personalTarget, signedHeaders(personalTarget, personalBody, peer.instanceKey.privateKey, keyId), personalBody)
  eq(personal.status, 202, "a Flag delivered to the account's personal inbox is accepted (202)")
  const { data: personalRows } = await db.from('reports').select('reported_user_id, report_type').eq('ap_id', personalId)
  assert(
    personalRows?.length === 1 && personalRows[0].reported_user_id === ALICE && personalRows[0].report_type === 'user',
    "a Flag at the personal inbox files the report",
    JSON.stringify(personalRows),
  )

  const unsignedId = `${peer.base}/flags/${crypto.randomUUID()}`
  const unsignedBody = JSON.stringify(flagActivity(peer, unsignedId, [`https://${INSTANCE_DOMAIN}/users/fx_alice`], 'x'))
  const unsigned = await post(target, { 'Content-Type': 'application/activity+json' }, unsignedBody)
  eq(unsigned.status, 401, 'an unsigned Flag is rejected (401)')
  const { data: unsignedRows } = await db.from('reports').select('id').eq('ap_id', unsignedId)
  eq(unsignedRows?.length, 0, 'an unsigned Flag files nothing')

  const strangerId = `${peer.base}/flags/${crypto.randomUUID()}`
  const strangerBody = JSON.stringify(flagActivity(peer, strangerId, [peer.actorUrl, `${peer.base}/notes/x`], 'x'))
  const stranger = await post(target, signedHeaders(target, strangerBody, peer.instanceKey.privateKey, keyId), strangerBody)
  eq(stranger.status, 202, 'a Flag about remote objects only is acknowledged (202)')
  const { data: strangerRows } = await db.from('reports').select('id').eq('ap_id', strangerId)
  eq(strangerRows?.length, 0, 'a Flag naming nothing local files nothing')

  const idlessBody = JSON.stringify(flagActivity(peer, undefined, [`https://${INSTANCE_DOMAIN}/users/fx_bob`], 'no id'))
  const idless = await post(target, signedHeaders(target, idlessBody, peer.instanceKey.privateKey, keyId), idlessBody)
  eq(idless.status, 202, 'a Flag without an id is accepted (202)')
  const { data: idlessRows } = await db
    .from('reports')
    .select('ap_id')
    .eq('source', 'federation')
    .eq('reported_user_id', BOB)
  assert(
    idlessRows?.length === 1 && (idlessRows[0].ap_id ?? '').startsWith(`${peer.instanceActorUrl}#flag-`),
    'an id-less Flag is filed under an id derived from its body',
    JSON.stringify(idlessRows),
  )
}

async function caseOutboundFlag(db: SupabaseClient, peer: Peer, localUrl: string, env: Record<string, string>, backend: Backend) {
  console.log('\nforwarded report -> Flag from the local instance actor to the peer shared inbox')

  const alice = createClient(env.HMFED_SUPABASE_URL, env.HMFED_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${userToken(ALICE_AUTH, env.HMFED_JWT_SECRET)}` } },
  })
  const { data: reportId, error } = await alice.rpc('create_report', {
    p_report_type: 'user',
    p_reported_user_id: REMOTE,
    p_reason: 'spam',
    p_comment: 'Forwarded comment',
    p_forward: true,
  })
  if (error || typeof reportId !== 'string') {
    fail('create_report as a local user', error?.message ?? JSON.stringify(reportId))
    return
  }

  const { data: queued } = await db.from('reports').select('forward, federation_status').eq('id', reportId).single()
  eq(queued?.federation_status, 'queued', 'a forwarded report about a remote account is queued')

  const before = peer.captured.length
  await backend.handleReportJob({ type: 'create', report_id: reportId })
  const delivered = peer.captured.slice(before)
  eq(delivered.length, 1, 'the peer received exactly one delivery')
  const req = delivered[0]
  if (!req) return

  eq(req.url, '/inbox', 'the Flag goes to the shared inbox')
  const raw = req.raw.toString('utf-8')
  const sent = JSON.parse(raw)
  eq(sent.type, 'Flag', 'the delivered activity is a Flag')
  eq(sent.actor, `https://${INSTANCE_DOMAIN}/users/instance.actor`, 'the Flag comes from the instance actor')
  eq(JSON.stringify(sent.object), JSON.stringify([peer.actorUrl]), 'the Flag names the reported account')
  eq(sent.content, 'Forwarded comment', "the Flag carries the reporter's comment")
  assert(!raw.includes('fx_alice') && !raw.includes(ALICE), 'nothing in the Flag names the reporter', raw)

  const params = parseSignatureHeader(req.headers.signature ?? '')
  eq(params.keyId, `https://${INSTANCE_DOMAIN}/users/instance.actor#main-key`, 'the Flag is signed with the instance actor key')
  eq(req.headers.digest, backend.createDigest(req.raw), 'Digest covers the bytes the peer received')

  const actorDoc = await getJson(`${localUrl}/users/instance.actor`)
  eq(actorDoc?.type, 'Application', 'the instance actor is published as an Application')
  eq(actorDoc?.publicKey?.id, params.keyId, 'the published key is the signing key')
  const signingString = [
    `(request-target): post ${req.url}`,
    `host: ${req.headers.host}`,
    `date: ${req.headers.date}`,
    `digest: ${req.headers.digest}`,
  ].join('\n')
  assert(
    !!actorDoc?.publicKey?.publicKeyPem &&
      crypto.createVerify('SHA256').update(signingString).verify(actorDoc.publicKey.publicKeyPem, params.signature, 'base64'),
    'the Flag signature verifies against the published instance actor key',
  )

  const wf = await get(
    `${localUrl}/.well-known/webfinger?resource=${encodeURIComponent(`acct:instance.actor@${INSTANCE_DOMAIN}`)}`,
    { Accept: 'application/jrd+json' },
  )
  assert(
    wf.status === 200 && (wf.json?.links ?? []).some((l: any) => l.rel === 'self' && l.href === actorDoc?.id),
    'WebFinger resolves the instance actor to its id',
    wf.body,
  )

  const { data: after } = await db.from('reports').select('federation_status, forwarded_at').eq('id', reportId).single()
  eq(after?.federation_status, 'completed', 'the report records the delivery')
  assert(!!after?.forwarded_at, 'forwarded_at is set')

  await backend.handleReportJob({ type: 'create', report_id: reportId })
  eq(peer.captured.length - before, 1, 'a forwarded report is not sent twice')
}

// WIRING

interface Backend {
  handleNewDM: (message: unknown) => Promise<void>
  handleReportJob: (data: { type: 'create'; report_id: string }) => Promise<void>
  verifySignature: (
    signature: string,
    headers: Record<string, string>,
    method: string,
    p: string,
    body?: unknown,
  ) => Promise<{ verified: boolean; actorUrl?: string; error?: string }>
  createDigest: (body: unknown) => string
  createApp: () => { listen: (port: number, host: string, cb: () => void) => http.Server }
}

async function loadBackend(): Promise<Backend> {
  const mod = (p: string) => import(pathToFileURL(path.join(BACKEND_ROOT, 'src', p)).href)
  const [server, listener, signature, reports] = await Promise.all([
    mod('server.ts'),
    mod('listeners/DatabaseListener.ts'),
    mod('activitypub/SignatureService.ts'),
    mod('queue/handlers/reportHandler.ts'),
  ])
  return {
    createApp: server.createApp,
    handleNewDM: listener.handleNewDM,
    handleReportJob: reports.handleReportJob,
    verifySignature: signature.SignatureService.verifySignature.bind(signature.SignatureService),
    createDigest: signature.SignatureService.createDigest.bind(signature.SignatureService),
  }
}

async function main() {
  const env = loadStackEnv()

  // Set before the backend's config module is imported: it validates the
  // environment at import time and exits the process when a name is missing.
  process.env.NODE_ENV = 'development'
  process.env.SUPABASE_URL = env.HMFED_SUPABASE_URL
  process.env.SUPABASE_ANON_KEY = env.HMFED_SUPABASE_ANON_KEY
  process.env.SUPABASE_SERVICE_ROLE_KEY = env.HMFED_SUPABASE_SERVICE_ROLE_KEY
  process.env.INSTANCE_DOMAIN = INSTANCE_DOMAIN
  process.env.REQUIRE_VALID_SIGNATURES = 'true'
  process.env.LOG_LEVEL = process.env.HMFED_LOG_LEVEL ?? 'error'
  if (!env.HMFED_LIVEKIT_URL || !env.HMFED_LIVEKIT_KEY || !env.HMFED_LIVEKIT_SECRET) {
    throw new Error('stack.env names no LiveKit - run: e2e/federation/stack.sh up')
  }
  process.env.LIVEKIT_URL = env.HMFED_LIVEKIT_URL
  process.env.LIVEKIT_API_KEY = env.HMFED_LIVEKIT_KEY
  process.env.LIVEKIT_API_SECRET = env.HMFED_LIVEKIT_SECRET
  process.env.ALLOW_FEDERATED_VOICE = 'true'
  const lk = new LiveKit(env.HMFED_LIVEKIT_URL, env.HMFED_LIVEKIT_KEY, env.HMFED_LIVEKIT_SECRET)

  const peer = new Peer()
  peer.livekit = lk
  await peer.start(env.HMFED_PEER_HOST)
  console.log(`peer instance on ${peer.base}`)

  const backend = await loadBackend()
  const app = backend.createApp()
  const local = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const localUrl = `http://127.0.0.1:${(local.address() as { port: number }).port}`
  console.log(`local instance on ${localUrl} (${INSTANCE_DOMAIN})`)
  peer.localUrl = localUrl

  const db = createClient(env.HMFED_SUPABASE_URL, env.HMFED_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    await seed(db, peer)
    const callApId = await caseVoiceInvite(db, peer, localUrl)
    await caseRedelivery(db, peer, localUrl, callApId)
    await caseTamperedBody(db, peer, localUrl)
    await caseUnsharedInvite(db, peer, localUrl)
    await caseVoiceAccept(db, peer, localUrl, callApId)
    await caseInboundDM(db, peer, localUrl)
    await caseOutboundDM(db, peer, backend)
    await caseSignedGetRetry(peer, localUrl, db)
    await casePostVisibility(db, peer, localUrl)
    await seedReports(db)
    await caseInboundFlag(db, peer, localUrl)
    await caseOutboundFlag(db, peer, localUrl, env, backend)
    await seedServers(db, peer)
    await caseHostedPrivateServer(peer, localUrl)
    await caseProxyReadsAsMember(peer, localUrl, env.HMFED_JWT_SECRET)
    await caseSyncSignsAsMember(db, peer, localUrl, env.HMFED_JWT_SECRET)
    await seedVoice(db, peer)
    await caseHostedDmCall(db, peer, localUrl, env.HMFED_JWT_SECRET, lk, backend)
    await casePeerHostedDmCall(db, peer, localUrl, env.HMFED_JWT_SECRET, lk, backend)
    await caseRemoteVoiceJoin(db, peer, localUrl, env.HMFED_JWT_SECRET, lk, backend)
    await caseHostedVoiceJoin(db, peer, localUrl, env.HMFED_JWT_SECRET, lk, backend)
  } finally {
    await new Promise<void>((resolve) => local.close(() => resolve()))
    await peer.stop()
  }

  console.log('')
  if (failures) {
    console.error(`${failures} check(s) failed`)
    process.exit(1)
  }
  console.log('all checks passed')
  // The rate limiter's sweep interval keeps the loop alive.
  process.exit(0)
}

main().catch((e) => {
  console.error(`roundtrip failed: ${e?.stack ?? e}`)
  process.exit(1)
})
