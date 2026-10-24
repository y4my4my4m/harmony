// Messages no profile wrote (a bot, a channel webhook, a person a bridge relays) as the Group's
// Notes with harmony:author, both directions (migration 20261028400001,
// activitypub/groupAuthor.ts).
//
// Hosted by the peer (its Group, fx_bob a member): this instance is the member's.
//   - the channel collection serves a webhook's and a bridged person's Notes attributedTo the
//     Group; the proxy caches them with no profile and no bot, the author in
//     metadata.remote_author (a bridged person also as discord_user);
//   - the Group's live Create is stored the same way and its Update edits it; the same Note
//     signed by a member is not stored.
//
// Hosted here (the private server, the peer's user an accepted member):
//   - a bot's message is queued; the channel collection serves it attributedTo the Group with
//     the bot's name in harmony:author, never /users/undefined;
//   - the federation job delivers it to the peer's instance as the Group's Create, signed with
//     the key the Group publishes.
//
// The BullMQ worker is not part of this harness: the job handler is called as the worker would.

import crypto from 'node:crypto'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { deliver, strictReceiverRefusal } from './groupActor.ts'
import type { SystemEventsContext } from './systemEvents.ts'

const AS = 'https://www.w3.org/ns/activitystreams'

async function poll<T>(find: () => Promise<T | null | undefined>, ms = 5000): Promise<T | null | undefined> {
  const until = Date.now() + ms
  for (;;) {
    const got = await find()
    if (got || Date.now() > until) return got
    await new Promise((r) => setTimeout(r, 100))
  }
}

