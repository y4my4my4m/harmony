// A channel's encryption and privacy on its copies, and encrypted voice closed to other instances
// (activitypub/channelFlags.ts, migration 20261109900001), both directions.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - the Group document and the channel document carry harmony:encryption and harmony:private for
//     a channel holding them, and neither key for a plain channel; so do a channel's Add and Update
//     and a category's Update;
//   - a join to an encrypted voice channel is answered with the Reject naming encryption, no token
//     and no presence row; a plain channel is joined, and turning encryption on there queues a grant
//     resync that drops the participant;
//   - /api/livekit/federated-token refuses the encrypted channel;
//   - a member's plaintext message to an encrypted channel is not stored, and is to a plain one.
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - a sync, a Group's Add and a Group's Update store channels.host_flags and
//     channel_categories.host_flags; a document without the properties clears them;
//   - an Update signed by a member changes nothing;
//   - a host before 1.9.5 sends neither, and leaves the copy at '{}'.
//
// The BullMQ worker is not part of this harness: the job handlers are called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }
const REFUSAL = 'This channel is end-to-end encrypted on its home instance, so accounts from other instances cannot join its calls.'

// Fixed so a failure names a row.
const T_ENC = 'fed00253-0000-0000-0000-000000000001'
const T_PLAIN = 'fed00253-0000-0000-0000-000000000002'
const V_ENC = 'fed00253-0000-0000-0000-000000000003'
const V_PLAIN = 'fed00253-0000-0000-0000-000000000004'
const T_PRIV = 'fed00253-0000-0000-0000-000000000005'
const C_PRIV = 'fed00253-0000-0000-0000-000000000006'
const P_VOICE = 'fed00253-0000-0000-0000-000000000011'
const P_ADDED = 'fed00253-0000-0000-0000-000000000012'
const P_CATEGORY = 'fed00253-0000-0000-0000-000000000013'
const HOSTED_CHANNELS = [T_ENC, T_PLAIN, V_ENC, V_PLAIN, T_PRIV]

interface Captured {
  url: string
  raw: Buffer
}

export interface ChannelHostFlagsContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraGroupFields: Record<string, unknown>
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: { bob: string; remote: string; hostedServer: string; remoteRef: string; remoteChannel: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function poll<T>(find: () => Promise<T | null | undefined> | T | null | undefined, ms = 5000): Promise<T | null | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = await find()
    if (got || Date.now() > until) return got
    await sleep(100)
  }
}

const flagKeys = (doc: Record<string, unknown> | undefined) =>
  Object.keys(doc ?? {}).filter((k) => k === 'harmony:encryption' || k === 'harmony:private').sort()

export async function caseChannelHostFlags(ctx: ChannelHostFlagsContext): Promise<void> {
  console.log('\nChannel flags -> encryption and privacy reach copies; encrypted voice refuses other instances')
  const backend = (p: string): Promise<any> => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  try {
    await hostedHere(ctx, backend)
    await hostedByPeer(ctx, backend)
  } finally {
    const { db, peer, ids } = ctx
    peer.extraGroupFields = {}
    await db.from('voice_channel_participants').delete().in('channel_id', HOSTED_CHANNELS)
    await db.from('voice_grant_resyncs').delete().in('channel_id', HOSTED_CHANNELS)
    await db.from('channels').delete().in('id', [...HOSTED_CHANNELS, P_VOICE, P_ADDED])
    await db.from('channel_categories').delete().in('id', [C_PRIV, P_CATEGORY])
    await db.from('server_encryption_settings').delete().eq('server_id', ids.hostedServer)
    await db.from('channels').update({ host_flags: {} }).eq('id', ids.remoteChannel)
  }
}

