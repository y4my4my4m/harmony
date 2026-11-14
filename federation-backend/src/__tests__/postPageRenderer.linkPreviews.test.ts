/**
 * Link previews on the public pages: a post's stored previews (posts.metadata.embeds, returned by
 * public_page_post as `embeds`) and links to image or video files render under its text, as the
 * app shows them. Preview fields come from the linked site and are escaped.
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

import { linkPreviewView, linkPreviewsHtml, renderPostCard } from '../activitypub/postPageRenderer.js';
import { pageContext, pageInstance } from '../publicPages/layout.js';

const ctx = pageContext('en', pageInstance(null), '/@alice');

function post(content: any[], embeds: Record<string, any> = {}, extra: Record<string, any> = {}) {
  return {
    id: '00000000-0000-0000-0000-000000000001',
    content,
    embeds,
    content_warning: null,
    visibility: 'public',
    created_at: '2026-01-01T00:00:00Z',
    media_attachments: [],
    author: { username: 'alice', display_name: 'Alice', avatar_url: null },
    ...extra,
  };
}

const url = (u: string) => ({ type: 'url', url: u });

describe('linkPreviewView', () => {
  it('shows a GIF page by its stored GIF', () => {
    expect(linkPreviewView('https://klipy.com/gifs/dance', {
      url: 'https://klipy.com/gifs/dance', provider: 'generic', title: 'Dance GIF', siteName: 'KLIPY', mediaOnly: true,
      image: 'https://static.klipy.com/ii/dance.gif',
    })).toEqual({ kind: 'image', href: 'https://klipy.com/gifs/dance', src: 'https://static.klipy.com/ii/dance.gif', alt: 'Dance GIF' });
  });

  it('shows a link to a GIF file as the file, stored preview or not', () => {
    const gif = 'https://static.klipy.com/ii/35cc/l5TICB3v.gif';
    expect(linkPreviewView(gif, null)).toEqual({ kind: 'image', href: gif, src: gif, alt: '' });
    expect(linkPreviewView(gif, { url: gif, provider: 'generic', title: 'static.klipy.com', siteName: 'static.klipy.com', mediaOnly: true, image: gif }))
      .toEqual({ kind: 'image', href: gif, src: gif, alt: '' });
  });

  it('loops a stored GIF that is a video file and plays a mediaOnly video as a clip', () => {
    expect(linkPreviewView('https://tenor.com/view/x', { title: 'x', image: 'https://media.tenor.com/x.mp4', mediaOnly: true }))
      .toMatchObject({ kind: 'loop', src: 'https://media.tenor.com/x.mp4' });
    expect(linkPreviewView('https://fxtwitter.com/a/status/1', { title: 'a', mediaOnly: true, video: { url: 'https://video.test/1.mp4' } }))
      .toMatchObject({ kind: 'clip', src: 'https://video.test/1.mp4' });
  });

  it('makes a card of a page preview', () => {
    expect(linkPreviewView('https://discord.com/blog/post', {
      url: 'https://discord.com/blog/post', provider: 'generic', title: 'Making content easier to discover',
      description: 'Starting November 16', siteName: 'Discord', image: 'https://cdn.discord.test/og.png',
    })).toEqual({
      kind: 'card', href: 'https://discord.com/blog/post', title: 'Making content easier to discover',
      description: 'Starting November 16', site: 'Discord', image: 'https://cdn.discord.test/og.png',
    });
  });

  it('keeps a Wikipedia GIF photo in a card', () => {
    expect(linkPreviewView('https://en.wikipedia.org/wiki/Cat', { title: 'Cat', image: 'https://upload.wikimedia.org/cat.gif' }))
      .toMatchObject({ kind: 'card', title: 'Cat' });
  });

  it('shows nothing for a page without a preview, a failed preview or an unsafe link', () => {
    expect(linkPreviewView('https://news.test/story', null)).toBeNull();
    expect(linkPreviewView('https://news.test/story', { failed: true, title: 'x' })).toBeNull();
    expect(linkPreviewView('javascript:alert(1)//x.gif', null)).toBeNull();
  });

  it('takes no plain-HTTP or script media from a preview', () => {
    expect(linkPreviewView('https://news.test/a', { title: 'A', image: 'http://news.test/a.jpg' })).toMatchObject({ kind: 'card', image: '' });
    expect(linkPreviewView('https://news.test/a', { title: 'A', mediaOnly: true, image: 'javascript:alert(1)' })).toMatchObject({ kind: 'card', image: '' });
  });
});

describe('linkPreviewsHtml', () => {
  it('renders a card and a GIF in content order, once per URL', () => {
    const html = linkPreviewsHtml(post([
      url('https://news.test/a'), { type: 'text', text: ' ' }, url('https://cdn.test/x.gif'), url('https://news.test/a'),
    ], { 'https://news.test/a': { title: 'A story', siteName: 'News' } }));
    expect(html.match(/data-testid="public-link-card"/g)).toHaveLength(1);
    expect(html.match(/data-testid="public-link-media"/g)).toHaveLength(1);
    expect(html.indexOf('public-link-card')).toBeLessThan(html.indexOf('public-link-media'));
    expect(html).toContain('<img src="https://cdn.test/x.gif"');
  });

  it('skips links with previews off and files already in the gallery', () => {
    const html = linkPreviewsHtml(post([
      { type: 'url', url: 'https://cdn.test/off.gif', preview: false },
      url('https://cdn.test/gallery.png'),
    ]), new Set(['https://cdn.test/gallery.png']));
    expect(html).toBe('');
  });

  it('shows at most four previews', () => {
    const parts = [1, 2, 3, 4, 5].map((n) => url(`https://cdn.test/${n}.png`));
    expect(linkPreviewsHtml(post(parts)).match(/public-link-media/g)).toHaveLength(4);
  });

  it('reads a raw posts row too (metadata.embeds)', () => {
    const row = { content: [url('https://news.test/a')], metadata: { embeds: { 'https://news.test/a': { title: 'Raw row' } } } };
    expect(linkPreviewsHtml(row)).toContain('Raw row');
  });

  it('escapes every field a linked site controls', () => {
    const html = linkPreviewsHtml(post([url('https://evil.test/a')], {
      'https://evil.test/a': {
        title: '<script>alert(1)</script>',
        description: '"><img src=x onerror=alert(2)>',
        siteName: '<b>site</b>',
        image: 'https://evil.test/i.png"onerror="alert(3)',
      },
    }));
    expect(html).not.toMatch(/<script|<img src=x|<b>|"onerror="/);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('renderPostCard', () => {
  it('puts the previews of a sensitive post behind its notice', () => {
    const html = renderPostCard(post([url('https://cdn.test/x.gif')], {}, { is_sensitive: true }), ctx, { level: 'feed' });
    expect(html).toMatch(/<details class="sensitive">[\s\S]*public-link-media[\s\S]*<\/details>/);
  });

  it('shows the previews of a plain post under its text', () => {
    const html = renderPostCard(post([{ type: 'text', text: 'look ' }, url('https://cdn.test/x.gif')]), ctx, { level: 'feed' });
    expect(html.indexOf('class="content"')).toBeLessThan(html.indexOf('public-link-media'));
    expect(html).not.toContain('<details class="sensitive">');
  });
});
