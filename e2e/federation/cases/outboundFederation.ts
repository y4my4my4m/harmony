// Outbound federation and remote profile import, round trip against the peer.
//
//   - a local boost of a peer post reaches the peer as Announce, not Create, and
//     the unboost as Undo(Announce), not Delete;
//   - block and unblock of the peer's user reach its inbox as Block and Undo(Block);
//   - a post mentioning a peer account this instance never stored resolves it
//     through WebFinger and delivers to its inbox, the account stored;
//   - an edit of the content warning alone reaches followers as Update(Note);
//   - deleting a post that mentioned a non-follower reaches that mentionee;
//   - the peer's outbox, 20-item pages, and featured collection are imported in
//     full, the featured posts pinned.
//
// Each write goes through PostgREST as fx_alice or the service role, so the
// table triggers run. The job each trigger queues is read off the database's
// pg_notify channel (JobTap, a LISTEN session over `docker exec psql`) and handed
// to the job's handler, as the worker would after BullMQ; the peer records the
// deliveries.
//
// WebFinger is https on the account's domain, and a handle carries no port. A
// TLS proxy container on the stack network (WEBFINGER_IP) forwards to the peer,
// and the backend accepts its self-signed certificate during that case only.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import net from 'node:net'
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export interface PeerLike {
  base: string
  actorUrl: string
  personalInbox: string
  sharedInbox: string
  captured: Array<{ method: string; url: string; headers: Record<string, string>; raw: Buffer }>
  extraGet?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
}

export interface OutboundContext {
  db: SupabaseClient
  peer: PeerLike
  localUrl: string
  env: Record<string, string>
  backendRoot: string
  instanceDomain: string
  alice: { id: string; auth: string }
  remote: string
  userToken: (authUserId: string, secret: string) => string
  verifySignature: (
    signature: string,
    headers: Record<string, string>,
    method: string,
    p: string,
    body?: unknown,
  ) => Promise<{ verified: boolean; actorUrl?: string; error?: string }>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  fail: (msg: string, detail?: unknown) => void
}

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

// Fixed so a failure names a row.
const BOOST_TARGET = 'fed00085-0000-0000-0000-000000000001'
const STRANGER = 'fed00085-0000-0000-0000-000000000002'
const PUBLISHER = 'fed00085-0000-0000-0000-000000000003'

// Host part of the stack subnet's TLS proxy address.
const WEBFINGER_HOST_OCTET = 200

// JOB TAP

interface Job {
  name: string
  data: any
}

/** LISTEN federation_jobs in the stack's database; every notification is kept. */
class JobTap {
  private readonly jobs: Job[] = []
  private out = ''
  private markers = new Set<string>()

  private constructor(private readonly proc: ChildProcessWithoutNullStreams) {
    proc.stdout.on('data', (chunk) => {
      this.out += chunk.toString('utf-8')
      let nl: number
      while ((nl = this.out.indexOf('\n')) >= 0) {
        const line = this.out.slice(0, nl)
        this.out = this.out.slice(nl + 1)
        const note = /^Asynchronous notification "federation_jobs" with payload "(.*)" received from server process with PID \d+\.$/.exec(line)
        if (note) {
          try {
            const payload = JSON.parse(note[1])
            this.jobs.push({ name: payload.name, data: payload.data })
          } catch {
            // A payload psql cut is not a job.
          }
        } else {
          this.markers.add(line.trim())
        }
      }
    })
  }

  static async open(project: string): Promise<JobTap> {
    const cid = execFileSync('docker', [
      'ps', '-q',
      '--filter', `label=com.docker.compose.project=${project}`,
      '--filter', 'label=com.docker.compose.service=db',
    ]).toString().trim()
    if (!cid) throw new Error(`no db container for compose project ${project}`)
    const proc = spawn('docker', ['exec', '-i', cid, 'psql', '-U', 'postgres', '-d', 'postgres', '-X', '-q', '-A', '-t'])
    const tap = new JobTap(proc)
    proc.stdin.write('LISTEN federation_jobs;\n')
    await tap.sync()
    return tap
  }

