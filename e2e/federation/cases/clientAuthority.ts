// What a client or an anonymous caller may name, through PostgREST under RLS and the backend's
// routes (migration 20261109600001).
//
//   - /fetch-reactions and its batch write only to the remote post whose id and URL both match; a
//     local or unrelated post keeps its row, and a followers-only post answers no anonymous caller;
//   - a thread keeps its creator, federation id, channel and parent: a rename leaves under the real
//     creator's key, and nothing leaves under another's;
//   - an activity id a client tries to plant does not drop the real delivery;
//   - a remote identity is not created by a client;
//   - anon and non-members read no one's permissions or rank; members read each other's;
//   - a reaction or favourite needs a post the caller reads;
//   - a copy's cached rows follow can_view_channel, and exclude deleted ones.

import crypto from 'node:crypto'
import http from 'node:http'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { JobTap } from './outboundFederation.ts'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const VIEW_CHANNEL = 2
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

class DocHost {
  docs: Record<string, unknown> = {}
  gets: string[] = []
  base = ''
  private server?: http.Server

  async start(hostname: string): Promise<void> {
    this.server = http.createServer((req, res) => {
      this.gets.push(req.url ?? '')
      const doc = this.docs[req.url ?? '']
      res.writeHead(doc ? 200 : 404, { 'Content-Type': 'application/activity+json' })
      res.end(doc ? JSON.stringify(doc) : undefined)
    })
    await new Promise<void>((resolve) => this.server!.listen(0, hostname, () => resolve()))
    this.base = `http://${hostname}:${(this.server.address() as { port: number }).port}`
  }
  async stop() {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()))
  }
}

