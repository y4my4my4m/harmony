const escapeMap: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#039;',
};

const escapeRegex = /[&<>"']/g;

export function escapeHtml(text: string): string {
  return text.replace(escapeRegex, (char) => escapeMap[char]);
}

/**
 * Schemes that are safe to render in href/src for user-controlled content.
 * NOTE: `data:` is intentionally excluded - it enables XSS via `data:text/html,...`.
 * `blob:` is allowed because it's commonly used for in-app previews (own-origin only).
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'blob:']);

/**
 * Sanitize a URL string for safe insertion into HTML href/src.
 *
 * Blocks dangerous schemes (`javascript:`, `data:`, `vbscript:`, `file:`, etc.) which
 * would otherwise execute script when clicked.
 *
 * Behavior:
 * - Returns `""` for `null`/`undefined`/empty input.
 * - Returns `""` for URLs whose scheme is not in `SAFE_URL_SCHEMES`.
 * - Returns the (trimmed) input unchanged for safe absolute URLs and for
 *   scheme-less URLs (relative paths, protocol-relative `//host/...`).
 * - Strips ASCII control characters (incl. tabs/newlines) which browsers ignore
 *   when parsing the scheme - these are a known XSS bypass vector
 *   (`java\tscript:`, `java\nscript:`).
 *
 * Use together with `escapeHtml` when inlining into HTML:
 *   `<a href="${escapeHtml(sanitizeUrl(url))}">`
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (url == null) return '';
  // Strip ASCII control chars (0x00–0x1F and 0x7F) - browsers ignore these
  // when matching the URL scheme, enabling bypasses like "java\tscript:".
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';

  // Scheme-less (relative path, protocol-relative, fragment, query-only) → allow.
  // A scheme requires `[a-z][a-z0-9+.-]*:` per RFC 3986.
  const schemeMatch = /^([a-z][a-z0-9+.\-]*):/i.exec(cleaned);
  if (!schemeMatch) return cleaned;

  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES.has(scheme)) return '';

  // Final structural check via URL parser (defends against malformed URLs that
  // pass the regex but break downstream rendering).
  try {
    // eslint-disable-next-line no-new
    new URL(cleaned);
  } catch {
    return '';
  }
  return cleaned;
}
