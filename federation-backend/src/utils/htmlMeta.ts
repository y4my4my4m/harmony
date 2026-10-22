import { decodeHtmlEntities } from './contentUtils.js';

/** A tag's attributes by lower-case name, in any order and quote style. */
export function tagAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const a of raw.matchAll(/([a-z:_-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/gi)) {
    attrs[a[1].toLowerCase()] = a[2] ?? a[3] ?? a[4] ?? '';
  }
  return attrs;
}

/**
 * Every <meta> tag's property, name or itemprop and its content, attributes in any order and
 * either quote style; the first occurrence of a key wins. Keys are lower-cased.
 */
export function parseMetaTags(html: string): Map<string, string> {
  const tags = new Map<string, string>();
  const tagPattern = /<meta\b([^>]*)>/gi;
  for (const tag of html.matchAll(tagPattern)) {
    const attrs = tagAttributes(tag[1]);
    const key = (attrs.property || attrs.name || attrs.itemprop || '').toLowerCase();
    const content = attrs.content;
    if (key && content !== undefined && content !== '' && !tags.has(key)) tags.set(key, decodeHtmlEntities(content));
  }
  return tags;
}