export async function caseGroupAuthored(ctx: SystemEventsContext): Promise<void> {
  console.log('\nBot, webhook and bridged messages -> the Group\'s Notes with harmony:author, stored with no profile')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const backend = (p: string) => import(pathToFileURL(path.join(ctx.backendRoot, 'src', p)).href)
  const bobUrl = `https://${instanceDomain}/users/fx_bob`
  const peerHost = new URL(peer.groupUrl).origin
  const row = async (id: string) => (await db.from('messages')
    .select('id, user_id, bot_id, channel_id, content, metadata').eq('id', id).maybeSingle()).data
  // https only: the receiver drops any other icon (parseGroupAuthor). The harness peer is http.
  const hook = { kind: 'webhook', id: crypto.randomUUID(), name: 'RT Deployer', icon: 'https://media.example/avatars/deployer.png' }
  const groupNote = (id: string, author: Record<string, unknown>, content: string) => ({
    type: 'Note',
    id: `${peerHost}/messages/${id}`,
    attributedTo: peer.groupUrl,
    content,
    context: `${peer.groupUrl}/channels/${ids.remoteChannel}`,
    published: new Date().toISOString(),
    'harmony:author': author,
  })

  // Hosted by the peer: backfill through the proxy.
  const hookNote = crypto.randomUUID()
  const bridgedNote = crypto.randomUUID()
  peer.extraChannelItems = [
    groupNote(hookNote, hook, 'deployed 1.9.0'),
    groupNote(bridgedNote, { kind: 'bridge', id: 'discord:4242', name: 'Dana', source: 'discord' }, 'hi from Discord'),
  ]
  try {
    const res = await ctx.get(`${localUrl}/channels/${ids.remoteChannel}/messages`, {
      Accept: 'application/json', Authorization: `Bearer ${ctx.bearer(ids.bobAuth)}`,
    })
    eq(res.status, 200, 'the member reads the peer\'s channel through the proxy')
    const item = (res.json?.messages ?? []).find((m: any) => m.id === hookNote)
    assert(item, 'the webhook\'s Note is in the page', res.body)
    eq(item?.author ?? null, null, 'served with no profile author')
    eq(item?.metadata?.remote_author?.name, 'RT Deployer', 'named as the webhook')

    const cached = await row(hookNote)
    eq(cached?.user_id ?? null, null, 'the cached row has no profile')
    eq(cached?.bot_id ?? null, null, 'and no bot of this instance')
    const author = cached?.metadata?.remote_author ?? {}
    eq(JSON.stringify([author.kind, author.id, author.name, author.avatar_url]),
      JSON.stringify(['webhook', hook.id, 'RT Deployer', hook.icon]),
      'its author is metadata.remote_author, picture included')
    const bridged = await row(bridgedNote)
    eq(bridged?.metadata?.discord_user?.display_name, 'Dana', 'a bridged person is stored as the bridge stores one')
    eq(bridged?.metadata?.bridge_source, 'discord', 'with its source')
  } finally {
    peer.extraChannelItems = []
  }

  // Hosted by the peer: live.
  const inbox = `${localUrl}/inbox`
  const activity = (type: 'Create' | 'Update', id: string, actor: string, content: string) => JSON.stringify({
    '@context': [AS, { harmony: 'https://mony.lol/ns#' }],
    id: `${peer.groupUrl}/activities/${crypto.randomUUID()}`,
    type,
    actor,
    to: [bobUrl],
    object: {
      ...groupNote(id, hook, content),
      attributedTo: actor,
      'harmony:serverId': ids.remoteRef,
      ...(type === 'Update' ? { updated: new Date().toISOString() } : {}),
    },
  })
  const forged = crypto.randomUUID()
  const forgedStatus = await deliver(ctx.post, ctx.signedHeaders, inbox, activity('Create', forged, peer.actorUrl, '<p>posing as a bot</p>'),
    peer.key.privateKey, `${peer.actorUrl}#main-key`)
  assert(forgedStatus < 300, 'the inbox takes a member\'s Note carrying harmony:author', forgedStatus)
  const live = crypto.randomUUID()
  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, activity('Create', live, peer.groupUrl, '<p>build green</p>'),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202, 'the inbox takes the Group\'s Create of a webhook message (202)')
  const stored = await poll(() => row(live))
  eq(stored?.channel_id, ids.remoteChannel, 'the webhook message is stored in the peer\'s channel')
  eq(stored?.user_id ?? null, null, 'with no profile')
  eq(stored?.metadata?.remote_author?.name, 'RT Deployer', 'under the webhook\'s name')
  eq(await row(forged), null, 'the member\'s Note is not stored')

  eq(await deliver(ctx.post, ctx.signedHeaders, inbox, activity('Update', live, peer.groupUrl, '<p>build red</p>'),
    peer.groupKey.privateKey, `${peer.groupUrl}#main-key`), 202, 'the inbox takes the Group\'s Update (202)')
  const edited = await poll(async () => {
    const r = await row(live)
    return JSON.stringify(r?.content ?? '').includes('build red') ? r : null
  })
  assert(edited, 'the Group\'s edit reaches the stored message', await row(live))

  // Hosted here.
  const on = await db.from('servers').update({ federation_enabled: true }).eq('id', ids.hostedServer)
  assert(!on.error, 'federate the hosted server', on.error?.message)
  const remoteMember = await db.from('user_servers').upsert(
    { server_id: ids.hostedServer, user_id: ids.remote, status: 'accepted', member_instance: new URL(peer.actorUrl).hostname },
    { onConflict: 'user_id,server_id' },
  )
  assert(!remoteMember.error, 'the peer\'s user is an accepted member of the hosted server', remoteMember.error?.message)

  const { data: bot, error: botError } = await db.from('bots').insert({
    username: `rtbot${crypto.randomUUID().slice(0, 8)}`, display_name: 'RT Bot', owner_id: ids.alice, is_public: false,
  }).select('id').single()
  assert(!botError && bot, 'a bot of fx_alice\'s', botError?.message)
  if (!bot) return
  const { data: message, error: messageError } = await db.from('messages').insert({
    channel_id: ids.hostedChannel, bot_id: bot.id, content: [{ type: 'text', text: 'a bot speaks' }],
  }).select('id, federation_status').single()
  assert(!messageError && message, 'the bot posts in the hosted channel', messageError?.message)
  if (!message) return
  eq(message.federation_status, 'queued', 'queued for the Group to deliver')

  const group = `https://${instanceDomain}/servers/${ids.hostedServer}`
  const objectId = `https://${instanceDomain}/messages/${message.id}`
  const pageUrl = `${localUrl}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}/messages?page=1`
  const page = await ctx.get(pageUrl, ctx.signedGetHeaders(pageUrl, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  const served = (page.json?.orderedItems ?? []).find((n: any) => n.id === objectId)
  assert(served, 'the channel collection serves the bot\'s message to the member\'s instance', page.body)
  eq(served?.attributedTo, group, 'attributed to the Group')
  eq(served?.['harmony:author']?.kind, 'bot', 'marked harmony:author of kind bot')
  eq(served?.['harmony:author']?.name, 'RT Bot', 'under the bot\'s name')
  assert(!(page.json?.orderedItems ?? []).some((n: any) => String(n.attributedTo).endsWith('/undefined')),
    'no item is attributed to /users/undefined')

  const { data: channel } = await db.from('channels').select('name').eq('id', ids.hostedChannel).single()
  const n = peer.captured.length
  const { handleChannelMessageFederation } = await backend('listeners/ChannelMessageHandler.ts')
  await handleChannelMessageFederation({
    message_id: message.id, channel_id: ids.hostedChannel, server_id: ids.hostedServer,
    channel_name: channel?.name ?? 'general', author_id: null,
  })
  const delivered = await poll(async () => peer.captured.slice(n).find((c) => {
    const body = JSON.parse(c.raw.toString('utf-8'))
    return body.type === 'Create' && body.object?.id === objectId
  }))
  assert(delivered, 'the bot\'s message reaches the peer\'s instance live')
  if (delivered) {
    const body = JSON.parse(delivered.raw.toString('utf-8'))
    eq(body.actor, group, 'as the Group\'s Create')
    eq(body.object?.attributedTo, group, 'attributed to the Group')
    eq(body.object?.['harmony:author']?.name, 'RT Bot', 'naming the bot')
    const refusal = await strictReceiverRefusal(delivered, localUrl, instanceDomain)
    assert(refusal === null, 'signed with the key the Group publishes', refusal)
  }
  eq((await db.from('messages').select('federation_status').eq('id', message.id).single()).data?.federation_status,
    'completed', 'and the message is marked federated')
}
