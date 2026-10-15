// Voice moderation across instances (federation-backend voiceModerationFederation.ts,
// 20261017100005_voice_moderation_followups.sql), each way:
//
// Hosting: this instance hosts the private server and the peer's user is a member in its voice
// channel. The owner moves them into a channel @everyone cannot connect to, disconnects them,
// and server-mutes and unmutes them; each reaches the peer's copy of the server as
// harmony:VoiceMemberMove, -Disconnect or -State from the Group, signed with the Group's key,
// which a strict receiver verifies against the Group document this instance serves. The moved
// member's instance then asks for the destination as for any join and the host admits it by
// the move: the token joins LiveKit. Before the move the same join is refused.
//
// Receiving: the peer hosts its private Group, copied here with fx_bob as a member. Its Group
// moves fx_bob between two voice channels of the copy: fx_bob's client is told on his user
// channel to switch, and his switch reaches the peer as a harmony:VoiceChannelJoin. A
// disconnect tells his client to leave; a server mute is stored in the copy, broadcast to its
// rosters and read back by fx_bob. Refused, telling nobody: the Group's activities signed by a
// user, unsigned, from another server's Group or a Group not copied here, for a local account
// that is no member, or for an account of another instance.
//
// Jobs are run by calling the worker's handler with the payload the database queues
// (157_voice_moderation_followups.sql asserts the payloads); the round trip runs no worker.

import crypto from 'node:crypto'
import { createRequire } from 'node:module'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type http from 'node:http'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const VOICE_CONTEXT = [AS, 'https://harmony.social/ns/voice']

// Fixed so a failure names a row.
const HOSTED_LOCKED = 'fed00187-0000-0000-0000-000000000001'
const COPY_VOICE2 = 'fed00187-0000-0000-0000-000000000002'
const OTHER_REF = 'fed00187-0000-0000-0000-000000000003'
const UNKNOWN_REF = 'fed00187-0000-0000-0000-000000000004'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface VoiceModerationFederationContext {
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
  livekit: { url: string; key: string; secret: string; join: (token: string) => Promise<{ close: () => void }> }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  bearer: (authUserId: string) => string
  asUser: (authUserId: string) => SupabaseClient
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  ids: {
    hostedServer: string
    hostedVoice: string
    ownerAuth: string
    remote: string
    bob: string
    bobAuth: string
    carol: string
    remoteRef: string
    remoteVoice: string
  }
}

function rsaKeyPair() {
  return crypto.generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: { type: 'spki', format: 'pem' },
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  })
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

async function userEvents(db: SupabaseClient, profileId: string, type: string): Promise<any[]> {
  const { data, error } = await db.rpc('hmfed_broadcasts', { p_topic: `user:${profileId}` })
  if (error) throw new Error(`hmfed_broadcasts: ${error.message}`)
  return ((data ?? []) as any[]).filter((p) => p?.type === type)
}

export async function caseVoiceModerationFederation(ctx: VoiceModerationFederationContext): Promise<void> {
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const { handleVoiceModerationFederationJob } = await backend('activitypub/voiceModerationFederation.ts')
  const { forgetInstanceSoftware } = await backend('activitypub/instanceSoftware.ts')
  const peerHost = new URL(ctx.peer.base).host
  const { data: known } = await ctx.db.from('federated_instances').select('software').eq('domain', peerHost).maybeSingle()
  await ctx.db.from('federated_instances').upsert({ domain: peerHost, software: 'harmony' }, { onConflict: 'domain' })
  forgetInstanceSoftware(peerHost)
  const previousExtraGet = ctx.peer.extraGet
  try {
    await hosting(ctx, handleVoiceModerationFederationJob)
    await receiving(ctx)
  } finally {
    ctx.peer.extraGet = previousExtraGet
    if (known) await ctx.db.from('federated_instances').update({ software: known.software }).eq('domain', peerHost)
    else await ctx.db.from('federated_instances').delete().eq('domain', peerHost)
    forgetInstanceSoftware(peerHost)
  }
}