async function hostedHere(ctx: ChannelHostFlagsContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const channelUrl = (id: string) => `${group}/channels/${id}`
  const inbox = `${localUrl}/servers/${ids.hostedServer}/inbox`
  const asMember = (activity: Record<string, unknown>) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(activity),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const signedGet = (url: string) => ctx.get(url, ctx.signedGetHeaders(url, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  const sentSince = (n: number) => peer.captured.slice(n).map((c) => JSON.parse(c.raw.toString('utf-8')))

  const fed = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!fed.error, 'federate the hosted server', fed.error?.message)
  await db.from('channels').delete().in('id', HOSTED_CHANNELS)
  await db.from('channel_categories').delete().eq('id', C_PRIV)

  const policy = await db.from('server_encryption_settings').upsert(
    { server_id: ids.hostedServer, encryption_mode: 'optional', voice_encryption_mode: 'disabled' },
    { onConflict: 'server_id' },
  )
  assert(!policy.error, 'the server leaves encryption to each channel', policy.error?.message)
  const category = await db.from('channel_categories').insert({ id: C_PRIV, server_id: ids.hostedServer, name: 'flags-hidden', order: 60 })
  assert(!category.error, 'seed the private category', category.error?.message)
  const seeded = await db.from('channels').insert([
    { id: T_ENC, server_id: ids.hostedServer, name: 'flags-text-encrypted', type: 0 },
    { id: T_PLAIN, server_id: ids.hostedServer, name: 'flags-text-plain', type: 0 },
    { id: V_ENC, server_id: ids.hostedServer, name: 'flags-voice-encrypted', type: 1 },
    { id: V_PLAIN, server_id: ids.hostedServer, name: 'flags-voice-plain', type: 1 },
    { id: T_PRIV, server_id: ids.hostedServer, name: 'flags-text-private', type: 0, category: C_PRIV },
  ])
  assert(!seeded.error, 'seed the channels', seeded.error?.message)
  const encryptedText = await db.from('channel_encryption_settings').update({ messages_encrypted: true }).eq('channel_id', T_ENC)
  assert(!encryptedText.error, 'encrypt a text channel\'s messages', encryptedText.error?.message)
  const encryptedVoice = await db.from('channel_encryption_settings').update({ voice_encrypted: true }).eq('channel_id', V_ENC)
  assert(!encryptedVoice.error, 'encrypt a voice channel\'s voice', encryptedVoice.error?.message)

  // Every member the peer hosts views the private channel, so the peer's copy may hold it.
  const { data: everyone } = await db.from('server_roles').select('id').eq('server_id', ids.hostedServer).eq('is_default', true).single()
  const { data: peerMembers } = await db.from('user_servers')
    .select('user_id, profiles!inner(domain, is_local)')
    .eq('server_id', ids.hostedServer).eq('status', 'accepted')
    .eq('profiles.is_local', false).eq('profiles.domain', new URL(peer.actorUrl).host)
  const memberIds = [...new Set([ids.remote, ...(peerMembers ?? []).map((m: any) => m.user_id as string)])]
  const hidden = await db.from('channel_permission_overrides').insert([
    { channel_id: T_PRIV, target_type: 'role', role_id: everyone?.id, allow_permissions: 0, deny_permissions: 2 },
    ...memberIds.map((id) => ({ channel_id: T_PRIV, target_type: 'user', user_id: id, allow_permissions: 2, deny_permissions: 0 })),
  ])
  assert(!hidden.error, 'hide a channel from @everyone and show it to the peer\'s members', hidden.error?.message)
  const hiddenCategory = await db.from('channel_category_permission_overrides').insert({
    category_id: C_PRIV, target_type: 'role', role_id: everyone?.id, allow_permissions: 0, deny_permissions: 2,
  })
  assert(!hiddenCategory.error, 'hide the category from @everyone', hiddenCategory.error?.message)

  // Documents.
  const doc = await signedGet(`${localUrl}/servers/${ids.hostedServer}`)
  const entry = (id: string) => (doc.json?.['harmony:channels'] ?? []).find((c: any) => c.localId === id)
  assert(entry(T_ENC), 'the Group document lists the encrypted channel', doc.status)
  eq(JSON.stringify(entry(T_ENC)?.['harmony:encryption']), '{"messages":true}', 'its entry carries the messages flag')
  eq(JSON.stringify(entry(V_ENC)?.['harmony:encryption']), '{"voice":true}', 'a voice channel\'s entry carries the voice flag')
  eq(flagKeys(entry(T_PLAIN)).length, 0, 'a plain text channel\'s entry has neither key')
  eq(flagKeys(entry(V_PLAIN)).length, 0, 'nor has a plain voice channel\'s')
  eq(entry(T_PRIV)?.['harmony:private'], true, 'a channel @everyone cannot view carries harmony:private')
  eq(entry(C_PRIV)?.['harmony:private'], true, 'as does such a category')
  assert(!('harmony:encryption' in (entry(C_PRIV) ?? {})), 'and a category carries no encryption')

  const channelDoc = await signedGet(`${localUrl}/servers/${ids.hostedServer}/channels/${V_ENC}`)
  eq(JSON.stringify(channelDoc.json?.['harmony:encryption']), '{"voice":true}', 'the channel document carries the flag')
  const plainDoc = await signedGet(`${localUrl}/servers/${ids.hostedServer}/channels/${V_PLAIN}`)
  eq(plainDoc.status, 200, 'the plain channel document is served')
  eq(flagKeys(plainDoc.json).length, 0, 'with neither key')

  // Activities, as the worker runs them.
  const { handleChannelCrudJob, handleCategoryCrudJob } = await backend('queue/handlers/serverStructureHandler.ts')
  const objectFor = (n: number, type: string, id: string) => () =>
    sentSince(n).find((a) => a.type === type && a.object?.id === channelUrl(id))?.object
  let n = peer.captured.length
  await handleChannelCrudJob({ type: 'update', channel_id: V_ENC, server_id: ids.hostedServer })
  const update = await poll(objectFor(n, 'Update', V_ENC))
  eq(JSON.stringify(update?.['harmony:encryption']), '{"voice":true}', 'the channel\'s Update carries the flag')
  await handleChannelCrudJob({ type: 'create', channel_id: T_ENC, server_id: ids.hostedServer })
  const add = await poll(objectFor(n, 'Add', T_ENC))
  eq(JSON.stringify(add?.['harmony:encryption']), '{"messages":true}', 'as does its Add')
  await handleChannelCrudJob({ type: 'update', channel_id: V_PLAIN, server_id: ids.hostedServer })
  const plainUpdate = await poll(objectFor(n, 'Update', V_PLAIN))
  assert(plainUpdate, 'a plain channel\'s Update reaches the peer')
  eq(flagKeys(plainUpdate as any).length, 0, 'with neither key')
  await handleCategoryCrudJob({ type: 'update', category_id: C_PRIV, server_id: ids.hostedServer })
  const categoryUpdate = await poll(objectFor(n, 'Update', C_PRIV))
  eq(categoryUpdate?.['harmony:private'], true, 'a category\'s Update carries harmony:private')

  // Voice.
  const join = async (channelId: string) => {
    const id = `${peer.actorUrl}/activities/voice-join/${crypto.randomUUID()}`
    const from = peer.captured.length
    const status = await asMember({
      '@context': [AS, HARMONY], id, type: 'harmony:VoiceChannelJoin', actor: peer.actorUrl,
      object: { type: 'harmony:VoiceChannel', id: channelUrl(channelId), name: 'voice' }, target: group,
      published: new Date().toISOString(),
    })
    const answer = await poll(() => sentSince(from).find((a) =>
      a.object === id && (a.type === 'harmony:VoiceChannelJoinAccept' || a.type === 'harmony:VoiceChannelJoinReject')))
    return { status, answer: answer as any }
  }
  const seated = async (channelId: string) => (await db.from('voice_channel_participants')
    .select('user_id').eq('channel_id', channelId).eq('user_id', ids.remote).maybeSingle()).data

  const refused = await join(V_ENC)
  eq(refused.status, 202, 'a member\'s join to an encrypted voice channel is acknowledged (202)')
  eq(refused.answer?.type, 'harmony:VoiceChannelJoinReject', 'and refused')
  eq(refused.answer?.reason, REFUSAL, 'saying why, unlike every other refusal')
  eq(refused.answer?.result, undefined, 'with no token')
  eq(await seated(V_ENC), null, 'and no presence row')

  const tokenBody = JSON.stringify({ actorId: peer.actorUrl, roomName: `channel-${V_ENC}`, roomType: 'voice_channel' })
  const tokenUrl = `${localUrl}/api/livekit/federated-token`
  const token = await ctx.post(tokenUrl, ctx.signedHeaders(tokenUrl, tokenBody, peer.key.privateKey, `${peer.actorUrl}#main-key`), tokenBody)
  eq(token.status, 403, '/api/livekit/federated-token refuses the channel too')
  assert(!token.body.includes('"token"'), 'with no token', token.body)

  const admitted = await join(V_PLAIN)
  eq(admitted.answer?.type, 'harmony:VoiceChannelJoinAccept', 'a plain voice channel admits the member')
  assert(await seated(V_PLAIN), 'who has a presence row')

  const turnedOn = await db.from('channel_encryption_settings').update({ voice_encrypted: true }).eq('channel_id', V_PLAIN)
  assert(!turnedOn.error, 'encryption turns on in that channel', turnedOn.error?.message)
  const { data: resync } = await db.from('voice_grant_resyncs').select('id').eq('channel_id', V_PLAIN)
  eq(resync?.length, 1, 'which queues a grant resync of the channel')
  const { syncVoiceGrants } = await backend('services/voiceGrantSync.ts')
  const synced = await syncVoiceGrants({ supabase: db }, ids.hostedServer)
  assert(synced.removed >= 1, 'the resync removes the participant', JSON.stringify(synced))
  eq(await seated(V_PLAIN), null, 'whose presence row is gone')
  const again = await join(V_PLAIN)
  eq(again.answer?.reason, REFUSAL, 'and a new join is refused with the same words')

  // Messages.
  const create = async (channelId: string, label: string) => {
    const id = `${peer.base}/messages/${crypto.randomUUID()}`
    const status = await asMember({
      '@context': AS, id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, actor: peer.actorUrl, type: 'Create',
      object: {
        type: 'Note', id, attributedTo: peer.actorUrl, content: `<p>${label}</p>`, context: channelUrl(channelId),
        'harmony:rawContent': [{ type: 'text', text: label }],
      },
    })
    return { status, stored: !!(await db.from('messages').select('id').eq('metadata->>ap_id', id).maybeSingle()).data }
  }
  const toEncrypted = await create(T_ENC, 'plaintext to an encrypted channel')
  eq(toEncrypted.status, 202, 'a member\'s plaintext to an encrypted channel is acknowledged (202)')
  eq(toEncrypted.stored, false, 'and not stored')
  eq((await create(T_PLAIN, 'plaintext to a plain channel')).stored, true, 'a plain channel stores it')
}

async function hostedByPeer(ctx: ChannelHostFlagsContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, ids, assert, eq } = ctx
  const { ServerDiscoveryService } = await backend('services/ServerDiscoveryService.ts')
  const inbox = `${localUrl}/inbox`
  const channelApId = peer.channelUrl(ids.remoteChannel)
  const asGroup = (body: unknown) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(body),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`)
  const asMember = (body: unknown) => deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(body),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  const activity = (type: string, actor: string, object: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    '@context': [AS, HARMONY], id: `${actor}/activities/${crypto.randomUUID()}`, type, actor, published: new Date().toISOString(), object, ...extra,
  })
  const flagsOf = async (id: string) => (await db.from('channels').select('host_flags').eq('id', id).maybeSingle()).data?.host_flags
  const categoryFlags = async (id: string) => (await db.from('channel_categories').select('host_flags').eq('id', id).maybeSingle()).data?.host_flags
  const settled = (read: () => Promise<unknown>, want: unknown) => poll(async () => (JSON.stringify(await read()) === JSON.stringify(want) ? true : null))

  await db.from('user_servers').upsert(
    { server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted', member_instance: ctx.instanceDomain },
    { onConflict: 'server_id,user_id' },
  )
  await db.from('channels').delete().in('id', [P_VOICE, P_ADDED])
  await db.from('channel_categories').delete().eq('id', P_CATEGORY)

  const entries = (flags: { text?: Record<string, unknown>; voice?: Record<string, unknown>; category?: Record<string, unknown> } = {}) => ({
    'harmony:channels': [
      { id: peer.channelUrl(P_CATEGORY), localId: P_CATEGORY, name: 'peer-hidden', type: 'harmony:Category', channelType: 'category', order: 7, ...flags.category },
      { id: channelApId, localId: ids.remoteChannel, name: 'peer-general', type: 'harmony:TextChannel', channelType: 'text', order: 0, ...flags.text },
      { id: peer.channelUrl(P_VOICE), localId: P_VOICE, name: 'peer-voice', type: 'harmony:VoiceChannel', channelType: 'voice', order: 1, ...flags.voice },
    ],
  })

  // A host before 1.9.5.
  peer.extraGroupFields = entries()
  await ServerDiscoveryService.syncRemoteServer(ids.remoteRef, { asUserId: ids.bob })
  eq(JSON.stringify(await flagsOf(ids.remoteChannel)), '{}', 'a Group with no flags leaves the copy\'s channel at {}')
  eq(JSON.stringify(await flagsOf(P_VOICE)), '{}', 'and creates a channel at {}')

  // A sync.
  peer.extraGroupFields = entries({
    text: { 'harmony:encryption': { messages: true } },
    voice: { 'harmony:encryption': { voice: true }, 'harmony:private': true },
    category: { 'harmony:private': true },
  })
  await ServerDiscoveryService.syncRemoteServer(ids.remoteRef, { asUserId: ids.bob })
  eq(JSON.stringify(await flagsOf(ids.remoteChannel)), '{"messages":true}', 'a sync stores the text channel\'s flag on the copy')
  eq(JSON.stringify(await flagsOf(P_VOICE)), JSON.stringify({ voice: true, private: true }), 'and the voice channel\'s')
  eq(JSON.stringify(await categoryFlags(P_CATEGORY)), '{"private":true}', 'and the category\'s')
  const untouched = await db.from('channel_encryption_settings').select('messages_encrypted, voice_encrypted').in('channel_id', [ids.remoteChannel, P_VOICE])
  assert((untouched.data ?? []).every((r: any) => !r.messages_encrypted && !r.voice_encrypted),
    'nothing is mirrored into channel_encryption_settings', JSON.stringify(untouched.data))
  const overrides = await db.from('channel_permission_overrides').select('id').in('channel_id', [ids.remoteChannel, P_VOICE])
  eq(overrides.data?.length, 0, 'and no override is written on the copy')

  // The Group turns a flag off: the property is gone from the document.
  peer.extraGroupFields = entries({ voice: { 'harmony:private': true } })
  await ServerDiscoveryService.syncRemoteServer(ids.remoteRef, { asUserId: ids.bob })
  eq(JSON.stringify(await flagsOf(ids.remoteChannel)), '{}', 'a later document without the property clears the flag')
  eq(JSON.stringify(await flagsOf(P_VOICE)), '{"private":true}', 'and leaves what it still carries')
  eq(JSON.stringify(await categoryFlags(P_CATEGORY)), '{}', 'a category\'s too')

  // Live, from the Group.
  const live = (extra: Record<string, unknown>) => ({ type: 'harmony:TextChannel', id: channelApId, name: 'peer-general', position: 0, category: null, ...extra })
  assert(await asGroup(activity('Update', peer.groupUrl, live({ 'harmony:encryption': { messages: true } }))) < 300, 'the inbox takes the Group\'s Update')
  assert(await settled(() => flagsOf(ids.remoteChannel), { messages: true }), 'which stores the flag', await flagsOf(ids.remoteChannel))

  assert(await asMember(activity('Update', peer.actorUrl, live({ 'harmony:private': true }))) < 300, 'the inbox takes a member\'s Update')
  await sleep(500)
  eq(JSON.stringify(await flagsOf(ids.remoteChannel)), '{"messages":true}', 'which changes nothing: only the Group speaks for its channels')

  await asGroup(activity('Update', peer.groupUrl, live({})))
  assert(await settled(() => flagsOf(ids.remoteChannel), {}), 'the Group\'s Update without the property clears it', await flagsOf(ids.remoteChannel))

  await asGroup(activity('Add', peer.groupUrl, {
    type: 'harmony:VoiceChannel', id: peer.channelUrl(P_ADDED), name: 'peer-added-voice', position: 2, category: null,
    'harmony:encryption': { voice: true },
  }, { target: peer.groupUrl }))
  assert(await settled(() => flagsOf(P_ADDED), { voice: true }), 'the Group\'s Add creates the channel with its flag', await flagsOf(P_ADDED))

  await asGroup(activity('Update', peer.groupUrl, {
    type: 'harmony:Category', id: peer.channelUrl(P_CATEGORY), name: 'peer-hidden', position: 7, order: 7, category: null, 'harmony:private': true,
  }))
  assert(await settled(() => categoryFlags(P_CATEGORY), { private: true }), 'the Group\'s Update of a category stores harmony:private', await categoryFlags(P_CATEGORY))
}
