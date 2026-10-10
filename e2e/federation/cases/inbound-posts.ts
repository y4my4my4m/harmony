// Inbound remote posts, delivered by the peer and by a second remote instance, the origin.
//
// The origin serves its actor and the documents a boost makes the local instance fetch: a
// Question no local row holds yet. Everything else arrives signed at the shared inbox and
// is read back through PostgREST.
//
//   - a Create(Note) of 3000 characters is stored intact, and an Update growing a stored
//     note past max_post_length (500) applies;
//   - a media-only Note (empty content, one image) keeps its attachment, in the content and
//     in posts.media_attachments; a sensitive Note stores media_attachments beside
//     is_sensitive and its content warning;
//   - an Announce of a Question not stored yet fetches it from the origin and stores the
//     poll and the boost;
//   - a Delete of an original soft-deletes its plain boosts, local and remote, and leaves
//     its quotes, local and remote;
//   - a remote author gets no activitypub_reblog notification; a local author does;
//   - the completed ap_activities row of a delivery is purged once 30 days old.

import crypto from 'node:crypto'
import http from 'node:http'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

const PUBLIC = 'https://www.w3.org/ns/activitystreams#Public'
const AS = 'https://www.w3.org/ns/activitystreams'

export interface InboundPostsContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  env: Record<string, string>
  ids: { alice: string; bob: string; bobAuth: string; remote: string }
  userToken: (authUserId: string, secret: string) => string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

/** A second remote instance: one actor and the documents put in `docs`, served to any GET. */
class Origin {
  readonly key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  readonly docs = new Map<string, unknown>()
  base = ''
  private server?: http.Server

