// Group relay (federation-backend/src/activitypub/groupRelay.ts), three parties each way.
//
// Hosting: this instance hosts the private server. The peer's user (instance B) posts, edits,
// reacts, takes the reaction back and deletes in its general channel through the server's
// inbox. A third instance C, with a member of its own, receives each as the Group's Announce
// of B's activity at its copy of the server, and checks it as a strict receiver does: the
// keyId is the Group's, the Group document this instance serves publishes that key, digest
// and signature verify. B gets none of its own activities back, and an instance D known to
// run Mastodon gets nothing.
//
// Receiving: the peer hosts its private Group, copied here with fx_bob as a member, and
// relays the activities of a user on instance B, signed with the Group's key. This instance
// verifies the Group's signature, reads the Group's members collection signed as fx_bob to
// admit the B user it does not know yet, records the membership, and stores the message,
// the edit, the reaction and its Undo, and the delete; on the copy's inbox and on the shared
// inbox alike. Refused, storing nothing: an Announce in the Group's name signed by a user,
// the Group of another server relaying into this one, a Group not copied here, an actor the
// Group does not list, an actor claiming to be a user of this instance.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const C_MEMBER = 'fed00186-0000-0000-0000-0000000000c1'
const D_MEMBER = 'fed00186-0000-0000-0000-0000000000d1'
const REMOTE_REF2 = 'fed00186-0000-0000-0000-000000000040'
const REMOTE_CHANNEL2 = 'fed00186-0000-0000-0000-000000000041'
const UNKNOWN_GROUP = 'fed00186-0000-0000-0000-0000000000ff'

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

/** Another instance: its users' actor documents, served to any GET, and every POST recorded. */
export class Instance {
  readonly keys = new Map<string, { publicKey: string; privateKey: string }>()
  readonly captured: Captured[] = []
  base = ''
  private server?: http.Server

  constructor(readonly users: string[]) {
    for (const user of users) this.keys.set(user, rsaKeyPair())
  }

  get host() {
    return new URL(this.base).host
  }
  actor(user: string) {
    return `${this.base}/users/${user}`
  }

  async start(hostname: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        if (req.method === 'POST') {
          this.captured.push({ method: 'POST', url: req.url ?? '', headers: req.headers as Record<string, string>, raw: Buffer.concat(chunks) })
          res.writeHead(202, { 'Content-Type': 'application/json' }).end('{}')
          return
        }
        const user = /^\/users\/([^/?]+)$/.exec(req.url ?? '')?.[1]
        const key = user ? this.keys.get(user) : undefined
        if (req.method !== 'GET' || !user || !key) {
          res.writeHead(404).end()
          return
        }
        const id = this.actor(user)
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify({
          '@context': [AS, 'https://w3id.org/security/v1'],
          id,
          type: 'Person',
          preferredUsername: user,
          inbox: `${id}/inbox`,
          endpoints: { sharedInbox: `${this.base}/inbox` },
          publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem: key.publicKey },
        }))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, '0.0.0.0', resolve))
    this.base = `http://${hostname}:${(this.server!.address() as { port: number }).port}`
  }

  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export interface GroupRelayContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraGet?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    bob: string
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

async function waitFor<T>(find: () => T | undefined, ms = 5000): Promise<T | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = find()
    if (got !== undefined || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

const body = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))

export async function caseGroupRelay(ctx: GroupRelayContext): Promise<void> {
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { forgetInstanceSoftware } = await backend('activitypub/instanceSoftware.ts')
  const hostname = new URL(ctx.peer.base).hostname
  const c = new Instance(['fx_relay_c'])
  const d = new Instance(['fx_relay_d'])
  const b = new Instance(['fx_relay_b', 'fx_relay_x'])
  await Promise.all([c.start(hostname), d.start(hostname), b.start(hostname)])
  const previousExtraGet = ctx.peer.extraGet
  try {
    await hosting(ctx, c, d, forgetInstanceSoftware)
    await receiving(ctx, b)
  } finally {
    ctx.peer.extraGet = previousExtraGet
    await ctx.db.from('federated_instances').delete().in('domain', [c.host, d.host])
    forgetInstanceSoftware(c.host)
    forgetInstanceSoftware(d.host)
    await Promise.all([c.stop(), d.stop(), b.stop()])
  }
}