  /** Round trip through the session; notifications sent before it are read. */
  async sync(): Promise<void> {
    const marker = `tap-${crypto.randomUUID()}`
    this.proc.stdin.write(`SELECT '${marker}';\n`)
    for (let i = 0; i < 100 && !this.markers.has(marker); i++) await sleep(50)
    this.markers.delete(marker)
  }

  /** The first job matching `match`, removed; null after `ms`. */
  async take(match: (job: Job) => boolean, ms = 5000): Promise<Job | null> {
    const until = Date.now() + ms
    while (Date.now() < until) {
      await this.sync()
      const i = this.jobs.findIndex(match)
      if (i >= 0) return this.jobs.splice(i, 1)[0]
      await sleep(100)
    }
    return null
  }

  close() {
    this.proc.stdin.end()
    this.proc.kill()
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// PEER DOCUMENTS

type Docs = Map<string, { contentType: string; body: unknown }>

function serveDocs(peer: PeerLike, docs: Docs, seen: string[]) {
  peer.extraGet = (req, res) => {
    const doc = docs.get(req.url ?? '')
    if (!doc) return false
    seen.push(req.url ?? '')
    res.writeHead(200, { 'Content-Type': doc.contentType })
    res.end(JSON.stringify(doc.body))
    return true
  }
}

const AP = 'application/activity+json'

function actorDoc(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    '@context': ['https://www.w3.org/ns/activitystreams'],
    id,
    type: 'Person',
    preferredUsername: name,
    inbox: `${id}/inbox`,
    ...extra,
  }
}

// HELPERS

function deliveriesSince(peer: PeerLike, before: number) {
  return peer.captured.slice(before).map((c) => {
    let body: any = null
    try {
      body = JSON.parse(c.raw.toString('utf-8'))
    } catch {
      body = null
    }
    return { url: c.url, headers: c.headers, raw: c.raw, body }
  })
}

async function backendModule(root: string, p: string) {
  return import(pathToFileURL(path.join(root, 'src', p)).href)
}

export async function runOutboundFederationCases(ctx: OutboundContext): Promise<void> {
  const { db, peer, env } = ctx
  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const alice = createClient(env.HMFED_SUPABASE_URL, env.HMFED_SUPABASE_ANON_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
    global: { headers: { Authorization: `Bearer ${ctx.userToken(ctx.alice.auth, env.HMFED_JWT_SECRET)}` } },
  })
  const docs: Docs = new Map()
  const seen: string[] = []
  serveDocs(peer, docs, seen)

  const tap = await JobTap.open(project)
  const posts = await backendModule(ctx.backendRoot, 'queue/handlers/postHandler.ts')
  const blocks = await backendModule(ctx.backendRoot, 'queue/handlers/blockHandler.ts')
  const handlers = { handlePostJob: posts.handlePostJob, handleBlockJob: blocks.handleBlockJob }

  // fx_remote follows fx_alice for these cases.
  await db.from('follows').delete().eq('follower_id', ctx.remote).eq('following_id', ctx.alice.id)
  const follow = await db.from('follows').insert({ follower_id: ctx.remote, following_id: ctx.alice.id, status: 'accepted' })
  if (follow.error) {
    ctx.fail('seed the follow fx_remote -> fx_alice', follow.error.message)
    tap.close()
    return
  }

  try {
    await caseBoost(ctx, alice, tap, handlers)
    await caseContentWarningEdit(ctx, alice, tap, handlers)
    await caseDeleteReachesMentionee(ctx, alice, tap, handlers)
    await caseMentionResolvedByWebFinger(ctx, alice, tap, handlers, docs, seen, project)
    await caseOutboxAndFeatured(ctx, docs, seen)
    await caseBlock(ctx, alice, tap, handlers)
  } finally {
    await db.from('follows').delete().eq('follower_id', ctx.remote).eq('following_id', ctx.alice.id)
    peer.extraGet = undefined
    tap.close()
  }
}

