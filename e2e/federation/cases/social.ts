// Inbound reply chains and the parent a reply's card previews (migration 20261105500001,
// federation-backend POST /resolve-reply-parents).
//
// An origin instance serves a chain A <- B; the peer delivers C replying to B. The local
// instance fetches B and A on receipt and links C -> B -> A:
//   - a local reader's PostgREST read reply_parent:in_reply_to(...) of C is B, with author and
//     text; A counts one direct reply and its thread (get_post_with_context) two replies;
//   - get_home_timeline_page of a follower of the origin's actor carries B's reply_parent A.
// The peer delivers replies whose parents the origin does not serve yet; each is stored with
// in_reply_to NULL and the parent's id in metadata.in_reply_to_ap_url:
//   - once the origin serves the parent, /resolve-reply-parents fetches it and links the reply;
//   - a parent that stays absent is fetched once, not again inside the failure window;
//   - a followers-only reply the caller cannot read has its parent fetched by nobody.

import crypto from 'node:crypto'
import http from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const AS = 'https://www.w3.org/ns/activitystreams'
const PARENT_EMBED =
  'id, in_reply_to, reply_parent:in_reply_to(id, content, is_deleted, author:profiles!posts_author_id_fkey(username, domain))'

export interface SocialContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  ids: { alice: string; aliceAuth: string }
  asUser: (authUserId: string) => SupabaseClient
  bearer: (authUserId: string) => string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

/** A second instance: one actor and the documents in `docs`, served to any GET; GETs counted by URL. */
class ChainOrigin {
  readonly key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  readonly docs = new Map<string, unknown>()
  readonly gets = new Map<string, number>()
  base = ''
  private server?: http.Server

  get actorUrl() {
    return `${this.base}/users/fx_chain`
  }

