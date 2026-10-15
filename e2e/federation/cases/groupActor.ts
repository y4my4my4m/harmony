// Group actor activities, both directions. A receiver takes an activity only from the owner
// of the key that signed it (InboxHandler, GroupService), so the Group's own activities are
// signed with the Group's key.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - the peer's second user joins with an invite and is answered at its inbox by an Accept
//     whose actor is the Group;
//   - a channel Update and a message Delete reach the peer's shared inbox as the Group's.
// Each is checked as a receiver checks it: the keyId names the actor, the actor document
// served by this instance publishes that key, the digest and signature verify.
//
// Hosted by the peer (its private Group, signing with its own key):
//   - an Accept of fx_carol's pending Join, signed by the peer's user instead, is refused 403
//     and leaves the membership pending; signed by the Group it accepts the membership;
//   - the Group's Delete removes a message in its channel, by its id on the peer or on this
//     instance, and no message in a channel of another server.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const INVITE = 'hmfed-group-actor'
const HOSTED_MESSAGE = 'fed00183-0000-0000-0000-000000000001'
const MIRRORED_PEER = 'fed00183-0000-0000-0000-000000000002'
const MIRRORED_OWN = 'fed00183-0000-0000-0000-000000000003'
const ELSEWHERE = 'fed00183-0000-0000-0000-000000000004'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface GroupActorContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    strangerUrl: string
    groupUrl: string
    key: { privateKey: string }
    strangerKey: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    bob: string
    carol: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

function parseSignatureHeader(signature: string): Record<string, string> {
  const parts: Record<string, string> = {}
  const re = /([A-Za-z0-9]+)\s*=\s*(?:"([^"]*)"|([^,]*))/g
  let m: RegExpExecArray | null
  while ((m = re.exec(signature)) !== null) parts[m[1]] = m[2] !== undefined ? m[2] : (m[3] ?? '').trim()
  return parts
}

function getJson(url: string): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url)
    http
      .get({ host: u.hostname, port: u.port, path: `${u.pathname}${u.search}`, headers: { Accept: 'application/activity+json' } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')))
          } catch (e) {
            reject(e)
          }
        })
      })
      .on('error', reject)
  })
}

/**
 * Null when the delivery passes a strict receiver: draft-cavage over (request-target), host,
 * date and digest; the digest matches the body; the keyId's owner is activity.actor; the
 * actor document, fetched from this instance, publishes that keyId owned by the actor; the
 * signature verifies against it. Otherwise the reason.
 */
export async function strictReceiverRefusal(c: Captured, localUrl: string, instanceDomain: string): Promise<string | null> {
  const body = JSON.parse(c.raw.toString('utf-8'))
  const params = parseSignatureHeader(c.headers.signature ?? '')
  if (params.headers !== '(request-target) host date digest') return `signed headers ${params.headers}`
  const digest = `SHA-256=${crypto.createHash('sha256').update(c.raw).digest('base64')}`
  if (c.headers.digest !== digest) return 'digest does not match the body'
  const keyOwner = (params.keyId ?? '').split('#')[0]
  if (keyOwner !== body.actor) return `signed by ${keyOwner}, actor is ${body.actor}`
  if (!keyOwner.startsWith(`https://${instanceDomain}/`)) return `key ${params.keyId} is not on this instance`
  const doc = await getJson(keyOwner.replace(`https://${instanceDomain}`, localUrl))
  const key = doc?.publicKey
  if (doc?.id !== keyOwner || key?.id !== params.keyId || key?.owner !== keyOwner || !key?.publicKeyPem) {
    return `actor document does not publish ${params.keyId}: ${JSON.stringify(key ?? null)}`
  }
  const signingString = [
    `(request-target): post ${c.url}`,
    `host: ${c.headers.host}`,
    `date: ${c.headers.date}`,
    `digest: ${digest}`,
  ].join('\n')
  return crypto.createVerify('SHA256').update(signingString).verify(key.publicKeyPem, params.signature, 'base64')
    ? null
    : 'signature does not verify against the published key'
}

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>

/**
 * A signed delivery. The inbox admits 60 a minute from one signing instance
 * (instanceInboxLimit) and the earlier cases spend the peer's share: a 429 is sent again
 * once the window turns, for at most 75 s.
 */
