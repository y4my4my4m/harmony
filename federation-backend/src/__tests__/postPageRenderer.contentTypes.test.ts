/**
 * Content-type coverage tests for `postPageRenderer.ts`.
 *
 * Background: the `MessagePart` discriminated union in `src/types.ts`
 * declares nine `type` literals (text, mention, hashtag, link, url,
 * embed, emoji, role_mention, file, system). The original renderer only
 * handled the first four, so a post whose entire content was a single
 * `{ type: 'url', url: '...' }` part (the shape produced when a user
 * pastes a bare URL into the composer) rendered an empty `.content`
 * div and an empty OG description on `/posts/:id`.
 *
 * These tests pin every part type to its expected HTML, and lock in
 * the specific regression: a URL-only post renders a non-empty
 * `<a href>` with tracking params stripped.
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
 * Slice the user-content island out of the rendered page. Mirrors the
 * helper in `postPageRenderer.xss.test.ts` — we want to assert against
 * the `<div class="content">` body only, not the page's `<head>`.
 */
function userContent(html: string): string {
  const m = /<div class="content">([\s\S]*?)<\/div>\s*(?:<div class="media-grid|<div class="stats-bar|<div class="meta)/i.exec(html);
  if (!m) {
    const start = html.indexOf('<div class="content">');
    expect(start, 'expected <div class="content"> in rendered page').toBeGreaterThan(-1);
    return html.slice(start);
  }
  return m[1];
}

describe('postPageRenderer — content-type coverage', () => {
  describe('regression: URL-only posts (the arstechnica case)', () => {
    it('renders an <a href> for a `type:url` part with tracking params stripped', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'url',
            url: 'https://arstechnica.com/security/2026/01/foo?utm_source=mastodon&utm_medium=social',
            preview: true,
          },
        ]),
        baseAuthor,
      );

      const island = userContent(html);
      expect(island.trim()).not.toBe('');
      expect(island).toMatch(/<a [^>]*href="https:\/\/arstechnica\.com\/security\/2026\/01\/foo"/);
      expect(island).toMatch(/rel="nofollow noopener"/);
      expect(island).toMatch(/target="_blank"/);
      // The visible label and the href should both be tracking-free.
      expect(island).not.toContain('utm_source');
      expect(island).not.toContain('utm_medium');
    });

    it('writes the cleaned URL into the og:description for crawlers', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'url',
            url: 'https://arstechnica.com/x?utm_brand=arstechnica',
            preview: true,
          },
        ]),
        baseAuthor,
      );

      // The og:description must not be empty (was the original bug — empty
      // description meant Mastodon/Discord previews showed no excerpt).
      const m = /<meta property="og:description" content="([^"]*)"/.exec(html);
      expect(m, 'og:description meta tag').not.toBeNull();
      expect(m![1]).toBe('https://arstechnica.com/x');
    });
  });

  describe('every MessagePart type renders the expected HTML', () => {
    it('renders a `text` part as escaped text with <br> for newlines', () => {
      const html = renderPostPage(
        basePost([{ type: 'text', text: 'line one\nline two' }]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toContain('line one');
      expect(island).toContain('<br>');
      expect(island).toContain('line two');
    });

    it('renders a `mention` part as a profile anchor', () => {
      const html = renderPostPage(
        basePost([{ type: 'mention', username: 'bob', domain: 'harmony.test', isLocal: true }]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toMatch(/<a [^>]*class="mention"[^>]*>@bob<\/a>/);
    });

    it('renders a `hashtag` part as a span', () => {
      const html = renderPostPage(
        basePost([{ type: 'hashtag', name: 'fediverse' }]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toContain('<span class="hashtag">#fediverse</span>');
    });

    it('renders a `link` part with text label', () => {
      const html = renderPostPage(
        basePost([{ type: 'link', url: 'https://example.com/page', text: 'visit' }]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toMatch(/<a [^>]*href="https:\/\/example\.com\/page"[^>]*>visit<\/a>/);
    });

    it('renders an `embed` part the same way a `url` part renders', () => {
      const html = renderPostPage(
        basePost([
          { type: 'embed', url: 'https://youtu.be/abc?si=trackingtoken', provider: 'youtube', previewId: 'p1' },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      // `si` is in the YouTube domain-specific stripper table.
      expect(island).toMatch(/<a [^>]*href="https:\/\/youtu\.be\/abc"/);
      expect(island).not.toContain('si=');
    });

    it('renders an `emoji` part as an <img src> with resolved storage URL', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'emoji',
            emoji: { id: 'e1', name: 'blobcat', url: 'blobcat.png', user_id: null },
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      // Attribute order isn't load-bearing; just assert both made it on.
      expect(island).toMatch(/<img\b[^>]*class="custom-emoji"/);
      expect(island).toMatch(/<img\b[^>]*alt=":blobcat:"/);
      // The renderer routes bucket-relative URLs through the imgproxy
      // render path; assert the bucket made it into the resolved src.
      expect(island).toContain('/storage/v1/render/image/public/emojis/blobcat.png');
    });

    it('renders an `emoji` part with an absolute URL as-is', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'emoji',
            emoji: { id: 'e2', name: 'thumbs', url: 'https://cdn.example.com/thumbs.png' },
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toContain('src="https://cdn.example.com/thumbs.png"');
    });

    it('falls back to text when an `emoji` part has no URL', () => {
      const html = renderPostPage(
        basePost([{ type: 'emoji', emoji: { id: 'e3', name: 'wave' } }]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toContain(':wave:');
      expect(island).not.toMatch(/<img\b/);
    });

    it('renders a `role_mention` with a safe hex color through to inline style', () => {
      const html = renderPostPage(
        basePost([
          { type: 'role_mention', roleId: 'r1', roleName: 'moderators', roleColor: '#ff8800' },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toMatch(/<span class="mention" style="color: #ff8800">@moderators<\/span>/);
    });

    it('rejects an unsafe `role_mention` color (CSS injection guard)', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'role_mention',
            roleId: 'r1',
            roleName: 'admins',
            // Attacker-controlled federated payload tries to escape the value.
            roleColor: 'red; background: url(http://evil/x)',
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toContain('@admins');
      expect(island).not.toContain('background:');
      expect(island).not.toContain('url(');
      // No `style=` attribute at all when the color failed validation.
      expect(island).not.toMatch(/<span class="mention"[^>]*style=/);
    });

    it('omits image `file` parts from the content body (they render in the media grid)', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'file',
            url: 'https://cdn.example.com/cat.jpg',
            fileType: 'image/jpeg',
            mimeType: 'image/jpeg',
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      // Nothing in the content island for images.
      expect(island.trim()).toBe('');
    });

    it('renders a non-image `file` part as a download anchor', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'file',
            url: 'https://cdn.example.com/manual.pdf',
            fileType: 'application/pdf',
            fileName: 'manual.pdf',
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).toMatch(/<a [^>]*href="https:\/\/cdn\.example\.com\/manual\.pdf"[^>]*>manual\.pdf<\/a>/);
    });

    it('renders nothing for a `system` part', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'system',
            event_type: 'join',
            user: { id: 'u1', username: 'alice', display_name: 'Alice' },
            timestamp: '2026-01-01T00:00:00Z',
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island.trim()).toBe('');
    });

    it('renders the same HTML for a `url` part as a `link` part with the same destination', () => {
      const url = 'https://example.com/abc';
      const htmlUrl = renderPostPage(basePost([{ type: 'url', url, preview: true }]), baseAuthor);
      const htmlLink = renderPostPage(basePost([{ type: 'link', url, text: url }]), baseAuthor);
      // Both produce the same anchor (same href, same visible label).
      expect(userContent(htmlUrl)).toMatch(/<a [^>]*href="https:\/\/example\.com\/abc"[^>]*>https:\/\/example\.com\/abc<\/a>/);
      expect(userContent(htmlLink)).toMatch(/<a [^>]*href="https:\/\/example\.com\/abc"[^>]*>https:\/\/example\.com\/abc<\/a>/);
    });
  });

  describe('safety — content-type renderers preserve XSS guards', () => {
    it('rejects a javascript: URL in a `url` part', () => {
      const html = renderPostPage(
        basePost([{ type: 'url', url: 'javascript:alert(1)', preview: true }]),
        baseAuthor,
      );
      const island = userContent(html);
      // The visible label still surfaces, but never as a live <a href>.
      expect(island).not.toMatch(/href="javascript:/i);
    });

    it('rejects a data:text/html URL in an `embed` part', () => {
      const html = renderPostPage(
        basePost([
          {
            type: 'embed',
            url: 'data:text/html,<script>alert(1)</script>',
            provider: 'generic',
            previewId: 'p1',
          },
        ]),
        baseAuthor,
      );
      const island = userContent(html);
      expect(island).not.toMatch(/href="data:/i);
    });
  });
});
