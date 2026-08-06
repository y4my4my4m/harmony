/**
 * XSS regression tests for `postPageRenderer.ts`, which renders the
 * `/posts/:id` page served to browsers and link-preview crawlers.
 *
 * The page CSP allows `'unsafe-inline'` for scripts and styles (needed by
 * the inline auth-redirect snippet and the inline `<style>` block), so any
 * `<style>` / `<script>` / `<img onerror>` smuggled into the rendered HTML
 * executes.
 *
 * Assertions run against the rendered HTML string via regex, scoped to the
 * user-content `.content` div; no DOM in the federation-backend test env.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
}));

import { renderPostPage } from '../activitypub/postPageRenderer.js';

const baseAuthor = {
  username: 'alice',
  display_name: 'Alice',
  avatar_url: null,
  federation_metadata: null,
};

function basePost(content: any) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    content,
    content_warning: null,
    visibility: 'public',
    created_at: '2026-01-01T00:00:00Z',
    favorites_count: 0,
    reblogs_count: 0,
    replies_count: 0,
  };
}

/**
 * Slice out the user-controlled region, which the renderer wraps in
 * `<div class="content">...</div>`. Excludes the head `<style>` block,
 * the inline auth-redirect `<script>`, and structural tags.
 */
function userContent(html: string): string {
  const m = /<div class="content">([\s\S]*?)<\/div>\s*(?:<div class="media-grid|<div class="stats-bar|<div class="meta)/i.exec(html);
  if (!m) {
    // No media/stats/meta section: take everything from the opening tag on.
    const start = html.indexOf('<div class="content">');
    expect(start, 'expected <div class="content"> in rendered page').toBeGreaterThan(-1);
    return html.slice(start);
  }
  return m[1];
}

const DANGEROUS_TAG_PATTERNS = [
  /<style\b/i,
  /<script\b/i,
  /<iframe\b/i,
  /<object\b/i,
  /<embed\b/i,
  /<link\b/i,
  /<meta\b/i,
  /<base\b/i,
  /<form\b/i,
  /<input\b/i,
];

/**
 * Invoke `fn` with each HTML start-tag's full `<tag attrs>` substring.
 * Scoping attribute checks to real tags avoids false positives on escaped
 * text, e.g. a literal ` onerror=` inside a value whose quotes became
 * `&quot;`.
 */
function forEachStartTag(html: string, fn: (tag: string) => void) {
  // `<` + tag-name + body up to the first unescaped `>`. Attribute values
  // carry `>` only as `&gt;`, which never matches the bare terminator.
  const tagRegex = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(html)) !== null) {
    fn(m[0]);
  }
}

/**
 * Decode the five named HTML entities plus numeric apostrophes, so
 * attribute values compare against literals after un-escaping.
 */
function decodeHtmlEntities(str: string): string {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/gi, "'");
}

/**
 * Parse a `<tag attrs>` substring into `{ name: decodedValue }`. Handles
 * only the canonical `name="value"` / `name='value'` shape the renderer
 * emits; nested quoting is out of scope.
 */
