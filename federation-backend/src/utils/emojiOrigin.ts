/**
 * Shortcode and origin instance of an inbound custom emoji.
 *
 * The origin is the instance the emoji belongs to, not the host serving its image: a Harmony
 * instance serves emoji from its storage host (db.example for example.org), Mastodon from a media
 * host or CDN. Mastodon's ProcessEmojisService keys a status's emoji on the account's domain.
 *
 * A qualified shortcode `name@domain` (Harmony's emojiResolvers.formatEmojiForFederation sends
 * every emoji not local to the receiver this way; Misskey uses `name@host`, and `name@.` for
 * its own) names its origin. An unqualified one belongs to the sender's instance.
 */

const HOST = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?::\d{1,5})?$/i;

function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).host.toLowerCase() || null;
  } catch {
    return null;
  }
}

export interface EmojiOrigin {
  /** Shortcode without colons or an origin suffix. */
  name: string;
  /**
   * Origin instance host, lowercase; null when neither the name nor the actor names one. A
   * shortcode qualified with `ownDomain` names an emoji of this instance (`own`); the domain is
   * then the sender's, for a row that holds a copy this instance does not recognise.
   */
  domain: string | null;
  own: boolean;
}

export function inboundEmojiOrigin(
  rawName: string,
  actorUrl: string | null | undefined,
  ownDomain?: string | null,
): EmojiOrigin {
  const bare = rawName.replace(/:/g, '').trim();
  const at = bare.lastIndexOf('@');
  const sender = hostOf(actorUrl);
  if (at > 0) {
    const suffix = bare.slice(at + 1).toLowerCase();
    const name = bare.slice(0, at);
    if (suffix === '.' || suffix === '') return { name, domain: sender, own: false };
    if (ownDomain && suffix === ownDomain.toLowerCase()) return { name, domain: sender, own: true };
    if (HOST.test(suffix)) return { name, domain: suffix, own: false };
  }
  return { name: bare, domain: sender, own: false };
}

/**
 * This instance's emojis row an inbound image URL names: not removed, unqualified (domain NULL),
 * stored under the same storage object key. A peer may echo the image from another host or the
 * render endpoint, so the key after `/public/` is compared, not the URL.
 */
export async function ownEmojiId(supabase: any, emojiUrl: string): Promise<string | null> {
  let key: string | null = null;
  try {
    const path = new URL(emojiUrl).pathname;
    const at = path.indexOf('/public/');
    key = at >= 0 ? path.slice(at + '/public/'.length) : null;
  } catch {
    return null;
  }
  if (!key || !key.startsWith('emojis/')) return null;
  const pattern = `%/public/${key.replace(/[\\%_]/g, (c) => `\\${c}`)}`;
  const { data } = await supabase
    .from('emojis')
    .select('id')
    .is('domain', null)
    .is('deleted_at', null)
    .like('url', pattern)
    .limit(1)
    .maybeSingle();
  return data?.id ?? null;
}
