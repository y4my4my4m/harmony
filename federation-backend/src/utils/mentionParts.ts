import config from '../config/index.js';

/**
 * Normalises mention parts received in `harmony:rawContent`. Locality is
 * relative to the sending instance there; here it is re-derived from the
 * host. A part without a host names a user of the sender, so it takes
 * `originHost`, never this instance's host.
 */
export function normalizeInboundMentions(content: any[], originHost: string | null): any[] {
  if (!Array.isArray(content)) return content;
  const localHost = String(config.INSTANCE_DOMAIN || '').toLowerCase();
  const origin = originHost ? originHost.toLowerCase() : null;
  return content.map((part: any) => {
    if (part?.type !== 'mention') return part;
    if (part.isBridged || part.domain === 'discord.com') return part;
    const domain = typeof part.domain === 'string' && part.domain
      ? part.domain.toLowerCase()
      : origin;
    if (!domain) return part;
    return {
      ...part,
      username: typeof part.username === 'string' ? part.username.replace(/^@+/, '') : part.username,
      domain,
      isLocal: domain === localHost,
    };
  });
}

/** Hostname (no port) of an actor URL, lowercased; null when unparseable. */
export function actorHostname(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
}
