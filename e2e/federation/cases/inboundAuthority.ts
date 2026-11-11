// What a signed activity may name, each way. A check on one object must not act on another the
// payload picks.
//
// Hosted here (the private server, the peer's user an accepted member, a reader on instance C):
//   - a Note whose id is on another host is refused, by id on any host and by this instance's own
//     URL of another author's message, so the Group never re-emits it;
//   - a Note reusing another message's uuid on its author's own host is one more message;
//   - a moderator's delete of a member's message reaches a reader as the Group's own Delete.
//
// Hosted by the peer (its Group copied here, fx_bob a member):
//   - a channel page's Note naming fx_bob's message by uuid neither rewrites nor flags it, and no
//     edit leaves under fx_bob's key;
//   - a relayed Delete of another member's message, and of a case variant of this instance's URL,
//     deletes nothing and no Delete leaves under fx_bob's key; the author's own still applies;
//   - a Question naming a poll by a case variant leaves it;
//   - a channel page redirected to another host is not requested there as fx_bob;
//   - Accept(Join) naming a local user who asked to join nothing signs nothing as them;
//   - a moderator of a local server changes no copy, and the Group's own Update still lands.
//
// Any instance:
//   - an activity id off the actor's host claims nothing, and a row of another actor is no
//     duplicate: the real delivery lands;
//   - an Announce under another host's id stores nothing, and the real post arrives;
//   - a url on another host is not stored, nor returned by /resolve-post;
//   - a Like or reply from a host that may not read a followers-only post does not attach to it,
//     by this instance's URL or another host's same path; a public post takes both;
//   - a QuoteRequest for a post on another host gets no stamp;
//   - a qualified emoji from another instance leaves the origin's cache row;
//   - a group invite is held by the spam guard, refused by the recipient's setting, and joins no
//     conversation found by remote id.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap } from './outboundFederation.ts'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const PUBLIC = `${AS}#Public`
const MANAGE_CHANNELS = 1 << 2
const MANAGE_MESSAGES = 1 << 21
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Fixed so a failure names a row.
const READER = 'fed00251-0000-0000-0000-000000000001'
const REDIRECTED_CHANNEL = 'fed00251-0000-0000-0000-000000000003'

interface Captured {
  url: string
  headers: Record<string, string>
  raw: Buffer
}