interface Handlers {
  handlePostJob: (data: any) => Promise<void>
  handleBlockJob: (data: any) => Promise<void>
}

/** The federate-post job the trigger queued for `postId` and `type`, run as the worker runs it. */
async function runPostJob(ctx: OutboundContext, tap: JobTap, handlers: Handlers, postId: string, type: string) {
  const job = await tap.take((j) => j.name === 'federate-post' && j.data?.post_id === postId && j.data?.type === type)
  if (!job) {
    ctx.fail(`the trigger queues a ${type} job for post ${postId}`)
    return null
  }
  await handlers.handlePostJob(job.data)
  return job
}

async function caseBoost(ctx: OutboundContext, alice: SupabaseClient, tap: JobTap, handlers: Handlers) {
  console.log('\nlocal boost of a peer post -> Announce; unboost -> Undo(Announce)')
  const { db, peer } = ctx
  const originalApId = `${peer.base}/users/fx_remote/statuses/boost-target`

  await db.from('posts').delete().eq('id', BOOST_TARGET)
  const seeded = await db.from('posts').insert({
    id: BOOST_TARGET, author_id: ctx.remote, ap_id: originalApId, visibility: 'public', is_local: false,
    content: [{ type: 'text', text: 'a peer post worth boosting' }],
  })
  if (seeded.error) return ctx.fail('seed the peer post', seeded.error.message)

  const announceId = `https://${ctx.instanceDomain}/activities/${crypto.randomUUID()}`
  const boost = await alice.from('posts').insert({
    author_id: ctx.alice.id,
    content: [{ type: 'text', text: 'a peer post worth boosting' }],
    visibility: 'public',
    is_local: true,
    is_federated: true,
    ap_id: announceId,
    metadata: { reblog_of: BOOST_TARGET },
  }).select('id').single()
  if (boost.error) return ctx.fail('fx_alice boosts the peer post', boost.error.message)

  let before = peer.captured.length
  if (!(await runPostJob(ctx, tap, handlers, boost.data.id, 'create'))) return
  let sent = deliveriesSince(peer, before)
  ctx.eq(sent.length, 1, 'the boost is delivered once: the peer is both follower and original author')
  const announce = sent[0]
  ctx.eq(announce?.url, '/inbox', 'the Announce goes to the peer\'s shared inbox')
  ctx.eq(announce?.body?.type, 'Announce', 'the boost federates as Announce, not Create')
  ctx.eq(announce?.body?.id, announceId, 'the Announce carries the boost\'s ap_id')
  ctx.eq(announce?.body?.object, originalApId, 'the Announce names the original by its AP id')
  ctx.assert(
    announce?.body?.to?.includes(PUBLIC) && announce?.body?.cc?.includes(peer.actorUrl),
    'the Announce is public and cc\'s the original author',
    JSON.stringify({ to: announce?.body?.to, cc: announce?.body?.cc }),
  )
  if (announce) {
    const v = await ctx.verifySignature(announce.headers.signature, announce.headers, 'POST', announce.url, announce.raw)
    ctx.eq(v.actorUrl, `https://${ctx.instanceDomain}/users/fx_alice`, 'the Announce is signed by the booster')
  }

  const retract = await alice.from('posts')
    .update({ is_deleted: true, deleted_at: new Date().toISOString() })
    .eq('id', boost.data.id)
  if (retract.error) return ctx.fail('fx_alice unboosts', retract.error.message)

  before = peer.captured.length
  if (!(await runPostJob(ctx, tap, handlers, boost.data.id, 'delete'))) return
  sent = deliveriesSince(peer, before)
  ctx.eq(sent.length, 1, 'the unboost is delivered once')
  const undo = sent[0]?.body
  ctx.eq(undo?.type, 'Undo', 'the unboost federates as Undo, not Delete')
  ctx.eq(undo?.object?.type, 'Announce', 'the Undo embeds the Announce')
  ctx.eq(undo?.object?.id, announceId, 'the embedded Announce keeps the id the peer stored the boost under')
  ctx.eq(undo?.object?.object, originalApId, 'the embedded Announce names the original')
}

