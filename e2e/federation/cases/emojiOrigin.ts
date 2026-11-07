// Inbound custom emoji reactions name their instance, not the host serving the image.
//
//   - the peer reacts with :eyes@<peer>: whose image sits on its storage host db.<peer>
//     (Harmony qualifies every emoji it sends to another instance): the emojis row is named
//     `eyes` with the peer's host as its domain, and the remote emoji cache keys it the same;
//   - the peer reacts with an unqualified :wave: served from a CDN: the row takes the peer's host;
//   - the peer reacts with :<name>@<this instance>: whose image is this instance's emoji, served
//     from another host: the reaction takes this instance's row, and no copy is stored.

import type { SupabaseClient } from '@supabase/supabase-js'

const AS = 'https://www.w3.org/ns/activitystreams'

// Fixed so a failure names a row.
const REACTED_POST = 'fed00239-0000-0000-0000-000000000001'

export interface EmojiOriginContext {
  db: SupabaseClient
  peer: { base: string; actorUrl: string; key: { privateKey: string } }
  localUrl: string
  instanceDomain: string
  ids: { alice: string }
  post: (url: string, headers: Record<string, string>, body: string) => Promise<{ status: number; body: string }>
  signedHeaders: (url: string, body: string, privateKey: string, keyId: string) => Record<string, string>
  assert: (cond: unknown, msg: string, detail?: unknown) => void
  eq: (actual: unknown, expected: unknown, msg: string) => void
}

export async function caseEmojiOrigin(ctx: EmojiOriginContext): Promise<void> {
  console.log('\ninbound emoji reaction -> the emoji names its instance, not its image host')
  const { db, peer, localUrl, instanceDomain, ids, assert, eq } = ctx
  const peerHost = new URL(peer.base).host.toLowerCase()
  const peerDomain = peerHost.replace(/:\d+$/, '')
  const tag = crypto.randomUUID().slice(0, 6)
  const eyesUrl = `https://db.${peerDomain}/storage/v1/object/public/emojis/eyes-${tag}.png`
  const waveUrl = `https://cdn.example.net/emoji/wave-${tag}.png`

  await db.from('posts').delete().eq('id', REACTED_POST)
  const seeded = await db.from('posts').insert({
    id: REACTED_POST, author_id: ids.alice, visibility: 'public', is_local: true,
    content: [{ type: 'text', text: 'react with your emoji' }],
  })
  assert(!seeded.error, 'seed the reacted post', seeded.error?.message)

  const react = (name: string, url: string) => ({
    '@context': [AS, { Emoji: 'toot:Emoji', toot: 'http://joinmastodon.org/ns#' }],
    id: `${peer.actorUrl}#react-${crypto.randomUUID()}`,
    type: 'EmojiReact',
    actor: peer.actorUrl,
    object: `https://${instanceDomain}/posts/${REACTED_POST}`,
    content: name,
    tag: [{ type: 'Emoji', id: url, name, icon: { type: 'Image', mediaType: 'image/png', url } }],
  })
  const deliver = async (activity: unknown) => {
    const body = JSON.stringify(activity)
    const target = `${localUrl}/inbox`
    return (await ctx.post(target, ctx.signedHeaders(target, body, peer.key.privateKey, `${peer.actorUrl}#main-key`), body)).status
  }

  eq(await deliver(react(`:eyes@${peerDomain}:`, eyesUrl)), 202, 'a reaction with a qualified emoji is accepted (202)')
  eq(await deliver(react(':wave:', waveUrl)), 202, 'a reaction with an unqualified emoji is accepted (202)')

  const row = async (url: string) =>
    (await db.from('emojis').select('name, domain').eq('url', url).maybeSingle()).data as { name: string; domain: string } | null
  const eyes = await row(eyesUrl)
  eq(eyes?.name, 'eyes', 'the qualified shortcode is stored without its suffix')
  eq(eyes?.domain, peerDomain, "and its domain is the peer's host, not its storage host")
  const wave = await row(waveUrl)
  eq(wave?.domain, peerHost, "an unqualified emoji served from a CDN takes the sender's host")

  const { data: cached } = await db.from('remote_emojis_cache').select('shortcode, origin_domain, full_code').eq('url', eyesUrl).maybeSingle()
  eq(cached ? `${cached.shortcode} ${cached.origin_domain} ${cached.full_code}` : null, `eyes ${peerDomain} :eyes@${peerDomain}:`,
    'the remote emoji cache keys it by its instance')

  const { data: reactions } = await db.from('post_interactions').select('emoji_id').eq('post_id', REACTED_POST).eq('interaction_type', 'emoji_reaction')
  eq((reactions ?? []).filter((r) => r.emoji_id).length, 2, 'both reactions point at their emoji rows')

  const ownName = `own${tag}`
  const ownKey = `emojis/instance/${ownName}.png`
  const { data: own, error: ownError } = await db.from('emojis').insert({
    name: ownName, url: `https://${instanceDomain}/storage/v1/object/public/${ownKey}`, server_id: null, domain: null, scope: 'instance',
  }).select('id').single()
  assert(!ownError && own, 'seed an emoji of this instance', ownError?.message)
  const echoed = `https://media.example.net/storage/v1/render/image/public/${ownKey}`
  eq(await deliver(react(`:${ownName}@${instanceDomain}:`, echoed)), 202, 'a reaction with this instance\'s own emoji is accepted (202)')
  const { data: ownReaction } = await db.from('post_interactions').select('emoji_id')
    .eq('post_id', REACTED_POST).eq('interaction_type', 'emoji_reaction').eq('emoji_id', own!.id).maybeSingle()
  assert(ownReaction, 'it points at this instance\'s row')
  eq((await db.from('emojis').select('id').eq('url', echoed)).data?.length ?? 0, 0, 'and no copy of it is stored')
  await db.from('emojis').delete().eq('id', own!.id)
}