async function hosting(ctx: VoiceModerationFederationContext, runJob: (job: Record<string, unknown>) => Promise<void>): Promise<void> {
  console.log('\nvoice moderation of the peer\'s user, hosted here -> the Group tells its instance; the move admits its join')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const channel = (id: string) => `${group}/channels/${id}`
  const copyInbox = `/servers/${ids.hostedServer}/inbox`

  await db.from('channels').delete().eq('id', HOSTED_LOCKED)
  const made = await db.from('channels').insert({ id: HOSTED_LOCKED, server_id: ids.hostedServer, name: 'locked-voice', type: 1 })
  assert(!made.error, 'a voice channel @everyone cannot connect to', made.error?.message)
  const { data: everyone } = await db.from('server_roles').select('id').eq('server_id', ids.hostedServer).eq('is_default', true).single()
  await db.from('channel_permission_overrides').insert({
    channel_id: HOSTED_LOCKED, target_type: 'role', role_id: everyone?.id, allow_permissions: 0, deny_permissions: 2 ** 24,
  })
  await db.from('voice_channel_participants').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  const seated = await db.from('voice_channel_participants').insert({
    channel_id: ids.hostedVoice, server_id: ids.hostedServer, user_id: ids.remote, is_federated: true,
  })
  assert(!seated.error, 'the peer\'s user is in the hosted voice channel', seated.error?.message)

  const moderate = async (route: string, payload: Record<string, unknown>) => {
    const res = await ctx.post(`${localUrl}/api/federation/voice/${route}`, {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.bearer(ids.ownerAuth)}`,
    }, JSON.stringify({ serverId: ids.hostedServer, userId: ids.remote, ...payload }))
    return res.status
  }
  const sentSince = (from: number, type: string) => () =>
    peer.captured.slice(from).find((c) => c.url === copyInbox && body(c).type === type)
  const checkSigned = async (c: Captured | undefined, what: string) => {
    if (!c) return
    const refusal = await strictReceiverRefusal(c, localUrl, instanceDomain)
    assert(refusal === null, `the ${what} is signed with the Group's key, as a strict receiver verifies it`, refusal)
  }
  const join = async (channelId: string) => {
    const id = `${peer.actorUrl}/activities/voice-join/${crypto.randomUUID()}`
    const json = JSON.stringify({
      '@context': VOICE_CONTEXT, id, type: 'harmony:VoiceChannelJoin', actor: peer.actorUrl,
      object: { type: 'harmony:VoiceChannel', id: channel(channelId), name: 'voice' }, target: group,
      published: new Date().toISOString(),
    })
    const from = peer.captured.length
    const status = await deliver(ctx.post, ctx.signedHeaders, `${localUrl}${copyInbox}`, json, peer.key.privateKey, `${peer.actorUrl}#main-key`)
    const answer = await waitFor(() => peer.captured.slice(from)
      .find((c) => c.url === '/inbox' && body(c).type === 'harmony:VoiceChannelJoinAccept' && body(c).object === id), 2000)
    return { status, accept: answer ? body(answer) : undefined }
  }

  const refused = await join(HOSTED_LOCKED)
  eq(refused.status, 202, 'before any move the member\'s join to the locked channel is acknowledged (202)')
  eq(refused.accept, undefined, 'and answered with no token')

  let mark = peer.captured.length
  eq(await moderate('move', { channelId: HOSTED_LOCKED }), 200, 'the owner moves the peer\'s user into the locked channel')
  await runJob({ type: 'update', kind: 'move', server_id: ids.hostedServer, user_id: ids.remote,
    from_channel_id: ids.hostedVoice, channel_id: HOSTED_LOCKED, reason: 'moved' })
  const moved = await waitFor(sentSince(mark, 'harmony:VoiceMemberMove'))
  assert(moved, 'the peer\'s copy of the server receives harmony:VoiceMemberMove')
  if (moved) {
    const m = body(moved)
    eq(m.actor, group, 'from the Group')
    eq(m.object, peer.actorUrl, 'naming the member')
    assert(JSON.stringify(m.to) === JSON.stringify([peer.actorUrl]), 'addressed to the member', JSON.stringify(m.to))
    eq(m.origin, channel(ids.hostedVoice), 'the channel left')
    eq(m.target, channel(HOSTED_LOCKED), 'and the channel to join')
  }
  await checkSigned(moved, 'move')

  const admitted = await join(HOSTED_LOCKED)
  eq(admitted.accept?.result?.roomName, `channel-${HOSTED_LOCKED}`, 'the member\'s instance asks to join as usual and the move admits it')
  if (admitted.accept?.result?.token) {
    const connection = await ctx.livekit.join(admitted.accept.result.token)
    const load = createRequire(path.join(ctx.backendRoot, 'package.json'))
    const sdk = load('livekit-server-sdk')
    const rooms = new sdk.RoomServiceClient(ctx.livekit.url.replace(/^ws/, 'http'), ctx.livekit.key, ctx.livekit.secret)
    const there = (await rooms.listParticipants(`channel-${HOSTED_LOCKED}`)).map((p: any) => p.identity)
    assert(there.includes(`federated:${peer.actorUrl}`), 'its token seats the member in the destination room', JSON.stringify(there))
    connection.close()
  }

  mark = peer.captured.length
  eq(await moderate('move', { channelId: null }), 200, 'the owner disconnects the peer\'s user')
  await runJob({ type: 'update', kind: 'disconnect', server_id: ids.hostedServer, user_id: ids.remote,
    from_channel_id: HOSTED_LOCKED, channel_id: null, reason: 'disconnected' })
  const disconnected = await waitFor(sentSince(mark, 'harmony:VoiceMemberDisconnect'))
  assert(disconnected, 'the peer\'s copy receives harmony:VoiceMemberDisconnect')
  if (disconnected) {
    eq(body(disconnected).origin, channel(HOSTED_LOCKED), 'naming the channel left')
    eq(body(disconnected)['harmony:reason'], 'disconnected', 'and why')
  }
  await checkSigned(disconnected, 'disconnect')

  mark = peer.captured.length
  eq(await moderate('moderation', { mute: true }), 200, 'the owner server-mutes the peer\'s user')
  await runJob({ type: 'update', kind: 'state', server_id: ids.hostedServer, user_id: ids.remote, muted: true, deafened: false })
  const state = await waitFor(sentSince(mark, 'harmony:VoiceMemberState'))
  assert(state && body(state)['harmony:serverMuted'] === true && body(state)['harmony:serverDeafened'] === false,
    'the peer\'s copy receives harmony:VoiceMemberState: muted, not deafened', state ? JSON.stringify(body(state)) : 'nothing')
  await checkSigned(state, 'state')

  mark = peer.captured.length
  eq(await moderate('moderation', { mute: false }), 200, 'the owner lifts the mute')
  await runJob({ type: 'update', kind: 'state', server_id: ids.hostedServer, user_id: ids.remote, muted: false, deafened: false })
  const lifted = await waitFor(sentSince(mark, 'harmony:VoiceMemberState'))
  eq(lifted ? body(lifted)['harmony:serverMuted'] : undefined, false, 'and the lift is sent too')

  mark = peer.captured.length
  await runJob({ type: 'update', kind: 'state', server_id: ids.hostedServer, user_id: ids.carol, muted: true, deafened: false })
  eq(peer.captured.slice(mark).filter((c) => c.url === copyInbox).length, 0, 'a local member\'s state is sent nowhere')

  await db.from('voice_channel_participants').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  await db.from('server_voice_moderation').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.remote)
  await db.from('channels').delete().eq('id', HOSTED_LOCKED)
}