async function caseContentWarningEdit(ctx: OutboundContext, alice: SupabaseClient, tap: JobTap, handlers: Handlers) {
  console.log('\ncontent warning edit alone -> Update(Note) to followers')
  const { peer } = ctx

  const created = await alice.from('posts').insert({
    author_id: ctx.alice.id, visibility: 'public', is_local: true,
    content: [{ type: 'text', text: 'about the finale' }],
  }).select('id').single()
  if (created.error) return ctx.fail('fx_alice posts', created.error.message)

  let before = peer.captured.length
  if (!(await runPostJob(ctx, tap, handlers, created.data.id, 'create'))) return
  ctx.eq(deliveriesSince(peer, before)[0]?.body?.type, 'Create', 'the post reaches the follower')

  const edit = await alice.from('posts').update({ content_warning: 'finale spoilers' }).eq('id', created.data.id)
  if (edit.error) return ctx.fail('fx_alice adds a content warning', edit.error.message)

  before = peer.captured.length
  if (!(await runPostJob(ctx, tap, handlers, created.data.id, 'update'))) return
  const update = deliveriesSince(peer, before)[0]?.body
  ctx.eq(update?.type, 'Update', 'the content warning edit federates as Update')
  ctx.eq(update?.object?.type, 'Note', 'the Update carries the Note')
  ctx.eq(update?.object?.summary, 'finale spoilers', 'the Note carries the new content warning')
}

async function caseDeleteReachesMentionee(ctx: OutboundContext, alice: SupabaseClient, tap: JobTap, handlers: Handlers) {
  console.log('\ndeleting a post that mentioned a non-follower -> Delete to that mentionee')
  const { db, peer } = ctx
  const peerHost = new URL(peer.base).host
  const strangerUrl = `${peer.base}/users/fx_stranger`

  await db.from('profiles').delete().eq('id', STRANGER)
  const seeded = await db.from('profiles').insert({
    id: STRANGER, username: 'fx_stranger', display_name: 'Stranger', domain: peerHost,
    federated_id: strangerUrl, inbox_url: `${strangerUrl}/inbox`, is_local: false,
  })
  if (seeded.error) return ctx.fail('seed fx_stranger', seeded.error.message)

  const created = await alice.from('posts').insert({
    author_id: ctx.alice.id, visibility: 'public', is_local: true,
    content: [
      { type: 'mention', userId: STRANGER, username: 'fx_stranger', domain: peerHost, isLocal: false },
      { type: 'text', text: ' a word for you' },
    ],
  }).select('id, ap_id').single()
  if (created.error) return ctx.fail('fx_alice mentions fx_stranger', created.error.message)

  let before = peer.captured.length
  if (!(await runPostJob(ctx, tap, handlers, created.data.id, 'create'))) return
  ctx.assert(
    deliveriesSince(peer, before).some((d) => d.url === '/users/fx_stranger/inbox' && d.body?.type === 'Create'),
    'the mentionee receives the Create',
  )

  // As activityPubService.deletePost writes it: the content is blanked in the same UPDATE.
  const removed = await alice.from('posts').update({
    is_deleted: true, deleted_at: new Date().toISOString(), content: [{ type: 'text', text: '[Deleted]' }],
  }).eq('id', created.data.id)
  if (removed.error) return ctx.fail('fx_alice deletes the post', removed.error.message)

  const job = await tap.take((j) => j.name === 'federate-post' && j.data?.post_id === created.data.id && j.data?.type === 'delete')
  if (!job) return ctx.fail('the trigger queues the delete job')
  const mentions = Array.isArray(job.data.mentions) ? job.data.mentions : []
  ctx.assert(
    mentions.length === 1 && mentions[0].username === 'fx_stranger' && mentions[0].domain === peerHost.toLowerCase(),
    'the delete job carries the mention the blanked content held',
    JSON.stringify(job.data.mentions),
  )
  before = peer.captured.length
  await handlers.handlePostJob(job.data)
  const toStranger = deliveriesSince(peer, before).filter((d) => d.url === '/users/fx_stranger/inbox')
  ctx.eq(toStranger.length, 1, 'the mentionee receives the Delete')
  ctx.eq(toStranger[0]?.body?.type, 'Delete', 'the delivery is a Delete')
  ctx.eq(
    toStranger[0]?.body?.object,
    created.data.ap_id || `https://${ctx.instanceDomain}/posts/${created.data.id}`,
    'the Delete names the post',
  )
}

