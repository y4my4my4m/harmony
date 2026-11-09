// Fields of a federated document that claim more than the document's author may say.
//
// Group documents:
//   - a document on a Group's host naming that Group's id, served at another path, makes no copy
//     from what it says: the Group's own document decides, and a Join goes to the Group's inbox;
//   - a document naming an id that serves nothing joins nothing;
//   - a Group listing the server and channel ids of another Group first does not cut that Group
//     off: its copy gets an id of its own and its other channels, its own and relayed messages
//     land there, and a member's message leaves for it. The channel listed first stays with the
//     row that holds it and takes nothing from the other Group.
//
// Notes:
//   - array `content` on a channel message is held to what harmony:rawContent is: no storage
//     path, no poll, mention locality re-derived;
//   - a direct message's attributedTo names nothing: domain and spam record are the actor's.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Another instance serving the documents it is given, every POST recorded by path. */
class Host {
  readonly key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  base = ''
  docs = new Map<string, unknown>()
  posts: Array<{ path: string; body: any }> = []
  private server?: http.Server

  actor(user: string) {
    return `${this.base}/users/${user}`
  }
  /** A Group document; `over` replaces any field. */
  group(id: string, name: string, channels: Array<{ id: string; name: string }>, over: Record<string, unknown> = {}) {
    const url = `${this.base}/servers/${id}`
    return {
      '@context': [AS, 'https://w3id.org/security/v1'],
      id: url,
      type: 'Group',
      name,
      preferredUsername: name.replace(/\W/g, ''),
      inbox: `${url}/inbox`,
      outbox: `${url}/outbox`,
      publicKey: { id: `${url}#main-key`, owner: url, publicKeyPem: this.key.publicKey },
      'harmony:channels': channels.map((c) => ({
        id: `${url}/channels/${c.id}`, localId: c.id, name: c.name, type: 'harmony:TextChannel',
      })),
      ...over,
    }
  }