export async function deliver(post: Post, sign: Sign, url: string, body: string, privateKey: string, keyId: string): Promise<number> {
  for (let attempt = 0; ; attempt++) {
    const { status } = await post(url, sign(url, body, privateKey, keyId), body)
    if (status !== 429 || attempt >= 15) return status
    await new Promise((r) => setTimeout(r, 5000))
  }
}

async function waitFor<T>(find: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = find()
    if (got !== undefined || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function caseGroupActor(ctx: GroupActorContext): Promise<void> {
  console.log('\nGroup actor -> Join answers, channel and message activities signed with the Group\'s key')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const since = (n: number, url: string, type: string) => () =>
    peer.captured.slice(n).find((c) => c.url === url && JSON.parse(c.raw.toString('utf-8')).type === type)

  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)
  await db.from('invites').delete().eq('code', INVITE)
  const invite = await db.from('invites').insert({ code: INVITE, server_id: ids.hostedServer, created_by: ids.alice, max_uses: 1 })
  assert(!invite.error, 'seed an invite to the hosted server', invite.error?.message)

  // The peer's second user joins the hosted private server.
  const join = JSON.stringify({
    '@context': AS,
    id: `${peer.strangerUrl}/activities/join-${crypto.randomUUID()}`,
    type: 'Join',
    actor: peer.strangerUrl,
    object: group,
    'harmony:inviteCode': INVITE,
  })
  const serverInbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  let n = peer.captured.length
  const send = (url: string, body: string, privateKey: string, actor: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, body, privateKey, `${actor}#main-key`)
  eq(await send(serverInbox, join, peer.strangerKey.privateKey, peer.strangerUrl), 202, 'the Join is taken (202)')
  const strangerInbox = new URL(`${peer.strangerUrl}/inbox`).pathname
  const accept = await waitFor(since(n, strangerInbox, 'Accept'))
  assert(accept, 'the Join is answered with an Accept at the joiner\'s inbox')
  if (accept) {
    eq(JSON.parse(accept.raw.toString('utf-8')).actor, group, 'the Accept is the Group\'s')
    const refusal = await strictReceiverRefusal(accept, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver takes it: signed with the key the Group publishes', refusal)
  }
  const { data: stranger } = await db.from('profiles').select('id').eq('federated_id', peer.strangerUrl).maybeSingle()
  const { data: membership } = await db.from('user_servers').select('status')
    .eq('server_id', ids.hostedServer).eq('user_id', stranger?.id ?? '').maybeSingle()
  eq(membership?.status, 'accepted', 'the joiner is an accepted member')

  // A channel Update and a message Delete reach the peer's shared inbox as the Group's.
  const { handleChannelUpdated } = await backend('listeners/DatabaseListener.ts')
  n = peer.captured.length
  await handleChannelUpdated({
    id: ids.hostedChannel, server_id: ids.hostedServer, name: 'general', description: 'renamed topic', type: 0, order: 0, category: null,
  }, {})
  const update = await waitFor(since(n, '/inbox', 'Update'))
  assert(update, 'the channel Update reaches the peer\'s shared inbox')
  if (update) {
    const body = JSON.parse(update.raw.toString('utf-8'))
    eq(body.actor, group, 'the Update is the Group\'s')
    eq(body.object?.id, `${group}/channels/${ids.hostedChannel}`, 'naming the channel')
    const refusal = await strictReceiverRefusal(update, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver takes the Update', refusal)
  }

  await db.from('messages').delete().in('id', [HOSTED_MESSAGE, MIRRORED_PEER, MIRRORED_OWN, ELSEWHERE])
  const seeded = await db.from('messages').insert({
    id: HOSTED_MESSAGE, channel_id: ids.hostedChannel, user_id: ids.alice, content: [{ type: 'text', text: 'moderated away' }],
  })
  assert(!seeded.error, 'seed a hosted channel message', seeded.error?.message)
  const { handleChannelMessageDelete } = await backend('listeners/ChannelMessageHandler.ts')
  n = peer.captured.length
  await handleChannelMessageDelete({ message_id: HOSTED_MESSAGE, channel_id: ids.hostedChannel, server_id: ids.hostedServer })
  const deletion = await waitFor(since(n, '/inbox', 'Delete'))
  assert(deletion, 'the message Delete reaches the peer\'s shared inbox')
  if (deletion) {
    const body = JSON.parse(deletion.raw.toString('utf-8'))
    eq(body.actor, group, 'the Delete is the Group\'s')
    eq(body.object, `https://${instanceDomain}/messages/${HOSTED_MESSAGE}`, 'naming the message')
    const refusal = await strictReceiverRefusal(deletion, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver takes the Delete', refusal)
  }

  // The peer's Group answers fx_carol's pending Join.
  await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.carol)
  const pending = await db.from('user_servers').insert({
    server_id: ids.remoteRef, user_id: ids.carol, status: 'pending', member_instance: instanceDomain,
  })
  assert(!pending.error, 'fx_carol\'s Join of the peer\'s Group is pending', pending.error?.message)
  const carolUrl = `https://${instanceDomain}/users/fx_carol`
  const carolInbox = `${localUrl}/users/fx_carol/inbox`
  const answer = (id: string) => JSON.stringify({
    '@context': AS,
    id: `${peer.groupUrl}/activities/${id}`,
    type: 'Accept',
    actor: peer.groupUrl,
    object: { type: 'Join', id: `${carolUrl}/activities/join-183`, actor: carolUrl, object: peer.groupUrl },
  })
  const carolStatus = async () => (await db.from('user_servers').select('status')
    .eq('server_id', ids.remoteRef).eq('user_id', ids.carol).maybeSingle()).data?.status

  const forged = answer('accept-by-user')
  eq(await send(carolInbox, forged, peer.key.privateKey, peer.actorUrl), 403,
    'an Accept by the Group signed with a member\'s key is refused (403)')
  eq(await carolStatus(), 'pending', 'and leaves the membership pending')

  const genuine = answer('accept-by-group')
  eq(await send(carolInbox, genuine, peer.groupKey.privateKey, peer.groupUrl), 202,
    'the Accept signed with the Group\'s key is taken (202)')
  eq(await carolStatus(), 'accepted', 'fx_carol is an accepted member of the peer\'s Group')

  // The peer's Group deletes messages in its channel.
  const peerMessageUrl = `${peer.base}/messages/${MIRRORED_PEER}`
  const mirrored = await db.from('messages').insert([
    { id: MIRRORED_PEER, channel_id: ids.remoteChannel, user_id: ids.remote, content: [{ type: 'text', text: 'peer wrote' }], metadata: { ap_id: peerMessageUrl } },
    { id: MIRRORED_OWN, channel_id: ids.remoteChannel, user_id: ids.bob, content: [{ type: 'text', text: 'bob wrote' }] },
    { id: ELSEWHERE, channel_id: ids.hostedChannel, user_id: ids.remote, content: [{ type: 'text', text: 'not the Group\'s' }], metadata: { ap_id: `${peer.base}/messages/${ELSEWHERE}` } },
  ])
  assert(!mirrored.error, 'seed messages in the peer\'s channel and in the hosted one', mirrored.error?.message)

  const groupDelete = async (object: string) => {
    const body = JSON.stringify({
      '@context': AS,
      id: `${peer.groupUrl}/activities/delete-${crypto.randomUUID()}`,
      type: 'Delete',
      actor: peer.groupUrl,
      object,
    })
    return send(`${localUrl}/inbox`, body, peer.groupKey.privateKey, peer.groupUrl)
  }
  const isDeleted = async (id: string) =>
    (await db.from('messages').select('is_deleted').eq('id', id).maybeSingle()).data?.is_deleted === true

  eq(await groupDelete(peerMessageUrl), 202, 'the Group\'s Delete of a message by the peer\'s user is taken (202)')
  eq(await isDeleted(MIRRORED_PEER), true, 'the message is deleted')
  eq(await groupDelete(`https://${instanceDomain}/messages/${MIRRORED_OWN}`), 202,
    'the Group\'s Delete of fx_bob\'s message, by its id here, is taken (202)')
  eq(await isDeleted(MIRRORED_OWN), true, 'fx_bob\'s message in the Group\'s channel is deleted')
  eq(await groupDelete(`${peer.base}/messages/${ELSEWHERE}`), 202, 'the Group\'s Delete of a hosted message is acknowledged (202)')
  eq(await isDeleted(ELSEWHERE), false, 'and deletes nothing outside the Group\'s channels')
}
