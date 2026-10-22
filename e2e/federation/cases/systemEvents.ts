// System notices as the Group's Notes, both directions (migration 20261026100001,
// activitypub/systemNotes.ts).
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - the channel collection serves "fx_bob joined" attributedTo the Group with harmony:system;
//     the proxy caches it as an authorless system row naming fx_bob's own profile, and a
//     notice about the peer's user names its mirror profile;
//   - the Group's live Create of a leave is stored the same way; the same Note signed by a
//     member is not stored as a notice.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - fx_carol leaving and joining posts authorless notices; the channel collection serves
//     them as the Group's Notes with her actor id;
//   - the federation job delivers the join to the peer's instance as the Group's Create,
//     signed with the key the Group publishes.
//
// The BullMQ worker is not part of this harness: the job handler is called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver, strictReceiverRefusal } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

interface Captured {
  method: string
  url: string
  headers: Record<string, string>
  raw: Buffer
}

export interface SystemEventsContext {
  db: SupabaseClient
  peer: {
    actorUrl: string
    groupUrl: string
    key: { privateKey: string }
    groupKey: { privateKey: string }
    captured: Captured[]
    extraChannelItems: Record<string, unknown>[]
  }
  localUrl: string
  instanceDomain: string
  backendRoot: string
  ids: {
    alice: string
    bob: string
    bobAuth: string
    carol: string
    remote: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  get: (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  bearer: (authUserId: string) => string
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

export async function caseSystemEvents(ctx: SystemEventsContext): Promise<void> {
  console.log('\nSystem notices -> the Group\'s Notes with harmony:system, stored as authorless system rows')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const bobUrl = `https://${instanceDomain}/users/fx_bob`
  const carolUrl = `https://${instanceDomain}/users/fx_carol`
  const peerHost = new URL(peer.groupUrl).origin
  const row = async (id: string) => (await db.from('messages')
    .select('id, user_id, bot_id, is_system, channel_id, metadata').eq('id', id).maybeSingle()).data
  const groupNote = (id: string, system: Record<string, unknown>, content: string) => ({
    type: 'Note',
    id: `${peerHost}/messages/${id}`,
    attributedTo: peer.groupUrl,
    content,
    context: `${peer.groupUrl}/channels/${ids.remoteChannel}`,
    published: new Date().toISOString(),
    'harmony:system': system,
  })

  // Hosted by the peer: backfill through the proxy.
  const bobJoin = crypto.randomUUID()
  const remoteJoin = crypto.randomUUID()
  peer.extraChannelItems = [
    groupNote(bobJoin, { type: 'member_join', subject: bobUrl }, 'fx_bob joined the server'),
    groupNote(remoteJoin, { type: 'member_join', subject: peer.actorUrl }, 'fx_remote joined the server'),
  ]
  try {
    const res = await ctx.get(`${localUrl}/channels/${ids.remoteChannel}/messages`, {
      Accept: 'application/json', Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}`,
    })
    eq(res.status, 200, 'the member reads the peer\'s channel through the proxy')
    const item = (res.json?.messages ?? []).find((m: any) => m.id === bobJoin)
    assert(item, 'the Group\'s join notice is in the page', res.body)
    eq(item?.is_system, true, 'served to the client as a system row')
    eq(item?.author ?? null, null, 'with no author')
    eq(item?.metadata?.subject_id, ids.bob, 'naming fx_bob\'s own profile')

    const cached = await row(bobJoin)
    eq(cached?.is_system, true, 'the cached row is a system row')
    eq(cached?.user_id ?? null, null, 'that fx_bob did not author')
    eq(cached?.metadata?.type, 'member_join', 'of type member_join')
    eq(cached?.metadata?.subject_id, ids.bob, 'naming fx_bob as its subject')
    eq((await row(remoteJoin))?.metadata?.subject_id, ids.remote, 'a notice about the peer\'s user names its mirror profile')
  } finally {
    peer.extraChannelItems = []
  }

  // Hosted by the peer: live.
  const inbox = `${localUrl}/inbox`
  const liveCreate = (id: string, actor: string) => JSON.stringify({
    '@context': [AS, { harmony: 'https://harmonyapp.dev/ns#' }],
    id: `${peer.groupUrl}/activities/${id}`,
    type: 'Create',
    actor,
    to: [bobUrl],
    object: {
      ...groupNote(id, { type: 'member_leave', subject: peer.actorUrl }, '<p>fx_remote left the server</p>'),
      attributedTo: actor,
      'harmony:serverId': ids.remoteRef,
    },
  })
  const forged = crypto.randomUUID()
  const forgedStatus = await deliver(ctx.post, ctx.signedHeaders, inbox, liveCreate(forged, peer.actorUrl),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  assert(forgedStatus < 300, 'the inbox takes a member\'s Note carrying the marker', forgedStatus)
  const leave = crypto.randomUUID()
  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, liveCreate(leave, peer.groupUrl),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202, 'the inbox takes the Group\'s Create of a leave (202)')
  const stored = await poll(() => row(leave))
  eq(stored?.is_system, true, 'the Group\'s leave is stored as a system row')
  eq(stored?.channel_id, ids.remoteChannel, 'in the peer\'s channel')
  eq(stored?.user_id ?? null, null, 'with no author')
  eq(stored?.metadata?.subject_id, ids.remote, 'naming the peer\'s user')
  const forgedRow = await row(forged)
  assert(!forgedRow?.is_system, 'the member\'s Note is no system notice', forgedRow)

  // Hosted here.
  const on = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!on.error, 'federate the hosted server', on.error?.message)
  const remoteMember = await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).hostname },
    { onConflict: 'user_id,server_id' },
  )
  assert(!remoteMember.error, 'the peer\'s user is an accepted member of the hosted server', remoteMember.error?.message)

  await db.from('user_servers').delete().eq('server_id', ids.hostedServer).eq('user_id', ids.carol)
  const joined = await db.from('user_servers').insert({ server_id: ids.hostedServer, user_id: ids.carol, status: 'accepted' })
  assert(!joined.error, 'fx_carol joins the hosted server', joined.error?.message)
  const { data: notice } = await db.from('messages')
    .select('id, channel_id, user_id, metadata, federation_status')
    .eq('is_system', true).eq('metadata->>type', 'member_join').eq('metadata->>subject_id', ids.carol)
    .order('created_at', { ascending: false }).limit(1).maybeSingle()
  assert(notice, 'her join posts a notice')
  eq(notice?.user_id ?? null, null, 'with no author')
  eq(notice?.federation_status, 'queued', 'queued for the Group to deliver')
  if (!notice) return

  const pageUrl = `${localUrl}/servers/${ids.hostedServer}/channels/${notice.channel_id}/messages?page=1`
  const page = await ctx.get(pageUrl, ctx.signedGetHeaders(pageUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const served = (page.json?.orderedItems ?? []).find((n: any) => n.id === `https://${instanceDomain}/messages/${notice.id}`)
  assert(served, 'the channel collection serves the join to the member\'s instance', page.body)
  eq(served?.attributedTo, group, 'attributed to the Group')
  eq(JSON.stringify(served?.['harmony:system']), JSON.stringify({ type: 'member_join', subject: carolUrl }),
    'marked harmony:system, naming fx_carol by her actor id')
  assert(!(page.json?.orderedItems ?? []).some((n: any) => String(n.attributedTo).endsWith('/undefined')),
    'no item is attributed to /users/undefined')

  const { data: channel } = await db.from('channels').select('name').eq('id', notice.channel_id).single()
  const n = peer.captured.length
  const { handleChannelMessageFederation } = await backend('listeners/ChannelMessageHandler.ts')
  await handleChannelMessageFederation({
    message_id: notice.id, channel_id: notice.channel_id, server_id: ids.hostedServer,
    channel_name: channel?.name ?? 'general', author_id: null,
  })
  const delivered = await poll(async () => peer.captured.slice(n).find((c) => {
    const body = JSON.parse(c.raw.toString('utf-8'))
    return body.type === 'Create' && body.object?.id === `https://${instanceDomain}/messages/${notice.id}`
  }))
  assert(delivered, 'the join reaches the peer\'s instance live')
  if (delivered) {
    const body = JSON.parse(delivered.raw.toString('utf-8'))
    eq(body.actor, group, 'as the Group\'s Create')
    eq(body.object?.['harmony:system']?.subject, carolUrl, 'naming fx_carol')
    const refusal = await strictReceiverRefusal(delivered, localUrl, instanceDomain)
    assert(refusal === null, 'signed with the key the Group publishes', refusal)
  }
  eq((await db.from('messages').select('federation_status').eq('id', notice.id).single()).data?.federation_status,
    'completed', 'and the notice is marked federated')
}
