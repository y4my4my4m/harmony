// Remote follow, poll votes, community follows and thread contexts, round trip against a
// second remote instance (the community host) that serves a Lemmy-style Group, its members
// and a Mastodon-style account, and records what is delivered to it.
//
//   - remote follow: every local account's WebFinger carries the OStatus subscribe template
//     of /authorize_interaction; /lookup-user resolves the account an actor URL names, through
//     WebFinger on its domain, and answers not_actor for a post;
//   - a Lemmy community is looked up by handle and followed: the Follow reaches the Group's
//     inbox signed by the follower, the Group's Accept accepts it;
//   - FEP-1b12: the Group's Announce{Create{Page}} stores the post as its member's, with the
//     content the member's host serves, and as the Group's boost on the follower's home
//     timeline; Lemmy's Announce{Page} of the same post adds no second boost; a comment is a
//     reply of the post and no boost; a relayed vote, a Group nobody follows and a post the
//     member's host does not serve store nothing;
//   - poll votes: a local vote on a remote Question reaches the poll author's inbox as
//     Create{Note{name, inReplyTo}}, to the author alone, signed by the voter; a second vote
//     is refused; the author's Update replaces the counts and a closed poll takes no vote;
//   - FEP-7888: local posts carry context /posts/<root>/context, served as the thread's
//     OrderedCollection; a reply in a thread whose remote root named a context carries it.
//
// WebFinger is https on the account's domain: a TLS proxy container on the stack network
// forwards to the community host (outboundFederation.ts startWebFingerProxy). The federate-*
// jobs the triggers queue are read off pg_notify (JobTap) and run as the worker runs them.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap, startWebFingerProxy } from './outboundFederation.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`
// Host part of the stack subnet's TLS proxy address; outboundFederation.ts takes .200.
const PROXY_OCTET = 201

export interface RemoteInteractionsContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; captured: Array<{ url: string; headers: Record<string, string>; raw: Buffer }> }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  env: Record<string, string>
  ids: { alice: string; aliceAuth: string; bob: string; bobAuth: string; remote: string }
  asUser: (authUserId: string) => SupabaseClient
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
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

interface Delivery {
  url: string
  headers: Record<string, string>
  raw: Buffer
  body: any
}

function keyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * The community host: actors with their own keys, objects served at their ids, WebFinger
 * for the proxy's domain, and every POST recorded.
 */
class CommunityHost {
  readonly keys = new Map<string, ReturnType<typeof keyPair>>()
  readonly actors = new Map<string, Record<string, unknown>>()
  readonly docs = new Map<string, unknown>()
  readonly captured: Delivery[] = []
  base = ''
  proxyDomain = ''
  private server?: http.Server

  url(p: string): string {
    return `${this.base}${p}`
  }

