/**
 * XSS regression tests for `postPageRenderer.ts`.
 *
 * The renderer ships the `/posts/:id` HTML page served to browsers and
 * crawlers (Mastodon, Discord, Slack, Twitter, etc. when they preview a
 * Harmony post URL). The page's CSP allows `'unsafe-inline'` for both
 * scripts and styles — required for the inline auth-redirect snippet and
 * the inline `<style>` block — so anything that smuggles a `<style>` /
 * `<script>` / `<img onerror>` into the rendered HTML would execute.
 *
 * These tests assert the renderer escapes user-supplied content before
 * splicing it into the HTML, and that links never carry `javascript:` /
 * `data:` schemes. They work on the rendered HTML STRING (no DOM
 * available in the federation-backend test environment) via regex
 * assertions scoped to the user-content `.content` div.
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
 * Slice the user-content island out of the rendered page. We don't want
 * to count the inline `<style>` block in <head>, the inline auth-redirect
 * `<script>`, or our own structural tags — only the part that holds
 * user-controlled data. The renderer wraps user content in
 * `<div class="content">…</div>`.
 */
function userContent(html: string): string {
  const m = /<div class="content">([\s\S]*?)<\/div>\s*(?:<div class="media-grid|<div class="stats-bar|<div class="meta)/i.exec(html);
  if (!m) {
    // Fall back to opening tag onwards if the post had no media/stats/meta.
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
 * Find every HTML start-tag in `island` and run `fn` on each one with
 * its full `<tag attrs>` substring. Lets us reason about attributes
 * inside REAL tags without false-positives on escaped text (e.g. a
 * literal ` onerror=` inside an attribute value where the surrounding
 * `"` was escaped to `&quot;`).
 */
function forEachStartTag(html: string, fn: (tag: string) => void) {
  // Conservative tag matcher: `<` + tag-name + body up to the first
  // unescaped `>`. Attribute values may contain `>` only inside escaped
  // entities (`&gt;`), which never match the bare `>` terminator.
  const tagRegex = /<([a-z][a-z0-9]*)\b([^>]*)>/gi;
  let m: RegExpExecArray | null;
  while ((m = tagRegex.exec(html)) !== null) {
    fn(m[0]);
  }
}

/**
 * Decode the standard 5 named HTML entities so we can compare an
 * attribute value against a literal string (e.g. asserting that
 * `href` doesn't START with `javascript:` even after un-escaping).
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
 * Parse attributes out of a `<tag attrs>` substring as a flat
 * `{ name: decodedValue }` map. We never need to match nested or
 * quoted-inside-quoted weirdness for our own renderer's output, just
 * the canonical `name="value"` / `name='value'` shape.
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

describe('renderPostPage — XSS regression', () => {
  it('escapes <style> in a text part', () => {
    const html = renderPostPage(
      basePost([{ type: 'text', text: '<style>body{display:none}</style> hi' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
    // The escaped characters survive in the HTML stream.
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
    // A federated MessagePart can carry an attacker-controlled
    // `username` — we must escape both in the URL and the label.
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
    // Defensive: federated payloads could include `link` parts. A
    // `javascript:` href would execute on click otherwise.
    const html = renderPostPage(
      basePost([{ type: 'link', url: 'javascript:alert(1)', text: 'click me' }]),
      baseAuthor,
    );
    assertNoExecutableUserContent(html);
    const island = userContent(html);
    // The label still renders, just not as a live anchor.
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

  it('escapes a string content fallback (defensive — DB constraint blocks this)', () => {
    // The `posts_content_is_array` CHECK constraint makes this path
    // unreachable in production, but if a row ever slipped through with
    // string content (legacy import, migration glitch) we MUST escape
    // it. The previous implementation returned the string verbatim —
    // direct stored XSS.
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
    // CW is rendered in its own div; check the whole HTML doesn't
    // gain a parsed <style> from the user input.
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
