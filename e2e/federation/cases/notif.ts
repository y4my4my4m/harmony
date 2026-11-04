// A Mastodon 4.5+ quote of a local post, as Mastodon delivers it, notifies the quoted author.
//
// Mastodon sends two activities for one quote, in no fixed order (PostStatusService queues
// both at once): a QuoteRequest to the quoted author's own inbox, carrying the quote Note
// inlined as `instrument`, and the Create of that Note to the shared inbox (StatusReachFinder
// counts the quoted author). The Note names the quoted post as `quote`, `_misskey_quote` and
// `quoteUri`, and has no `quoteAuthorization` until the Accept arrives; then an Update of the
// Note adds it.
//
//   - each order is answered with an Accept and stored as a quote of the local post, not a
//     reply or a link;
//   - the quoted author gets one activitypub_quote notification that opens the quote post,
//     broadcast on their user channel; the Update and a repeated Create add none;
//   - a quote by an account the author blocks is answered with a Reject and notifies nobody.

import type { SupabaseClient } from '@supabase/supabase-js'

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`
// Mastodon's context extensions for a quote Note (context_extensions :quotes).
const QUOTE_CONTEXT = [AS, {
  quote: { '@id': 'https://w3id.org/fep/044f#quote', '@type': '@id' },
  quoteUri: 'http://fedibird.com/ns#quoteUri',
  _misskey_quote: 'https://misskey-hub.net/ns#_misskey_quote',
  quoteAuthorization: { '@id': 'https://w3id.org/fep/044f#quoteAuthorization', '@type': '@id' },
  QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest',
}]

// Fixed so a failure names a row.
const QUOTED = 'fed00218-0000-0000-0000-000000000001'

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

export interface QuoteNotificationContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    personalInbox: string
    key: { privateKey: string }
    captured: Array<{ method: string; url: string; raw: Buffer }>
  }
  localUrl: string
  instanceDomain: string
  ids: { alice: string; remote: string }
  post: Post
  signedHeaders: Sign
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function poll<T>(read: () => Promise<T>, done: (value: T) => boolean, ms = 8000): Promise<T> {
  const until = Date.now() + ms
  for (;;) {
    const value = await read()
    if (done(value) || Date.now() > until) return value
    await sleep(150)
  }
}

export async function caseQuoteNotifications(ctx: QuoteNotificationContext): Promise<void> {
  console.log('\nquote notifications -> a Mastodon quote of a local post notifies its author')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const quotedApId = `https://${instanceDomain}/posts/${QUOTED}`
  const aliceActor = `https://${instanceDomain}/users/fx_alice`
  const keyId = `${peer.actorUrl}#main-key`
  const peerInboxPath = new URL(peer.personalInbox).pathname

  // The inbox admits 60 deliveries a minute from one signing instance and earlier cases spend
  // the peer's share: a 429 is sent again once the window turns, for at most 75 s.
  const deliver = async (path: string, activity: unknown): Promise<number> => {
    const url = `${localUrl}${path}`
    const body = JSON.stringify(activity)
    for (let attempt = 0; ; attempt++) {
      const { status } = await ctx.post(url, ctx.signedHeaders(url, body, peer.key.privateKey, keyId), body)
      if (status !== 429 || attempt >= 15) return status
      await sleep(5000)
    }
  }

  await db.from('notifications').delete().eq('user_id', ids.alice).eq('type', 'activitypub_quote')
  await db.from('user_blocks').delete().eq('blocker_id', ids.alice).eq('blocked_user_id', ids.remote)
  await db.from('posts').delete().eq('id', QUOTED)
  const seeded = await db.from('posts').insert({
    id: QUOTED, author_id: ids.alice, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'quote this one' }],
  })
  assert(!seeded.error, 'seed the quoted post', seeded.error?.message)

  const note = (n: string, extra: Record<string, unknown> = {}) => ({
    id: `${peer.actorUrl}/statuses/n218-${n}`,
    type: 'Note',
    attributedTo: peer.actorUrl,
    published: new Date().toISOString(),
    to: [PUBLIC],
    cc: [`${peer.actorUrl}/followers`, aliceActor],
    content: `<p>quoting ${n}</p><p class="quote-inline">RE: <a href="${quotedApId}">${quotedApId}</a></p>`,
    quote: quotedApId,
    _misskey_quote: quotedApId,
    quoteUri: quotedApId,
    interactionPolicy: { canQuote: { automaticApproval: [PUBLIC] } },
    ...extra,
  })
  const quoteRequest = (n: string) => ({
    '@context': QUOTE_CONTEXT,
    id: `${peer.actorUrl}#quote_requests/n218-${n}`,
    type: 'QuoteRequest',
    actor: peer.actorUrl,
    object: quotedApId,
    instrument: note(n),
  })
  const create = (n: string) => ({
    '@context': QUOTE_CONTEXT,
    id: `${peer.actorUrl}/statuses/n218-${n}/activity`,
    type: 'Create',
    actor: peer.actorUrl,
    published: new Date().toISOString(),
    to: [PUBLIC],
    cc: [`${peer.actorUrl}/followers`, aliceActor],
    object: note(n),
  })

  /** The answer the peer's user inbox received for a QuoteRequest. */
  const answerTo = async (requestId: string, before: number) => poll(async () => {
    const got = peer.captured.slice(before)
      .filter((c) => c.method === 'POST' && c.url === peerInboxPath)
      .map((c) => JSON.parse(c.raw.toString('utf-8')))
      .find((a) => (a.object?.id ?? a.object) === requestId)
    return got ?? null
  }, (a) => a !== null)

  const storedQuote = (n: string) => poll(async () => {
    const { data } = await db.from('posts').select('id, in_reply_to, metadata, reblog')
      .eq('ap_id', `${peer.actorUrl}/statuses/n218-${n}`).maybeSingle()
    return data as any
  }, (row) => row !== null)

  const quoteNotifications = async (postId: string) => {
    const { data } = await db.from('notifications').select('id, type, data')
      .eq('user_id', ids.alice).eq('type', 'activitypub_quote').eq('data->>post_id', postId)
    return (data ?? []) as any[]
  }

  const broadcastsFor = async (notificationId: string) => {
    const { data, error } = await db.rpc('hmfed_broadcasts', { p_topic: `user:${ids.alice}` })
    if (error) throw new Error(`hmfed_broadcasts: ${error.message}`)
    return ((data ?? []) as any[]).filter((p) => p?.type === 'notification:new' && p.notification?.id === notificationId)
  }

  for (const [n, order] of [['a', ['QuoteRequest', 'Create']], ['b', ['Create', 'QuoteRequest']]] as const) {
    const before = peer.captured.length
    for (const step of order) {
      const status = step === 'QuoteRequest'
        ? await deliver('/users/fx_alice/inbox', quoteRequest(n))
        : await deliver('/inbox', create(n))
      eq(status < 300, true, `${step} ${n} (${order.join(' then ')}) is taken`)
    }

    const answer = await answerTo(`${peer.actorUrl}#quote_requests/n218-${n}`, before)
    eq(answer?.type, 'Accept', `quote ${n}: the QuoteRequest is accepted`)
    const stamp = typeof answer?.result === 'string' ? answer.result : ''
    assert(stamp.startsWith(`${aliceActor}/quote_authorizations/`), `quote ${n}: with a stamp under the quoted author`, stamp)

    const row = await storedQuote(n)
    assert(row !== null, `quote ${n}: the Note is stored`)
    eq(row?.metadata?.is_quote, true, `quote ${n}: as a quote`)
    eq(row?.metadata?.reblog_of, QUOTED, `quote ${n}: of the local post`)
    eq(row?.in_reply_to ?? null, null, `quote ${n}: not as a reply`)
    eq(row?.reblog?.id, QUOTED, `quote ${n}: with the quoted post embedded`)

    const notes = await poll(() => quoteNotifications(row.id), (list) => list.length > 0)
    eq(notes.length, 1, `quote ${n}: the quoted author gets one quote notification`)
    eq(notes[0]?.data?.sender?.username, 'fx_remote', `quote ${n}: by the quoting account`)
    eq(notes[0]?.data?.from_user_id, ids.remote, `quote ${n}: from the quoting account`)
    eq(notes[0]?.data?.quoted_post_id, QUOTED, `quote ${n}: naming the quoted post`)
    eq((await broadcastsFor(notes[0]?.id)).length, 1, `quote ${n}: broadcast once on the author's user channel`)

    const update = {
      '@context': QUOTE_CONTEXT,
      id: `${peer.actorUrl}/statuses/n218-${n}#updates/1`,
      type: 'Update',
      actor: peer.actorUrl,
      to: [PUBLIC],
      object: note(n, { quoteAuthorization: stamp, updated: new Date().toISOString() }),
    }
    eq((await deliver('/inbox', update)) < 300, true, `quote ${n}: the Update carrying the stamp is taken`)
    eq((await deliver('/inbox', create(n))) < 300, true, `quote ${n}: a repeated Create is taken`)
    await sleep(1000)
    eq((await quoteNotifications(row.id)).length, 1, `quote ${n}: the Update and the repeated Create notify no one again`)
  }

  const blocked = await db.from('user_blocks').insert({ blocker_id: ids.alice, blocked_user_id: ids.remote })
  assert(!blocked.error, 'alice blocks the peer\'s user', blocked.error?.message)
  const before = peer.captured.length
  eq((await deliver('/users/fx_alice/inbox', quoteRequest('c'))) < 300, true, 'a blocked account\'s QuoteRequest is taken')
  eq((await deliver('/inbox', create('c'))) < 300, true, 'and its Create')
  const refused = await answerTo(`${peer.actorUrl}#quote_requests/n218-c`, before)
  eq(refused?.type, 'Reject', 'a blocked account\'s quote is rejected')
  await sleep(1500)
  const { data: blockedRow } = await db.from('posts').select('id').eq('ap_id', `${peer.actorUrl}/statuses/n218-c`).maybeSingle()
  eq(blockedRow ? (await quoteNotifications(blockedRow.id)).length : 0, 0, 'and notifies no one')

  await db.from('user_blocks').delete().eq('blocker_id', ids.alice).eq('blocked_user_id', ids.remote)
  await db.from('posts').delete().like('ap_id', `${peer.actorUrl}/statuses/n218-%`)
  await db.from('posts').delete().eq('id', QUOTED)
}
