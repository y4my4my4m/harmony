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
// Two paths carry the defects this harness exists to catch:
//   - public.federated_voice_calls, whose column set an inbound
//     harmony:VoiceCallInvite writes directly;
//   - the DM delivery path's choice of inbox URL, asserted from the request
//     the peer actually received.
//
// Not covered: the BullMQ worker, Redis (the rate limiters fall back to their
// in-memory store), realtime broadcast (the gateway answers 501 and the voice
// handler ignores the result), and any fetch back from the peer - the local
// instance's own domain resolves nowhere, so it is only ever delivered to.
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
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const BACKEND_ROOT = process.env.HMFED_BACKEND_ROOT ?? path.resolve(__dirname, '../../federation-backend')

const INSTANCE_DOMAIN = 'local.hmfed.test'

// Fixed so a failure names a row.
const ALICE = 'fed00000-0000-0000-0000-000000000001' // local, sends the DM
const BOB = 'fed00000-0000-0000-0000-000000000002' // local, receives calls and DMs
const REMOTE = 'fed00000-0000-0000-0000-000000000003' // mirror of the peer's user
const CONVERSATION = 'fed00000-0000-0000-0000-000000000010'

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

class Peer {
  readonly key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })

  readonly captured: Captured[] = []
  actorFetches = 0
  private server?: http.Server
  base = ''

  get actorUrl() {
    return `${this.base}/users/fx_remote`
  }
  get personalInbox() {
    return `${this.base}/users/fx_remote/inbox`
  }
  get sharedInbox() {
    return `${this.base}/inbox`
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

// FIXTURE

async function seed(db: SupabaseClient, peer: Peer) {
  const peerHost = new URL(peer.base).host

  // Delete before insert: ids are fixed and the tables cascade from profiles.
  await db.from('profiles').delete().in('id', [ALICE, BOB, REMOTE])

  const { error } = await db.from('profiles').insert([
    {
      id: ALICE,
      username: 'fx_alice',
      display_name: 'Alice',
      domain: INSTANCE_DOMAIN,
      federated_id: `https://${INSTANCE_DOMAIN}/users/fx_alice`,
      inbox_url: `https://${INSTANCE_DOMAIN}/users/fx_alice/inbox`,
      is_local: true,
    },
    {
      id: BOB,
      username: 'fx_bob',
      display_name: 'Bob',
      domain: INSTANCE_DOMAIN,
      federated_id: `https://${INSTANCE_DOMAIN}/users/fx_bob`,
      inbox_url: `https://${INSTANCE_DOMAIN}/users/fx_bob/inbox`,
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

  await db.from('conversations').delete().eq('id', CONVERSATION)
  const conv = await db
    .from('conversations')
    .insert({ id: CONVERSATION, type: 'direct', created_by: ALICE })
  if (conv.error) throw new Error(`seed conversation: ${conv.error.message}`)

  const parts = await db.from('conversation_participants').insert([
    { conversation_id: CONVERSATION, user_id: ALICE },
    { conversation_id: CONVERSATION, user_id: REMOTE },
  ])
  if (parts.error) throw new Error(`seed participants: ${parts.error.message}`)
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
      // Minted by the calling instance and not a UUID;
      // federated_voice_calls.conversation_id is text.
      conversationId: 'remote-room-7f3c',
      livekitUrl: 'wss://livekit.remote.example',
      roomName: 'fed-call-7f3c',
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
  eq(row.conversation_id, 'remote-room-7f3c', 'conversation_id keeps the remote instance-minted id verbatim')
  eq(row.livekit_url, 'wss://livekit.remote.example', 'livekit_url comes from the invite')
  eq(row.room_name, 'fed-call-7f3c', 'room_name comes from the invite')
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

async function caseVoiceAccept(db: SupabaseClient, peer: Peer, localUrl: string, callApId: string) {
  console.log('\ninbound harmony:VoiceCallAccept -> status')

  const published = new Date().toISOString()
  const activity = {
    '@context': ['https://www.w3.org/ns/activitystreams', 'https://harmony.social/ns/voice'],
    id: `${peer.actorUrl}#accept-${crypto.randomUUID()}`,
    type: 'harmony:VoiceCallAccept',
    actor: peer.actorUrl,
    to: [`https://${INSTANCE_DOMAIN}/users/fx_bob`],
    object: callApId,
    published,
  }
  const body = JSON.stringify(activity)
  const target = `${localUrl}/users/fx_bob/inbox`

  const res = await post(target, signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
  eq(res.status, 202, 'signed accept is accepted (202)')

  const { data: rows } = await db
    .from('federated_voice_calls')
    .select('status, accepted_at')
    .eq('ap_id', callApId)
  eq(rows?.[0]?.status, 'accepted', 'the pending call moves to accepted')
  // Postgres renders the offset as +00:00; compare instants, not spellings.
  const acceptedAt = rows?.[0]?.accepted_at
  assert(
    Date.parse(acceptedAt ?? '') === Date.parse(published),
    'accepted_at is the accept activity timestamp',
    `expected ${published}, got ${acceptedAt}`,
  )
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

// WIRING

interface Backend {
  handleNewDM: (message: unknown) => Promise<void>
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
  const [server, listener, signature] = await Promise.all([
    mod('server.ts'),
    mod('listeners/DatabaseListener.ts'),
    mod('activitypub/SignatureService.ts'),
  ])
  return {
    createApp: server.createApp,
    handleNewDM: listener.handleNewDM,
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

  const peer = new Peer()
  await peer.start(env.HMFED_PEER_HOST)
  console.log(`peer instance on ${peer.base}`)

  const backend = await loadBackend()
  const app = backend.createApp()
  const local = await new Promise<http.Server>((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s))
  })
  const localUrl = `http://127.0.0.1:${(local.address() as { port: number }).port}`
  console.log(`local instance on ${localUrl} (${INSTANCE_DOMAIN})`)

  const db = createClient(env.HMFED_SUPABASE_URL, env.HMFED_SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  try {
    await seed(db, peer)
    const callApId = await caseVoiceInvite(db, peer, localUrl)
    await caseRedelivery(db, peer, localUrl, callApId)
    await caseTamperedBody(db, peer, localUrl)
    await caseVoiceAccept(db, peer, localUrl, callApId)
    await caseInboundDM(db, peer, localUrl)
    await caseOutboundDM(db, peer, backend)
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