  async start(hostname: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => {
        const url = req.url ?? ''
        if (req.method === 'POST') {
          const raw = Buffer.concat(chunks).toString('utf-8')
          this.posts.push({ path: url, body: raw ? JSON.parse(raw) : null })
          res.writeHead(202)
          res.end()
          return
        }
        const user = /^\/users\/([a-z_]+)$/.exec(url)?.[1]
        const doc = user
          ? {
              '@context': [AS, 'https://w3id.org/security/v1'],
              id: this.actor(user),
              type: 'Person',
              preferredUsername: user,
              inbox: `${this.actor(user)}/inbox`,
              endpoints: { sharedInbox: `${this.base}/inbox` },
              publicKey: { id: `${this.actor(user)}#main-key`, owner: this.actor(user), publicKeyPem: this.key.publicKey },
            }
          : this.docs.get(url)
        if (!doc) {
          res.writeHead(404)
          res.end()
          return
        }
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify(doc))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, hostname, () => resolve()))
    this.base = `http://${hostname}:${(this.server.address() as { port: number }).port}`
  }
  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export interface ClaimedFieldsContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  bearer: (authUserId: string) => string
  asUser: (authUserId: string) => SupabaseClient
  ids: { bob: string; bobAuth: string; remote: string; hostedServer: string; hostedChannel: string }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseClaimedFields(ctx: ClaimedFieldsContext): Promise<void> {
  console.log('\nClaimed fields -> a federated document says only what its author may say')
  const { db, peer, ids, localUrl, assert, eq } = ctx
  const D = ctx.instanceDomain
  const hostname = new URL(peer.base).hostname
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)

  const real = new Host()
  const evil = new Host()
  await Promise.all([real.start(hostname), evil.start(hostname)])

  const sharedInbox = `${localUrl}/inbox`
  const send = (url: string, activity: Record<string, unknown>, key: string, keyActor: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, JSON.stringify({ '@context': AS, ...activity }), key, `${keyActor}#main-key`)
  const join = async (serverUrl: string) =>
    ctx.post(`${localUrl}/servers/join`, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}`,
    }, JSON.stringify({ serverUrl, userId: ids.bob }))
  const copyOf = async (apId: string) =>
    (await db.from('servers').select('id, name, federation_inbox_url').eq('ap_id', apId).maybeSingle()).data as any
  const channelsOf = async (serverId: string | undefined) =>
    ((await db.from('channels').select('id, ap_id').eq('server_id', serverId ?? '')).data ?? []) as any[]

  const madeServers: string[] = []
  const madeProfiles: string[] = []
  try {
    // A document on the Group's host naming the Group's id --------------------------------------
    const forgedId = crypto.randomUUID()
    const forgedChannel = crypto.randomUUID()
    const realChannel = crypto.randomUUID()
    const forgedGroup = `${real.base}/servers/${forgedId}`
    real.docs.set(`/servers/${forgedId}`, real.group(forgedId, 'Real name', [{ id: realChannel, name: 'real' }]))
    real.docs.set('/uploads/forged.json', real.group(forgedId, 'Forged name', [{ id: forgedChannel, name: 'forged' }], {
      inbox: `${real.base}/uploads/inbox`,
    }))
    const viaForged = await join(`${real.base}/uploads/forged.json`)
    assert(viaForged.status < 500, 'a join through a document at another path answers', viaForged)
    await sleep(300)
    const forgedCopy = await copyOf(forgedGroup)
    if (forgedCopy) madeServers.push(forgedCopy.id)
    eq(forgedCopy?.name, 'Real name', 'the copy has the name the Group\'s own document gives')
    eq(forgedCopy?.federation_inbox_url, `${forgedGroup}/inbox`, 'and its inbox')
    const forgedChannels = (await channelsOf(forgedCopy?.id)).map((c) => c.id)
    assert(forgedChannels.includes(realChannel), 'and its channels', forgedChannels)
    assert(!forgedChannels.includes(forgedChannel), 'not the ones the other document lists', forgedChannels)
    assert(!real.posts.some((p) => p.path === '/uploads/inbox'), 'and no Join goes to the path it names')

    const noCanonical = crypto.randomUUID()
    real.docs.set('/uploads/dangling.json', real.group(noCanonical, 'Dangling', []))
    await join(`${real.base}/uploads/dangling.json`)
    await sleep(200)
    const dangling = await copyOf(`${real.base}/servers/${noCanonical}`)
    if (dangling) madeServers.push(dangling.id)
    eq(dangling, null, 'a document naming an id that serves nothing makes no copy')

    // A Group listing another Group's channel id ------------------------------------------------
    const groupId = crypto.randomUUID()
    const shared = crypto.randomUUID()
    const own = crypto.randomUUID()
    const realGroup = `${real.base}/servers/${groupId}`
    const evilGroup = `${evil.base}/servers/${groupId}`
    evil.docs.set(`/servers/${groupId}`, evil.group(groupId, 'Squatter', [{ id: shared, name: 'squat' }]))
    real.docs.set(`/servers/${groupId}`, real.group(groupId, 'Squatted', [{ id: shared, name: 'general' }, { id: own, name: 'other' }]))
    await join(evilGroup)
    await sleep(200)
    const evilCopy = await copyOf(evilGroup)
    if (evilCopy) madeServers.push(evilCopy.id)
    assert(evilCopy, 'a Group is copied under its uuid')
    await join(realGroup)
    await sleep(300)
    const realCopy = await copyOf(realGroup)
    if (realCopy) madeServers.push(realCopy.id)
    assert(realCopy, 'the Group whose uuid another took is copied too', realCopy)
    const realChannels = await channelsOf(realCopy?.id)
    console.log(`  note  copy id reused: ${realCopy?.id === groupId}, channels: ${realChannels.map((c) => c.ap_id).join(', ') || 'none'}`)
    assert(realChannels.some((c) => c.ap_id === `${realGroup}/channels/${own}`), 'with the channel no one else lists', realChannels)
    assert(!realChannels.some((c) => c.ap_id === `${realGroup}/channels/${shared}`), 'the one listed first stays with the row holding it', realChannels)
    eq((await db.from('channels').select('server_id').eq('id', shared).maybeSingle()).data?.server_id, evilCopy?.id, 'and is not moved')

    const groupUpdate = await send(sharedInbox, {
      id: `${realGroup}/activities/${crypto.randomUUID()}`,
      type: 'Update',
      actor: realGroup,
      object: { id: realGroup, type: 'Group', name: 'Renamed by its Group' },
    }, real.key.privateKey, realGroup)
    eq(groupUpdate, 202, 'the Group\'s Update is taken (202)')
    await sleep(300)
    eq((await copyOf(realGroup))?.name, 'Renamed by its Group', 'and applies to its copy')
    assert((await copyOf(evilGroup))?.name !== 'Renamed by its Group', 'not to the row holding its uuid')

    const groupSays = async (group: string, host: Host, channel: string, text: string) => {
      const id = crypto.randomUUID()
      const status = await send(sharedInbox, {
        id: `${group}/activities/${crypto.randomUUID()}`,
        type: 'Create',
        actor: group,
        object: {
          type: 'Note',
          id: `${host.base}/messages/${id}`,
          attributedTo: group,
          content: text,
          context: `${group}/channels/${channel}`,
          published: new Date().toISOString(),
          'harmony:serverId': groupId,
          'harmony:author': { kind: 'webhook', id: crypto.randomUUID(), name: 'Announcer' },
        },
      }, host.key.privateKey, group)
      eq(status, 202, `${text}: the inbox takes the Group's Note`)
      await sleep(300)
      return (await db.from('messages').select('channel_id').eq('id', id).maybeSingle()).data as any
    }
    const ownStored = await groupSays(realGroup, real, own, 'in its own channel')
    assert(ownStored, 'the Group\'s message lands in the channel no one else lists', ownStored)
    eq(await groupSays(realGroup, real, shared, 'in the listed channel'), null, 'its message naming the channel listed first lands nowhere')
    const evilStored = await groupSays(evilGroup, evil, own, 'in another Group\'s channel')
    eq(evilStored, null, 'and the other Group\'s message naming its channel lands nowhere')

    const member = real.actor('fx_claim_member')
    const memberProfile = crypto.randomUUID()
    const seeded = await db.from('profiles').insert({
      id: memberProfile, username: 'fx_claim_member', display_name: 'member', domain: new URL(real.base).host, is_local: false,
      federated_id: member, inbox_url: `${member}/inbox`, shared_inbox_url: `${real.base}/inbox`,
    })
    assert(!seeded.error, 'seed a member of the Group', seeded.error?.message)
    madeProfiles.push(memberProfile)
    const accepted = await db.from('user_servers').insert({ server_id: realCopy?.id, user_id: memberProfile, status: 'accepted' })
    assert(!accepted.error, 'an accepted member of its copy', accepted.error?.message)
    const relayedNote = crypto.randomUUID()
    const relayed = await send(sharedInbox, {
      id: `${realGroup}/activities/${crypto.randomUUID()}`,
      type: 'Announce',
      actor: realGroup,
      object: {
        id: `${member}/activities/${crypto.randomUUID()}`,
        type: 'Create',
        actor: member,
        object: {
          type: 'Note',
          id: `${real.base}/messages/${relayedNote}`,
          attributedTo: member,
          content: 'relayed',
          context: `${realGroup}/channels/${own}`,
          published: new Date().toISOString(),
          'harmony:serverId': groupId,
        },
      },
    }, real.key.privateKey, realGroup)
    eq(relayed, 202, 'the Group\'s relay is taken (202)')
    await sleep(300)
    eq((await db.from('messages').select('channel_id').eq('id', relayedNote).maybeSingle()).data?.channel_id, own,
      'and the member\'s message lands in the Group\'s channel')

    const bobAccepted = await db.from('user_servers').update({ status: 'accepted' }).eq('server_id', realCopy?.id).eq('user_id', ids.bob)
    assert(!bobAccepted.error, 'fx_bob an accepted member', bobAccepted.error?.message)
    real.posts = []
    const bobMessage = crypto.randomUUID()
    const said = await ctx.asUser(ids.bobAuth).from('messages').insert({
      id: bobMessage, channel_id: own, user_id: ids.bob, content: [{ type: 'text', text: 'from the copy' }],
    })
    assert(!said.error, 'fx_bob posts in the copy', said.error?.message)
    const { handleChannelMessageFederation } = await backend('listeners/ChannelMessageHandler.ts')
    await handleChannelMessageFederation({ message_id: bobMessage, channel_id: own, server_id: realCopy?.id, channel_name: 'other', author_id: ids.bob })
    let bobNote: any = null
    for (let i = 0; i < 40 && !bobNote; i++) {
      await sleep(200)
      bobNote = real.posts.find((p) => p.path === `/servers/${groupId}/inbox` && String(p.body?.object?.id ?? '').includes(bobMessage))
    }
    assert(bobNote, 'and it leaves for the Group\'s inbox', real.posts.map((p) => p.path))
    assert(String(bobNote?.body?.object?.context ?? '').endsWith(`/channels/${own}`), 'naming the Group\'s channel', bobNote?.body?.object?.context)

    // Array content on a channel message --------------------------------------------------------
    const hostedChannelCtx = `https://${D}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}`
    await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
    await db.from('user_servers').upsert(
      { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted' },
      { onConflict: 'server_id,user_id' },
    )
    const victimPath = `c/${ids.hostedChannel}/${crypto.randomUUID()}.png`
    const arrayNote = crypto.randomUUID()
    const poll = crypto.randomUUID()
    const arrayStatus = await send(sharedInbox, {
      id: `${peer.base}/activities/${crypto.randomUUID()}`,
      type: 'Create',
      actor: peer.actorUrl,
      object: {
        type: 'Note',
        id: `${peer.base}/messages/${arrayNote}`,
        attributedTo: peer.actorUrl,
        context: hostedChannelCtx,
        published: new Date().toISOString(),
        'harmony:serverId': ids.hostedServer,
        content: [
          { type: 'text', text: 'array content' },
          { type: 'file', url: `${peer.base}/x.png`, path: victimPath, mimeType: 'image/png', name: 'x.png' },
          { type: 'poll', pollId: poll },
          { type: 'mention', userId: ids.bob, username: 'fx_bob', domain: new URL(peer.base).hostname, isLocal: true },
        ],
      },
    }, peer.key.privateKey, peer.actorUrl)
    eq(arrayStatus, 202, 'a channel Note with array content is taken (202)')
    await sleep(300)
    const { data: arrayRow } = await db.from('messages').select('content').eq('id', arrayNote).maybeSingle()
    const parts = (arrayRow?.content ?? []) as any[]
    console.log(`  note  stored parts: ${JSON.stringify(parts).slice(0, 300)}`)
    assert(parts.some((p) => p.type === 'text'), 'it is stored', arrayRow)
    assert(!parts.some((p) => p.path !== undefined), 'with no storage path', parts)
    assert(!parts.some((p) => p.type === 'poll'), 'no poll', parts)
    assert(!parts.some((p) => p.type === 'mention' && p.isLocal === true), 'and no mention claiming locality', parts)

    // attributedTo of a direct message ----------------------------------------------------------
    const dmId = `${evil.base}/notes/${crypto.randomUUID()}`
    const evilActor = evil.actor('fx_claim_evil')
    const dmActivity = (id: string, activity: string) => ({
      id: activity,
      type: 'Create',
      actor: evilActor,
      to: [`https://${D}/users/fx_bob`],
      object: {
        type: 'Note', id, attributedTo: 'https://trusted.example.test/users/admin', content: 'hello',
        to: [`https://${D}/users/fx_bob`],
      },
    })
    const dmStatus = await send(sharedInbox, dmActivity(dmId, `${evil.base}/activities/${crypto.randomUUID()}`), evil.key.privateKey, evilActor)
    eq(dmStatus, 202, 'a direct message claiming another author is taken (202)')
    await sleep(300)
    const { data: evilProfile } = await db.from('profiles').select('id').eq('federated_id', evilActor).maybeSingle()
    if (evilProfile?.id) madeProfiles.push(evilProfile.id)
    const { data: dmRow } = await db.from('messages').select('user_id, metadata').eq('metadata->>ap_id', dmId).maybeSingle()
    assert(dmRow, 'it is stored', dmRow)
    eq(dmRow?.user_id, evilProfile?.id, 'under the actor who signed it')
    eq((dmRow?.metadata as any)?.from_domain, new URL(evilActor).hostname, 'with the actor\'s domain')

    const { resetSpamConfigCache } = await backend('services/FederationSpamGuard.ts')
    const { data: antispam } = await db.from('instance_config').select('config_value').eq('config_key', 'antispam').maybeSingle()
    const antispamWas = antispam?.config_value ?? null
    await db.from('instance_config').upsert(
      { config_key: 'antispam', config_value: { ...(antispamWas ?? {}), federation_spam_mode: 'hold', federation_new_actor_days: 3650 } },
      { onConflict: 'config_key' },
    )
    resetSpamConfigCache()
    try {
      const heldActivity = `${evil.base}/activities/${crypto.randomUUID()}`
      const heldActor = evil.actor('fx_claim_held')
      await send(sharedInbox, {
        ...dmActivity(`${evil.base}/notes/${crypto.randomUUID()}`, heldActivity),
        actor: heldActor,
      }, evil.key.privateKey, heldActor)
      await sleep(300)
      const { data: heldProfile } = await db.from('profiles').select('id').eq('federated_id', heldActor).maybeSingle()
      if (heldProfile?.id) madeProfiles.push(heldProfile.id)
      const { data: held } = await db.from('suspicious_activity').select('actor_uri, actor_domain').eq('activity_id', heldActivity).maybeSingle()
      assert(held, 'a held direct message is recorded', held)
      eq(held?.actor_uri, heldActor, 'as coming from the actor who signed it')
      await db.from('suspicious_activity').delete().eq('activity_id', heldActivity)
    } finally {
      await db.from('instance_config').upsert(
        { config_key: 'antispam', config_value: antispamWas ?? {} },
        { onConflict: 'config_key' },
      )
      resetSpamConfigCache()
    }
  } finally {
    await db.from('messages').delete().eq('channel_id', ids.hostedChannel).eq('user_id', ids.remote)
    for (const id of madeServers) {
      await db.from('user_servers').delete().eq('server_id', id)
      await db.from('channels').delete().eq('server_id', id)
      await db.from('servers').delete().eq('id', id)
    }
    for (const id of madeProfiles) await db.from('profiles').delete().eq('id', id)
    await Promise.all([real.stop(), evil.stop()])
  }
}
