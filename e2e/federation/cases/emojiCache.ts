// Emoji tags of an inbound public Note land in the remote emoji cache, the list an instance
// admin imports from (federation-backend utils/remoteEmojiCache.ts, upsert_remote_emoji).
//
//   - the peer's emoji with Misskey's _misskey_license.freeText: cached under the peer's host,
//     not the host serving its image, with the licence;
//   - the peer's emoji without a licence: cached with none;
//   - an emoji the Note qualifies with another instance: not cached, the peer does not speak
//     for that instance.
//
// The tags ride on a Note inbound-posts.ts already delivers: the inbox admits 60 deliveries a
// minute from one signing host and the cases around it spend that share.

import type { SupabaseClient } from '@supabase/supabase-js'

export interface EmojiCacheProbe {
  /** Emoji tags for the Note's `tag`. */
  tags: unknown[]
  licensed: string
  licensedUrl: string
  license: string
  plain: string
  foreign: string
}

export function emojiCacheProbe(peerBase: string): EmojiCacheProbe {
  const tag = crypto.randomUUID().slice(0, 6)
  const licensed = `blobcat${tag}`
  const plain = `plain${tag}`
  const foreign = `theirs${tag}`
  const licensedUrl = `https://media.example.net/emoji/${licensed}.png`
  const license = `CC BY 4.0, Artist ${tag}`
  const emoji = (name: string, url: string, extra: Record<string, unknown> = {}) => ({
    type: 'Emoji', id: `${peerBase}/emojis/${name.replace(/[:@.]/g, '')}`, name,
    icon: { type: 'Image', mediaType: 'image/png', url }, ...extra,
  })
  return {
    tags: [
      emoji(`:${licensed}:`, licensedUrl, { _misskey_license: { freeText: license } }),
      emoji(`:${plain}:`, `${peerBase}/emoji/${plain}.png`),
      emoji(`:${foreign}@other.example:`, `https://other.example/emoji/${foreign}.png`),
    ],
    licensed, licensedUrl, license, plain, foreign,
  }
}

interface Cached {
  origin_domain: string
  full_code: string
  url: string
  license: string | null
  usage_count: number
}

/** After the Note carrying `probe.tags` was accepted and stored. */
export async function checkEmojiCache(
  ctx: {
    db: SupabaseClient
    peer: { base: string }
    assert: (cond: unknown, msg: string, detail?: unknown) => void
    eq: (actual: unknown, expected: unknown, msg: string) => void
  },
  probe: EmojiCacheProbe,
): Promise<void> {
  const { db, assert, eq } = ctx
  const peerHost = new URL(ctx.peer.base).host.toLowerCase()
  const cached = async (shortcode: string) =>
    (await db.from('remote_emojis_cache').select('origin_domain, full_code, url, license, usage_count')
      .eq('shortcode', shortcode).maybeSingle()).data as Cached | null

  // The cache write follows the stored post without holding the delivery's answer.
  let plain: Cached | null = null
  for (let i = 0; i < 50 && !plain; i++) {
    plain = await cached(probe.plain)
    if (!plain) await new Promise((r) => setTimeout(r, 100))
  }
  assert(plain, "the Note's emoji reach the remote emoji cache")

  const row = await cached(probe.licensed)
  eq(row ? `${row.origin_domain} ${row.full_code} ${row.url}` : null,
    `${peerHost} :${probe.licensed}@${peerHost}: ${probe.licensedUrl}`,
    "an emoji is cached under the peer's host, not its image host")
  eq(row?.license, probe.license, 'with the licence the peer sent')
  eq(row?.usage_count, 1, 'counted once')
  eq(plain?.license ?? null, null, 'an emoji sent without a licence has none')
  eq(await cached(probe.foreign), null, 'an emoji of another instance is not cached from the peer')

  await db.from('remote_emojis_cache').delete().in('shortcode', [probe.licensed, probe.plain, probe.foreign])
}
