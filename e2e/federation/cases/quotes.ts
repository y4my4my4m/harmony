// FEP-044f quotes (Mastodon 4.5) against the peer.
//
//   - a local public post's Note advertises canQuote for the public;
//   - the peer's QuoteRequest for it, signed by its user, is answered at that user's inbox
//     with an Accept whose result is a QuoteAuthorization this instance serves to anyone;
//   - a QuoteRequest for a direct post is answered with a Reject and no stamp;
//   - a remote post is served by its origin: /posts/<id> of a stored peer post redirects
//     there, and a replies page lists ids, never Notes attributed to this host.

import type { SupabaseClient } from '@supabase/supabase-js'

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`

// Fixed so a failure names a row.
const QUOTED_PUBLIC = 'fed00177-0000-0000-0000-000000000001'
const QUOTED_DIRECT = 'fed00177-0000-0000-0000-000000000002'
const PEER_POST = 'fed00177-0000-0000-0000-000000000003'

export interface QuotesContext {
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
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const AP_ACCEPT = { Accept: 'application/activity+json' }

export async function caseQuotes(ctx: QuotesContext): Promise<void> {
  console.log('\nquotes -> FEP-044f policy, QuoteRequest answered with a stamp or a Reject')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const apId = (id: string) => `https://${instanceDomain}/posts/${id}`
  const peerInboxPath = new URL(peer.personalInbox).pathname

  await db.from('posts').delete().in('id', [QUOTED_PUBLIC, QUOTED_DIRECT, PEER_POST])
  const seeded = await db.from('posts').insert([
    { id: QUOTED_PUBLIC, author_id: ids.alice, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'quote me' }] },
    { id: QUOTED_DIRECT, author_id: ids.alice, visibility: 'direct', is_local: true, content: [{ type: 'text', text: 'not this one' }] },
    {
      id: PEER_POST, author_id: ids.remote, visibility: 'public', is_local: false, in_reply_to: QUOTED_PUBLIC,
      ap_id: `${peer.actorUrl}/statuses/177`, content: [{ type: 'text', text: 'a peer reply' }],
    },
  ])
  assert(!seeded.error, 'seed the quoted posts', seeded.error?.message)

  const note = await fetch(`${localUrl}/posts/${QUOTED_PUBLIC}`, { headers: AP_ACCEPT }).then((r) => r.json())
  eq(JSON.stringify(note.interactionPolicy?.canQuote?.automaticApproval), JSON.stringify([PUBLIC]),
    'a public post advertises canQuote for the public')

  const request = async (postId: string, n: number) => {
    const quoteNote = `${peer.actorUrl}/statuses/q${n}`
    const activity = {
      '@context': [AS, { QuoteRequest: 'https://w3id.org/fep/044f#QuoteRequest' }],
      id: `${quoteNote}/quote`,
      type: 'QuoteRequest',
      actor: peer.actorUrl,
      object: apId(postId),
      instrument: { type: 'Note', id: quoteNote, attributedTo: peer.actorUrl, to: [PUBLIC], content: '<p>quoting</p>', quote: apId(postId) },
    }
    const body = JSON.stringify(activity)
    const target = `${localUrl}/inbox`
    const before = peer.captured.length
    const res = await ctx.post(target, ctx.signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)
    eq(res.status < 300, true, `the QuoteRequest for ${postId === QUOTED_PUBLIC ? 'the public' : 'the direct'} post is taken`)
    let answer: any = null
    for (let i = 0; i < 50 && !answer; i++) {
      const got = peer.captured.slice(before).find((c) => c.method === 'POST' && c.url === peerInboxPath)
      if (got) answer = JSON.parse(got.raw.toString('utf-8'))
      else await new Promise((r) => setTimeout(r, 100))
    }
    return { answer, quoteNote, requestId: activity.id }
  }

  const accepted = await request(QUOTED_PUBLIC, 1)
  eq(accepted.answer?.type, 'Accept', 'the public post\'s quote is accepted')
  eq(accepted.answer?.actor, `https://${instanceDomain}/users/fx_alice`, 'by the quoted author')
  eq(accepted.answer?.object?.id, accepted.requestId, 'the Accept names the QuoteRequest')
  const stamp = String(accepted.answer?.result ?? '')
  assert(new RegExp(`^https://${instanceDomain.replace(/\./g, '\\.')}/users/fx_alice/quote_authorizations/[0-9a-f-]{36}$`).test(stamp),
    'the result is a stamp under the quoted author', stamp)
  const stored = await db.from('quote_authorizations').select('quoting_post_uri, quoting_actor_uri').eq('quoted_post_id', QUOTED_PUBLIC)
  eq(JSON.stringify(stored.data), JSON.stringify([{ quoting_post_uri: accepted.quoteNote, quoting_actor_uri: peer.actorUrl }]),
    'one stamp is stored for the quote')

  const stampPath = stamp.replace(`https://${instanceDomain}`, '')
  const served = await fetch(`${localUrl}${stampPath}`, { headers: AP_ACCEPT })
  eq(served.status, 200, 'the stamp is served unsigned')
  const doc = served.status === 200 ? await served.json() : null
  eq(doc?.type, 'QuoteAuthorization', 'as a QuoteAuthorization')
  eq(doc?.interactingObject, accepted.quoteNote, 'naming the quote post')
  eq(doc?.interactionTarget, apId(QUOTED_PUBLIC), 'and the quoted post')

  const rejected = await request(QUOTED_DIRECT, 2)
  eq(rejected.answer?.type, 'Reject', 'a direct post\'s quote is rejected')
  const none = await db.from('quote_authorizations').select('id').eq('quoted_post_id', QUOTED_DIRECT)
  eq(none.data?.length, 0, 'and no stamp is stored')

  const remote = await fetch(`${localUrl}/posts/${PEER_POST}`, { headers: AP_ACCEPT, redirect: 'manual' })
  eq(remote.status, 302, 'a stored peer post is not served here')
  eq(remote.headers.get('location'), `${peer.actorUrl}/statuses/177`, 'it redirects to its origin')

  const replies = await fetch(`${localUrl}/posts/${QUOTED_PUBLIC}/replies?page=1`, { headers: AP_ACCEPT }).then((r) => r.json())
  eq(JSON.stringify(replies.orderedItems), JSON.stringify([`${peer.actorUrl}/statuses/177`]),
    'the replies page lists the peer reply by its id')

  await db.from('posts').delete().in('id', [QUOTED_PUBLIC, QUOTED_DIRECT, PEER_POST])
}
