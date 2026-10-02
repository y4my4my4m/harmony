/**
 * Custom emoji in a Misskey user's name, as {name, url}. Misskey's `emojis` map lists only
 * remote emoji; a shortcode missing from it is served by the queried instance at
 * /emoji/<name>.webp, or /emoji/<name>@<host>.webp for a user from another host (Misskey's
 * own client resolves it the same way).
 */
export function misskeyDisplayNameEmojis(
  user: { name?: string | null; host?: string | null; emojis?: unknown } | null | undefined,
  instanceDomain: string,
): Array<{ name: string; url: string }> {
  const byName = new Map<string, string>();
  if (user?.emojis && typeof user.emojis === 'object' && !Array.isArray(user.emojis)) {
    for (const [name, url] of Object.entries(user.emojis as Record<string, unknown>)) {
      if (typeof url === 'string' && /^https:\/\//.test(url)) byName.set(name, url);
    }
  }
  const host = user?.host && user.host !== '.' ? user.host : null;
  for (const match of (user?.name ?? '').matchAll(/:([A-Za-z0-9_+-]+):/g)) {
    const name = match[1];
    if (byName.has(name)) continue;
    const path = host ? `${name}@${host}` : name;
    byName.set(name, `https://${instanceDomain}/emoji/${encodeURIComponent(path)}.webp`);
  }
  return [...byName].map(([name, url]) => ({ name, url }));
}