/** A TLS reverse proxy to the peer on `ip`, port 443, labelled into the compose project. */
function startWebFingerProxy(project: string, ip: string, peerBase: string): { stop: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hmfed-wf-'))
  execFileSync('openssl', [
    'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-keyout', path.join(dir, 'key.pem'), '-out', path.join(dir, 'cert.pem'), '-subj', `/CN=${ip}`,
  ], { stdio: 'ignore' })
  fs.writeFileSync(path.join(dir, 'default.conf'), [
    'server {',
    '  listen 443 ssl;',
    '  ssl_certificate /etc/nginx/conf.d/cert.pem;',
    '  ssl_certificate_key /etc/nginx/conf.d/key.pem;',
    `  location / { proxy_pass ${peerBase}; }`,
    '}',
    '',
  ].join('\n'))
  for (const f of fs.readdirSync(dir)) fs.chmodSync(path.join(dir, f), 0o644)
  fs.chmodSync(dir, 0o755)
  const name = `${project}-webfinger-tls`
  execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' })
  execFileSync('docker', [
    'run', '-d', '--rm', '--name', name,
    '--label', `com.docker.compose.project=${project}`,
    '--network', `${project}_default`, '--ip', ip,
    '-v', `${dir}:/etc/nginx/conf.d:ro`,
    process.env.HMFED_NGINX_IMAGE ?? 'nginx:alpine',
  ], { stdio: 'ignore' })
  return {
    stop: () => {
      try { execFileSync('docker', ['rm', '-f', name], { stdio: 'ignore' }) } catch { /* gone */ }
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

async function caseMentionResolvedByWebFinger(
  ctx: OutboundContext, alice: SupabaseClient, tap: JobTap, handlers: Handlers, docs: Docs, seen: string[], project: string,
) {
  console.log('\nmention of an account never stored here -> WebFinger, then delivery to its inbox')
  const { db, peer, env } = ctx
  const ip = `${env.HMFED_SUBNET.split('/')[0].split('.').slice(0, 3).join('.')}.${WEBFINGER_HOST_OCTET}`
  const actorUrl = `${peer.base}/users/fx_wf`
  const webfinger = `/.well-known/webfinger?resource=${encodeURIComponent(`acct:fx_wf@${ip}`)}`

  docs.set(webfinger, {
    contentType: 'application/jrd+json',
    body: { subject: `acct:fx_wf@${ip}`, links: [{ rel: 'self', type: AP, href: actorUrl }] },
  })
  docs.set('/users/fx_wf', { contentType: AP, body: actorDoc(actorUrl, 'fx_wf', { webfinger: `acct:fx_wf@${ip}` }) })
  // A row from an earlier run on this stack names that run's peer port.
  await db.from('profiles').delete().eq('federated_id', actorUrl)
  await db.from('profiles').delete().eq('username', 'fx_wf').eq('domain', ip)

  let proxy: { stop: () => void } | null = null
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  try {
    proxy = startWebFingerProxy(project, ip, peer.base)
    // nginx answers once its config is loaded.
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise<boolean>((resolve) => {
        const s = net.connect(443, ip, () => { s.end(); resolve(true) })
        s.on('error', () => resolve(false))
      })
      if (!up) await sleep(200)
    }
    ctx.assert(up, `the WebFinger proxy answers on ${ip}:443`)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    const created = await alice.from('posts').insert({
      author_id: ctx.alice.id, visibility: 'public', is_local: true,
      content: [
        { type: 'mention', userId: `unresolved-fx_wf@${ip}`, username: 'fx_wf', domain: ip, isLocal: false },
        { type: 'text', text: ' hello from harmony' },
      ],
    }).select('id').single()
    if (created.error) return ctx.fail('fx_alice mentions @fx_wf', created.error.message)

    const before = peer.captured.length
    if (!(await runPostJob(ctx, tap, handlers, created.data.id, 'create'))) return

    ctx.assert(seen.includes(webfinger), 'the handle is resolved through WebFinger on its domain', JSON.stringify(seen))
    const stored = await db.from('profiles').select('id, username, domain, inbox_url').eq('federated_id', actorUrl).maybeSingle()
    ctx.assert(
      stored.data?.username === 'fx_wf' && stored.data?.domain === ip && stored.data?.inbox_url === `${actorUrl}/inbox`,
      'the mentioned account is stored under its handle',
      JSON.stringify(stored.data),
    )
    const toMentionee = deliveriesSince(peer, before).filter((d) => d.url === '/users/fx_wf/inbox')
    ctx.eq(toMentionee.length, 1, 'the mentionee\'s inbox receives the post')
    const note = toMentionee[0]?.body?.object
    ctx.assert(
      Array.isArray(note?.tag) && note.tag.some((t: any) => t.type === 'Mention' && t.href === actorUrl),
      'the Mention tag names the resolved actor',
      JSON.stringify(note?.tag),
    )
    ctx.assert(note?.cc?.includes(actorUrl), 'the Note cc\'s the mentionee', JSON.stringify(note?.cc))
  } catch (e) {
    ctx.fail('WebFinger mention case', (e as Error)?.message ?? e)
  } finally {
    if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting
    proxy?.stop()
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  let json: any = null
  try {
    json = await res.json()
  } catch {
    json = null
  }
  return { status: res.status, json }
}

async function caseOutboxAndFeatured(ctx: OutboundContext, docs: Docs, seen: string[]) {
  console.log('\nremote profile import -> every item of 20-item outbox pages, featured posts pinned')
  const { db, peer, localUrl } = ctx
  const peerHost = new URL(peer.base).host
  const actorUrl = `${peer.base}/users/fx_pub`
  const outbox = `${actorUrl}/outbox`
  const featured = `${actorUrl}/collections/featured`
  const statusUrl = (n: number) => `${actorUrl}/statuses/${n}`
  const note = (n: number) => ({
    id: statusUrl(n),
    type: 'Note',
    attributedTo: actorUrl,
    content: `<p>outbox post ${n}</p>`,
    published: new Date(Date.UTC(2026, 0, 1) - n * 60_000).toISOString(),
    to: [PUBLIC],
    cc: [`${actorUrl}/followers`],
  })
  const boostedUrl = `${peer.base}/users/fx_remote/statuses/boosted-in-outbox`

  // Page 1 holds 19 posts and an Announce of a peer note this instance has not
  // stored; pages 2 and 3 hold 20 and 6 posts.
  const items: any[] = []
  for (let n = 1; n <= 45; n++) {
    items.push({ id: `${statusUrl(n)}/activity`, type: 'Create', actor: actorUrl, object: note(n) })
    if (n === 10) {
      items.push({ id: `${actorUrl}/statuses/boost-1/activity`, type: 'Announce', actor: actorUrl, object: boostedUrl, published: note(10).published })
    }
  }
  const pages = [items.slice(0, 20), items.slice(20, 40), items.slice(40)]
  const pageUrl = (i: number) => (i === 0 ? '?page=true' : `?page=true&max_id=${i}`)
  docs.set('/users/fx_pub', { contentType: AP, body: actorDoc(actorUrl, 'fx_pub', { outbox, featured }) })
  docs.set('/users/fx_pub/outbox', {
    contentType: AP,
    body: { id: outbox, type: 'OrderedCollection', totalItems: items.length, first: `${outbox}${pageUrl(0)}` },
  })
  pages.forEach((page, i) => {
    docs.set(`/users/fx_pub/outbox${pageUrl(i)}`, {
      contentType: AP,
      body: {
        id: `${outbox}${pageUrl(i)}`, type: 'OrderedCollectionPage', partOf: outbox, orderedItems: page,
        ...(i < pages.length - 1 ? { next: `${outbox}${pageUrl(i + 1)}` } : {}),
      },
    })
  })
  for (let n = 1; n <= 45; n++) docs.set(`/users/fx_pub/statuses/${n}`, { contentType: AP, body: note(n) })
  docs.set('/users/fx_remote/statuses/boosted-in-outbox', {
    contentType: AP,
    body: {
      id: boostedUrl, type: 'Note', attributedTo: peer.actorUrl, content: '<p>boosted by fx_pub</p>',
      published: '2025-12-01T00:00:00.000Z', to: [PUBLIC], cc: [],
    },
  })
  // One featured post embedded, one by id.
  docs.set('/users/fx_pub/collections/featured', {
    contentType: AP,
    body: { id: featured, type: 'OrderedCollection', totalItems: 2, orderedItems: [note(3), statusUrl(41)] },
  })

  await db.from('profiles').delete().eq('id', PUBLISHER)
  const seeded = await db.from('profiles').insert({
    id: PUBLISHER, username: 'fx_pub', display_name: 'Publisher', domain: peerHost, is_local: false,
    federated_id: actorUrl, inbox_url: `${actorUrl}/inbox`, outbox_url: outbox,
  })
  if (seeded.error) return ctx.fail('seed fx_pub', seeded.error.message)

  const lookup = await postJson(`${localUrl}/lookup-user`, { handle: `fx_pub@${peerHost}` })
  ctx.assert(lookup.status === 200 && lookup.json?.backfilling === true,
    'opening the profile starts the outbox import', JSON.stringify(lookup.json)?.slice(0, 200))

  const ownPosts = async () => {
    const { data } = await db.from('posts').select('ap_id, is_pinned, ap_type, reblog, metadata').eq('author_id', PUBLISHER)
    return data ?? []
  }
  // The featured sync stores statuses/41 alongside; the first page is what the import owes.
  const firstPage = pages[0].map((item) => (item.type === 'Announce' ? item.id : item.object.id))
  const unstored = (stored: any[]) => firstPage.filter((id) => !stored.some((r) => r.ap_id === id))
  let rows: any[] = []
  for (let i = 0; i < 100; i++) {
    rows = await ownPosts()
    if (unstored(rows).length === 0 && rows.filter((r) => r.is_pinned).length >= 2) break
    await sleep(200)
  }
  ctx.assert(unstored(rows).length === 0, 'the first import stores every item of the first 20-item page',
    JSON.stringify(unstored(rows)))
  ctx.assert(!rows.some((r) => r.ap_id === statusUrl(20)), 'the first import stops at the end of the page')

  for (let call = 0; call < 2; call++) {
    const more = await postJson(`${localUrl}/fetch-posts`, { user_id: PUBLISHER, outbox_url: outbox, max_id: 'more', limit: 20 })
    ctx.eq(more.status, 200, `load more ${call + 1} is answered`)
    if (call === 1) ctx.eq(more.json?.has_more, false, 'the last page ends the import')
  }

  rows = await ownPosts()
  const notes = new Set(rows.filter((r) => r.ap_type !== 'Announce').map((r) => r.ap_id))
  const missing = Array.from({ length: 45 }, (_, i) => statusUrl(i + 1)).filter((u) => !notes.has(u))
  ctx.assert(missing.length === 0, 'all 45 posts of the outbox are stored', JSON.stringify(missing))
  const reblog = rows.find((r) => r.ap_type === 'Announce')
  ctx.assert(
    reblog?.reblog?.ap_id === boostedUrl && reblog?.metadata?.reblog_of,
    'the Announce is stored with the original it boosts, fetched first',
    JSON.stringify(reblog),
  )
  ctx.assert(seen.includes('/users/fx_remote/statuses/boosted-in-outbox'), 'the boosted original is fetched from its origin')

  const pinned = rows.filter((r) => r.is_pinned).map((r) => r.ap_id).sort()
  ctx.assert(
    JSON.stringify(pinned) === JSON.stringify([statusUrl(3), statusUrl(41)].sort()),
    'the featured posts are pinned, and only they',
    JSON.stringify(pinned),
  )
  const profile = await db.from('profiles').select('featured_url').eq('id', PUBLISHER).single()
  ctx.eq(profile.data?.featured_url, featured, 'the featured collection URL is remembered')
}

async function caseBlock(ctx: OutboundContext, alice: SupabaseClient, tap: JobTap, handlers: Handlers) {
  console.log('\nblock and unblock of the peer\'s user -> Block and Undo(Block) to its inbox')
  const { peer } = ctx

  await ctx.db.from('user_blocks').delete().eq('blocker_id', ctx.alice.id).eq('blocked_user_id', ctx.remote)
  const blocked = await alice.from('user_blocks')
    .insert({ blocker_id: ctx.alice.id, blocked_user_id: ctx.remote })
    .select('id').single()
  if (blocked.error) return ctx.fail('fx_alice blocks fx_remote', blocked.error.message)

  const job = await tap.take((j) => j.name === 'federate-block' && j.data?.block_id === blocked.data.id && j.data?.type === 'create')
  if (!job) return ctx.fail('the trigger queues the block job')
  ctx.eq(job.data.blocked_user_id, ctx.remote, 'the block job names the blocked account')

  let before = peer.captured.length
  await handlers.handleBlockJob(job.data)
  let sent = deliveriesSince(peer, before)
  ctx.eq(sent.length, 1, 'the Block is delivered')
  ctx.eq(sent[0]?.url, '/users/fx_remote/inbox', 'the Block goes to the blocked actor\'s inbox')
  ctx.eq(sent[0]?.body?.type, 'Block', 'the delivery is a Block')
  ctx.eq(sent[0]?.body?.object, peer.actorUrl, 'the Block names the blocked actor')
  const blockId = sent[0]?.body?.id

  const unblocked = await alice.from('user_blocks').delete().eq('id', blocked.data.id)
  if (unblocked.error) return ctx.fail('fx_alice unblocks fx_remote', unblocked.error.message)
  const undoJob = await tap.take((j) => j.name === 'federate-block' && j.data?.block_id === blocked.data.id && j.data?.type === 'delete')
  if (!undoJob) return ctx.fail('the trigger queues the unblock job')

  before = peer.captured.length
  await handlers.handleBlockJob(undoJob.data)
  sent = deliveriesSince(peer, before)
  ctx.eq(sent.length, 1, 'the unblock is delivered')
  ctx.eq(sent[0]?.body?.type, 'Undo', 'the unblock is an Undo')
  ctx.eq(sent[0]?.body?.object?.type, 'Block', 'the Undo embeds the Block')
  ctx.eq(sent[0]?.body?.object?.id, blockId, 'the embedded Block keeps the id it was sent under')
}
