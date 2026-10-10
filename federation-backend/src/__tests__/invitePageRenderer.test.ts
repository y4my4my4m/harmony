/**
 * The invite link-preview page (/invite/:code) and its oEmbed. Server name, description,
 * icon and banner are set by server managers, so every one is attacker-controlled text.
 * Assertions run against the rendered HTML string; no DOM in this test env.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  },
}));

import {
  DESCRIPTION_LIMIT,
  inviteCounts,
  inviteDescription,
  renderInvalidInvitePage,
  renderInviteOEmbed,
  renderInvitePage,
  renderUnavailableInvitePage,
  truncate,
} from '../services/invitePageRenderer.js';
import type { InvitePreview } from '../services/invitePreview.js';

function preview(extra: Partial<InvitePreview> = {}): InvitePreview {
  return {
    code: 'ABCD1234',
    name: 'Lounge',
    description: 'A place to hang out.',
    icon: null,
    banner: null,
    memberCount: 12,
    onlineCount: 3,
    ...extra,
  };
}

const meta = (html: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key.replace(/[:.]/g, '\\$&')}" content="([^"]*)">`).exec(html)?.[1];

function decode(value: string | undefined): string | undefined {
  return value
    ?.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function tags(html: string): string[] {
  return html.match(/<[a-zA-Z][^>]*>/g) ?? [];
}

describe('invite page escaping', () => {
  const hostile = preview({
    name: '"><script>alert(1)</script><meta http-equiv="refresh" content="0;url=https://evil.test">',
    description: "</title><img src=x onerror=alert(1)> it's <b>bold</b> & \"quoted\"",
  });
  const html = renderInvitePage(hostile, { oembed: true });

  it('carries no script, inline handler or refresh', () => {
    expect(html).not.toMatch(/<script\b/i);
    for (const tag of tags(html)) {
      const names = tag.replace(/="[^"]*"/g, '=""');
      expect(names, tag).not.toMatch(/\s(on[a-z]+|http-equiv)\s*=/i);
    }
  });

  it('keeps every attribute value inside its quotes', () => {
    const attributed = tags(html).filter((t) => /^<(meta|link|img|a)\s/.test(t));
    expect(attributed.length).toBeGreaterThan(10);
    for (const tag of attributed) {
      expect(tag.replace(/\s+[a-z:-]+="[^"<>]*"/g, ''), tag).toMatch(/^<(meta|link|img|a)>$/);
    }
  });

  it('round-trips the name and description through the meta tags', () => {
    expect(decode(meta(html, 'og:title'))).toBe(hostile.name);
    expect(decode(meta(html, 'og:description'))).toBe(`12 members · 3 online — ${hostile.description}`);
  });

  it('escapes them in the title and body text', () => {
    expect(html).toContain('<title>&quot;&gt;&lt;script&gt;');
    expect(html).toContain('&lt;/title&gt;&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('invite page image', () => {
  const card = (html: string) => meta(html, 'twitter:card');

  it('uses the banner object as a large image', () => {
    const html = renderInvitePage(preview({ banner: 's1/banner.png', icon: 's1/icon.png' }));
    expect(meta(html, 'og:image')).toBe('https://db.harmony.test/storage/v1/object/public/server_banners/s1/banner.png');
    expect(meta(html, 'twitter:image')).toBe(meta(html, 'og:image'));
    expect(card(html)).toBe('summary_large_image');
    expect(meta(html, 'og:image:alt')).toBe('Lounge banner');
  });

  it('turns a stored render URL into its object URL', () => {
    const html = renderInvitePage(preview({
      banner: 'https://db.harmony.test/storage/v1/render/image/public/server_banners/s1/b.png?width=640&height=200',
    }));
    expect(meta(html, 'og:image')).toBe('https://db.harmony.test/storage/v1/object/public/server_banners/s1/b.png');
  });

  it('uses a custom icon as a thumbnail without a banner', () => {
    const html = renderInvitePage(preview({ icon: 's1/icon.png' }));
    expect(meta(html, 'og:image')).toBe('https://db.harmony.test/storage/v1/object/public/server_icons/s1/icon.png');
    expect(card(html)).toBe('summary');
    expect(meta(html, 'og:image:alt')).toBe('Lounge icon');
  });

  it('falls back to the instance PNG for the default server icon', () => {
    for (const icon of [null, '/default_server.webp']) {
      const html = renderInvitePage(preview({ icon }));
      expect(meta(html, 'og:image')).toBe('https://harmony.test/img/app_icon_square.png');
      expect(meta(html, 'og:image:width')).toBe('526');
      expect(meta(html, 'og:image:height')).toBe('526');
      expect(card(html)).toBe('summary');
    }
  });

  it('makes a root-relative image absolute and drops a scheme it cannot serve', () => {
    expect(meta(renderInvitePage(preview({ icon: '/uploads/icon.png' })), 'og:image'))
      .toBe('https://harmony.test/uploads/icon.png');
    expect(meta(renderInvitePage(preview({ banner: '//evil.test/x.png' })), 'og:image'))
      .toBe('https://harmony.test/img/app_icon_square.png');
  });
});

describe('invite page text', () => {
  it('formats the counts', () => {
    expect(inviteCounts(preview({ memberCount: 1, onlineCount: 1 }))).toBe('1 member · 1 online');
    expect(inviteCounts(preview({ memberCount: 1234, onlineCount: 56 }))).toBe('1,234 members · 56 online');
    expect(inviteCounts(preview({ memberCount: 0, onlineCount: 0 }))).toBe('0 members');
    expect(inviteCounts(preview({ memberCount: 5, onlineCount: null }))).toBe('5 members');
  });

  it('describes with counts alone when the server has no description', () => {
    expect(inviteDescription(preview({ description: null }))).toBe('12 members · 3 online');
  });

  it('collapses whitespace and cuts a long description with an ellipsis', () => {
    const about = inviteDescription(preview({ description: `line\n\n one\t${'x'.repeat(400)}` })).split(' — ')[1];
    expect(Array.from(about)).toHaveLength(DESCRIPTION_LIMIT);
    expect(about.startsWith('line one xxx')).toBe(true);
    expect(about.endsWith('x…')).toBe(true);
    expect(truncate('a'.repeat(DESCRIPTION_LIMIT), DESCRIPTION_LIMIT)).toBe('a'.repeat(DESCRIPTION_LIMIT));
  });

  it('does not split a surrogate pair', () => {
    const cut = truncate('😀'.repeat(10), 5);
    expect(cut).toBe('😀😀😀😀…');
  });

  it('names the server, the instance and the invite URL', () => {
    const html = renderInvitePage(preview());
    expect(meta(html, 'og:title')).toBe('Lounge');
    expect(meta(html, 'og:site_name')).toBe('Harmony');
    expect(meta(html, 'og:url')).toBe('https://harmony.test/invite/ABCD1234');
    expect(meta(html, 'og:type')).toBe('website');
    expect(html).toContain('<link rel="canonical" href="https://harmony.test/invite/ABCD1234">');
    expect(html).toContain('<a class="cta" href="https://harmony.test/invite/ABCD1234">Open in Harmony</a>');
  });

  it('colours the embed with the primary colour and asks not to be indexed', () => {
    const html = renderInvitePage(preview());
    expect(meta(html, 'theme-color')).toBe('#0EA5E9');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
  });

  it('advertises oEmbed only when asked', () => {
    const link = '<link rel="alternate" type="application/json+oembed" '
      + 'href="https://harmony.test/oembed?url=https%3A%2F%2Fharmony.test%2Finvite%2FABCD1234&amp;format=json" title="Lounge">';
    expect(renderInvitePage(preview(), { oembed: true })).toContain(link);
    expect(renderInvitePage(preview())).not.toContain('json+oembed');
  });
});

describe('invalid and unavailable invite pages', () => {
  it('say the invite is dead without naming a server', () => {
    const html = renderInvalidInvitePage();
    expect(meta(html, 'og:title')).toBe('Invite invalid or expired');
    expect(meta(html, 'og:site_name')).toBe('Harmony');
    expect(meta(html, 'og:image')).toBe('https://harmony.test/img/app_icon_square.png');
    expect(meta(html, 'og:url')).toBeUndefined();
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
    expect(meta(html, 'theme-color')).not.toBe('#0EA5E9');
    expect(html).not.toMatch(/<script\b/i);
  });

  it('offer the invite again when the lookup failed', () => {
    const html = renderUnavailableInvitePage('ABCD1234');
    expect(meta(html, 'og:title')).toBe('Server invite');
    expect(html).toContain('href="https://harmony.test/invite/ABCD1234"');
    expect(meta(html, 'robots')).toBe('noindex, nofollow');
  });
});

describe('invite oEmbed', () => {
  it('names the invite, the server and the instance', () => {
    expect(renderInviteOEmbed(preview())).toEqual({
      version: '1.0',
      type: 'link',
      title: 'Lounge',
      author_name: "You've been invited to join a server",
      author_url: 'https://harmony.test/invite/ABCD1234',
      provider_name: 'Harmony',
      provider_url: 'https://harmony.test',
      cache_age: 300,
    });
  });
});