  addActor(p: string, type: string, name: string, extra: Record<string, unknown> = {}): string {
    const id = this.url(p)
    const key = keyPair()
    this.keys.set(id, key)
    this.actors.set(id, {
      '@context': [AS, 'https://w3id.org/security/v1'],
      id,
      type,
      preferredUsername: name,
      name,
      inbox: `${id}/inbox`,
      followers: `${id}/followers`,
      endpoints: { sharedInbox: this.url('/inbox') },
      publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: key.publicKey },
      ...extra,
    })
    return id
  }

  keyOf(actor: string): string {
    return this.keys.get(actor)!.privateKey
  }

  async start(host: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const raw = Buffer.concat(chunks)
        const url = this.url(req.url ?? '')
        if (req.method === 'POST') {
          let body: any = null
          try { body = JSON.parse(raw.toString('utf-8')) } catch { body = null }
          this.captured.push({ url: req.url ?? '', headers: req.headers as Record<string, string>, raw, body })
          res.writeHead(202).end()
          return
        }
        const finger = /^\/\.well-known\/webfinger\?resource=([^&]+)$/.exec(req.url ?? '')
        if (finger) {
          const acct = decodeURIComponent(finger[1]).replace(/^acct:/, '')
          const name = acct.split('@')[0]
          const actor = [...this.actors.values()].find((a) => a.preferredUsername === name && a.webfinger === `acct:${acct}`)
          if (!actor) return void res.writeHead(404).end()
          res.writeHead(200, { 'Content-Type': 'application/jrd+json' })
          res.end(JSON.stringify({ subject: `acct:${acct}`, links: [{ rel: 'self', type: 'application/activity+json', href: actor.id }] }))
          return
        }
        const doc = this.actors.get(url) ?? this.docs.get(url)
        if (!doc) return void res.writeHead(404).end()
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify(doc))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    this.base = `http://${host}:${(this.server!.address() as { port: number }).port}`
  }

  since(n: number): Delivery[] {
    return this.captured.slice(n)
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export async function caseRemoteInteractions(ctx: RemoteInteractionsContext): Promise<void> {
  const { db, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const project = process.env.HMFED_PROJECT ?? 'hmfed'
  const local = (p: string) => `https://${ctx.instanceDomain}${p}`
  const inbox = `${ctx.localUrl}/inbox`
  const alice = ctx.asUser(ctx.ids.aliceAuth)

  const host = new CommunityHost()
  await host.start(new URL(ctx.peer.base).hostname)
  const proxyIp = `${ctx.env.HMFED_SUBNET.split('/')[0].split('.').slice(0, 3).join('.')}.${PROXY_OCTET}`
  const group = host.addActor('/c/fx_tech', 'Group', 'fx_tech', { webfinger: `acct:fx_tech@${proxyIp}` })
  const quiet = host.addActor('/c/fx_quiet', 'Group', 'fx_quiet')
  const ann = host.addActor('/u/fx_ann_lemmy', 'Person', 'fx_ann_lemmy')
  const carol = host.addActor('/u/fx_pollster', 'Person', 'fx_pollster', { webfinger: `acct:fx_pollster@${proxyIp}` })
  const staticPage = host.url('/post/static')
  host.docs.set(staticPage, { id: staticPage, type: 'Page', attributedTo: ann, name: 'static', content: '<p>static</p>', to: [PUBLIC] })

  // Rows of an earlier run on this stack name that run's port; profiles.domain carries none.
  for (const domain of [proxyIp, new URL(host.base).hostname]) {
    await db.from('profiles').delete().in('username', ['fx_tech', 'fx_quiet', 'fx_ann_lemmy', 'fx_pollster']).eq('domain', domain)
  }

  // The inbox admits 60 deliveries a minute from one signing host, shared with the peer: a 429
  // is sent again once the window turns, for at most 75 s.
  const deliver = async (activity: Record<string, unknown>, signer: string) => {
    const body = JSON.stringify({ '@context': AS, ...activity })
    for (let attempt = 0; ; attempt++) {
      const res = await ctx.post(inbox, ctx.signedHeaders(inbox, body, host.keyOf(signer), `${signer}#main-key`), body)
      if (res.status !== 429 || attempt >= 15) return res.status
      await sleep(5000)
    }
  }
  const lookup = async (body: Record<string, unknown>) => {
    const res = await fetch(`${ctx.localUrl}/lookup-user`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })
    return { status: res.status, json: await res.json().catch(() => null) }
  }
  const postBy = async (apId: string) => (await db.from('posts').select('*').eq('ap_id', apId).maybeSingle()).data

  let proxy: { stop: () => void } | null = null
  const tlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED
  const tap = await JobTap.open(project)
  const [{ handleFollowJob }, { handlePollVoteJob }, { handlePostJob }] = await Promise.all([
    backend('queue/handlers/followHandler.ts'),
    backend('queue/handlers/pollVoteHandler.ts'),
    backend('queue/handlers/postHandler.ts'),
  ])

  try {
    proxy = startWebFingerProxy(project, proxyIp, host.base)
    let up = false
    for (let i = 0; i < 50 && !up; i++) {
      up = await new Promise<boolean>((resolve) => {
        const s = net.connect(443, proxyIp, () => { s.end(); resolve(true) })
        s.on('error', () => resolve(false))
      })
      if (!up) await sleep(200)
    }
    assert(up, `the WebFinger proxy answers on ${proxyIp}:443`)
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'

    // REMOTE FOLLOW ------------------------------------------------------------------------
    console.log('\nremote follow -> WebFinger subscribe template, actors by URL')
    const finger = await ctx.get(`${ctx.localUrl}/.well-known/webfinger?resource=${encodeURIComponent(`acct:fx_alice@${ctx.instanceDomain}`)}`)
    const subscribe = finger.json?.links?.find((l: any) => l.rel === 'http://ostatus.org/schema/1.0/subscribe')
    eq(subscribe?.template, local('/authorize_interaction?uri={uri}'), 'a local account\'s WebFinger carries the subscribe template')

    const byUrl = await lookup({ url: carol })
    assert(byUrl.status === 200 && byUrl.json?.user?.federated_id === carol && byUrl.json.user.domain === proxyIp,
      'an actor URL resolves to its account, confirmed through WebFinger on its domain', JSON.stringify(byUrl))
    const again = await lookup({ url: carol })
    eq(again.json?.cached, true, 'a stored actor is answered by its id')
    const local_ = await lookup({ url: local('/social/profile/fx_alice') })
    eq(local_.json?.user?.id, ctx.ids.alice, 'a local profile URL names the local account')
    const notActor = await lookup({ url: staticPage })
    eq(`${notActor.status} ${notActor.json?.kind}`, '404 not_actor', 'a URL that serves no actor is not_actor')

    // COMMUNITY FOLLOW ---------------------------------------------------------------------
    console.log('\ncommunity follow -> Follow, Accept')
    const found = await lookup({ handle: `fx_tech@${proxyIp}` })
    const groupProfile = found.json?.user
    assert(found.status === 200 && groupProfile?.federated_id === group && groupProfile.username === 'fx_tech',
      'the community is looked up by its handle', JSON.stringify(found))
    if (!groupProfile?.id) return
    const groupUrlLookup = await lookup({ url: group })
    eq(groupUrlLookup.json?.user?.id, groupProfile.id, 'the community URL names the same account')

    const followed = await alice.from('follows').insert({ follower_id: ctx.ids.alice, following_id: groupProfile.id }).select('id, status').single()
    if (followed.error) return ctx.fail('fx_alice follows the community', followed.error.message)
    eq(followed.data.status, 'pending', 'a follow of a community waits for its Accept')
    const followJob = await tap.take((j) => j.name === 'federate-follow' && j.data?.follow_id === followed.data.id)
    if (!followJob) return ctx.fail('the follow queues a federate-follow job')
    let before = host.captured.length
    await handleFollowJob(followJob.data)
    const follow = host.since(before).find((d) => d.url === '/c/fx_tech/inbox')
    eq(follow?.body?.type, 'Follow', 'the Follow reaches the Group\'s inbox')
    eq(follow?.body?.object, group, 'the Follow names the Group')
    if (follow) {
      const v = await ctx.verifySignature(follow.headers.signature, follow.headers, 'POST', follow.url, follow.raw)
      eq(v.actorUrl, local('/users/fx_alice'), 'the Follow is signed by the follower')
    }

    eq(await deliver({ id: `${group}/activities/accept/1`, type: 'Accept', actor: group, to: [follow?.body?.actor], object: follow?.body }, group), 202,
      'the Group\'s Accept is taken')
    const accepted = await db.from('follows').select('status').eq('id', followed.data.id).maybeSingle()
    eq(accepted.data?.status, 'accepted', 'the Accept accepts the follow')

    // FEP-1b12 -----------------------------------------------------------------------------
    console.log('\nFEP-1b12 -> Announce{Create{Page}}, Announce{Page}, comments, votes')
    const pageId = host.url(`/post/${crypto.randomUUID()}`)
    const page = {
      id: pageId, type: 'Page', attributedTo: ann, name: 'Rust 2.0 is out', content: '<p>served by the origin</p>',
      to: [group, PUBLIC], cc: [], audience: group, published: new Date().toISOString(),
    }
    host.docs.set(pageId, page)
    const create = (object: any) => ({ id: host.url(`/activities/create/${crypto.randomUUID()}`), type: 'Create', actor: ann, to: [PUBLIC], cc: [group], object })
    const announce = (object: any, actor = group) => ({ id: host.url(`/activities/announce/${crypto.randomUUID()}`), type: 'Announce', actor, to: [PUBLIC], cc: [`${actor}/followers`], object })

    const wrapped = announce(create({ ...page, content: '<p>forged in transit</p>' }))
    eq(await deliver(wrapped, group), 202, 'Announce{Create{Page}} is taken')
    const stored = await postBy(pageId)
    const annProfile = (await db.from('profiles').select('id').eq('federated_id', ann).maybeSingle()).data
    assert(stored && stored.author_id === annProfile?.id, 'the post is stored as its member\'s', JSON.stringify(stored))
    const text = JSON.stringify(stored?.content ?? [])
    assert(text.includes('served by the origin') && !text.includes('forged'), 'the post carries what the member\'s host serves', text)
    const boost = await postBy(wrapped.id)
    assert(boost?.author_id === groupProfile.id && boost?.metadata?.reblog_of === stored?.id, 'the Group boosts the post', JSON.stringify(boost))
    const onTimeline = await db.from('timeline_entries').select('post_id').eq('user_id', ctx.ids.alice).eq('timeline_type', 'home').eq('post_id', boost?.id ?? '')
    eq(onTimeline.data?.length, 1, 'the boost is on the follower\'s home timeline')

    eq(await deliver(announce({ ...page, actor: ann }), group), 202, 'Lemmy\'s Announce{Page} of the same post is taken')
    const boosts = await db.from('posts').select('id').eq('author_id', groupProfile.id).eq('metadata->>reblog_of', stored?.id ?? '')
    eq(boosts.data?.length, 1, 'the second Announce adds no second boost')

    const commentId = host.url(`/comment/${crypto.randomUUID()}`)
    const comment = { id: commentId, type: 'Note', attributedTo: ann, content: '<p>first!</p>', inReplyTo: pageId, to: [PUBLIC], cc: [group], audience: group, published: new Date().toISOString() }
    host.docs.set(commentId, comment)
    eq(await deliver(announce(create(comment)), group), 202, 'Announce{Create{Note}} of a comment is taken')
    const reply = await postBy(commentId)
    eq(reply?.in_reply_to, stored?.id, 'the comment is a reply of the post')
    const commentBoosts = await db.from('posts').select('id').eq('author_id', groupProfile.id).eq('metadata->>reblog_of', reply?.id ?? '')
    eq(commentBoosts.data?.length, 0, 'a comment is not boosted')

    eq(await deliver(announce({ id: `${ann}#like-1`, type: 'Like', actor: ann, object: pageId }), group), 202, 'a relayed vote is acknowledged')
    const likes = await db.from('post_interactions').select('id').eq('post_id', stored?.id ?? '').eq('user_id', annProfile?.id ?? '')
    eq(likes.data?.length, 0, 'a relayed vote is not a favourite')

    const unservedId = host.url(`/post/${crypto.randomUUID()}`)
    await deliver(announce(create({ ...page, id: unservedId })), group)
    eq(await postBy(unservedId), null, 'a post the member\'s host does not serve is not stored')

    const quietId = host.url(`/post/${crypto.randomUUID()}`)
    host.docs.set(quietId, { ...page, id: quietId, to: [quiet, PUBLIC], audience: quiet })
    await deliver(announce(create({ ...page, id: quietId }), quiet), quiet)
    eq(await postBy(quietId), null, 'a community nobody here follows relays nothing')

    // POLL VOTES ---------------------------------------------------------------------------
    console.log('\npoll votes -> Create{Note{name}} to the author, Update Question')
    const questionId = host.url(`/u/fx_pollster/statuses/${crypto.randomUUID()}`)
    const question = (votes: [number, number], extra: Record<string, unknown> = {}) => ({
      id: questionId, type: 'Question', attributedTo: carol, content: '<p>Tea or coffee?</p>', to: [PUBLIC], cc: [],
      published: new Date().toISOString(), endTime: new Date(Date.now() + 86_400_000).toISOString(),
      votersCount: votes[0] + votes[1],
      oneOf: [
        { type: 'Note', name: 'Tea', replies: { type: 'Collection', totalItems: votes[0] } },
        { type: 'Note', name: 'Coffee', replies: { type: 'Collection', totalItems: votes[1] } },
      ],
      ...extra,
    })
    eq(await deliver({ id: `${questionId}/activity`, type: 'Create', actor: carol, to: [PUBLIC], object: question([1, 0]) }, carol), 202,
      'the Create of a Question is taken')
    const poll = await postBy(questionId)
    if (!poll) return ctx.fail('the poll is stored')

    const voted = await alice.rpc('vote_remote_poll', { p_post_id: poll.id, p_choices: [1] })
    assert(!voted.error && voted.data?.poll_options?.[1]?.votes === 1 && voted.data?.poll_voters_count === 2,
      'the vote is counted at once', JSON.stringify(voted))
    const voteJob = await tap.take((j) => j.name === 'federate-poll-vote' && j.data?.post_id === poll.id)
    if (!voteJob) return ctx.fail('the vote queues a federate-poll-vote job')
    before = host.captured.length
    await handlePollVoteJob(voteJob.data)
    const sent = host.since(before)
    eq(sent.length, 1, 'one delivery per answer')
    const vote = sent[0]
    eq(vote?.url, '/u/fx_pollster/inbox', 'the vote reaches the poll author\'s inbox')
    assert(vote?.body?.type === 'Create' && vote.body.object?.type === 'Note' && vote.body.object.name === 'Coffee'
      && vote.body.object.inReplyTo === questionId && vote.body.object.content === undefined,
      'the vote is Create{Note{name, inReplyTo}} with no content', JSON.stringify(vote?.body))
    assert(JSON.stringify(vote?.body?.to) === JSON.stringify([carol]) && vote?.body?.cc === undefined && JSON.stringify(vote?.body?.object?.to) === JSON.stringify([carol]),
      'the vote is addressed to the poll author alone', JSON.stringify(vote?.body))
    if (vote) {
      const v = await ctx.verifySignature(vote.headers.signature, vote.headers, 'POST', vote.url, vote.raw)
      eq(v.actorUrl, local('/users/fx_alice'), 'the vote is signed by the voter')
    }
    const rows = await db.from('post_poll_votes').select('choice, delivered_at').eq('post_id', poll.id)
    assert(rows.data?.length === 1 && rows.data[0].choice === 1 && rows.data[0].delivered_at, 'the vote is recorded delivered', JSON.stringify(rows.data))
    const twice = await alice.rpc('vote_remote_poll', { p_post_id: poll.id, p_choices: [0] })
    assert(String(twice.error?.message ?? '').includes('POLL_ALREADY_VOTED'), 'a second vote is refused', JSON.stringify(twice.error))

    eq(await deliver({ id: `${questionId}#updates/1`, type: 'Update', actor: carol, to: [PUBLIC], object: question([1, 1]) }, carol), 202,
      'the author\'s Update is taken')
    const counted = await postBy(questionId)
    assert(counted?.metadata?.poll_options?.[1]?.votes === 1 && counted?.metadata?.poll_voters_count === 2,
      'the Update replaces the counts', JSON.stringify(counted?.metadata))
    await deliver({ id: `${questionId}#updates/2`, type: 'Update', actor: carol, to: [PUBLIC], object: question([1, 1], { closed: new Date().toISOString() }) }, carol)
    const closed = await ctx.asUser(ctx.ids.bobAuth).rpc('vote_remote_poll', { p_post_id: poll.id, p_choices: [0] })
    assert(String(closed.error?.message ?? '').includes('POLL_CLOSED'), 'a poll its author closed takes no vote', JSON.stringify(closed.error))

    // FEP-7888 -----------------------------------------------------------------------------
    console.log('\nFEP-7888 -> context on local Notes, the thread collection')
    await db.from('follows').delete().eq('follower_id', ctx.ids.remote).eq('following_id', ctx.ids.alice)
    await db.from('follows').insert({ follower_id: ctx.ids.remote, following_id: ctx.ids.alice, status: 'accepted' })
    const runPost = async (postId: string) => {
      const job = await tap.take((j) => j.name === 'federate-post' && j.data?.post_id === postId && j.data?.type === 'create')
      if (!job) return ctx.fail(`the trigger queues a create job for post ${postId}`)
      await handlePostJob(job.data)
    }
    const created = (deliveries: Delivery[], postId: string) => deliveries.find((d) => d.body?.type === 'Create' && String(d.body?.object?.id ?? '').endsWith(postId))

    const root = await alice.from('posts').insert({ author_id: ctx.ids.alice, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'thread root' }] }).select('id, ap_id').single()
    if (root.error) return ctx.fail('fx_alice posts a thread root', root.error.message)
    const peerBefore = ctx.peer.captured.length
    await runPost(root.data.id)
    const replyRow = await alice.from('posts').insert({
      author_id: ctx.ids.alice, visibility: 'public', is_local: true, in_reply_to: root.data.id, content: [{ type: 'text', text: 'thread reply' }],
    }).select('id, ap_id').single()
    if (replyRow.error) return ctx.fail('fx_alice replies in the thread', replyRow.error.message)
    await runPost(replyRow.data.id)
    const toPeer = ctx.peer.captured.slice(peerBefore).map((c) => ({ ...c, body: JSON.parse(c.raw.toString('utf-8')) }))
    const contextUrl = local(`/posts/${root.data.id}/context`)
    eq(created(toPeer, root.data.id)?.body?.object?.context, contextUrl, 'a root post carries its thread\'s context')
    eq(created(toPeer, replyRow.data.id)?.body?.object?.context, contextUrl, 'a reply carries its root\'s context')

    const collection = await ctx.get(`${ctx.localUrl}/posts/${root.data.id}/context`)
    assert(collection.status === 200 && collection.json?.type === 'OrderedCollection' && collection.json.id === contextUrl
      && collection.json.totalItems === 2 && collection.json.attributedTo === local('/users/fx_alice'),
      'the context is an OrderedCollection of the thread, owned by the root\'s author', JSON.stringify(collection.json))
    const firstPage = await ctx.get(`${ctx.localUrl}/posts/${root.data.id}/context?page=1`)
    eq(JSON.stringify(firstPage.json?.orderedItems), JSON.stringify([
      root.data.ap_id || local(`/posts/${root.data.id}`),
      replyRow.data.ap_id || local(`/posts/${replyRow.data.id}`),
    ]), 'the first page lists the root, then the reply')
    eq((await ctx.get(`${ctx.localUrl}/posts/${replyRow.data.id}/context`)).status, 404, 'a reply serves no context of its own')

    const remoteRootId = host.url(`/u/fx_pollster/statuses/${crypto.randomUUID()}`)
    const remoteContext = host.url('/contexts/9')
    eq(await deliver({
      id: `${remoteRootId}/activity`, type: 'Create', actor: carol, to: [PUBLIC],
      object: { id: remoteRootId, type: 'Note', attributedTo: carol, content: '<p>remote root</p>', context: remoteContext, to: [PUBLIC], cc: [], published: new Date().toISOString() },
    }, carol), 202, 'a remote Note with a context is taken')
    const remoteRoot = await postBy(remoteRootId)
    eq(remoteRoot?.metadata?.ap_context, remoteContext, 'the Note\'s context is kept')
    const localReply = await alice.from('posts').insert({
      author_id: ctx.ids.alice, visibility: 'public', is_local: true, in_reply_to: remoteRoot?.id, content: [{ type: 'text', text: 'reply to a remote root' }],
    }).select('id').single()
    if (localReply.error) return ctx.fail('fx_alice replies to the remote root', localReply.error.message)
    const hostBefore = host.captured.length
    const peerBefore2 = ctx.peer.captured.length
    await runPost(localReply.data.id)
    const replyCreate = created([
      ...host.since(hostBefore),
      ...ctx.peer.captured.slice(peerBefore2).map((c) => ({ ...c, body: JSON.parse(c.raw.toString('utf-8')) })),
    ], localReply.data.id)
    eq(replyCreate?.body?.object?.context, remoteContext, 'a local reply carries the context its remote root named')
  } catch (e) {
    ctx.fail('remote interactions', (e as Error)?.stack ?? e)
  } finally {
    if (tlsSetting === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED
    else process.env.NODE_TLS_REJECT_UNAUTHORIZED = tlsSetting
    proxy?.stop()
    tap.close()
    await db.from('follows').delete().eq('follower_id', ctx.ids.remote).eq('following_id', ctx.ids.alice)
    await host.stop()
  }
}
