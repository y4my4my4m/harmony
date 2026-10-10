// Replies of a remote post, crawled from its origin (federation-backend ActorService
// POST /fetch-replies and GET /fetch-replies/status, migration 20261011800001).
//
// A second peer serves a status shaped as Mastodon serves one: its replies collection embeds
// a first page with the author's own replies and links a page of other accounts' replies as
// URIs (ActivityPub::RepliesController). That page is served after a delay, so the crawl is
// seen running and a second request joins it. The collection carries no totalItems; the
// complete walk's count becomes remote_replies_count.
//
// Sibling replies are also inserted concurrently through PostgREST, one transaction each:
// the reply counter's lock on the parent once made such inserts abort with 40P01.

import crypto from 'node:crypto'
import http from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'

export interface RepliesCaseContext {
  db: SupabaseClient
  /** The local instance's listen address. */
  localUrl: string
  /** Host address federation code may fetch: the compose network's gateway. */
  peerHost: string
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const AUTHOR = 'fed00000-0000-0000-0000-0000000001a0'
const ROOT_POST = 'fed00000-0000-0000-0000-0000000001a1'
const SIBLING_PARENT = 'fed00000-0000-0000-0000-0000000001a2'
const SIBLINGS = 24
/** Delay of the other accounts' page; longer than the backend's 800 ms answer wait. */
const PAGE_DELAY_MS = 3000
const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'

class RepliesPeer {
  private server?: http.Server
  private readonly publicKeyPem = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  }).publicKey
  base = ''
  readonly gets: string[] = []

  get rootUrl() {
    return `${this.base}/users/rp_author/statuses/1`
  }
  get othersPage() {
    return `${this.rootUrl}/replies?only_other_accounts=true&page=true`
  }
  get lockedUrl() {
    return `${this.base}/users/rp_author/statuses/locked`
  }
  actor(name: string) {
    return `${this.base}/users/${name}`
  }

  /** Replies by other accounts, listed by URI on the second page. */
  get otherReplies(): Array<{ id: string; author: string }> {
    return [
      { id: `${this.actor('rp_kiwi')}/statuses/11`, author: 'rp_kiwi' },
      { id: `${this.actor('rp_kiwi')}/statuses/12`, author: 'rp_kiwi' },
      { id: `${this.actor('rp_pat')}/statuses/13`, author: 'rp_pat' },
      { id: `${this.actor('rp_pat')}/statuses/14`, author: 'rp_pat' },
    ]
  }

  private note(id: string, author: string, inReplyTo: string | null, text: string) {
    return {
      id,
      type: 'Note',
      attributedTo: this.actor(author),
      inReplyTo,
      to: [PUBLIC],
      published: new Date(Date.now() - 5 * 60_000).toISOString(),
      content: `<p>${text}</p>`,
    }
  }

  private documents(): Map<string, unknown> {
    const docs = new Map<string, unknown>()
    const self = [
      this.note(`${this.rootUrl.replace(/1$/, '2')}`, 'rp_author', this.rootUrl, 'self reply one'),
      this.note(`${this.rootUrl.replace(/1$/, '3')}`, 'rp_author', this.rootUrl, 'self reply two'),
    ]
    docs.set(this.rootUrl, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      ...this.note(this.rootUrl, 'rp_author', null, 'a status with replies'),
      replies: {
        id: `${this.rootUrl}/replies`,
        type: 'Collection',
        first: { type: 'CollectionPage', partOf: `${this.rootUrl}/replies`, next: this.othersPage, items: self },
      },
      likes: { id: `${this.rootUrl}/likes`, type: 'Collection', totalItems: 3 },
      shares: { id: `${this.rootUrl}/shares`, type: 'Collection', totalItems: 1 },
    })
    docs.set(this.othersPage, {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: this.othersPage,
      type: 'CollectionPage',
      partOf: `${this.rootUrl}/replies`,
      items: this.otherReplies.map((r) => r.id),
    })
    for (const r of this.otherReplies) docs.set(r.id, this.note(r.id, r.author, this.rootUrl, `reply ${r.id.slice(-2)}`))
    for (const name of ['rp_author', 'rp_kiwi', 'rp_pat']) {
      docs.set(this.actor(name), {
        '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'],
        id: this.actor(name),
        type: 'Person',
        preferredUsername: name,
        inbox: `${this.actor(name)}/inbox`,
        publicKey: { id: `${this.actor(name)}#main-key`, owner: this.actor(name), publicKeyPem: this.publicKeyPem },
      })
    }
    return docs
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = `${this.base}${req.url ?? ''}`
      if (req.method !== 'GET') {
        res.writeHead(405).end()
        return
      }
      this.gets.push(url)
      if (url === this.lockedUrl) {
        res.writeHead(401, { 'Content-Type': 'application/json' })
        res.end('{"error":"Request not signed"}')
        return
      }
      const doc = this.documents().get(url)
      if (!doc) {
        res.writeHead(404).end()
        return
      }
      const send = () => {
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify(doc))
      }
      if (url === this.othersPage) setTimeout(send, PAGE_DELAY_MS)
      else send()
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    this.base = `http://${host}:${(this.server!.address() as { port: number }).port}`
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve())
  }
}

