// A server's custom emojis on the copies its member instances hold (activitypub/copyMirror.ts
// harmony:emojis, services/CopyMirrorService.applyGroupEmojis, migration 20261114200001), both
// directions.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - the Group lists its emojis, each under the Group with its shortcode and image;
//   - a rename and a removal go out as the Group's Update carrying the whole list, signed with
//     the Group's key.
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - a sync stores the Group's emojis as server emojis of the copy naming the peer's images;
//     the row an earlier activity cached for one of those images is taken over, keeping its id;
//     an emoji under another Group's id is not stored;
//   - a Group without harmony:emojis (1.9.6 and older) leaves them as they are;
//   - the Group's Update renames one and removes the other; the same Update signed by a member
//     changes nothing;
//   - fx_bob's reaction with the copy's emoji reaches the peer naming the peer's image.
//
// The BullMQ worker is not part of this harness: the job handlers are called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

// Fixed so a failure names a row.
const H_WAVE = 'fed00287-0000-0000-0000-0000000000a1'
const P_WAVE = 'fed00287-0000-0000-0000-0000000000b1'
const P_DANCE = 'fed00287-0000-0000-0000-0000000000b2'
const CACHED = 'fed00287-0000-0000-0000-0000000000c1'
const PEER_MESSAGE = 'fed00287-0000-0000-0000-000000000001'

interface Captured { method: string; url: string; headers: Record<string, string>; raw: Buffer }

export interface CopyEmojisContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraGroupFields: Record<string, unknown>
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

