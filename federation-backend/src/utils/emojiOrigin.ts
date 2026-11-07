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
  /** Origin instance host, lowercase; null when neither the name nor the actor names one. */
  domain: string | null;
}

export function inboundEmojiOrigin(rawName: string, actorUrl: string | null | undefined): EmojiOrigin {
  const bare = rawName.replace(/:/g, '').trim();
  const at = bare.lastIndexOf('@');
  const sender = hostOf(actorUrl);
  if (at > 0) {
    const suffix = bare.slice(at + 1).toLowerCase();
    const name = bare.slice(0, at);
    if (suffix === '.' || suffix === '') return { name, domain: sender };
    if (HOST.test(suffix)) return { name, domain: suffix };
  }
  return { name: bare, domain: sender };
}
