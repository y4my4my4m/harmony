// Stickers over federation (20261031200001_custom_stickers.sql, federation-backend utils/stickers.ts):
//   - a hosted channel's history page carries a sticker in harmony:rawContent beside its image
//     fallback, and the image as a Document named by the description, which Harmony before
//     1.9.2 and other software show;
//   - a sticker in a Note from the peer's Group channel is stored on the copy as a sticker of the
//     peer, one sticker per message;
//   - a direct message names its sticker in harmony:sticker beside the attachment; inbound, a Note
//     with it becomes a sticker, one without it (Mastodon) stays an image.
//
// Registered from roundtrip.ts; the harness carries what this module needs of it.

import crypto from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { deliver } from './groupActor.ts'

const AS = 'https://www.w3.org/ns/activitystreams'
const HARMONY = { harmony: 'https://mony.lol/ns#' }

/** JSON with object keys sorted: jsonb stores keys in its own order. */
function canonical(value: unknown): string {
  const sort = (v: unknown): unknown => Array.isArray(v)
    ? v.map(sort)
    : v && typeof v === 'object'
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, sort(x)]))
      : v
  return JSON.stringify(sort(value))
}

type Post = (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
type Sign = (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
type Get = (url: string, headers?: Record<string, string>) => Promise<{ status: number; body: string; json: any }>

export interface StickersContext {
  db: SupabaseClient
  peer: {
    base: string
    actorUrl: string
    key: { privateKey: string }
    captured: Array<{ url: string; raw: Buffer }>
    channelUrl: (id: string) => string
  }
  localUrl: string
  instanceDomain: string
  post: Post
  get: Get
  signedHeaders: Sign
  signedGetHeaders: (url: string, privateKey: string, keyId: string) => Record<string, string>
  handleNewDM: (message: unknown) => Promise<void>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
  ids: {
    alice: string
    bob: string
    remote: string
    conversation: string
    hostedServer: string
    hostedChannel: string
    remoteRef: string
    remoteChannel: string
  }
}

export async function caseStickers(ctx: StickersContext): Promise<void> {
  console.log('\nstickers -> rawContent part and image fallback out, a sticker of the peer in, DMs by harmony:sticker')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  // Inbound parts name the sender by hostname, without a port (actorHostname).
  const peerHost = new URL(peer.base).hostname
  const stickerId = crypto.randomUUID()
  const url = `https://db.${instanceDomain}/storage/v1/object/public/stickers/server/${ids.hostedServer}/${stickerId}.png`
  const sticker = { type: 'sticker', id: stickerId, url, name: 'Cat wave', description: 'A cat waving', width: 160, height: 120, mimeType: 'image/png' }
  const fallback = { type: 'file', fileType: 'image', url, fileName: 'Cat wave', altText: 'A cat waving', stickerId, width: 160, height: 120, mimeType: 'image/png' }

  // Out: the hosted channel's history page, as the peer's member reads it.
  const sent = await db.from('messages').insert({
    channel_id: ids.hostedChannel, user_id: ids.alice, content: [{ type: 'text', text: 'sticker from alice' }, sticker, fallback],
  }).select('id').single()
  assert(!sent.error, 'fx_alice sends a sticker in the hosted channel', sent.error?.message)
  const page = `${localUrl}/servers/${ids.hostedServer}/channels/${ids.hostedChannel}/messages?page=1`
  const read = await ctx.get(page, ctx.signedGetHeaders(page, peer.key.privateKey, `${peer.actorUrl}#main-key`))
  eq(read.status, 200, 'the peer\'s member reads the hosted channel')
  const note = (read.json?.orderedItems ?? []).find((n: any) => n?.id === `https://${instanceDomain}/messages/${sent.data?.id}`)
  assert(note, 'the page carries the sticker message', read.body.slice(0, 400))
  const raw = (note?.['harmony:rawContent'] ?? []) as any[]
  eq(JSON.stringify(raw.map((p) => p.type)), JSON.stringify(['text', 'sticker', 'file']), 'rawContent holds the text, the sticker and its image')
  eq(canonical(raw[1]), canonical(sticker), 'a 1.9.2 peer reads the sticker part as sent')
  eq(raw[2]?.stickerId, stickerId, 'the image names its sticker, which a 1.9.2 peer hides')
  eq(raw[2]?.altText, 'A cat waving', 'and carries the description, which a peer before 1.9.2 shows as alt text')
  const doc = (note?.attachment ?? []).find((a: any) => a?.url === url)
  eq(canonical(doc ?? null), canonical({ type: 'Document', mediaType: 'image/png', url, name: 'A cat waving' }),
    'other software gets the image as a Document named by the description')

  // In: a Note of the peer's Group channel, on the copy here, by the peer's user as a member of it.
  const membership = await db.from('user_servers').select('user_id').eq('server_id', ids.remoteRef).eq('user_id', ids.remote).maybeSingle()
  if (!membership.data) {
    const joined = await db.from('user_servers').insert({
      server_id: ids.remoteRef, user_id: ids.remote, status: 'accepted', member_instance: peerHost,
    })
    assert(!joined.error, 'the peer\'s user is a member of the copy', joined.error?.message)
  }
  const inbound = (parts: unknown[]) => {
    const id = `${peer.base}/messages/${crypto.randomUUID()}`
    const body = JSON.stringify({
      '@context': [AS, HARMONY], id: `${peer.actorUrl}/activities/${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl,
      to: [`https://${instanceDomain}/users/fx_bob`],
      object: {
        type: 'Note', id, attributedTo: peer.actorUrl, content: '<p>sticker from the peer</p>',
        context: peer.channelUrl(ids.remoteChannel), 'harmony:serverId': ids.remoteRef, 'harmony:rawContent': parts,
      },
    })
    return { id, send: () => deliver(ctx.post, ctx.signedHeaders, `${localUrl}/inbox`, body, peer.key.privateKey, `${peer.actorUrl}#main-key`) }
  }
  const stored = async (apId: string) => {
    for (let i = 0; i < 30; i++) {
      const row = (await db.from('messages').select('content').eq('metadata->>ap_id', apId).maybeSingle()).data
      if (row) return row.content as any[]
      await new Promise((r) => setTimeout(r, 200))
    }
    return null
  }
  const peerUrl = `${peer.base}/storage/v1/object/public/stickers/server/x/1.png`
  const second = `${peer.base}/storage/v1/object/public/stickers/server/x/2.png`
  const peerSticker = { ...sticker, id: 'peer-sticker', url: peerUrl, name: 'Peer wave' }
  const peerFallback = { ...fallback, url: peerUrl, stickerId: 'peer-sticker' }
  const one = inbound([
    { type: 'text', text: 'sticker from the peer' }, peerSticker, peerFallback,
    { ...peerSticker, id: 'extra', url: second }, { ...peerFallback, url: second, stickerId: 'extra' },
  ])
  eq(await one.send(), 202, 'the peer\'s Note with two stickers is taken (202)')
  const content = await stored(one.id)
  assert(content, 'and stored on the copy')
  eq(JSON.stringify((content ?? []).map((p) => p.type)), JSON.stringify(['text', 'sticker', 'file', 'file']),
    'one sticker is kept; the other stays as its image only')
  eq(content?.[1]?.domain, peerHost, 'the kept sticker is marked as the peer\'s')
  eq(content?.[2]?.stickerId, 'peer-sticker', 'its image stays its fallback')
  eq(content?.[3]?.stickerId, undefined, 'the dropped sticker\'s image is a plain image')

  const bad = inbound([{ ...peerSticker, description: '' }, peerFallback])
  eq(await bad.send(), 202, 'a Note with a sticker lacking a description is taken (202)')
  const badContent = await stored(bad.id)
  eq(JSON.stringify((badContent ?? []).map((p) => [p.type, p.stickerId ?? null])), JSON.stringify([['file', null]]),
    'the malformed sticker is dropped and its image kept')
  if (!membership.data) await db.from('user_servers').delete().eq('server_id', ids.remoteRef).eq('user_id', ids.remote)

  // DM out.
  const before = peer.captured.length
  const dm = await db.from('messages').insert({
    conversation_id: ids.conversation, user_id: ids.alice, content: [{ type: 'text', text: 'dm sticker' }, sticker, fallback],
  }).select('*').single()
  assert(!dm.error, 'fx_alice sends the peer a sticker in a DM', dm.error?.message)
  await ctx.handleNewDM(dm.data)
  const delivered = peer.captured.slice(before).map((r) => JSON.parse(r.raw.toString('utf-8')))
  const dmNote = delivered.find((a) => a?.object?.directMessage === true)?.object
  assert(dmNote, 'the peer receives the DM', JSON.stringify(delivered).slice(0, 400))
  eq(canonical(dmNote?.['harmony:sticker'] ?? null), canonical({
    id: stickerId, url, name: 'Cat wave', description: 'A cat waving', width: 160, height: 120, mediaType: 'image/png',
  }), 'the DM Note names its sticker in harmony:sticker')
  const dmDoc = (dmNote?.attachment ?? []).find((a: any) => a?.url === url)
  eq(dmDoc?.name, 'A cat waving', 'beside the image attachment named by the description')

  // DM in.
  const dmIn = async (extension: unknown) => {
    const id = `${peer.base}/notes/${crypto.randomUUID()}`
    const to = [`https://${instanceDomain}/users/fx_bob`]
    const body = JSON.stringify({
      '@context': [AS, HARMONY], id: `${peer.actorUrl}#create-${crypto.randomUUID()}`, type: 'Create', actor: peer.actorUrl, to, cc: [],
      object: {
        id, type: 'Note', attributedTo: peer.actorUrl, content: '<p>dm sticker in</p>', to, cc: [], directMessage: true,
        attachment: [{ type: 'Document', mediaType: 'image/png', url: peerUrl, name: 'A cat waving' }],
        ...(extension ? { 'harmony:sticker': extension } : {}),
      },
    })
    const target = `${localUrl}/users/fx_bob/inbox`
    eq(await deliver(ctx.post, ctx.signedHeaders, target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), 202, 'the DM is taken (202)')
    return stored(id)
  }
  const withSticker = await dmIn({ id: 'peer-sticker', url: peerUrl, name: 'Peer wave', description: 'A cat waving', mediaType: 'image/png' })
  const types = (withSticker ?? []).map((p) => p.type)
  assert(types.includes('sticker') && types.includes('file'), 'a 1.9.2 sender\'s DM becomes a sticker and its fallback', JSON.stringify(withSticker))
  const dmSticker = (withSticker ?? []).find((p) => p.type === 'sticker')
  eq(dmSticker?.domain, peerHost, 'marked as the peer\'s')
  eq((withSticker ?? []).find((p) => p.type === 'file')?.stickerId, 'peer-sticker', 'with the attachment as its fallback')
  const plain = await dmIn(undefined)
  eq(JSON.stringify((plain ?? []).filter((p) => p.type !== 'text').map((p) => [p.type, p.stickerId ?? null])), JSON.stringify([['file', null]]),
    'a DM without harmony:sticker, as Mastodon sends it, stays an image')
}