async function poll<T>(find: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = await find()
    if (got || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function caseCopyEmojis(ctx: CopyEmojisContext): Promise<void> {
  console.log('\nServers hosted elsewhere -> their custom emojis on the copy')
  const { db, peer, ids } = ctx
  const backend = async (p: string): Promise<any> => {
    try {
      return await import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
    } catch (e) {
      ctx.assert(false, `the backend has ${p}`, (e as Error).message)
      return {}
    }
  }
  try {
    await hostedHere(ctx, backend)
    await hostedByPeer(ctx, backend)
  } finally {
    peer.extraGroupFields = {}
    await db.from('reactions').delete().eq('message_id', PEER_MESSAGE)
    await db.from('messages').delete().eq('id', PEER_MESSAGE)
    await db.from('emojis').delete().in('id', [H_WAVE, CACHED])
    await db.from('emojis').delete().eq('server_id', ids.remoteRef).not('ap_id', 'is', null)
    await db.from('servers').update({ allow_cross_server_emojis: true }).eq('id', ids.remoteRef)
  }
}

async function hostedHere(ctx: CopyEmojisContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const peerHost = new URL(peer.base).host
  const image = `https://${instanceDomain}/storage/v1/object/public/emojis/${ids.hostedServer}/wave.png`
  const body = (c: Captured) => JSON.parse(c.raw.toString('utf-8'))
  const updateSince = (n: number) => async () =>
    peer.captured.slice(n).find((c) => c.url === '/inbox' && body(c).type === 'Update' && body(c).object?.type === 'Group')

  await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: peerHost },
    { onConflict: 'server_id,user_id' },
  )
  await db.from('emojis').delete().eq('id', H_WAVE)
  const seeded = await db.from('emojis').insert({ id: H_WAVE, name: 'wave', url: image, server_id: ids.hostedServer, scope: 'server' })
  assert(!seeded.error, 'seed an emoji on the hosted server', seeded.error?.message)

  const groupUrl = `${localUrl}/servers/${ids.hostedServer}`
  const doc = await ctx.get(groupUrl, ctx.signedGetHeaders(groupUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  eq(doc.status, 200, 'the peer\'s user reads the Group')
  const listed = (Array.isArray(doc.json?.['harmony:emojis']) ? doc.json['harmony:emojis'] : [])
    .find((e: any) => e?.id === `${group}/emojis/${H_WAVE}`)
  assert(listed, 'the Group lists its emojis in harmony:emojis', JSON.stringify(doc.json?.['harmony:emojis'] ?? null))
  eq(listed?.type, 'Emoji', 'each an Emoji')
  eq(listed?.name, ':wave:', 'with its shortcode')
  eq(listed?.icon?.url, image, 'and its image')
  eq(doc.json?.['harmony:crossServerEmojis'], true, 'the Group says its emojis may be used in other servers')

  const { handleServerUpdateJob } = await backend('queue/handlers/serverStructureHandler.ts')
  await db.from('emojis').update({ name: 'hello' }).eq('id', H_WAVE)
  let n = peer.captured.length
  await handleServerUpdateJob?.({ type: 'update', server_id: ids.hostedServer })
  const renamed = await poll(updateSince(n))
  assert(renamed, 'a rename reaches the peer as the Group\'s Update')
  if (renamed) {
    const entry = (body(renamed).object?.['harmony:emojis'] ?? []).find((e: any) => e?.id === `${group}/emojis/${H_WAVE}`)
    eq(entry?.name, ':hello:', 'carrying the renamed emoji')
    assert(await strictReceiverRefusal(renamed, localUrl, instanceDomain) === null, 'signed with the Group\'s key')
  }

  await db.from('emojis').update({ deleted_at: new Date().toISOString() }).eq('id', H_WAVE)
  n = peer.captured.length
  await handleServerUpdateJob?.({ type: 'update', server_id: ids.hostedServer })
  const removed = await poll(updateSince(n))
  const list = removed ? body(removed).object?.['harmony:emojis'] : null
  assert(Array.isArray(list) && !list.some((e: any) => e?.id === `${group}/emojis/${H_WAVE}`),
    'a removed emoji is gone from the next Update\'s list', JSON.stringify(list))
}

async function hostedByPeer(ctx: CopyEmojisContext, backend: (p: string) => Promise<any>): Promise<void> {
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const peerOrigin = new URL(peer.base).origin
  const peerHost = new URL(peer.base).host.toLowerCase()
  const apId = (id: string) => `${peer.groupUrl}/emojis/${id}`
  const image = (name: string) => `${peerOrigin}/storage/v1/object/public/emojis/${name}.png`
  const emoji = (id: string, name: string, file = name) =>
    ({ type: 'Emoji', id: apId(id), name: `:${name}:`, icon: { type: 'Image', url: image(file) } })
  const copyEmoji = async (id: string) => (await db.from('emojis')
    .select('id, name, url, server_id, scope, domain, deleted_at')
    .eq('server_id', ids.remoteRef).eq('ap_id', apId(id)).maybeSingle()).data

  await db.from('user_servers').upsert(
    { server_id: ids.remoteRef, user_id: ids.bob, status: 'accepted', member_instance: instanceDomain },
    { onConflict: 'server_id,user_id' },
  )
  await db.from('emojis').delete().eq('server_id', ids.remoteRef).not('ap_id', 'is', null)
  await db.from('emojis').delete().eq('id', CACHED)
  // As an earlier reaction from the peer cached it: no server, the peer's host as domain.
  const cached = await db.from('emojis').insert({ id: CACHED, name: 'dance', url: image('dance'), server_id: null, domain: peerHost })
  assert(!cached.error, 'seed the row an earlier activity cached', cached.error?.message)

  const { ServerDiscoveryService } = await backend('services/ServerDiscoveryService.ts')
  peer.extraGroupFields = {
    'harmony:crossServerEmojis': false,
    'harmony:emojis': [
      emoji(P_WAVE, 'wave'),
      emoji(P_DANCE, 'dance'),
      // Another Group's emoji: never stored.
      { ...emoji(P_WAVE, 'forged'), id: `https://elsewhere.example/servers/${ids.remoteRef}/emojis/${P_WAVE}` },
    ],
  }
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  const wave = await copyEmoji(P_WAVE)
  assert(wave, 'the sync stores the Group\'s emoji on the copy')
  eq(wave?.name, 'wave', 'with its name')
  eq(wave?.url, image('wave'), 'the peer\'s image')
  eq(wave?.scope, 'server', 'as a server emoji')
  eq(wave?.domain, peerHost, 'of the peer')
  eq((await copyEmoji(P_DANCE))?.id, CACHED, 'the row an earlier activity cached for an image is taken over, keeping its id')
  const forged = await db.from('emojis').select('id').eq('name', 'forged')
  eq(forged.data?.length ?? -1, 0, 'an emoji under another Group\'s id is not stored')
  const crossServer = async () => (await db.from('servers').select('allow_cross_server_emojis').eq('id', ids.remoteRef).maybeSingle()).data?.allow_cross_server_emojis
  eq(await crossServer(), false, 'the copy stores the Group\'s cross-server emoji switch')

  peer.extraGroupFields = {}
  await ServerDiscoveryService?.syncRemoteServer?.(ids.remoteRef, { asUserId: ids.bob })
  eq((await copyEmoji(P_WAVE))?.deleted_at ?? null, null, 'a Group without harmony:emojis leaves the copy\'s emojis as they are')

  // Live, from the Group.
  const inbox = `${localUrl}/inbox`
  const activity = (actor: string, emojis: unknown[]) => ({
    '@context': [AS, HARMONY], id: `${actor}/activities/${crypto.randomUUID()}`, type: 'Update', actor,
    published: new Date().toISOString(),
    object: { id: peer.groupUrl, type: 'Group', name: 'Peer private', 'harmony:ChatServer': true, 'harmony:emojis': emojis, 'harmony:crossServerEmojis': true },
  })
  assert(await deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(activity(peer.groupUrl, [emoji(P_WAVE, 'hello', 'wave')])),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`) < 300, 'the inbox takes the Group\'s Update')
  const renamed = await poll(async () => {
    const r = await copyEmoji(P_WAVE)
    return r?.name === 'hello' ? r : null
  })
  assert(renamed, 'the Group\'s Update renames an emoji')
  assert((await copyEmoji(P_DANCE))?.deleted_at, 'and removes one it no longer lists')
  eq(await crossServer(), true, 'and sets the cross-server emoji switch')

  await deliver(ctx.post, ctx.signedHeaders, inbox, JSON.stringify(activity(peer.actorUrl, [])),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  await new Promise((r) => setTimeout(r, 1000))
  eq((await copyEmoji(P_WAVE))?.deleted_at ?? null, null, 'the same Update signed by a member changes nothing')

  // fx_bob reacts with the copy's emoji.
  await db.from('messages').delete().eq('id', PEER_MESSAGE)
  const message = await db.from('messages').insert({
    id: PEER_MESSAGE, channel_id: ids.remoteChannel, user_id: ids.remote, content: [{ type: 'text', text: 'react here' }],
    metadata: { federated: true, ap_id: `${peerOrigin}/messages/${PEER_MESSAGE}` },
  })
  assert(!message.error, 'cache a message of the peer\'s channel', message.error?.message)
  const reaction = await db.from('reactions')
    .insert({ message_id: PEER_MESSAGE, user_id: ids.bob, emoji_id: renamed?.id }).select('id').single()
  assert(!reaction.error && reaction.data, 'fx_bob reacts with the copy\'s emoji', reaction.error?.message)
  const { handleChannelReactionJob } = await backend('queue/handlers/channelReactionHandler.ts')
  const before = peer.captured.length
  await handleChannelReactionJob?.({
    type: 'create', reaction_id: reaction.data?.id, message_id: PEER_MESSAGE, user_id: ids.bob, emoji_id: renamed?.id,
  })
  const like = await poll(async () => peer.captured.slice(before)
    .map((c) => { try { return JSON.parse(c.raw.toString('utf-8')) } catch { return null } })
    .find((a) => a?.type === 'Like' || a?.type === 'EmojiReact'))
  assert(like, 'the reaction reaches the peer')
  eq(like?.tag?.[0]?.icon?.url, image('wave'), 'naming the peer\'s image')
  assert(typeof like?.content === 'string' && like.content.startsWith(':hello'), 'and the emoji\'s shortcode', like?.content)
}