  get actorUrl() {
    return `${this.base}/users/fx_origin`
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const url = `${this.base}${req.url ?? ''}`
      const doc = url === this.actorUrl
        ? {
            '@context': [AS, 'https://w3id.org/security/v1'],
            id: this.actorUrl,
            type: 'Person',
            preferredUsername: 'fx_origin',
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

/** Text of a content array, parts joined. */
function textOf(content: unknown): string {
  return Array.isArray(content) ? content.filter((p) => p?.type === 'text').map((p) => p.text).join('') : ''
}

export async function caseInboundPosts(ctx: InboundPostsContext) {
  const { db, peer, localUrl, assert, eq } = ctx

  const deliver = async (activity: Record<string, unknown>, signer = { key: peer.key.privateKey, actor: peer.actorUrl }) => {
    const body = JSON.stringify({ '@context': AS, ...activity })
    const target = `${localUrl}/inbox`
    return (await ctx.post(target, ctx.signedHeaders(target, body, signer.key, `${signer.actor}#main-key`), body)).status
  }
  const postByApId = async (apId: string) =>
    (await db.from('posts').select('*').eq('ap_id', apId).maybeSingle()).data
  const note = (id: string, attributedTo: string, extra: Record<string, unknown> = {}) => ({
    id, type: 'Note', attributedTo, to: [PUBLIC], cc: [], published: new Date().toISOString(),
    content: '<p>note</p>', ...extra,
  })
  const create = (object: { id: string; attributedTo: string }) => ({
    id: `${object.id}/activity`, type: 'Create', actor: object.attributedTo, to: [PUBLIC], object,
  })

  const origin = new Origin()
  await origin.start(new URL(peer.base).hostname)
  const asOrigin = { key: origin.key.privateKey, actor: origin.actorUrl }

  try {
    console.log('\ninbound Create(Note) past max_post_length -> stored intact; Update past it applies')
    {
      const long = 'a'.repeat(3000)
      const id = `${peer.base}/notes/long-${crypto.randomUUID()}`
      eq(await deliver(create(note(id, peer.actorUrl, { content: `<p>${long}</p>` }))), 202, 'the long Create is accepted (202)')
      const stored = await postByApId(id)
      eq(textOf(stored?.content).length, 3000, 'a 3000-character note is stored')
      eq(textOf(stored?.content), long, 'with its text intact')

      const editedId = `${peer.base}/notes/edited-${crypto.randomUUID()}`
      await deliver(create(note(editedId, peer.actorUrl, { content: '<p>short</p>' })))
      eq(textOf((await postByApId(editedId))?.content), 'short', 'the short note is stored')
      const grown = 'b'.repeat(2000)
      eq(await deliver({
        id: `${editedId}#update`, type: 'Update', actor: peer.actorUrl, to: [PUBLIC],
        object: note(editedId, peer.actorUrl, { content: `<p>${grown}</p>`, updated: new Date().toISOString() }),
      }), 202, 'the Update is accepted (202)')
      eq(textOf((await postByApId(editedId))?.content), grown, 'the edit growing the note to 2000 characters applies')

      const { data: activity } = await db.from('ap_activities').select('id, status').eq('ap_id', `${id}/activity`).maybeSingle()
      eq(activity?.status, 'completed', 'the inbox records the processed Create as completed')
      await db.from('ap_activities').update({ created_at: new Date(Date.now() - 31 * 86400_000).toISOString() }).eq('id', activity?.id)
      const { data: purged, error } = await db.rpc('purge_processed_ap_activities')
      assert(!error && purged >= 1, 'purge_processed_ap_activities deletes completed rows past 30 days', error?.message ?? purged)
      eq((await db.from('ap_activities').select('id').eq('id', activity?.id).maybeSingle()).data, null,
        'the 31-day-old completed Create is gone')
    }

    console.log('\ninbound media-only and sensitive Notes -> attachments in content and media_attachments')
    {
      const image = {
        type: 'Document', mediaType: 'image/png', url: 'https://media.remote.test/cat.png', name: 'a cat',
        width: 640, height: 480, blurhash: 'UBL_:rOpGG-oBUNG',
      }
      const mediaOnly = `${peer.base}/notes/media-${crypto.randomUUID()}`
      eq(await deliver(create(note(mediaOnly, peer.actorUrl, { content: '', attachment: [image] }))), 202,
        'the media-only Create is accepted (202)')
      const stored = await postByApId(mediaOnly)
      eq(JSON.stringify(stored?.content?.map((p: any) => [p.type, p.url])), JSON.stringify([['file', image.url]]),
        'the media-only note keeps its image as a content file part')
      eq(stored?.media_attachments?.length, 1, 'and stores it in media_attachments')
      eq(stored?.media_attachments?.[0]?.url, image.url, 'with its URL')
      eq(stored?.media_attachments?.[0]?.description, 'a cat', 'with the AP name as its alt text')

      const sensitive = `${peer.base}/notes/sensitive-${crypto.randomUUID()}`
      eq(await deliver(create(note(sensitive, peer.actorUrl, {
        content: '<p>spoilered</p>', sensitive: true, summary: 'cw', attachment: [image],
      }))), 202, 'the sensitive Create is accepted (202)')
      const row = await postByApId(sensitive)
      eq(row?.is_sensitive, true, 'the sensitive note is stored sensitive')
      eq(row?.content_warning, 'cw', 'with its content warning')
      eq(row?.media_attachments?.[0]?.mediaType, 'image/png', 'and its media in media_attachments, which the gallery blurs')
    }

    console.log('\ninbound Announce of a Question not stored yet -> fetched from its origin, stored with the boost')
    {
      const questionId = `${origin.base}/notes/poll-${crypto.randomUUID()}`
      origin.docs.set(questionId, {
        '@context': AS,
        ...note(questionId, origin.actorUrl, { type: 'Question', content: '<p>tabs or spaces?</p>' }),
        oneOf: [
          { type: 'Note', name: 'tabs', replies: { type: 'Collection', totalItems: 3 } },
          { type: 'Note', name: 'spaces', replies: { type: 'Collection', totalItems: 5 } },
        ],
        votersCount: 8,
        endTime: new Date(Date.now() + 86400_000).toISOString(),
      })
      const announceId = `${peer.base}/announces/${crypto.randomUUID()}`
      eq(await deliver({ id: announceId, type: 'Announce', actor: peer.actorUrl, to: [PUBLIC], object: questionId }), 202,
        'the Announce is accepted (202)')

      const poll = await postByApId(questionId)
      eq(poll?.ap_type, 'Question', 'the boosted Question is fetched and stored')
      eq(poll?.url, questionId, 'through storeRemotePost, which records its url')
      eq(JSON.stringify(poll?.metadata?.poll_options), JSON.stringify([{ name: 'tabs', votes: 3 }, { name: 'spaces', votes: 5 }]),
        'with its poll options')
      const boost = await postByApId(announceId)
      eq(boost?.author_id, ctx.ids.remote, 'the boost is stored for the peer')
      assert(!!poll && boost?.reblog?.id === poll.id, 'the boost names the stored poll', boost?.reblog?.id)
      eq(boost?.reblog?.metadata?.is_poll, true, 'and carries its poll for the timeline')
    }

    console.log('\nDelete of an original -> plain boosts deleted, quotes kept')
    {
      const originalId = `${peer.base}/notes/original-${crypto.randomUUID()}`
      await deliver(create(note(originalId, peer.actorUrl, { content: '<p>quoted and boosted</p>' })))
      const original = await postByApId(originalId)
      assert(!!original, 'the original is stored')

      const remoteBoostId = `${origin.base}/announces/${crypto.randomUUID()}`
      eq(await deliver({ id: remoteBoostId, type: 'Announce', actor: origin.actorUrl, to: [PUBLIC], object: originalId }, asOrigin), 202,
        'the origin\'s boost is accepted (202)')
      const remoteQuoteId = `${origin.base}/notes/quote-${crypto.randomUUID()}`
      eq(await deliver(create(note(remoteQuoteId, origin.actorUrl, { content: '<p>my take</p>', quoteUrl: originalId })), asOrigin), 202,
        'the origin\'s quote is accepted (202)')

      const bob = createClient(ctx.env.HMFED_SUPABASE_URL, ctx.env.HMFED_SUPABASE_ANON_KEY, {
        auth: { autoRefreshToken: false, persistSession: false },
        global: { headers: { Authorization: `Bearer ${ctx.userToken(ctx.ids.bobAuth, ctx.env.HMFED_JWT_SECRET)}` } },
      })
      const localBoost = await bob.from('posts')
        .insert({ author_id: ctx.ids.bob, content: [], visibility: 'public', metadata: { reblog_of: original?.id } })
        .select('id').single()
      const localQuote = await bob.from('posts')
        .insert({
          author_id: ctx.ids.bob, content: [{ type: 'text', text: 'local take' }], visibility: 'public',
          metadata: { reblog_of: original?.id, is_quote: true },
        })
        .select('id').single()
      assert(!localBoost.error && !localQuote.error, 'fx_bob boosts and quotes the original',
        localBoost.error?.message ?? localQuote.error?.message)

      eq(await deliver({ id: `${originalId}#delete`, type: 'Delete', actor: peer.actorUrl, to: [PUBLIC],
        object: { id: originalId, type: 'Tombstone' } }), 202, 'the Delete is accepted (202)')

      const deleted = async (id: string | undefined, column: 'id' | 'ap_id' = 'id') =>
        (await db.from('posts').select('is_deleted').eq(column, id ?? '').maybeSingle()).data?.is_deleted
      eq(await deleted(originalId, 'ap_id'), true, 'the original is deleted')
      eq(await deleted(remoteBoostId, 'ap_id'), true, 'the remote boost is deleted with it')
      eq(await deleted(localBoost.data?.id), true, 'the local boost is deleted with it')
      eq(await deleted(remoteQuoteId, 'ap_id'), false, 'the remote quote stays')
      eq(await deleted(localQuote.data?.id), false, 'the local quote stays')
    }

    console.log('\ninbound boosts -> activitypub_reblog notifies local authors only')
    {
      const { data: originProfile } = await db.from('profiles').select('id').eq('federated_id', origin.actorUrl).maybeSingle()
      const { count: remoteCount } = await db.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('type', 'activitypub_reblog')
        .in('user_id', [ctx.ids.remote, originProfile?.id ?? ctx.ids.remote])
      eq(remoteCount, 0, 'the remote authors boosted above hold no activitypub_reblog notification')

      const alicePost = crypto.randomUUID()
      const { error } = await db.from('posts').insert({
        id: alicePost, author_id: ctx.ids.alice, visibility: 'public', is_local: true,
        content: [{ type: 'text', text: 'boost me' }],
      })
      assert(!error, 'seed a local post', error?.message)
      eq(await deliver({
        id: `${peer.base}/announces/${crypto.randomUUID()}`, type: 'Announce', actor: peer.actorUrl, to: [PUBLIC],
        object: `https://${ctx.instanceDomain}/posts/${alicePost}`,
      }), 202, 'the peer\'s boost of fx_alice\'s post is accepted (202)')
      const { count: localCount } = await db.from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('type', 'activitypub_reblog')
        .eq('user_id', ctx.ids.alice)
        .eq('data->>post_id', alicePost)
      eq(localCount, 1, 'fx_alice is notified of the boost')
    }
  } finally {
    await origin.stop()
  }
}