async function receiving(ctx: VoiceModerationFederationContext): Promise<void> {
  console.log('\nvoice moderation from the peer\'s Group, received here -> fx_bob\'s client is told; forgeries tell nobody')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const bobUrl = `https://${instanceDomain}/users/fx_bob`
  const carolUrl = `https://${instanceDomain}/users/fx_carol`
  const copyInbox = (serverId: string) => `${localUrl}/servers/${serverId}/inbox`
  const sharedInbox = `${localUrl}/inbox`
  const otherGroup = `${peer.base}/servers/${OTHER_REF}`
  const unknownGroup = `${peer.base}/servers/${UNKNOWN_REF}`
  const otherKey = rsaKeyPair()
  const unknownKey = rsaKeyPair()

  const groupDoc = (id: string, publicKeyPem: string) => ({
    '@context': AS, id, type: 'Group', name: 'peer group', inbox: `${id}/inbox`,
    publicKey: { id: `${id}#main-key`, owner: id, publicKeyPem },
  })
  peer.extraGet = (req, res) => {
    const doc = req.url === `/servers/${OTHER_REF}` ? groupDoc(otherGroup, otherKey.publicKey)
      : req.url === `/servers/${UNKNOWN_REF}` ? groupDoc(unknownGroup, unknownKey.publicKey) : null
    if (!doc) return false
    res.writeHead(200, { 'Content-Type': 'application/activity+json' })
    res.end(JSON.stringify(doc))
    return true
  }

  await db.from('channels').delete().eq('id', COPY_VOICE2)
  await db.from('servers').delete().eq('id', OTHER_REF)
  const ch = await db.from('channels').insert({
    id: COPY_VOICE2, server_id: ids.remoteRef, name: 'peer-voice-2', type: 1, is_remote: true, ap_id: peer.channelUrl(COPY_VOICE2),
  })
  assert(!ch.error, 'the copy of the peer\'s Group has a second voice channel', ch.error?.message)
  const peerHost = new URL(peer.base).host
  const other = await db.from('servers').insert({
    id: OTHER_REF, name: 'Peer other', owner: ids.remote, public: false, is_local_server: false, federation_enabled: true,
    ap_id: otherGroup, federation_inbox_url: `${otherGroup}/inbox`, federation_domain: peerHost, host_domain: peerHost,
  })
  assert(!other.error, 'and another server of the peer is copied here', other.error?.message)

  const activity = (groupUrl: string, type: string, extra: Record<string, unknown>) => JSON.stringify({
    '@context': VOICE_CONTEXT, id: `${groupUrl}/voice-moderation/${crypto.randomUUID()}`, type, actor: groupUrl,
    to: [bobUrl], object: bobUrl, published: new Date().toISOString(), ...extra,
  })
  const move = (groupUrl = peer.groupUrl, extra: Record<string, unknown> = {}) => activity(groupUrl, 'harmony:VoiceMemberMove', {
    origin: peer.channelUrl(ids.remoteVoice), target: peer.channelUrl(COPY_VOICE2), 'harmony:reason': 'moved', ...extra,
  })
  const asGroup = (url: string, json: string) =>
    deliver(ctx.post, ctx.signedHeaders, url, json, peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
  const moves = async (profileId: string) => userEvents(db, profileId, 'voice:moved')

  const before = (await moves(ids.bob)).length
  eq(await asGroup(copyInbox(ids.remoteRef), move()), 202, 'the Group\'s harmony:VoiceMemberMove is taken at the copy\'s inbox (202)')
  const told = (await moves(ids.bob)).slice(before)
  assert(told.length === 1 && told[0].server_id === ids.remoteRef && told[0].from_channel_id === ids.remoteVoice
    && told[0].channel_id === COPY_VOICE2 && told[0].reason === 'moved',
  'fx_bob\'s client is told to switch to the copy\'s channel', JSON.stringify(told))

  const mark = peer.captured.length
  const switched = await ctx.post(`${localUrl}/api/federation/voice/join`, {
    'Content-Type': 'application/json', Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}`,
  }, JSON.stringify({ channelId: COPY_VOICE2, serverId: ids.remoteRef }))
  eq(switched.status, 200, 'switching, fx_bob\'s client asks for the destination')
  const asked = peer.captured.slice(mark).find((c) => c.url === `/servers/${ids.remoteRef}/inbox`)
  assert(asked && body(asked).type === 'harmony:VoiceChannelJoin' && body(asked).object?.id === peer.channelUrl(COPY_VOICE2),
    'and the host receives his harmony:VoiceChannelJoin for it, for its token', asked ? JSON.stringify(body(asked)).slice(0, 200) : 'nothing')

  eq(await asGroup(copyInbox(ids.remoteRef), activity(peer.groupUrl, 'harmony:VoiceMemberDisconnect', {
    origin: peer.channelUrl(COPY_VOICE2), 'harmony:reason': 'disconnected',
  })), 202, 'the Group\'s harmony:VoiceMemberDisconnect is taken (202)')
  const left = (await moves(ids.bob)).at(-1)
  assert(left?.channel_id === null && left?.from_channel_id === COPY_VOICE2 && left?.reason === 'disconnected',
    'fx_bob\'s client is told to leave voice', JSON.stringify(left))

  const flags = async () => (await db.from('server_voice_moderation').select('muted, deafened')
    .eq('server_id', ids.remoteRef).eq('user_id', ids.bob).maybeSingle()).data
  eq(await asGroup(copyInbox(ids.remoteRef), activity(peer.groupUrl, 'harmony:VoiceMemberState', {
    'harmony:serverMuted': true, 'harmony:serverDeafened': false,
  })), 202, 'the Group\'s harmony:VoiceMemberState is taken (202)')
  eq(JSON.stringify(await flags()), JSON.stringify({ muted: true, deafened: false }), 'the server mute is stored in the copy')
  const { data: read } = await ctx.asUser(ids.bobAuth).rpc('get_server_voice_moderation', { p_server_id: ids.remoteRef })
  assert(Array.isArray(read) && read.some((r: any) => r.user_id === ids.bob && r.muted === true),
    'fx_bob reads it, as the copy\'s rosters do', JSON.stringify(read))
  const { data: roster } = await db.rpc('hmfed_broadcasts', { p_topic: `voice-channels:${ids.remoteRef}` })
  assert(((roster ?? []) as any[]).some((p) => p?.event === 'voice-moderation' && p?.userId === ids.bob && p?.muted === true),
    'the copy\'s rosters are told', JSON.stringify(roster).slice(0, 200))
  assert((await userEvents(db, ids.bob, 'voice:moderation')).some((e) => e.server_id === ids.remoteRef && e.muted === true),
    'and so is fx_bob\'s own client, whose controls lock')

  eq(await asGroup(sharedInbox, activity(peer.groupUrl, 'harmony:VoiceMemberState', {
    'harmony:serverMuted': false, 'harmony:serverDeafened': false,
  })), 202, 'the Group\'s state is taken at the shared inbox too (202)')
  eq(await flags(), null, 'and lifts the mute')

  // Refused.
  const counts = async () => [
    (await moves(ids.bob)).length, (await moves(ids.carol)).length, (await moves(ids.remote)).length,
  ].join(',')
  const quiet = await counts()

  const forged = move()
  const asUser = (url: string) => deliver(ctx.post, ctx.signedHeaders, url, forged, peer.key.privateKey, `${peer.actorUrl}#main-key`)
  eq(await asUser(copyInbox(ids.remoteRef)), 403, 'the Group\'s move signed by a user is refused at the copy\'s inbox (403)')
  eq(await asUser(sharedInbox), 403, 'and at the shared inbox (403)')
  const unsigned = await ctx.post(copyInbox(ids.remoteRef), { 'Content-Type': 'application/activity+json' }, move())
  eq(unsigned.status, 401, 'an unsigned one is refused (401)')

  const asOther = (url: string) => deliver(ctx.post, ctx.signedHeaders, url, move(otherGroup), otherKey.privateKey, `${otherGroup}#main-key`)
  eq(await asOther(copyInbox(ids.remoteRef)), 202, 'another server\'s Group is acknowledged at this server\'s copy (202)')
  eq(await asOther(copyInbox(OTHER_REF)), 202, 'and at its own copy, naming this server\'s channels (202)')
  eq(await asOther(sharedInbox), 202, 'and at the shared inbox (202)')
  eq(await deliver(ctx.post, ctx.signedHeaders, sharedInbox, move(unknownGroup), unknownKey.privateKey, `${unknownGroup}#main-key`), 202,
    'a Group not copied here is acknowledged (202)')

  eq(await asGroup(copyInbox(ids.remoteRef), move(peer.groupUrl, { object: carolUrl, to: [carolUrl] })), 202,
    'the Group\'s move of a local account that is no member is acknowledged (202)')
  eq(await asGroup(copyInbox(ids.remoteRef), move(peer.groupUrl, { object: peer.actorUrl, to: [peer.actorUrl] })), 202,
    'and of an account of another instance (202)')
  eq(await counts(), quiet, 'none of them tells any client anything')

  await db.from('servers').delete().eq('id', OTHER_REF)
  await db.from('channels').delete().eq('id', COPY_VOICE2)
}