async function postJson(url: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function getJson(url: string): Promise<{ status: number; body: any }> {
  const res = await fetch(url)
  return { status: res.status, body: await res.json().catch(() => null) }
}

async function seed(db: SupabaseClient, peer: RepliesPeer): Promise<void> {
  await db.from('posts').delete().in('in_reply_to', [ROOT_POST, SIBLING_PARENT])
  await db.from('posts').delete().in('id', [ROOT_POST, SIBLING_PARENT])
  await db.from('profiles').delete().eq('id', AUTHOR)

  const host = new URL(peer.base).host
  const profile = await db.from('profiles').insert({
    id: AUTHOR,
    username: 'rp_author',
    display_name: 'Replies peer author',
    domain: host,
    federated_id: peer.actor('rp_author'),
    inbox_url: `${peer.actor('rp_author')}/inbox`,
    is_local: false,
  })
  if (profile.error) throw new Error(`seed replies author: ${profile.error.message}`)

  const posts = await db.from('posts').insert([
    {
      id: ROOT_POST,
      author_id: AUTHOR,
      content: [{ type: 'text', text: 'a status with replies' }],
      visibility: 'public',
      is_local: false,
      ap_id: peer.rootUrl,
      url: peer.rootUrl,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
    {
      id: SIBLING_PARENT,
      author_id: AUTHOR,
      content: [{ type: 'text', text: 'a parent for concurrent replies' }],
      visibility: 'public',
      is_local: false,
      ap_id: `${peer.base}/users/rp_author/statuses/siblings`,
      created_at: new Date(Date.now() - 10 * 60_000).toISOString(),
    },
  ])
  if (posts.error) throw new Error(`seed replies posts: ${posts.error.message}`)
}

/** Concurrent sibling inserts, one PostgREST transaction each. */
async function caseConcurrentSiblings(ctx: RepliesCaseContext, peer: RepliesPeer): Promise<void> {
  console.log('\nconcurrent sibling replies')
  const results = await Promise.all(Array.from({ length: SIBLINGS }, (_, i) => ctx.db.from('posts').insert({
    author_id: AUTHOR,
    content: [{ type: 'text', text: `sibling ${i}` }],
    visibility: 'public',
    is_local: false,
    ap_id: `${peer.base}/users/rp_author/statuses/sibling-${i}`,
    in_reply_to: SIBLING_PARENT,
  })))
  const errors = results.filter((r) => r.error).map((r) => `${r.error!.code}: ${r.error!.message}`)
  ctx.eq(errors.length, 0, `${SIBLINGS} sibling replies inserted at once all commit`)
  if (errors.length) console.log(`        ${errors.slice(0, 3).join('; ')}`)
  ctx.assert(!errors.some((e) => e.startsWith('40P01')), 'no sibling insert deadlocks', errors.join('; '))

  const { data } = await ctx.db.from('posts').select('replies_count').eq('id', SIBLING_PARENT).single()
  ctx.eq(data?.replies_count, SIBLINGS, 'the parent counts every sibling')
}

async function caseCrawl(ctx: RepliesCaseContext, peer: RepliesPeer): Promise<void> {
  console.log('\nreply crawl of a remote status')
  const statusUrl = `${ctx.localUrl}/fetch-replies/status?post_ap_id=${encodeURIComponent(peer.rootUrl)}`

  const first = await postJson(`${ctx.localUrl}/fetch-replies`, { post_ap_id: peer.rootUrl, post_id: ROOT_POST, async: true })
  ctx.eq(first.status, 200, 'POST /fetch-replies answers before the crawl ends')
  ctx.eq(first.body?.status, 'started', 'the first request starts a crawl')
  ctx.eq(first.body?.result, null, 'a started crawl carries no result yet')

  const joined = await postJson(`${ctx.localUrl}/fetch-replies`, { post_ap_id: peer.rootUrl, post_id: ROOT_POST, async: true })
  ctx.eq(joined.body?.status, 'running', 'a second request joins the running crawl')
  ctx.eq((await getJson(statusUrl)).body?.status, 'running', 'the status reads running')

  let done: any = null
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const res = await getJson(statusUrl)
    if (res.body?.status !== 'running') {
      done = res.body
      break
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  ctx.eq(done?.status, 'done', 'the status reads done once the crawl ends')
  ctx.assert(
    done?.result?.outcome === 'ok' && done.result.found === 6 && done.result.stored === 6
      && done.result.complete === true && done.result.truncated === false,
    'the result lists six replies, all stored, over a complete walk',
    JSON.stringify(done?.result),
  )
  ctx.eq(peer.gets.filter((u) => u === peer.rootUrl).length, 1, 'the joined request fetched the status once')

  const { data: replies } = await ctx.db.from('posts').select('ap_id, author_id').eq('in_reply_to', ROOT_POST)
  ctx.eq(replies?.length, 6, 'six replies are stored under the post')
  const { data: authors } = await ctx.db
    .from('profiles')
    .select('federated_id')
    .in('federated_id', [peer.actor('rp_kiwi'), peer.actor('rp_pat')])
  ctx.eq(authors?.length, 2, 'the other accounts are stored from their actor documents')

  const { data: root } = await ctx.db
    .from('posts')
    .select('replies_count, remote_replies_count, remote_favorites_count, replies_fetched_at')
    .eq('id', ROOT_POST)
    .single()
  ctx.eq(root?.remote_replies_count, 6, 'the complete walk records the origin\'s reply count')
  ctx.eq(root?.replies_count, 6, 'the displayed counter follows it')
  ctx.eq(root?.remote_favorites_count, 3, 'the likes figure is read on the way')
  ctx.assert(!!root?.replies_fetched_at, 'replies_fetched_at records the crawl', root?.replies_fetched_at)
  ctx.eq(done?.replies_fetched_at, root?.replies_fetched_at, 'the status carries the recorded crawl time')

  const before = peer.gets.length
  const recent = await postJson(`${ctx.localUrl}/fetch-replies`, { post_ap_id: peer.rootUrl, async: true })
  ctx.eq(recent.body?.status, 'recent', 'a request inside the interval starts no crawl')
  ctx.eq(recent.body?.result?.found, 6, 'and answers with the last result')
  ctx.eq(peer.gets.length, before, 'the origin is not contacted again')

  const legacy = await postJson(`${ctx.localUrl}/fetch-replies`, { post_ap_id: peer.rootUrl, force: true })
  ctx.assert(
    legacy.body?.status === 'recent' && legacy.body?.count === 0 && !('result' in legacy.body),
    'a request without async still gets the answer shape of clients up to 1.7.0',
    JSON.stringify(legacy.body),
  )
}

async function caseLocked(ctx: RepliesCaseContext, peer: RepliesPeer): Promise<void> {
  console.log('\nreply crawl refused by the origin')
  const res = await postJson(`${ctx.localUrl}/fetch-replies`, { post_ap_id: peer.lockedUrl, async: true, force: true })
  let body = res.body
  for (let i = 0; i < 40 && (body?.status === 'started' || body?.status === 'running'); i++) {
    await new Promise((r) => setTimeout(r, 250))
    body = (await getJson(`${ctx.localUrl}/fetch-replies/status?post_ap_id=${encodeURIComponent(peer.lockedUrl)}`)).body
  }
  ctx.eq(body?.result?.outcome, 'unauthorized', 'a 401 from the origin reads unauthorized')
}

export async function caseRemoteReplies(ctx: RepliesCaseContext): Promise<void> {
  const peer = new RepliesPeer()
  await peer.start(ctx.peerHost)
  try {
    await seed(ctx.db, peer)
    await caseConcurrentSiblings(ctx, peer)
    await caseCrawl(ctx, peer)
    await caseLocked(ctx, peer)
  } finally {
    await peer.stop()
  }
}