  note(name: string, text: string, inReplyTo?: string) {
    const id = `${this.base}/users/fx_chain/statuses/${name}`
    return {
      '@context': AS, id, type: 'Note', attributedTo: this.actorUrl, to: [PUBLIC], cc: [],
      published: new Date().toISOString(), content: `<p>${text}</p>`, ...(inReplyTo ? { inReplyTo } : {}),
    }
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = `${this.base}${req.url ?? ''}`
      if (req.method === 'GET') this.gets.set(url, (this.gets.get(url) ?? 0) + 1)
      const doc = url === this.actorUrl
        ? {
            '@context': [AS, 'https://w3id.org/security/v1'],
            id: this.actorUrl,
            type: 'Person',
            preferredUsername: 'fx_chain',
            inbox: `${this.actorUrl}/inbox`,
            publicKey: { id: `${this.actorUrl}#main-key`, owner: this.actorUrl, publicKeyPem: this.key.publicKey },
          }
        : this.docs.get(url)
      if (req.method !== 'GET' || !doc) {
        res.writeHead(req.method === 'POST' ? 202 : 404).end()
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/activity+json' })
      res.end(JSON.stringify(doc))
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    this.base = `http://${host}:${(this.server!.address() as { port: number }).port}`
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

function textOf(content: unknown): string {
  return Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : ''
}

export async function caseSocial(ctx: SocialContext) {
  const { db, peer, localUrl, assert, eq } = ctx
  const alice = ctx.asUser(ctx.ids.aliceAuth)

  const deliver = async (object: Record<string, unknown>) => {
    const body = JSON.stringify({
      '@context': AS, id: `${object.id}/activity`, type: 'Create', actor: peer.actorUrl,
      to: object.to, cc: object.cc ?? [], object,
    })
    const target = `${localUrl}/inbox`
    return (await ctx.post(target, ctx.signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)).status
  }
  const peerNote = (name: string, text: string, inReplyTo: string, to: string[] = [PUBLIC]) => ({
    id: `${peer.base}/notes/${name}-${crypto.randomUUID()}`, type: 'Note', attributedTo: peer.actorUrl,
    to, cc: [], published: new Date().toISOString(), content: `<p>${text}</p>`, inReplyTo,
  })
  const byApId = async (apId: string) =>
    (await db.from('posts').select('*').eq('ap_id', apId).maybeSingle()).data
  const resolveParents = async (postIds: string[], authUserId?: string) => {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (authUserId) headers.Authorization = `Bearer ${ctx.bearer(authUserId)}`
    const res = await ctx.post(`${localUrl}/resolve-reply-parents`, headers, JSON.stringify({ post_ids: postIds }))
    return { status: res.status, results: (JSON.parse(res.body || '{}').results ?? {}) as Record<string, string> }
  }

  const origin = new ChainOrigin()
  await origin.start(new URL(peer.base).hostname)
  let follow: { follower_id: string; following_id: string } | null = null

  try {
    console.log('\ninbound reply chain: the peer answers B, B answers A, both on the origin -> stored and linked')
    const a = origin.note(`a-${crypto.randomUUID()}`, 'root of the chain')
    const b = origin.note(`b-${crypto.randomUUID()}`, 'middle of the chain', a.id)
    origin.docs.set(a.id, a)
    origin.docs.set(b.id, b)
    const c = peerNote('c', 'end of the chain', b.id)
    eq(await deliver(c), 202, 'the reply is accepted (202)')
    const [rowA, rowB, rowC] = [await byApId(a.id), await byApId(b.id), await byApId(c.id)]
    assert(rowA && rowB && rowC, 'the reply and both of its ancestors are stored')
    eq(rowC?.in_reply_to, rowB?.id, 'the reply is linked to its parent')
    eq(rowB?.in_reply_to, rowA?.id, 'the parent is linked to the top post')
    eq(rowC?.conversation_root_id, rowA?.id, 'the reply names the top post as its conversation root')
    eq(origin.gets.get(a.id), 1, 'the top post is fetched once')
    eq(origin.gets.get(b.id), 1, 'the parent is fetched once')

    const { data: preview, error: previewError } = await alice.from('posts').select(PARENT_EMBED).eq('id', rowC?.id).single()
    eq(previewError?.message ?? null, null, 'a local reader reads the reply with its parent embedded')
    eq((preview as any)?.reply_parent?.id, rowB?.id, 'the embedded parent is the parent')
    eq(textOf((preview as any)?.reply_parent?.content), 'middle of the chain', 'with its text')
    eq((preview as any)?.reply_parent?.author?.username, 'fx_chain', 'and its author')

    const { data: top } = await db.from('posts').select('replies_count').eq('id', rowA?.id).single()
    eq(top?.replies_count, 1, 'the top post counts its one direct reply')
    const { data: thread } = await alice.rpc('get_post_with_context', {
      p_post_id: rowA?.id, p_user_id: ctx.ids.alice, p_context_type: 'thread',
    })
    eq(thread?.descendants?.length, 2, 'the top post\'s thread holds both replies')
    eq(thread?.threadInfo?.totalPosts, 3, 'and counts three posts')

    console.log('\nhome timeline: a follower of the origin\'s actor gets each reply with its parent')
    follow = { follower_id: ctx.ids.alice, following_id: rowA?.author_id }
    const { error: followError } = await db.from('follows').insert({ ...follow, status: 'accepted' })
    eq(followError?.message ?? null, null, 'the reader follows the origin\'s actor')
    const { data: home, error: homeError } = await alice.rpc('get_home_timeline_page', { p_limit: 100 })
    eq(homeError?.message ?? null, null, 'get_home_timeline_page answers')
    const homeB = (home as any[] | null)?.find((row) => row.id === rowB?.id)
    eq(homeB?.reply_parent?.id, rowA?.id, 'the parent\'s row carries its own parent')
    eq(textOf(homeB?.reply_parent?.content), 'root of the chain', 'with its text')
    const homeA = (home as any[] | null)?.find((row) => row.id === rowA?.id)
    eq(homeA?.reply_parent ?? null, null, 'the top post carries none')

    console.log('\nreply before its parent: stored waiting; /resolve-reply-parents links it once the origin serves the parent')
    const lateParent = origin.note(`late-${crypto.randomUUID()}`, 'the late parent')
    const late = peerNote('late', 'answer to the late parent', lateParent.id)
    eq(await deliver(late), 202, 'the reply is accepted (202)')
    const waiting = await byApId(late.id)
    eq(waiting?.in_reply_to ?? null, null, 'the reply is stored without a parent')
    eq(waiting?.metadata?.in_reply_to_ap_url, lateParent.id, 'naming the parent\'s id')
    origin.docs.set(lateParent.id, lateParent)
    const linked = await resolveParents([waiting?.id], ctx.ids.aliceAuth)
    eq(linked.status, 200, '/resolve-reply-parents answers 200')
    eq(linked.results[waiting?.id], 'linked', 'the reply is linked')
    const storedParent = await byApId(lateParent.id)
    assert(storedParent, 'the parent is stored')
    const { data: latePreview } = await alice.from('posts').select(PARENT_EMBED).eq('id', waiting?.id).single()
    eq((latePreview as any)?.reply_parent?.id, storedParent?.id, 'the reader reads the fetched parent through the reply')

    console.log('\nreply whose parent stays absent: fetched once, then not again inside the failure window')
    const absentUrl = `${origin.base}/users/fx_chain/statuses/absent-${crypto.randomUUID()}`
    const orphan = peerNote('orphan', 'answer to nothing', absentUrl)
    eq(await deliver(orphan), 202, 'the reply is accepted (202)')
    const orphanRow = await byApId(orphan.id)
    const onReceipt = origin.gets.get(absentUrl) ?? 0
    const first = await resolveParents([orphanRow?.id])
    eq(first.results[orphanRow?.id], 'unavailable', 'the parent is unavailable')
    eq(origin.gets.get(absentUrl), onReceipt + 1, 'the parent is fetched again once')
    const second = await resolveParents([orphanRow?.id])
    eq(second.results[orphanRow?.id], 'unavailable', 'a second request answers unavailable')
    eq(origin.gets.get(absentUrl), onReceipt + 1, 'without fetching it')

    console.log('\nfollowers-only reply: a caller who cannot read it fetches nothing for it')
    const privateUrl = `${origin.base}/users/fx_chain/statuses/private-${crypto.randomUUID()}`
    const privateReply = peerNote('private', 'for followers', privateUrl, [`${peer.actorUrl}/followers`])
    eq(await deliver(privateReply), 202, 'the reply is accepted (202)')
    const privateRow = await byApId(privateReply.id)
    eq(privateRow?.visibility, 'followers', 'stored followers-only')
    const beforeAnon = origin.gets.get(privateUrl) ?? 0
    const anon = await resolveParents([privateRow?.id])
    eq(anon.results[privateRow?.id], 'none', 'an anonymous caller gets none')
    eq(origin.gets.get(privateUrl) ?? 0, beforeAnon, 'and its parent is not fetched')
  } finally {
    if (follow) await db.from('follows').delete().eq('follower_id', follow.follower_id).eq('following_id', follow.following_id)
    await origin.stop()
  }
}