/** Another instance: actor documents for any user, a fixed channel page, every request recorded. */
class Host {
  readonly key = crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
  base = ''
  gets: Array<{ url: string; headers: http.IncomingHttpHeaders }> = []
  posts: any[] = []
  private server?: http.Server

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
          const raw = Buffer.concat(chunks).toString('utf-8')
          this.posts.push(raw ? JSON.parse(raw) : null)
          res.writeHead(202)
          res.end()
          return
        }
        const user = /^\/users\/([a-z_]+)$/.exec(req.url ?? '')?.[1]
        if (user) {
          res.writeHead(200, { 'Content-Type': 'application/activity+json' })
          res.end(JSON.stringify({
            '@context': [AS, 'https://w3id.org/security/v1'],
            id: this.actor(user),
            type: 'Person',
            preferredUsername: user,
            inbox: `${this.actor(user)}/inbox`,
            endpoints: { sharedInbox: `${this.base}/inbox` },
            publicKey: { id: `${this.actor(user)}#main-key`, owner: this.actor(user), publicKeyPem: this.key.publicKey },
          }))
          return
        }
        this.gets.push({ url: req.url ?? '', headers: req.headers })
        res.writeHead(200, { 'Content-Type': 'application/activity+json' })
        res.end(JSON.stringify({ '@context': AS, type: 'OrderedCollectionPage', orderedItems: [] }))
      })
    })
    await new Promise<void>((resolve) => this.server!.listen(0, hostname, () => resolve()))
    this.base = `http://${hostname}:${(this.server.address() as { port: number }).port}`
  }
  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export interface InboundAuthorityContext {
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
    groupGetRequests: Captured[]
    extraChannelItems: Record<string, unknown>[]
    extraGet?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  bearer: (authUserId: string) => string
  asUser: (authUserId: string) => SupabaseClient
  userEvents: (db: SupabaseClient, profileId: string) => Promise<any[]>
  ids: {
    alice: string
    bob: string
    bobAuth: string
    carol: string
    carolAuth: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseInboundAuthority(ctx: InboundAuthorityContext): Promise<void> {
  console.log('\nInbound authority -> what a signed activity names is checked against what it acts on')
  const { db, peer, ids, localUrl, assert, eq } = ctx
  const D = ctx.instanceDomain
  const hostname = new URL(peer.base).hostname
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)

  const evil = new Host()
  const other = new Host()
  const reader = new Host()
  await Promise.all([evil.start(hostname), other.start(hostname), reader.start(hostname)])
  const tap = await JobTap.open(process.env.HMFED_PROJECT ?? 'hmfed')
  const { forgetInstanceSoftware } = await backend('activitypub/instanceSoftware.ts')
  const previousExtraGet = peer.extraGet

  const sharedInbox = `${localUrl}/inbox`
  const hostedInbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const hostedGroup = `https://${D}/servers/${ids.hostedServer}`
  const hostedContext = `${hostedGroup}/channels/${ids.hostedChannel}`
  const copyInbox = `${localUrl}/servers/${ids.remoteRef}/inbox`
  const groupInboxPath = `/servers/${ids.remoteRef}/inbox`
  const bobHeaders = { Accept: 'application/json', Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}` }

  const send = (url: string, activity: Record<string, unknown>, key: string, actor: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, JSON.stringify({ '@context': AS, actor, ...activity }), key, `${actor}#main-key`)
  const asMember = (url: string, activity: Record<string, unknown>) => send(url, activity, peer.key.privateKey, peer.actorUrl)
  const asGroup = (url: string, activity: Record<string, unknown>) => send(url, activity, peer.groupKey.privateKey, peer.groupUrl)
  const asEvil = (url: string, activity: Record<string, unknown>, user = 'fx_auth_evil') =>
    send(url, activity, evil.key.privateKey, evil.actor(user))
  const activityId = (base: string) => `${base}/activities/${crypto.randomUUID()}`

  const bobSays = async (text: string): Promise<string> => {
    const id = crypto.randomUUID()
    const r = await ctx.asUser(ids.bobAuth).from('messages').insert({ id, channel_id: ids.remoteChannel, user_id: ids.bob, content: [{ type: 'text', text }] })
    assert(!r.error, `fx_bob posts "${text}" in the copy`, r.error?.message)
    return id
  }
  const message = async (id: string) =>
    (await db.from('messages').select('user_id, content, encrypted, is_deleted').eq('id', id).maybeSingle()).data as any
  const keyIdOf = (signature: unknown) => /keyId="([^"]+)"/.exec(String(signature ?? ''))?.[1] ?? null
  const groupInboxSince = (n: number) => peer.captured.slice(n).filter((c) => c.url === groupInboxPath)

  let cooking: string | null = null
  try {
    // Hosted here -------------------------------------------------------------------------
    const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
    assert(!fed.error, 'federate the hosted server', fed.error?.message)
    await db.from('profiles').delete().eq('id', READER)
    const seeded = await db.from('profiles').insert({
      id: READER, username: 'fx_auth_reader', display_name: 'reader', domain: reader.host, is_local: false,
      federated_id: reader.actor('fx_auth_reader'), inbox_url: `${reader.actor('fx_auth_reader')}/inbox`, shared_inbox_url: `${reader.base}/inbox`,
    })
    assert(!seeded.error, 'seed a member on instance C', seeded.error?.message)
    const joined = await db.from('user_servers').insert({ server_id: ids.hostedServer, user_id: READER, status: 'accepted', member_instance: reader.host })
    assert(!joined.error, 'an accepted member of the hosted server', joined.error?.message)
    await db.from('federated_instances').upsert([{ domain: reader.host, software: 'harmony' }], { onConflict: 'domain' })
    forgetInstanceSoftware(reader.host)

    const createNote = (id: string, extra: Record<string, unknown> = {}) => ({
      id: activityId(peer.actorUrl),
      type: 'Create',
      object: { type: 'Note', id, attributedTo: peer.actorUrl, content: 'x', context: hostedContext, ...extra },
    })
    const storedByApId = async (id: string) => (await db.from('messages').select('id').eq('metadata->>ap_id', id).maybeSingle()).data

    const foreign = `https://r.example.test/messages/${crypto.randomUUID().toUpperCase()}`
    eq(await asMember(hostedInbox, createNote(foreign)), 202, 'a Note under another host\'s id is taken (202)')
    eq(await storedByApId(foreign), null, 'and stores nothing')

    const { data: alices } = await db.from('messages').select('id').eq('channel_id', ids.hostedChannel).eq('user_id', ids.alice).limit(1)
    const aliceMessage = alices?.[0]?.id as string
    const aliceUrl = `https://${D}/messages/${aliceMessage}`
    eq(await asMember(hostedInbox, createNote(aliceUrl)), 202, 'a Note under this instance\'s URL of fx_alice\'s message is taken (202)')
    eq(await storedByApId(aliceUrl), null, 'and stores nothing')
    eq(await asMember(hostedInbox, { id: activityId(peer.actorUrl), type: 'Delete', object: aliceUrl }), 202, 'a Delete naming it is taken (202)')
    await sleep(300)
    eq((await message(aliceMessage))?.is_deleted, false, 'fx_alice\'s message stays')
    assert(!reader.posts.some((p) => p?.object?.object === aliceUrl), 'and no reader is sent a Delete naming it')

    const pollId = `https://r.example.test/messages/${crypto.randomUUID().toUpperCase()}`
    eq(await asMember(hostedInbox, createNote(pollId, {
      'harmony:poll': { type: 'Question', name: 'q', oneOf: [{ type: 'Note', name: 'a' }, { type: 'Note', name: 'b' }] },
    })), 202, 'a poll under another host\'s id is taken (202)')
    eq((await db.from('message_polls').select('id').eq('ap_id', pollId).maybeSingle()).data, null, 'and stores no poll')

    const ownId = `${peer.base}/messages/${crypto.randomUUID()}`
    eq(await asMember(hostedInbox, createNote(ownId)), 202, 'a Note on its author\'s host is taken (202)')
    const own = await storedByApId(ownId)
    assert(own, 'and stored')

    // A moderator's delete of a member's message: the Group's own Delete.
    const modRole = await db.from('server_roles').insert({
      server_id: ids.hostedServer, name: 'auth-mods', color: '#99AAB5', position: 9, permissions: MANAGE_MESSAGES,
    }).select('id').single()
    assert(!modRole.error, 'a role managing messages', modRole.error?.message)
    const roleGiven = await db.from('user_roles').insert({ user_id: ids.remote, role_id: modRole.data?.id, server_id: ids.hostedServer })
    assert(!roleGiven.error, 'held by the peer\'s user', roleGiven.error?.message)
    const readerNote = `${reader.base}/messages/${crypto.randomUUID()}`
    const readerRow = await db.from('messages').insert({
      channel_id: ids.hostedChannel, user_id: READER, content: [{ type: 'text', text: 'reader wrote' }],
      metadata: { ap_id: readerNote, federated: true }, federation_status: 'skipped',
    }).select('id').single()
    assert(!readerRow.error, 'instance C\'s member posts', readerRow.error?.message)
    eq(await asMember(hostedInbox, { id: activityId(peer.actorUrl), type: 'Delete', object: readerNote }), 202, 'the moderator deletes it (202)')
    await sleep(300)
    eq((await message(readerRow.data?.id as string))?.is_deleted, true, 'it is deleted here')
    const deleteJob = await tap.take((j) => j.name === 'federate-channel-message-delete' && j.data?.message_id === readerRow.data?.id, 3000)
    assert(deleteJob, 'the Group\'s own Delete is queued')
    if (deleteJob) {
      const { handleChannelMessageDeleteJob } = await backend('queue/handlers/channelMessageHandler.ts')
      await handleChannelMessageDeleteJob(deleteJob.data)
      let sent: any
      for (let i = 0; i < 30 && !sent; i++) {
        sent = reader.posts.find((p) => p?.type === 'Delete' && p?.actor === hostedGroup)
        if (!sent) await sleep(100)
      }
      assert(sent, 'and reaches the reader as the Group\'s', JSON.stringify(reader.posts.slice(-3)))
    }

    // Hosted by the peer --------------------------------------------------------------------
    const copyRow = async () => (await db.from('servers').select('name, description, icon, banner, public').eq('id', ids.remoteRef).single()).data
    const copyBefore = await copyRow()

    // A page Note naming fx_bob's message.
    const named = await bobSays('bob original')
    const flagged = await bobSays('bob plain')
    const nGroup = peer.captured.length
    peer.extraChannelItems = [{
      type: 'Note', id: `${peer.base}/messages/${named}`, attributedTo: peer.strangerUrl, content: 'FORGED', context: peer.channelUrl(ids.remoteChannel),
      published: new Date().toISOString(),
      'harmony:rawContent': [{ type: 'text', text: 'FORGED' }, { type: 'file', fileType: 'image', url: `${peer.base}/x.png`, fileName: 'x.png' }],
    }, {
      type: 'Note', id: `${peer.base}/messages/${flagged}`, attributedTo: peer.strangerUrl, content: 'x', context: peer.channelUrl(ids.remoteChannel),
      published: new Date().toISOString(), 'harmony:encrypted': true,
    }]
    eq((await ctx.get(`${localUrl}/channels/${ids.remoteChannel}/messages`, bobHeaders)).status, 200, 'a member reads the page')
    peer.extraChannelItems = []
    const afterPage = await message(named)
    assert(!JSON.stringify(afterPage?.content).includes('FORGED'), 'fx_bob\'s message keeps its content', JSON.stringify(afterPage?.content))
    eq((await message(flagged))?.encrypted ?? false, false, 'and another is not flagged encrypted')
    eq(await tap.take((j) => j.name === 'federate-channel-message-edit' && j.data?.message_id === named, 1000), null, 'no edit is queued under fx_bob\'s key')
    eq(groupInboxSince(nGroup).length, 0, 'and none reaches the Group')

    // A relayed Delete.
    await db.from('user_servers').upsert({
      server_id: ids.remoteRef, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.base).host,
    }, { onConflict: 'user_id,server_id' })
    const relayDelete = (object: string, actor = peer.actorUrl) => asGroup(copyInbox, {
      id: `${peer.groupUrl}/relays/${crypto.randomUUID()}`,
      type: 'Announce',
      to: [`https://${D}/users/fx_bob`],
      object: { id: activityId(actor), type: 'Delete', actor, object },
    })
    const bobKeeps = await bobSays('bob keeps this')
    eq(await relayDelete(`https://${D}/messages/${bobKeeps.toUpperCase()}`), 202, 'a relayed Delete by a case variant is taken (202)')
    eq(await relayDelete(`https://${D}/messages/${bobKeeps}`), 202, 'and by the exact URL (202)')
    await sleep(300)
    eq((await message(bobKeeps))?.is_deleted, false, 'another member deletes nothing of fx_bob\'s')
    eq(await tap.take((j) => j.name === 'federate-channel-message-delete' && j.data?.message_id === bobKeeps, 1000), null, 'no Delete is queued under fx_bob\'s key')

    const remoteOwnId = crypto.randomUUID()
    const remoteOwnUrl = `${peer.base}/messages/${remoteOwnId}`
    const remoteOwn = await db.from('messages').insert({
      id: remoteOwnId, channel_id: ids.remoteChannel, user_id: ids.remote, content: [{ type: 'text', text: 'peer wrote' }],
      metadata: { ap_id: remoteOwnUrl, federated: true }, federation_status: 'skipped',
    })
    assert(!remoteOwn.error, 'the peer\'s user has a message in the copy', remoteOwn.error?.message)
    eq(await relayDelete(remoteOwnUrl), 202, 'a relayed Delete of their own is taken (202)')
    await sleep(300)
    eq((await message(remoteOwnId))?.is_deleted, true, 'and applies')

    // A Question by a case variant.
    await db.from('servers').update({ federation_metadata: { message_polls: true } }).eq('id', ids.remoteRef)
    const poll = await ctx.asUser(ids.bobAuth).rpc('create_message_poll', {
      p_channel_id: ids.remoteChannel, p_conversation_id: null, p_question: 'Where?', p_options: ['Here', 'There'], p_duration_hours: 4,
    })
    assert(!poll.error, 'fx_bob posts a poll in the copy', poll.error?.message)
    const pollMessage = poll.data?.id as string
    const pollRow = async () => (await db.from('message_polls').select('expires_at, remote_voters').eq('message_id', pollMessage).maybeSingle()).data as any
    const pollBefore = await pollRow()
    eq(await asGroup(sharedInbox, {
      id: activityId(peer.groupUrl), type: 'Update',
      object: { type: 'Question', id: `https://${D}/messages/${pollMessage.toUpperCase()}`, closed: '2020-01-01T00:00:00Z', votersCount: 999 },
    }), 202, 'a Question by a case variant is taken (202)')
    await sleep(200)
    eq(JSON.stringify(await pollRow()), JSON.stringify(pollBefore), 'and leaves the poll')

    // A channel page redirected to another host.
    const redirected = REDIRECTED_CHANNEL
    const channel = await db.from('channels').insert({
      id: redirected, server_id: ids.remoteRef, name: 'redirected', type: 0, is_remote: true, ap_id: `${peer.groupUrl}/channels/${redirected}`,
    })
    assert(!channel.error, 'a channel of the copy', channel.error?.message)
    peer.extraGet = (req, res) => {
      if (!(req.url ?? '').startsWith(`/servers/${ids.remoteRef}/channels/${redirected}/messages`)) return false
      res.writeHead(302, { Location: `${other.base}/servers/P/channels/Q/messages?page=1` })
      res.end()
      return true
    }
    await ctx.get(`${localUrl}/channels/${redirected}/messages`, bobHeaders)
    peer.extraGet = previousExtraGet
    eq(other.gets.length, 0, 'the other host is not requested as fx_bob')
    eq((await db.from('messages').select('id').eq('channel_id', redirected)).data?.length ?? 0, 0, 'and nothing is cached in the channel')

    // Accept(Join) naming a local user who asked for nothing.
    const nGets = peer.groupGetRequests.length
    eq(await asGroup(sharedInbox, {
      id: activityId(peer.groupUrl), type: 'Accept',
      object: { type: 'Join', id: `${peer.groupUrl}/joins/${crypto.randomUUID()}`, actor: `https://${D}/users/fx_carol`, object: peer.groupUrl },
    }), 202, 'an Accept naming fx_carol is taken (202)')
    await sleep(1500)
    const signers = peer.groupGetRequests.slice(nGets).map((g) => keyIdOf(g.headers.signature))
    assert(!signers.some((s) => s?.endsWith('/users/fx_carol#main-key')), 'nothing is signed as fx_carol', JSON.stringify(signers))
    eq((await db.from('user_servers').select('status').eq('server_id', ids.remoteRef).eq('user_id', ids.carol).maybeSingle()).data, null, 'and she is no member')

    // A moderator of a local server, granted through the calls an ordinary owner has.
    const carol = ctx.asUser(ids.carolAuth)
    const made = await carol.from('servers').insert([{ name: 'Cooking', description: null, public: false, owner: ids.carol }]).select('id').single()
    assert(!made.error, 'an ordinary user creates a server', made.error?.message)
    cooking = made.data?.id as string
    const turnedOn = await carol.from('servers').update({ federation_enabled: true }).eq('id', cooking).select('id').single()
    assert(!turnedOn.error, 'and turns federation on', turnedOn.error?.message)
    const code = `auth${crypto.randomUUID().slice(0, 8)}`
    const invite = await carol.from('invites').insert({ code, server_id: cooking, created_by: ids.carol, max_uses: 1 })
    assert(!invite.error, 'and makes an invite', invite.error?.message)
    const cookingInbox = `${localUrl}/servers/${cooking}/inbox`
    eq(await send(cookingInbox, {
      id: activityId(peer.strangerUrl), type: 'Join', object: `https://${D}/servers/${cooking}`, 'harmony:inviteCode': code,
    }, peer.strangerKey.privateKey, peer.strangerUrl), 202, 'a remote account joins (202)')
    await sleep(500)
    const stranger = (await db.from('profiles').select('id').eq('federated_id', peer.strangerUrl).maybeSingle()).data
    const role = await carol.from('server_roles').insert({
      server_id: cooking, name: 'mods', color: '#99AAB5', hoist: false, mentionable: false, position: 5, permissions: MANAGE_CHANNELS,
    }).select('id').single()
    assert(!role.error, 'the owner makes a role', role.error?.message)
    const granted = await carol.from('user_roles').insert({ user_id: stranger?.id, role_id: role.data?.id, server_id: cooking })
    assert(!granted.error, 'and gives it to the remote account', granted.error?.message)
    eq(await send(cookingInbox, {
      id: activityId(peer.strangerUrl), type: 'Update',
      object: {
        type: 'Group', id: `https://evil.example/servers/${ids.remoteRef}`, name: 'Forged', summary: 'Forged', icon: { url: 'https://evil.example/x.png' },
        image: { url: 'https://evil.example/y.png' }, 'harmony:public': !copyBefore?.public,
      },
    }, peer.strangerKey.privateKey, peer.strangerUrl), 202, 'its Update naming the copy is taken (202)')
    await sleep(200)
    eq(JSON.stringify(await copyRow()), JSON.stringify(copyBefore), 'and changes nothing of the copy')
    eq(await send(cookingInbox, {
      id: activityId(peer.strangerUrl), type: 'Update',
      object: { type: 'harmony:TextChannel', id: peer.channelUrl(ids.remoteChannel), name: 'hijacked' },
    }, peer.strangerKey.privateKey, peer.strangerUrl), 202, 'its Update naming the copy\'s channel is taken (202)')
    await sleep(200)
    assert((await db.from('channels').select('name').eq('id', ids.remoteChannel).single()).data?.name !== 'hijacked', 'and leaves the channel')

    // Any instance --------------------------------------------------------------------------
    const realName = 'Named by its Group'
    const groupUpdate = (id: string, name: string) => JSON.stringify({
      '@context': AS, id, type: 'Update', actor: peer.groupUrl, object: { id: peer.groupUrl, type: 'Group', name, 'harmony:ChatServer': true },
    })
    const postAsGroup = (body: string) => deliver(ctx.post, ctx.signedHeaders, sharedInbox, body, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
    const copyName = async () => (await copyRow())?.name

    const claimed = activityId(peer.groupUrl)
    eq(await asEvil(sharedInbox, { id: claimed, type: 'Like', object: `${evil.base}/none` }), 202, 'a Like under the Group\'s activity id is taken (202)')
    eq((await db.from('ap_activities').select('id').eq('ap_id', claimed).maybeSingle()).data, null, 'and claims no row')
    eq(await postAsGroup(groupUpdate(claimed, realName)), 202, 'the Group\'s real Update is taken (202)')
    await sleep(200)
    eq(await copyName(), realName, 'and lands')

    const claimedAtServer = activityId(peer.groupUrl)
    eq(await asEvil(`${localUrl}/servers/${crypto.randomUUID()}/inbox`, { id: claimedAtServer, type: 'Like', object: `${evil.base}/none` }), 202, 'also at the inbox of no server (202)')
    eq((await db.from('ap_activities').select('id').eq('ap_id', claimedAtServer).maybeSingle()).data, null, 'claiming no row')
    eq(await postAsGroup(groupUpdate(claimedAtServer, `${realName} again`)), 202, 'the real Update is taken (202)')
    await sleep(200)
    eq(await copyName(), `${realName} again`, 'and lands')

    const sameHost = `${peer.actorUrl}/activities/${crypto.randomUUID()}`
    eq(await send(sharedInbox, { id: sameHost, type: 'Like', object: `${evil.base}/none` }, peer.strangerKey.privateKey, peer.strangerUrl), 202, 'another user on the same host takes an id first (202)')
    const noteOfRemote = `${peer.base}/notes/${crypto.randomUUID()}`
    const realCreate = await asMember(sharedInbox, {
      id: sameHost, type: 'Create', to: [PUBLIC],
      object: { type: 'Note', id: noteOfRemote, attributedTo: peer.actorUrl, content: 'landed', to: [PUBLIC] },
    })
    eq(realCreate, 202, 'the actor\'s real activity under that id is taken (202)')
    await sleep(200)
    assert((await db.from('posts').select('id').eq('ap_id', noteOfRemote).maybeSingle()).data, 'and lands')

    const plain = crypto.randomUUID()
    const followersOnly = crypto.randomUUID()
    const posts = await db.from('posts').insert([
      { id: plain, author_id: ids.alice, visibility: 'public', is_local: true, content: [{ type: 'text', text: 'alice public' }] },
      { id: followersOnly, author_id: ids.alice, visibility: 'followers', is_local: true, content: [{ type: 'text', text: 'alice followers only' }] },
    ])
    assert(!posts.error, 'fx_alice has a public and a followers-only post', posts.error?.message)
    const plainUrl = `https://${D}/posts/${plain}`
    const followersUrl = `https://${D}/posts/${followersOnly}`

    const realPost = `${peer.base}/users/fx_remote/statuses/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, { id: realPost, type: 'Announce', object: plainUrl, to: [PUBLIC] }), 202, 'an Announce under the peer\'s post URL is taken (202)')
    await sleep(200)
    eq((await db.from('posts').select('id').eq('ap_id', realPost).maybeSingle()).data, null, 'and stores nothing')
    eq(await asMember(sharedInbox, {
      id: activityId(peer.actorUrl), type: 'Create', to: [PUBLIC],
      object: { type: 'Note', id: realPost, attributedTo: peer.actorUrl, content: 'the real post', to: [PUBLIC] },
    }), 202, 'the real Create is taken (202)')
    await sleep(200)
    assert(JSON.stringify((await db.from('posts').select('content').eq('ap_id', realPost).maybeSingle()).data?.content).includes('the real post'), 'and stored')
    const boostId = `${evil.base}/boosts/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, { id: boostId, type: 'Announce', object: plainUrl, to: [PUBLIC] }), 202, 'an Announce on the actor\'s own host is taken (202)')
    await sleep(200)
    assert((await db.from('posts').select('id').eq('ap_id', boostId).maybeSingle()).data, 'and stored')

    const claimedUrl = `${peer.base}/@fx_remote/${crypto.randomUUID()}`
    const claimNote = `${evil.base}/notes/${crypto.randomUUID()}`
    const homeUrl = `${evil.base}/@fx_auth_evil/1`
    const homeNote = `${evil.base}/notes/${crypto.randomUUID()}`
    const createPublic = (id: string, url: string) => ({
      id: activityId(evil.base), type: 'Create', to: [PUBLIC],
      object: { type: 'Note', id, url, attributedTo: evil.actor('fx_auth_evil'), content: 'note', to: [PUBLIC] },
    })
    eq(await asEvil(sharedInbox, createPublic(claimNote, claimedUrl)), 202, 'a Note with a url on another host is taken (202)')
    eq(await asEvil(sharedInbox, createPublic(homeNote, homeUrl)), 202, 'and one with its own (202)')
    await sleep(200)
    eq((await db.from('posts').select('url').eq('ap_id', claimNote).maybeSingle()).data?.url, null, 'the claimed url is not stored')
    eq((await db.from('posts').select('url').eq('ap_id', homeNote).maybeSingle()).data?.url, homeUrl, 'its own is')
    const resolveBody = JSON.stringify({ url: claimedUrl })
    const resolved = await ctx.post(`${localUrl}/resolve-post`, { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(resolveBody)) }, resolveBody)
    const claimRow = (await db.from('posts').select('id').eq('ap_id', claimNote).maybeSingle()).data
    assert(!resolved.body.includes(String(claimRow?.id)), '/resolve-post does not return that post for the claimed url', resolved.body)

    const interactions = async (postId: string) => (await db.from('post_interactions').select('id').eq('post_id', postId).eq('interaction_type', 'favorite')).data?.length ?? 0
    eq(await asEvil(sharedInbox, { id: activityId(evil.base), type: 'Like', object: followersUrl }), 202, 'a stranger\'s Like of a followers-only post is taken (202)')
    eq(await asEvil(sharedInbox, { id: activityId(evil.base), type: 'Like', object: `${evil.base}/posts/${followersOnly}` }), 202, 'and by the same path on another host (202)')
    await sleep(200)
    eq(await interactions(followersOnly), 0, 'neither attaches')
    eq(await asEvil(sharedInbox, { id: activityId(evil.base), type: 'Like', object: plainUrl }), 202, 'a Like of a public post is taken (202)')
    await sleep(200)
    eq(await interactions(plain), 1, 'and attaches')

    const replyTo = async (inReplyTo: string) => {
      const id = `${evil.base}/notes/${crypto.randomUUID()}`
      await asEvil(sharedInbox, {
        id: activityId(evil.base), type: 'Create', to: [PUBLIC],
        object: { type: 'Note', id, attributedTo: evil.actor('fx_auth_evil'), inReplyTo, content: 'reply', to: [PUBLIC] },
      })
      await sleep(200)
      return (await db.from('posts').select('in_reply_to').eq('ap_id', id).maybeSingle()).data?.in_reply_to ?? null
    }
    eq(await replyTo(followersUrl), null, 'a stranger\'s reply does not link to a followers-only post')
    eq(await replyTo(followersOnly), null, 'nor by its bare uuid')
    eq(await replyTo(plainUrl), plain, 'a reply to a public post links')

    const foreignQuote = `${peer.base}/users/fx_remote/statuses/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, { id: activityId(evil.base), type: 'QuoteRequest', object: plainUrl, instrument: foreignQuote }), 202, 'a QuoteRequest for a post on another host is taken (202)')
    await sleep(300)
    eq((await db.from('quote_authorizations').select('id').eq('quoting_post_uri', foreignQuote).maybeSingle()).data, null, 'and gets no stamp')
    const ownQuote = `${evil.base}/users/fx_auth_evil/statuses/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, { id: activityId(evil.base), type: 'QuoteRequest', object: plainUrl, instrument: ownQuote }), 202, 'one for its own post is taken (202)')
    await sleep(300)
    assert((await db.from('quote_authorizations').select('id').eq('quoting_post_uri', ownQuote).maybeSingle()).data, 'and gets one')

    const origin = 'origin.example.test'
    await db.rpc('upsert_remote_emoji', { p_shortcode: 'authblob', p_origin_domain: origin, p_full_code: `:authblob@${origin}:`, p_url: `https://${origin}/real.png` })
    eq(await asEvil(sharedInbox, {
      id: activityId(evil.base), type: 'EmojiReact', object: plainUrl, content: ':authblob:',
      tag: [{ type: 'Emoji', name: `:authblob@${origin}:`, icon: { url: `${evil.base}/x.png` } }],
    }), 202, 'a reaction naming another instance\'s emoji is taken (202)')
    await sleep(200)
    eq((await db.from('remote_emojis_cache').select('url').eq('shortcode', 'authblob').eq('origin_domain', origin).maybeSingle()).data?.url,
      `https://${origin}/real.png`, 'and leaves that instance\'s cache row')

    // Group invites.
    const inviteOf = (conversationId: string, recipient: string) => {
      const to = [`https://${D}/users/${recipient}`]
      return {
        id: activityId(evil.base), type: 'Create', to,
        object: {
          type: 'Note', id: `${evil.base}/group-invites/${crypto.randomUUID()}`, attributedTo: evil.actor('fx_auth_invite'), to, content: 'x',
          metadata: { type: 'group_invite', conversation_id: conversationId, conversation_name: 'Your account' },
        },
      }
    }
    const conversationBy = async (remoteId: string) =>
      (await db.from('conversations').select('id').eq('metadata->>remote_conversation_id', remoteId).maybeSingle()).data

    const { resetSpamConfigCache } = await backend('services/FederationSpamGuard.ts')
    const { data: antispam } = await db.from('instance_config').select('config_value').eq('config_key', 'antispam').maybeSingle()
    const antispamWas = antispam?.config_value ?? null
    const spamMode = async (mode: string) => {
      const set = await db.from('instance_config').upsert(
        { config_key: 'antispam', config_value: { ...(antispamWas ?? {}), federation_spam_mode: mode } }, { onConflict: 'config_key' })
      assert(!set.error, `the spam guard set to ${mode}`, set.error?.message)
      resetSpamConfigCache()
    }
    await spamMode('reject')
    const heldInvite = `https://r.example.test/conversations/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, inviteOf(heldInvite, 'fx_alice'), 'fx_auth_invite'), 202, 'an invite from a new stranger with the guard rejecting is taken (202)')
    await sleep(200)
    eq(await conversationBy(heldInvite), null, 'and makes no conversation')
    await spamMode('off')

    await db.from('profiles').update({ dm_policy: 'following' }).eq('id', ids.alice)
    const refusedInvite = `https://r.example.test/conversations/${crypto.randomUUID()}`
    eq(await asEvil(sharedInbox, inviteOf(refusedInvite, 'fx_alice'), 'fx_auth_invite'), 202, 'an invite to an account limiting who can start a conversation is taken (202)')
    await sleep(200)
    eq(await conversationBy(refusedInvite), null, 'and makes no conversation')
    await db.from('profiles').update({ dm_policy: 'everyone' }).eq('id', ids.alice)

    const existing = await db.from('conversations').insert({ type: 'group', created_by: ids.bob, metadata: { federated: true, remote_conversation_id: `auth-${crypto.randomUUID()}` } }).select('id, metadata').single()
    assert(!existing.error, 'a conversation of other people, known by remote id', existing.error?.message)
    await db.from('conversation_participants').insert({ conversation_id: existing.data?.id, user_id: ids.bob })
    const invitesToAlice = async () => (await ctx.userEvents(db, ids.alice)).filter((e) => JSON.stringify(e).includes('"is_invite"')).length
    const invitesBefore = await invitesToAlice()
    eq(await asEvil(sharedInbox, inviteOf(existing.data?.metadata?.remote_conversation_id, 'fx_alice'), 'fx_auth_invite'), 202, 'an invite naming it is taken (202)')
    await sleep(200)
    const inside = (await db.from('conversation_participants').select('user_id').eq('conversation_id', existing.data?.id)).data ?? []
    eq(inside.length, 1, 'and joins nobody to it')
    eq(await invitesToAlice(), invitesBefore, 'and no notice points fx_alice at it')

    if (antispamWas) await db.from('instance_config').upsert({ config_key: 'antispam', config_value: antispamWas }, { onConflict: 'config_key' })
    else await db.from('instance_config').delete().eq('config_key', 'antispam')
    resetSpamConfigCache()

    // The Group's own real Update still lands at the end, with the copy's other fields.
    eq(await postAsGroup(groupUpdate(activityId(peer.groupUrl), String(copyBefore?.name))), 202, 'the Group names the copy back (202)')
    await sleep(200)
    eq(await copyName(), copyBefore?.name, 'and the name returns')
  } finally {
    peer.extraChannelItems = []
    peer.extraGet = previousExtraGet
    tap.close()
    await db.from('user_roles').delete().eq('user_id', ids.remote).eq('server_id', ids.hostedServer)
    await db.from('server_roles').delete().eq('server_id', ids.hostedServer).eq('name', 'auth-mods')
    await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', READER)
    await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.remote)
    await db.from('federated_instances').delete().eq('domain', reader.host)
    forgetInstanceSoftware(reader.host)
    if (cooking) await db.from('servers').delete().eq('id', cooking)
    await db.from('channels').delete().eq('id', REDIRECTED_CHANNEL)
    await Promise.all([evil.stop(), other.stop(), reader.stop()])
  }
}