export interface ClientAuthorityContext {
  db: SupabaseClient
  anon: SupabaseClient
  asUser: (authUserId: string) => SupabaseClient
  bearer: (authUserId: string) => string
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    captured: Array<{ url: string; headers: Record<string, string>; raw: Buffer }>
    extraGet?: (req: http.IncomingMessage, res: http.ServerResponse) => boolean
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  ids: {
    alice: string
    aliceAuth: string
    bob: string
    bobAuth: string
    carol: string
    carolAuth: string
    remote: string
    hostedServer: string
    remoteRef: string
  }
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseClientAuthority(ctx: ClientAuthorityContext): Promise<void> {
  console.log('\nClient authority -> what a client or anonymous caller names is checked against the caller')
  const { db, anon, peer, ids, localUrl, assert, eq } = ctx
  const D = ctx.instanceDomain
  const peerHost = new URL(peer.base).host
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const json = { 'Content-Type': 'application/json', Accept: 'application/json' }
  const carol = ctx.asUser(ids.carolAuth)
  const alice = ctx.asUser(ids.aliceAuth)
  const keyIdOf = (signature: unknown) => /keyId="([^"]+)"/.exec(String(signature ?? ''))?.[1] ?? null

  const evil = new DocHost()
  await evil.start(new URL(peer.base).hostname)
  const tap = await JobTap.open(process.env.HMFED_PROJECT ?? 'hmfed')
  const previousExtraGet = peer.extraGet
  const servers: string[] = []
  const posts: string[] = []
  const newServer = async (name: string, owner: string): Promise<{ server: string; channel: string }> => {
    const server = crypto.randomUUID()
    const channel = crypto.randomUUID()
    const a = await db.from('servers').insert({ id: server, name, owner, federation_enabled: true })
    const b = await db.from('channels').insert({ id: channel, server_id: server, name: 'general', type: 0 })
    assert(!a.error && !b.error, `seed ${name}`, a.error?.message ?? b.error?.message)
    servers.push(server)
    return { server, channel }
  }

  try {
    // /fetch-reactions -----------------------------------------------------------------------
    const note = `${evil.base}/objects/n1`
    evil.docs['/objects/n1'] = {
      '@context': AS, id: note, type: 'Note', attributedTo: `${evil.base}/users/x`,
      likes: {
        type: 'Collection', totalItems: 999,
        items: [{
          type: 'EmojiReaction', actor: `${evil.base}/users/x`, content: ':forged:',
          tag: [{ type: 'Emoji', name: ':forged:', icon: { type: 'Image', url: 'https://evil.example/e.png' } }],
        }],
      },
    }
    const direct = crypto.randomUUID()
    const publicLocal = crypto.randomUUID()
    const heldRemote = crypto.randomUUID()
    const privateRemote = crypto.randomUUID()
    posts.push(direct, publicLocal, heldRemote, privateRemote)
    const seeded = await db.from('posts').insert([
      { id: direct, author_id: ids.alice, content: [{ type: 'text', text: 'to alice' }], visibility: 'direct', is_local: true, metadata: {} },
      { id: publicLocal, author_id: ids.alice, content: [{ type: 'text', text: 'public' }], visibility: 'public', is_local: true, metadata: {} },
      { id: heldRemote, author_id: ids.remote, content: [{ type: 'text', text: 'remote' }], visibility: 'public', is_local: false, ap_id: note, metadata: {} },
      { id: privateRemote, author_id: ids.remote, content: [{ type: 'text', text: 'followers' }], visibility: 'followers', is_local: false,
        ap_id: `${evil.base}/objects/private`, metadata: { remote_reactions: { ':held:': { count: 1, reactors: [] } }, remote_reactions_fetched_at: new Date().toISOString() } },
    ])
    assert(!seeded.error, 'seed posts for the reactions routes', seeded.error?.message)
    const reactionsOf = async (id: string) =>
      (await db.from('posts').select('metadata, remote_favorites_count').eq('id', id).single()).data as any
    const fetchReactions = (post_ap_id: string, post_id: string) =>
      ctx.post(`${localUrl}/fetch-reactions`, json, JSON.stringify({ post_ap_id, post_id }))

    eq((await fetchReactions(note, direct)).status, 200, 'an anonymous request naming a private post by id is answered')
    let row = await reactionsOf(direct)
    eq(row?.metadata?.remote_reactions ?? null, null, 'and writes no reactions onto it')
    eq(row?.remote_favorites_count ?? null, null, 'nor counts')
    const named = await fetchReactions('https://unrelated.example/x', direct)
    assert(!named.body.includes('cached'), 'a later request naming it reads nothing back', named.body)
    eq((await fetchReactions(note, publicLocal)).status, 200, 'naming a public local post is answered')
    eq((await reactionsOf(publicLocal))?.metadata?.remote_reactions ?? null, null, 'and leaves it')
    eq((await ctx.post(`${localUrl}/fetch-reactions-batch`, json, JSON.stringify({ posts: [{ post_ap_id: note, post_id: direct }] }))).status,
      200, 'the batch route answers the same request')
    eq((await reactionsOf(direct))?.metadata?.remote_reactions ?? null, null, 'and leaves the post')
    const privateRead = await fetchReactions(`${evil.base}/objects/private`, privateRemote)
    assert(!privateRead.body.includes(':held:'), 'a followers-only post\'s stored reactions go to no anonymous caller', privateRead.body)
    eq((await fetchReactions(note, heldRemote)).status, 200, 'the remote post the URL names is answered')
    assert((await reactionsOf(heldRemote))?.metadata?.remote_reactions, 'and takes its reactions')

    // Threads --------------------------------------------------------------------------------
    const own = await newServer('carol srv', ids.carol)
    const member = await db.from('user_servers').insert({ server_id: own.server, user_id: ids.remote, status: 'accepted', member_instance: peerHost })
    assert(!member.error, 'a member from the peer', member.error?.message)
    const created = await carol.rpc('create_channel_thread', { p_channel_id: own.channel, p_name: 'by carol' })
    assert(!created.error, 'fx_carol creates a thread', created.error?.message)
    const thread = created.data as string
    const threadRow = async () => (await db.from('threads').select('created_by, ap_id, channel_id, parent_message_id').eq('id', thread).single()).data as any
    const before = await threadRow()
    const refused = async (patch: Record<string, unknown>, what: string) => {
      const r = await carol.from('threads').update(patch).eq('id', thread).select('id')
      assert(r.error, `${what} is refused`, JSON.stringify(r.data))
    }
    await refused({ created_by: ids.alice }, 'naming another creator')
    await refused({ ap_id: `${peer.base}/threads/alices`, name: 'renamed' }, 'naming a federation id')
    eq(await tap.take((j) => j.name === 'federate-thread' && j.data?.thread_id === thread && j.data?.type === 'update', 1000), null, 'no Update is queued for either')

    const other = await newServer('victim srv', ids.alice)
    await db.from('user_servers').upsert([
      { server_id: other.server, user_id: ids.carol, status: 'accepted' },
      { server_id: other.server, user_id: ids.bob, status: 'accepted' },
    ], { onConflict: 'user_id,server_id' })
    await refused({ channel_id: other.channel }, 'moving it into another server')
    const parent = await db.from('messages').insert({ channel_id: own.channel, user_id: ids.remote, content: [{ type: 'text', text: 'remote note' }] }).select('id').single()
    assert(!parent.error, 'a message of another member', parent.error?.message)
    await refused({ parent_message_id: parent.data?.id }, 'taking another message as its parent')
    eq(JSON.stringify(await threadRow()), JSON.stringify(before), 'the row is unchanged')

    const renamed = await carol.from('threads').update({ name: 'renamed by carol' }).eq('id', thread).select('name').single()
    assert(!renamed.error, 'the creator renames it', renamed.error?.message)
    const job = await tap.take((j) => j.name === 'federate-thread' && j.data?.thread_id === thread && j.data?.type === 'update', 4000)
    assert(job, 'and an Update is queued')
    if (job) {
      const n = peer.captured.length
      const { handleThreadJob } = await backend('queue/handlers/threadHandler.ts')
      await handleThreadJob(job.data)
      for (let i = 0; i < 40 && peer.captured.length === n; i++) await sleep(100)
      const sent = peer.captured.slice(n)[0]
      const body = sent ? JSON.parse(sent.raw.toString('utf-8')) : null
      eq(body?.actor, `https://${D}/users/fx_carol`, 'under the creator\'s actor')
      eq(keyIdOf(sent?.headers?.signature), `https://${D}/users/fx_carol#main-key`, 'and key')
    }

    // The dedupe ledger ----------------------------------------------------------------------
    const planted = `${peer.base}/activities/${crypto.randomUUID()}`
    const plant = await carol.from('ap_activities').insert({
      ap_id: planted, ap_type: 'Follow', actor_id: ids.carol, actor_ap_id: peer.actorUrl,
      activity_data: { id: planted }, status: 'completed', is_local: false, origin_domain: peerHost,
    })
    assert(plant.error, 'a client plants no activity id')
    await db.from('follows').delete().eq('follower_id', ids.remote).eq('following_id', ids.alice)
    const follow = JSON.stringify({ '@context': AS, id: planted, type: 'Follow', actor: peer.actorUrl, object: `https://${D}/users/fx_alice` })
    eq(await deliver(ctx.post, ctx.signedHeaders, `${localUrl}/inbox`, follow, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202, 'the real Follow under that id is taken (202)')
    await sleep(500)
    assert((await db.from('follows').select('id').eq('follower_id', ids.remote).eq('following_id', ids.alice)).data?.length, 'and lands')

    // Remote identity ------------------------------------------------------------------------
    const squat = await carol.rpc('create_federated_profile', {
      p_username: 'realuser', p_display_name: 'Trusted Person', p_domain: 'squat.example',
      p_avatar_url: 'https://evil.example/a.png', p_federated_id: 'https://squat.example/users/realuser', p_bio: 'attacker text',
    })
    assert(squat.error, 'a client creates no remote profile')
    eq((await db.from('profiles').select('id').eq('federated_id', 'https://squat.example/users/realuser').maybeSingle()).data, null, 'and none is stored')

    // Permission lookups ---------------------------------------------------------------------
    const lookup = (client: SupabaseClient, user: string) =>
      client.rpc('has_permission', { p_user_id: user, p_server_id: ids.hostedServer, p_permission: 'VIEW_CHANNEL' })
    eq((await lookup(anon, ids.alice)).data, false, 'anon reads nothing about the owner of a private server')
    eq((await anon.rpc('get_user_highest_role_position', { p_user_id: ids.alice, p_server_id: ids.hostedServer })).data, 0, 'nor their rank')
    assert((await anon.rpc('get_default_channel', { p_server_id: ids.hostedServer })).error, 'nor a channel id')
    const closedServer = await newServer('closed srv', ids.alice)
    const staff = (await db.from('profiles').select('is_admin, is_moderator').eq('id', ids.carol).single()).data
    assert(!staff?.is_admin && !staff?.is_moderator, 'fx_carol is no instance staff here', JSON.stringify(staff))
    eq((await carol.rpc('has_permission', { p_user_id: ids.alice, p_server_id: closedServer.server, p_permission: 'VIEW_CHANNEL' })).data,
      false, 'a non-member reads nothing about a member')
    eq((await carol.rpc('get_user_highest_role_position', { p_user_id: ids.alice, p_server_id: closedServer.server })).data, 0, 'nor their rank')
    eq((await lookup(alice, ids.alice)).data, true, 'the owner reads their own')
    eq((await ctx.asUser(ids.carolAuth).rpc('has_permission', { p_user_id: ids.alice, p_server_id: other.server, p_permission: 'VIEW_CHANNEL' })).data,
      true, 'a member reads another member\'s')

    // Reactions ------------------------------------------------------------------------------
    const reaction = await carol.rpc('add_post_emoji_reaction', { p_user_id: ids.carol, p_post_id: direct, p_custom_emoji_content: '👍' })
    assert(reaction.error, 'no reaction on a post the caller cannot read')
    assert((await carol.from('post_interactions').insert({ user_id: ids.carol, post_id: direct, interaction_type: 'favorite' })).error, 'nor a favourite')
    eq((await db.from('posts').select('favorites_count').eq('id', direct).single()).data?.favorites_count ?? 0, 0, 'its count stays')
    assert(!(await carol.rpc('add_post_emoji_reaction', { p_user_id: ids.carol, p_post_id: publicLocal, p_custom_emoji_content: '👍' })).error, 'a public post takes one')

    // A copy's cached rows -------------------------------------------------------------------
    const open = crypto.randomUUID()
    const closed = crypto.randomUUID()
    const opened = await db.from('channels').insert([
      { id: open, server_id: ids.remoteRef, name: 'cached-open', type: 0, is_remote: true, ap_id: peer.channelUrl(open) },
      { id: closed, server_id: ids.remoteRef, name: 'cached-closed', type: 0, is_remote: true, ap_id: peer.channelUrl(closed) },
    ])
    assert(!opened.error, 'two channels of the copy', opened.error?.message)
    const everyone = await db.from('server_roles').select('id').eq('server_id', ids.remoteRef).eq('is_default', true).maybeSingle()
    if (everyone.data?.id) {
      await db.from('channel_permission_overrides').insert({ channel_id: closed, target_type: 'role', role_id: everyone.data.id, allow_permissions: 0, deny_permissions: VIEW_CHANNEL })
    }
    const seedRows = await db.from('messages').insert([
      { channel_id: open, user_id: ids.remote, content: [{ type: 'text', text: 'cached open' }], metadata: { federated: true }, federation_status: 'skipped' },
      { channel_id: open, user_id: ids.remote, content: [{ type: 'text', text: 'cached deleted' }], metadata: { federated: true }, federation_status: 'skipped', is_deleted: true },
      { channel_id: closed, user_id: ids.remote, content: [{ type: 'text', text: 'cached closed' }], metadata: { federated: true }, federation_status: 'skipped' },
    ])
    assert(!seedRows.error, 'cached rows in both', seedRows.error?.message)
    peer.extraGet = (req, res) => {
      if (!/\/channels\/[^/]+\/messages/.test(req.url ?? '') || !(req.url ?? '').includes(open) && !(req.url ?? '').includes(closed)) return false
      res.writeHead(500)
      res.end()
      return true
    }
    const bobHeaders = { Accept: 'application/json', Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}` }
    const openRead = await ctx.get(`${localUrl}/channels/${open}/messages`, bobHeaders)
    eq(openRead.json?.source, 'cache', 'the host failing, a member reads the channel\'s cached rows')
    assert(openRead.body.includes('cached open') && !openRead.body.includes('cached deleted'), 'without the deleted ones', openRead.body)
    if (everyone.data?.id) {
      const closedRead = await ctx.get(`${localUrl}/channels/${closed}/messages`, bobHeaders)
      assert(!closedRead.body.includes('cached closed'), 'a channel the member cannot view serves none', closedRead.body)
    }
    peer.extraGet = previousExtraGet
    await db.from('channels').delete().in('id', [open, closed])
  } finally {
    peer.extraGet = previousExtraGet
    tap.close()
    await db.from('follows').delete().eq('follower_id', ids.remote).eq('following_id', ids.alice)
    if (posts.length) await db.from('posts').delete().in('id', posts)
    if (servers.length) await db.from('servers').delete().in('id', servers)
    await evil.stop()
  }
}
