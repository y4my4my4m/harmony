/**
 * A display name for surfaces that paint plain text only: link-preview cards (OpenGraph,
 * Twitter, oEmbed), page titles and OS notifications. Custom emoji shortcodes (`:blob:`,
 * Misskey's `:blob@host:`) are dropped with the U+200B spacers Harmony writes around them;
 * whitespace collapses. A name made of emoji alone falls back to `fallback`.
 */
export function plainDisplayName(name: string | null | undefined, fallback = ''): string {
  const plain = (name ?? '')
    .replace(/:[a-zA-Z0-9_+-]+(?:@[a-zA-Z0-9.-]+)?:/g, '')
    .replace(/​/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return plain || fallback;
}
