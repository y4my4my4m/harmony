import DOMPurify from 'dompurify';

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
 * Schemes safe to render in href/src for user-controlled content.
 * NOTE: `data:` is excluded - it enables XSS via `data:text/html,...`.
 * `blob:` is allowed for in-app previews (own-origin only).
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'blob:']);

/**
 * Tags allowed inside user-generated message HTML (chat, DMs, profile bios).
 *
 * Absent: `<style>`, `<script>`, `<iframe>`, `<object>`, `<embed>`, `<form>`,
 * `<input>`, `<link>`, `<meta>`, `<base>`. Any of these lets a remote user
 * repaint or break out of the app UI even though Vue's `v-html` strips inline
 * `<script>` execution.
 *
 * `<img>` is allowed for inline emojis; `FORBID_ATTR` below still strips
 * `onerror`, `onload`, and friends.
 */
const MESSAGE_ALLOWED_TAGS = [
  'a',
  'b',
  'blockquote',
  'br',
  'code',
  'del',
  'em',
  'i',
  'img',
  'p',
  's',
  'span',
  'strong',
  'sub',
  'sup',
  'u',
];

const MESSAGE_ALLOWED_ATTR = [
  'class',
  'alt',
  'title',
  'src',
  'href',
  'rel',
  'target',
  'draggable',
  // style carries role mention colors from the renderer; DOMPurify still
  // parses and sanitizes the property list.
  'style',
];

/**
 * Sanitize HTML produced by the chat/DM/profile message renderers.
 *
 * Last line of defense against user-injected HTML: strips every tag and
 * attribute off the allowlist even when an earlier escape step failed.
 *
 * IMPORTANT: apply to the final HTML string immediately before `v-html`.
 * Concatenating untrusted text onto sanitized output re-introduces injection.
 */
export function sanitizeMessageHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MESSAGE_ALLOWED_TAGS,
    ALLOWED_ATTR: MESSAGE_ALLOWED_ATTR,
    // No data-*; blocks `data-uri-template` and friends injected by browser
    // extensions. Messages never render data-* attributes.
    ALLOW_DATA_ATTR: false,
    // Strip unknown protocols in href/src, redundant with `sanitizeUrl`.
    // Regex matches absolute safe-scheme URLs; relative/hash refs pass by
    // default.
    ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|blob):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    // Forbid even if they end up in ALLOWED_ATTR via aliasing
    FORBID_ATTR: [
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onmouseout',
      'onfocus',
      'onblur',
      'onkeyup',
      'onkeydown',
      'onkeypress',
      'onsubmit',
      'onchange',
      'onanimationstart',
      'onanimationend',
      'onanimationiteration',
      'ontransitionend',
      'formaction',
      'srcdoc',
    ],
    // Blocks <style>/<script>/<iframe> even if they pass ALLOWED_TAGS via
    // mXSS in older browsers.
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'button', 'select', 'option'],
  });
}

/**
 * Allowlist for the structural HTML built by `useContentRenderer`'s
 * `formattedHTML` (HTML-mode) path. That markup is renderer output, but it
 * inlines user-supplied text (mentions, hashtags, URLs, emoji shortcodes).
 *
 * Adds to `sanitizeMessageHtml`'s set the structural tags the formatter
 * emits: `div`, `iframe` (YouTube embeds), `video`, `audio`, `source`,
 * `picture`, `figure`, `figcaption`. Inline event handlers are still stripped.
 *
 * `iframe` src is restricted to the YouTube embed origin by the renderer
 * before this sanitizer runs (`sanitizeUrl` + buildYouTubeEmbedUrl).
 */
const FORMATTED_HTML_ALLOWED_TAGS = [
  ...MESSAGE_ALLOWED_TAGS,
  'div',
  'iframe',
  'video',
  'audio',
  'source',
  'picture',
  'figure',
  'figcaption',
];

const FORMATTED_HTML_ALLOWED_ATTR = [
  ...MESSAGE_ALLOWED_ATTR,
  'controls',
  'preload',
  'loading',
  'allow',
  'allowfullscreen',
  'frameborder',
  'data-tag',
  'data-user-id',
  'data-handle',
];

export function sanitizeFormattedHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: FORMATTED_HTML_ALLOWED_TAGS,
    ALLOWED_ATTR: FORMATTED_HTML_ALLOWED_ATTR,
    ALLOW_DATA_ATTR: false,
    ADD_URI_SAFE_ATTR: ['href', 'src'],
    FORBID_ATTR: [
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onmouseout',
      'onfocus',
      'onblur',
      'onkeyup',
      'onkeydown',
      'onkeypress',
      'onsubmit',
      'onchange',
      'onanimationstart',
      'onanimationend',
      'onanimationiteration',
      'ontransitionend',
      'formaction',
      'srcdoc',
    ],
    FORBID_TAGS: ['style', 'script', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'button', 'select', 'option'],
  });
}

/**
 * Bio/display-name sanitizer. Message allowlist minus `<a>`: user-injected
 * interactive links are not permitted there. Clickable URLs in bios go
 * through the structured MessagePart pipeline instead.
 */
export function sanitizeInlineHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MESSAGE_ALLOWED_TAGS.filter((t) => t !== 'a'),
    ALLOWED_ATTR: MESSAGE_ALLOWED_ATTR.filter((a) => a !== 'href' && a !== 'rel' && a !== 'target'),
    ALLOW_DATA_ATTR: false,
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'button', 'select', 'option', 'a'],
    FORBID_ATTR: [
      'onerror',
      'onload',
      'onclick',
      'onmouseover',
      'onmouseout',
      'onfocus',
      'onblur',
      'onkeyup',
      'onkeydown',
      'onkeypress',
      'onsubmit',
      'onchange',
      'onanimationstart',
      'onanimationend',
      'onanimationiteration',
      'ontransitionend',
      'formaction',
      'srcdoc',
    ],
  });
}

/**
 * Sanitize a URL string for safe insertion into HTML href/src.
 *
 * Blocks schemes that execute script when clicked (`javascript:`, `data:`,
 * `vbscript:`, `file:`).
 *
 * Behavior:
 * - Returns `""` for `null`/`undefined`/empty input.
 * - Returns `""` for URLs whose scheme is not in `SAFE_URL_SCHEMES`.
 * - Returns the (trimmed) input unchanged for safe absolute URLs and for
 *   scheme-less URLs (relative paths, protocol-relative `//host/...`).
 * - Strips ASCII control characters (incl. tabs/newlines); browsers ignore
 *   them when parsing the scheme, a known XSS bypass vector
 *   (`java\tscript:`, `java\nscript:`).
 *
 * Use together with `escapeHtml` when inlining into HTML:
 *   `<a href="${escapeHtml(sanitizeUrl(url))}">`
 */
export function sanitizeUrl(url: string | null | undefined): string {
  if (url == null) return '';
  // Strip ASCII control chars (0x00-0x1F, 0x7F): browsers ignore them when
  // matching the URL scheme, enabling bypasses like "java\tscript:".
  // eslint-disable-next-line no-control-regex
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';

  // Scheme-less (relative path, protocol-relative, fragment, query-only) -> allow.
  // A scheme requires `[a-z][a-z0-9+.-]*:` per RFC 3986.
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) return cleaned;

  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES.has(scheme)) return '';

  // Structural check via URL parser: rejects malformed URLs that pass the
  // regex but break downstream rendering.
  try {
    // eslint-disable-next-line no-new
    new URL(cleaned);
  } catch {
    return '';
  }
  return cleaned;
}