function parseAttrs(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  const attrRegex = /\b([a-zA-Z_:][a-zA-Z0-9_:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g;
  let m: RegExpExecArray | null;
  while ((m = attrRegex.exec(tag)) !== null) {
    const name = m[1].toLowerCase();
    const rawValue = m[2] ?? m[3] ?? m[4] ?? '';
    attrs[name] = decodeHtmlEntities(rawValue);
  }
  return attrs;
}

function assertNoExecutableUserContent(html: string) {
  const island = userContent(html);
  for (const pattern of DANGEROUS_TAG_PATTERNS) {
    expect(pattern.test(island), `unexpected dangerous tag in user content`).toBe(false);
  }

  forEachStartTag(island, (tag) => {
    const attrs = parseAttrs(tag);
    // No inline event handlers.
    for (const name of Object.keys(attrs)) {
      expect(
        name.startsWith('on'),
        `unexpected on*= handler on a real tag in user content: <${tag}>`,
      ).toBe(false);
    }
    // href/src/action must not be a javascript:/data:text/html URL.
    for (const attrName of ['href', 'src', 'action', 'formaction']) {
      const val = attrs[attrName];
      if (val) {
        const lowered = val.trim().toLowerCase();
        expect(
          lowered.startsWith('javascript:') || lowered.startsWith('data:text/html'),
          `unsafe URL scheme on ${attrName}="${val}" in user content`,
        ).toBe(false);
      }
    }
  });
}

describe('renderPostPage - XSS regression', () => {
  it('escapes <style> in a text part', () => {
    const html = renderPostPage(
      basePost([{ type: 'text', text: '<style>body{display:none}</style> hi' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
    // Escaped form survives in the output.
    const island = userContent(html);
    expect(island).toContain('&lt;style&gt;');
  });

  it('escapes <script> in a text part', () => {
    const html = renderPostPage(
      basePost([{ type: 'text', text: '<script>alert(1)</script>after' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('escapes <img onerror> in a text part', () => {
    const html = renderPostPage(
      basePost([{ type: 'text', text: '<img src=x onerror=alert(1)>' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('escapes hostile mention username (federated source)', () => {
    // A federated MessagePart carries an attacker-controlled `username`;
    // it is escaped in both the URL and the label.
    const html = renderPostPage(
      basePost([
        {
          type: 'mention',
          username: 'x" onclick="alert(1)',
          domain: 'evil.com',
          isLocal: false,
        },
      ]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('escapes hostile hashtag name (federated source)', () => {
    const html = renderPostPage(
      basePost([{ type: 'hashtag', name: 'x" onclick="alert(1)' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('refuses a javascript: URL in a `link` part', () => {
    // Federated payloads may include `link` parts; a `javascript:` href
    // would execute on click.
    const html = renderPostPage(
      basePost([{ type: 'link', url: 'javascript:alert(1)', text: 'click me' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
    const island = userContent(html);
    // Label renders as text, not as an anchor.
    expect(island).toContain('click me');
  });

  it('refuses a data:text/html URL in a `link` part', () => {
    const html = renderPostPage(
      basePost([
        { type: 'link', url: 'data:text/html,<script>alert(1)</script>', text: 'click' },
      ]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('escapes a string content fallback (defensive - DB constraint blocks this)', () => {
    // The `posts_content_is_array` CHECK constraint makes this path
    // unreachable in production. A row with string content (legacy import,
    // migration glitch) must still be escaped; returning it verbatim is
    // stored XSS.
    const html = renderPostPage(
      basePost('<style>body{display:none}</style><script>alert(1)</script>'),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
  });

  it('escapes <style> in content_warning', () => {
    const html = renderPostPage(
      { ...basePost([{ type: 'text', text: 'hi' }]), content_warning: '<style>x</style>' },
      baseAuthor,
    );
    // CW renders in its own div, outside the `.content` island.
    const cwMatch = /<div class="content-warning">([\s\S]*?)<\/div>/.exec(html);
    expect(cwMatch).not.toBeNull();
    const cw = cwMatch![1];
    expect(/<style\b/i.test(cw)).toBe(false);
    expect(cw).toContain('&lt;style&gt;');
  });

  it('preserves legitimate mentions / hashtags / text', () => {
    const html = renderPostPage(
      basePost([
        { type: 'text', text: 'hello ' },
        { type: 'mention', username: 'bob', domain: 'harmony.test', isLocal: true },
        { type: 'text', text: ' #' },
        { type: 'hashtag', name: 'tag' },
      ]),
      baseAuthor,
    );
    const island = userContent(html);
    expect(island).toContain('hello');
    expect(island).toMatch(/<a [^>]*class="mention"/);
    expect(island).toMatch(/<span class="hashtag"/);
    expect(island).toContain('#tag');
  });
});
