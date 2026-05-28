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
 * Schemes that are safe to render in href/src for user-controlled content.
 * NOTE: `data:` is intentionally excluded - it enables XSS via `data:text/html,...`.
 * `blob:` is allowed because it's commonly used for in-app previews (own-origin only).
 */
const SAFE_URL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:', 'blob:']);

/**
 * Tags allowed inside user-generated message HTML (chat, DMs, profile bios).
 *
 * Notably absent: `<style>`, `<script>`, `<iframe>`, `<object>`, `<embed>`,
 * `<form>`, `<input>`, `<link>`, `<meta>`, `<base>`. Allowing any of these
 * lets a remote user repaint or break out of the app UI even though Vue's
 * `v-html` strips inline `<script>` execution.
 *
 * `<img>` is allowed for inline emojis only — DOMPurify will still strip
 * dangerous attributes (`onerror`, `onload`, …) via `FORBID_ATTR` below.
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
  // narrowly-scoped style is allowed for role mention colors set by our own
  // renderer; DOMPurify still parses/sanitizes the property list.
  'style',
];

/**
 * Sanitize HTML produced by Harmony's chat/DM/profile message renderers.
 *
 * This is the last line of defense against user-injected HTML. Even if an
 * earlier escape step failed (e.g. a renderer accidentally splices unescaped
 * user text into its output), this strips every tag/attribute that isn't on
 * the allowlist.
 *
 * Use this on the FINAL HTML string immediately before passing it to
 * `v-html`. Do NOT use it on partial fragments that will later be
 * concatenated with untrusted text — concatenation after sanitization
 * re-introduces injection risk.
 */
export function sanitizeMessageHtml(html: string): string {
  if (!html) return '';
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS: MESSAGE_ALLOWED_TAGS,
    ALLOWED_ATTR: MESSAGE_ALLOWED_ATTR,
    // No data-* (blocks `data-uri-template` and friends used by some browser
    // extensions; we don't render data-* in messages anyway).
    ALLOW_DATA_ATTR: false,
    // Strip unknown protocols in href/src - belt and suspenders alongside our
    // own `sanitizeUrl`. `\b(?:blob|tel|mailto|http|https):` matches absolute
    // safe-scheme URLs; relative/hash refs are allowed by default.
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
    // Defensive: block any <style>/<script>/<iframe> even if they sneak past
    // ALLOWED_TAGS (e.g. via mXSS in older browsers).
    FORBID_TAGS: ['style', 'script', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form', 'input', 'textarea', 'button', 'select', 'option'],
  });
}

/**
 * Sanitizer for the structural HTML built by `useContentRenderer`'s
 * `formattedHTML` (HTML-mode) path. This output is our own renderer output,
 * not raw user HTML — but it inlines user-supplied text into the markup
 * (mentions, hashtags, URLs, emoji shortcodes), so a regression in any of
 * those branches could reintroduce XSS.
 *
 * Compared to `sanitizeMessageHtml`, this allows the additional structural
 * tags the formatter emits: `div`, `iframe` (YouTube embeds), `video`,
 * `audio`, `source`, `picture`, `figure`, `figcaption`. Inline event
 * handlers (`onerror`, etc.) are still stripped.
 *
 * Note: `iframe`s are restricted to the YouTube embed origin by the renderer
 * before this sanitizer runs (via `sanitizeUrl` + buildYouTubeEmbedUrl);
 * DOMPurify additionally enforces a safe-URI regex on `src` attributes.
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
 * Strict bio/display-name sanitizer. Same allowlist as the message
 * sanitizer but with `<a>` blocked — display names and bios should never
 * contain interactive links injected by the user; if we want clickable
 * URLs there we should render them through the structured MessagePart
 * pipeline.
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