async function hosting(
  ctx: GroupRelayContext,
  c: Instance,
  d: Instance,
  forgetInstanceSoftware: (host?: string) => void,
): Promise<void> {
  console.log('\nGroup relay, hosted here -> a member\'s activities reach a third instance as the Group\'s Announce')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const inbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const copyInbox = `/servers/${ids.hostedServer}/inbox`

  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)
  await db.from('profiles').delete().in('id', [C_MEMBER, D_MEMBER])
  const seeded = await db.from('profiles').insert([C_MEMBER, D_MEMBER].map((id, i) => {
    const instance = i === 0 ? c : d
    const user = i === 0 ? 'fx_relay_c' : 'fx_relay_d'
    return {
      id, username: user, display_name: user, domain: instance.host, is_local: false,
      federated_id: instance.actor(user), inbox_url: `${instance.actor(user)}/inbox`, shared_inbox_url: `${instance.base}/inbox`,
    }
  }))
  assert(!seeded.error, 'seed a member on instance C and one on instance D', seeded.error?.message)
  const joined = await db.from('user_servers').insert([
    { server_id: ids.hostedServer, user_id: C_MEMBER, status: 'accepted', member_instance: c.host },
    { server_id: ids.hostedServer, user_id: D_MEMBER, status: 'accepted', member_instance: d.host },
  ])
  assert(!joined.error, 'both are accepted members of the hosted server', joined.error?.message)
  // C is Harmony and D Mastodon, as an admin records them; neither is asked for NodeInfo.
  const known = await db.from('federated_instances').upsert(
    [{ domain: c.host, software: 'harmony' }, { domain: d.host, software: 'mastodon' }],
    { onConflict: 'domain' },
  )
  assert(!known.error, 'record the software of C and D', known.error?.message)
  forgetInstanceSoftware(c.host)
  forgetInstanceSoftware(d.host)

  const send = async (activity: Record<string, unknown>) => {
    const json = JSON.stringify({ '@context': AS, actor: peer.actorUrl, ...activity })
    return deliver(ctx.post, ctx.signedHeaders, inbox, json, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  }
  const relayOf = (innerId: string) => () =>
    c.captured.find((x) => x.url === copyInbox && body(x).object?.id === innerId)

  const checkRelay = async (activity: Record<string, any>, what: string) => {
    const got = await waitFor(relayOf(activity.id))
    assert(got, `C receives the ${what} at its copy of the server`)
    if (!got) return
    const announce = body(got)
    eq(announce.type, 'Announce', `the ${what} arrives as an Announce`)
    eq(announce.actor, group, 'by the Group')
    assert(JSON.stringify(announce.object) === JSON.stringify({ '@context': AS, actor: peer.actorUrl, ...activity }),
      `of B's ${what} unchanged`, JSON.stringify(announce.object).slice(0, 200))
    assert(JSON.stringify(announce.to) === JSON.stringify([c.actor('fx_relay_c')]), 'addressed to C\'s member', JSON.stringify(announce.to))
    const refusal = await strictReceiverRefusal(got, localUrl, instanceDomain)
    assert(refusal === null, 'a strict receiver verifies it as signed by the Group', refusal)
  }

  const noteId = `${peer.base}/messages/${crypto.randomUUID()}`
  const note = {
    type: 'Note', id: noteId, attributedTo: peer.actorUrl, content: '<p>from B</p>',
    context: `${group}/channels/${ids.hostedChannel}`, 'harmony:serverId': ids.hostedServer,
  }
  const createAct = { id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', object: note }
  eq(await send(createAct), 202, 'B\'s message is taken by the server inbox (202)')
  const row = async () => (await db.from('messages').select('id, content, is_deleted').eq('metadata->>ap_id', noteId).maybeSingle()).data
  assert(await row(), 'the message is stored here')
  await checkRelay(createAct, 'message')

  const updateAct = { id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Update', object: { ...note, content: '<p>edited on B</p>' } }
  eq(await send(updateAct), 202, 'B\'s edit is taken (202)')
  assert(JSON.stringify((await row())?.content ?? '').includes('edited on B'), 'the edit applies here')
  await checkRelay(updateAct, 'edit')

  const message = await row()
  const reactions = async () =>
    (await db.from('reactions').select('custom_emoji_content').eq('message_id', message?.id ?? '').eq('user_id', ids.remote)).data ?? []
  const like = { id: `${peer.actorUrl}/likes/${crypto.randomUUID()}`, type: 'Like', object: noteId, content: '🎉' }
  eq(await send(like), 202, 'B\'s reaction is taken (202)')
  eq((await reactions()).length, 1, 'the reaction is stored here')
  await checkRelay(like, 'reaction')

  const undo = { id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Undo', object: { ...like, actor: peer.actorUrl } }
  eq(await send(undo), 202, 'B takes its reaction back (202)')
  eq((await reactions()).length, 0, 'the reaction is removed here')
  await checkRelay(undo, 'reaction removal')

  const del = { id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Delete', object: noteId }
  eq(await send(del), 202, 'B\'s delete is taken (202)')
  eq((await row())?.is_deleted, true, 'the message is deleted here')
  await checkRelay(del, 'delete')

  const relayedIds = new Set([createAct.id, updateAct.id, like.id, undo.id, del.id])
  const backToB = peer.captured.filter((x) => x.url === copyInbox && relayedIds.has(body(x).object?.id))
  eq(backToB.length, 0, 'B gets none of its own activities back')
  eq(d.captured.length, 0, 'D, known to run Mastodon, is sent nothing')
}

async function receiving(ctx: GroupRelayContext, b: Instance): Promise<void> {
  console.log('\nGroup relay, received here -> the peer\'s Group relays a third instance\'s user')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const peerHost = new URL(peer.base).host
  const userB = b.actor('fx_relay_b')
  const strangerB = b.actor('fx_relay_x')
  const group2 = `${peer.base}/servers/${REMOTE_REF2}`
  const unknownGroup = `${peer.base}/servers/${UNKNOWN_GROUP}`
  const group2Key = rsaKeyPair()
  const unknownKey = rsaKeyPair()

  // The peer serves its Group's members to a signed GET, and two more Groups' documents.
  const memberGets: string[] = []
  const groupDoc = (id: string, publicKeyPem: string) => ({
    '@context': AS, id, type: 'Group', name: 'peer group', inbox: `${id}/inbox`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
  })
  peer.extraGet = (req, res) => {
    const json = (status: number, doc: unknown) => {
      res.writeHead(status, { 'Content-Type': 'application/activity+json' })
      res.end(JSON.stringify(doc))
      return true
    }
    if (req.url === `/servers/${ids.remoteRef}/members?page=1`) {
      memberGets.push(String(req.headers.signature ?? ''))
      if (!req.headers.signature) return json(401, { error: 'signature required' })
      return json(200, {
        '@context': AS, id: `${peer.groupUrl}/members?page=1`, type: 'OrderedCollectionPage',
        orderedItems: [`https://${instanceDomain}/users/fx_bob`, userB],
      })
    }
    if (req.url === `/servers/${REMOTE_REF2}`) return json(200, groupDoc(group2, group2Key.publicKey))
    if (req.url === `/servers/${UNKNOWN_GROUP}`) return json(200, groupDoc(unknownGroup, unknownKey.publicKey))
    return false
  }

  // A second server of the peer, copied here.
  await db.from('servers').delete().eq('id', REMOTE_REF2)
  await db.from('profiles').delete().in('username', ['fx_relay_b', 'fx_relay_x'])
  const copy2 = await db.from('servers').insert({
    id: REMOTE_REF2, name: 'Peer second', owner: ids.alice, public: false, is_local_server: false, federation_enabled: true,
    ap_id: group2, federation_inbox_url: `${group2}/inbox`, federation_domain: peerHost, host_domain: peerHost,
  })
  assert(!copy2.error, 'copy a second server of the peer', copy2.error?.message)
  const ch2 = await db.from('channels').insert({
    id: REMOTE_CHANNEL2, server_id: REMOTE_REF2, name: 'second', type: 0, is_remote: true, ap_id: `${group2}/channels/${REMOTE_CHANNEL2}`,
  })
  assert(!ch2.error, 'with a channel', ch2.error?.message)
  const m2 = await db.from('user_servers').insert({ server_id: REMOTE_REF2, user_id: ids.bob, status: 'accepted', member_instance: instanceDomain })
  assert(!m2.error, 'fx_bob is a member of it', m2.error?.message)

  const copyInbox = (serverId: string) => `${localUrl}/servers/${serverId}/inbox`
  const sharedInbox = `${localUrl}/inbox`
  const announce = (groupUrl: string, inner: Record<string, unknown>) => JSON.stringify({
    '@context': AS, id: `${groupUrl}/relays/${crypto.randomUUID()}`, type: 'Announce', actor: groupUrl, object: inner,
    to: [`https://${instanceDomain}/users/fx_bob`],
  })
  const asGroup = (url: string, json: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, json, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
  const noteBy = (actor: string, extra: Record<string, unknown> = {}) => {
    const id = `${new URL(actor).origin}/messages/${crypto.randomUUID()}`
    return {
      type: 'Note', id, attributedTo: actor, content: '<p>relayed from B</p>',
      context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef, ...extra,
    }
  }
  const createBy = (actor: string, object: Record<string, unknown>) => ({ '@context': AS, id: `${actor}/activities/${crypto.randomUUID()}`, type: 'Create', actor, object })
  const stored = async (noteId: string) =>
    (await db.from('messages').select('id, channel_id, user_id, content, is_deleted').eq('metadata->>ap_id', noteId).maybeSingle()).data

  const note = noteBy(userB)
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, createBy(userB, note))), 202,
    'the Group\'s relay of B\'s message is taken at the copy\'s inbox (202)')
  const row = await stored(note.id as string)
  const { data: profileB } = await db.from('profiles').select('id').eq('federated_id', userB).maybeSingle()
  assert(row && row.channel_id === ids.remoteChannel && row.user_id === profileB?.id,
    'B\'s message is stored in the Group\'s channel, by B\'s user', JSON.stringify(row))
  assert(memberGets.length > 0 && memberGets.every((s) => s.includes(`https://${instanceDomain}/users/fx_bob#main-key`)),
    'the Group\'s members collection was read signed as fx_bob', JSON.stringify(memberGets.map((s) => s.slice(0, 80))))
  const { data: mirrored } = await db.from('user_servers').select('status')
    .eq('server_id', ids.remoteRef).eq('user_id', profileB?.id ?? '').maybeSingle()
  eq(mirrored?.status, 'accepted', 'B\'s user is recorded as a member of the copy')

  const edit = { '@context': AS, id: `${userB}/activities/${crypto.randomUUID()}`, type: 'Update', actor: userB, object: { ...note, content: '<p>edited on B</p>' } }
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, edit)), 202, 'the relayed edit is taken (202)')
  assert(JSON.stringify((await stored(note.id as string))?.content ?? '').includes('edited on B'), 'the edit applies')

  const reactions = async () =>
    (await db.from('reactions').select('custom_emoji_content').eq('message_id', row?.id ?? '').eq('user_id', profileB?.id ?? '')).data ?? []
  const like = { id: `${userB}/likes/${crypto.randomUUID()}`, type: 'Like', actor: userB, object: note.id, content: '🎉' }
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, { '@context': AS, ...like })), 202, 'the relayed reaction is taken (202)')
  eq(JSON.stringify(await reactions()), JSON.stringify([{ custom_emoji_content: '🎉' }]), 'the reaction is stored')
  const undo = { '@context': AS, id: `${userB}/activities/${crypto.randomUUID()}`, type: 'Undo', actor: userB, object: like }
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, undo)), 202, 'the relayed Undo is taken (202)')
  eq((await reactions()).length, 0, 'the reaction is removed')

  const del = { '@context': AS, id: `${userB}/activities/${crypto.randomUUID()}`, type: 'Delete', actor: userB, object: note.id }
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, del)), 202, 'the relayed delete is taken (202)')
  eq((await stored(note.id as string))?.is_deleted, true, 'the message is deleted')

  const viaShared = noteBy(userB)
  eq(await asGroup(sharedInbox, announce(peer.groupUrl, createBy(userB, viaShared))), 202,
    'the Group\'s relay is taken at the shared inbox too (202)')
  assert(await stored(viaShared.id as string), 'and its message is stored')

  // Refused.
  const forged = noteBy(userB)
  const forgedJson = announce(peer.groupUrl, createBy(userB, forged))
  const asUser = (url: string) => deliver(ctx.post, ctx.signedHeaders, url, forgedJson, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  eq(await asUser(copyInbox(ids.remoteRef)), 403, 'an Announce in the Group\'s name signed by a user is refused at the copy\'s inbox (403)')
  eq(await asUser(sharedInbox), 403, 'and at the shared inbox (403)')
  eq(await stored(forged.id as string), null, 'its message is not stored')

  const intoOther = noteBy(userB)
  const relayOther = announce(group2, createBy(userB, intoOther))
  const asGroup2 = (url: string) => deliver(ctx.post, ctx.signedHeaders, url, relayOther, group2Key.privateKey, `${group2}#main-key`)
  eq(await asGroup2(copyInbox(REMOTE_REF2)), 202, 'another server\'s Group relaying into this one is acknowledged at its own copy (202)')
  eq(await asGroup2(copyInbox(ids.remoteRef)), 202, 'and at this server\'s copy (202)')
  eq(await asGroup2(sharedInbox), 202, 'and at the shared inbox (202)')
  eq(await stored(intoOther.id as string), null, 'but stores nothing')

  const fromUnknown = noteBy(userB)
  const relayUnknown = announce(unknownGroup, createBy(userB, fromUnknown))
  const asUnknown = (url: string) => deliver(ctx.post, ctx.signedHeaders, url, relayUnknown, unknownKey.privateKey, `${unknownGroup}#main-key`)
  eq(await asUnknown(copyInbox(UNKNOWN_GROUP)), 202, 'a Group not copied here is acknowledged (202)')
  eq(await asUnknown(sharedInbox), 202, 'at either inbox (202)')
  eq(await stored(fromUnknown.id as string), null, 'and stores nothing')

  const byStranger = noteBy(strangerB)
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, createBy(strangerB, byStranger))), 202,
    'the Group\'s relay of an actor it does not list is acknowledged (202)')
  eq(await stored(byStranger.id as string), null, 'and stores nothing')
  const { data: strangerProfile } = await db.from('profiles').select('id').eq('federated_id', strangerB).maybeSingle()
  const { data: strangerRow } = await db.from('user_servers').select('status')
    .eq('server_id', ids.remoteRef).eq('user_id', strangerProfile?.id ?? '00000000-0000-0000-0000-000000000000').maybeSingle()
  eq(strangerRow, null, 'no membership is recorded for it')

  const aliceUrl = `https://${instanceDomain}/users/fx_alice`
  const asAlice = { ...noteBy(userB), id: `https://${instanceDomain}/messages/${crypto.randomUUID()}`, attributedTo: aliceUrl }
  eq(await asGroup(copyInbox(ids.remoteRef), announce(peer.groupUrl, createBy(aliceUrl, asAlice))), 202,
    'a relay naming a user of this instance is acknowledged (202)')
  eq(await stored(asAlice.id as string), null, 'and stores nothing')

  await db.from('servers').delete().eq('id', REMOTE_REF2)
}
