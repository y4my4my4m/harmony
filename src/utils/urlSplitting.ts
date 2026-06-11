/**
 * Split URLs that were concatenated without separators (e.g. bridge code that
 * joined `https://a.png` + `https://b.png` into one string).
 */

/** Match until whitespace, glued next URL, closing bracket, or end of string. */
const GLUED_URL_BODY_REGEX = /https?:\/\/[^\s<>"']+?(?=https?:\/\/|\s|$|>)/g;

/** Strip trailing punctuation often captured when URLs are glued in prose. */
export function trimUrlTrailingDelimiter(url: string): { url: string; trimmedChars: number } {
  let trimmedChars = 0;
  let cleaned = url;
  while (cleaned.length > 0 && /[.,;:!?)>\]}]$/.test(cleaned)) {
    cleaned = cleaned.slice(0, -1);
    trimmedChars++;
  }
  return { url: cleaned, trimmedChars };
}

/**
 * Extract individual http(s) URLs from a string, including multiple URLs glued
 * together (`...pnghttps://...`).
 */
export function extractHttpUrls(text: string): string[] {
  if (!text) return [];

  const urls: string[] = [];
  GLUED_URL_BODY_REGEX.lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = GLUED_URL_BODY_REGEX.exec(text)) !== null) {
    const { url } = trimUrlTrailingDelimiter(match[0]);
    if (url) urls.push(url);
  }

  return urls;
}

/**
 * Discord-style: URLs wrapped in angle brackets (<https://...>) are linked but
 * do not generate embeds/previews. Brackets are omitted from stored content.
 */
export function parseUrlMatchContext(
  text: string,
  matchIndex: number,
  rawLength: number,
): { url: string; preview: boolean; segmentStart: number; segmentEnd: number } {
  const suppressed = matchIndex > 0 && text[matchIndex - 1] === '<';
  let segmentStart = matchIndex;
  let segmentEnd = matchIndex + rawLength;

  const { url: trimmedUrl, trimmedChars } = trimUrlTrailingDelimiter(text.slice(matchIndex, segmentEnd));
  segmentEnd -= trimmedChars;

  if (suppressed) {
    segmentStart -= 1;
    if (segmentEnd < text.length && text[segmentEnd] === '>') {
      segmentEnd += 1;
    }
  }

  return { url: trimmedUrl, preview: !suppressed, segmentStart, segmentEnd };
}

/** Shared regex for URL tokenization (compose-time and display-time). */
export const URL_TOKEN_REGEX = GLUED_URL_BODY_REGEX;

/**
 * Split prose into text/url parts, honouring Discord-style `<https://...>`
 * suppress-embed syntax. Does not parse emojis or mentions.
 */
export function splitTextForUrlParts(
  text: string,
): Array<{ type: 'text'; text: string } | { type: 'url'; url: string; preview: boolean }> {
  if (!text) return [];

  const parts: Array<{ type: 'text'; text: string } | { type: 'url'; url: string; preview: boolean }> = [];
  URL_TOKEN_REGEX.lastIndex = 0;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = URL_TOKEN_REGEX.exec(text)) !== null) {
    const { url, preview, segmentStart, segmentEnd } = parseUrlMatchContext(
      text,
      match.index,
      match[0].length,
    );
    if (!url) continue;

    if (segmentStart > lastIndex) {
      const before = text.slice(lastIndex, segmentStart);
      if (before) parts.push({ type: 'text', text: before });
    }

    parts.push({ type: 'url', url, preview });
    lastIndex = segmentEnd;
  }

  if (lastIndex < text.length) {
    const tail = text.slice(lastIndex);
    if (tail) parts.push({ type: 'text', text: tail });
  }

  return parts;
}

/** True when text is only multiple URLs concatenated (bridge attachment glue). */
export function isPureGluedUrlBlob(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.includes('<') || trimmed.includes('>')) return false;
  const urls = extractHttpUrls(trimmed);
  return urls.length > 1 && urls.join('') === trimmed.replace(/\s/g, '');
}
