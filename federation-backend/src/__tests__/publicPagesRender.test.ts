/**
 * Rendering of the public profile and post pages (publicPages/profilePage.ts,
 * activitypub/postPageRenderer.ts) and the script that hands a signed-in browser to the app
 * (publicPages/layout.ts handOffScript). Assertions run on the HTML string; the script runs in
 * a vm context with stub storage, cookie and location.
 */

import vm from 'node:vm';
import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
}));

import { renderProfilePage } from '../publicPages/profilePage.js';
import { renderPostPage } from '../activitypub/postPageRenderer.js';
import {
  APP_SESSION_COOKIE,
  HAND_OFF_KEY,
  HAND_OFF_WINDOW_MS,
  handOffScript,
  pageContentSecurityPolicy,
  pageContext,
  pageInstance,
} from '../publicPages/layout.js';

const ctx = pageContext('en', pageInstance({ name: 'Harmony Test', registrations_open: true }), '/@alice');

const POST_ID = '0b0e0000-0000-4000-8000-000000000001';

const alice = {
  id: 'a11ce000-0000-4000-8000-000000000001',
  username: 'alice',
  display_name: 'Alice',
  avatar_url: null,
  domain: null,
  is_local: true,
  discoverable: true,
  display_name_emojis: [],
};

function account(over: Record<string, unknown> = {}) {
  return {
    ...alice,
    bio: 'Hello there',
    profile_fields: [],
    followers_count: 12,
    following_count: 3,
    posts_count: 40,
    created_at: '2026-01-02T00:00:00Z',
    locked: false,
    ...over,
  };
}

function post(over: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    created_at: '2026-10-01T12:00:00Z',
    content: [{ type: 'text', text: 'hello world' }],
    content_warning: null,
    visibility: 'public',
    is_local: true,
    is_sensitive: false,
    media_attachments: [],
    replies_count: 1,
    reblogs_count: 2,
    favorites_count: 3,
    author: alice,
    ...over,
  };
}

const profile = (over: Partial<Parameters<typeof renderProfilePage>[0]> = {}, before: string | null = null) =>
  renderProfilePage({ account: account(), pinned: [], posts: [post()], next: null, ...over }, ctx, { before });

/** Every start tag of the document, for attribute checks that ignore escaped text. */
function startTags(html: string): string[] {
  return html.match(/<[a-z][^>]*>/gi) ?? [];
}

function body(html: string): string {
  return html.slice(html.indexOf('<body>'));
}

describe('profile page', () => {
  it('escapes the display name, bio and fields', () => {
    const html = profile({
      account: account({
        display_name: '<img src=x onerror=alert(1)>Eve',
        bio: '<script>alert(1)</script>\n\n"quoted" & <b>bold</b>',
        profile_fields: [
          { name: '<svg onload=alert(1)>', value: '<a href="javascript:alert(1)">x</a>' },
          { name: 'site', value: 'https://alice.example' },
        ],
      }),
    });
    const content = body(html);
    expect(content).not.toMatch(/<script>alert/i);
    expect(content).not.toMatch(/<img src=x/i);
    expect(content).not.toMatch(/<svg onload/i);
    expect(content).not.toMatch(/<b>bold/);
    expect(content).toContain('&lt;img src=x onerror=alert(1)&gt;Eve');
    expect(content).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(content).toContain('&lt;svg onload=alert(1)&gt;');
    expect(content).toContain('<a href="https://alice.example" rel="me nofollow noopener noreferrer" target="_blank">https://alice.example</a>');
    for (const tag of startTags(html)) {
      // Attribute names only: escaped text inside a quoted value is inert.
      expect(tag.replace(/"[^"]*"/g, '""')).not.toMatch(/\son[a-z]+=/i);
      expect(tag).not.toMatch(/javascript:/i);
    }
    expect(html).toContain('<title>&lt;img src=x onerror=alert(1)&gt;Eve (@alice@harmony.test) - Harmony Test</title>');
  });

  it('keeps an unsafe banner colour out of the style attribute', () => {
    const html = profile({ account: account({ color: 'red; background: url(https://evil.example/x)' }) });
    expect(html).not.toContain('evil.example');
    expect(profile({ account: account({ color: '#ff8800' }) })).toContain('style="--banner: #ff8800"');
  });

  it('shows the handle, counts, join date, lock and the join card', () => {
    const html = profile({ account: account({ locked: true }) });
    expect(html).toContain('@alice@harmony.test');
    expect(html).toMatch(/<strong>40<\/strong>Posts/);
    expect(html).toMatch(/<strong>12<\/strong>Followers/);
    expect(html).toMatch(/<strong>3<\/strong>Following/);
    expect(html).toContain('<time datetime="2026-01-02T00:00:00Z" data-style="date">');
    expect(html).toContain('aria-label="Approves followers"');
    expect(html).toContain('data-testid="public-join"');
    expect(html).toContain('href="/register"');
    expect(html).toContain(`href="/login?redirect=${encodeURIComponent('/@alice')}"`);
  });

  it('leaves out the sign-up links while registration is closed', () => {
    const closed = pageContext('en', pageInstance({ name: 'Harmony Test', registrations_open: false }), '/@alice');
    const html = renderProfilePage({ account: account(), pinned: [], posts: [], next: null }, closed, { before: null });
    expect(html).not.toContain('href="/register"');
    expect(html).toContain('href="/login?redirect=');
  });

  it('lists pinned posts before the others, marked pinned', () => {
    const pinned = post({ id: '0b0e0000-0000-4000-8000-0000000000aa', content: [{ type: 'text', text: 'pinned one' }], is_pinned: true });
    const html = profile({ pinned: [pinned] });
    expect(html).toContain('data-testid="public-pinned"');
    expect(html.indexOf('pinned one')).toBeLessThan(html.indexOf('hello world'));
    expect(html).toMatch(/class="pinned-label">[\s\S]*?Pinned<\/p>/);
  });

  it('links the next page by cursor and the first page from a later one', () => {
    const next = '0b0e0000-0000-4000-8000-0000000000ff';
    const first = profile({ next });
    expect(first).toContain(`href="/@alice?before=${next}" rel="next" data-testid="public-older"`);
    expect(first).not.toContain('rel="first"');
    const later = profile({ next: null }, POST_ID);
    expect(later).toContain('href="/@alice" rel="first"');
    expect(later).not.toContain('rel="next"');
    expect(later).toContain('<meta name="robots" content="noindex, noarchive">');
  });

  it('says so when there are no public posts', () => {
    expect(profile({ posts: [] })).toContain('No public posts yet.');
  });

  it('carries the account\'s ActivityPub alternate, canonical and hand-off', () => {
    const html = profile();
    expect(html).toContain('<link rel="canonical" href="https://harmony.test/@alice">');
    expect(html).toContain('<link rel="alternate" type="application/activity+json" href="https://harmony.test/users/alice">');
    expect(html).toContain('<meta property="og:type" content="profile">');
    expect(html).toContain('"/social/profile/alice"');
  });

  it('links a remote quote to its origin and a local one to its page', () => {
    const remoteAuthor = { ...alice, id: 'b0b', username: 'bob', is_local: false, domain: 'remote.example' };
    const quoted = post({
      quote: { id: 'q1', content: [{ type: 'text', text: 'quoted text' }], is_local: false, url: 'https://remote.example/@bob/9', author: remoteAuthor, media_attachments: [] },
    });
    const html = profile({ posts: [quoted] });
    expect(html).toContain('href="https://remote.example/@bob/9" data-testid="public-quote"');
    expect(html).toContain('@bob@remote.example');
    expect(html).toContain('quoted text');
  });
});

describe('post page media', () => {
  const page = (over: Record<string, unknown>) => renderPostPage(post(over), alice, pageContext('en', pageInstance(null), `/@alice/${POST_ID}`));

  it('shows an attached image with its alt text, size and focal point', () => {
    const html = page({
      media_attachments: [{
        type: 'Image', url: 'https://db.harmony.test/storage/v1/object/public/user_media/u/posts/cat.jpg',
        mediaType: 'image/jpeg', name: 'IMG_0001.jpg', description: 'A cat "asleep"', width: 1200, height: 800,
        meta: { focus: { x: 0.5, y: -0.5 } },
      }],
    });
    const grid = /<div class="media-grid media-1 single">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? '';
    expect(grid).toContain('<img src="https://db.harmony.test/storage/v1/object/public/user_media/u/posts/cat.jpg" alt="A cat &quot;asleep&quot;"');
    expect(grid).toContain('width="1200" height="800"');
    expect(grid).toContain('style="aspect-ratio: 1200 / 800"');
    expect(grid).toContain('style="object-position: 75% 75%"');
    expect(grid).toContain('class="alt-badge"');
    expect(grid).not.toContain('IMG_0001');
    expect(html).toContain('<meta property="og:image" content="https://db.harmony.test/storage/v1/object/public/user_media/u/posts/cat.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
  });

  it('shows video, gifv and audio players, and other files as links', () => {
    const html = page({
      media_attachments: [
        { type: 'Video', url: 'https://cdn.example/clip.mp4', mediaType: 'video/mp4' },
        { type: 'gifv', url: 'https://cdn.example/loop.mp4' },
        { type: 'Audio', url: 'https://cdn.example/song.ogg', mediaType: 'audio/ogg' },
        { type: 'Document', url: 'https://cdn.example/paper.pdf', mediaType: 'application/pdf' },
      ],
    });
    expect(html).toContain('<video src="https://cdn.example/clip.mp4" aria-label="" controls playsinline preload="metadata">');
    expect(html).toContain('<video src="https://cdn.example/loop.mp4" aria-label="" autoplay muted loop playsinline preload="metadata">');
    expect(html).toContain('<audio src="https://cdn.example/song.ogg" aria-label="" controls preload="none">');
    expect(html).toContain('class="media-file" href="https://cdn.example/paper.pdf"');
    expect(html).toContain('media-grid media-3');
  });

  it('takes the content\'s file parts when nothing is attached', () => {
    const html = page({
      content: [
        { type: 'text', text: 'look' },
        { type: 'file', url: 'https://remote.example/media/a.png', mimeType: 'image/png', altText: 'remote alt' },
      ],
    });
    expect(html).toContain('<img src="https://remote.example/media/a.png" alt="remote alt"');
    expect(/<div class="content">([\s\S]*?)<\/div>/.exec(html)?.[1]).toBe('look');
  });

  it('drops media whose URL is not http(s)', () => {
    const html = page({
      media_attachments: [
        { type: 'Image', url: 'javascript:alert(1)' },
        { type: 'Image', url: 'data:image/png;base64,AAAA' },
        { type: 'Image', url: '/relative.png' },
      ],
    });
    expect(html).not.toContain('class="media-grid');
    expect(html).not.toContain('javascript:');
  });

  it('folds sensitive media behind a toggle and keeps it out of the preview card', () => {
    const html = page({
      is_sensitive: true,
      media_attachments: [{ type: 'Image', url: 'https://cdn.example/nsfw.jpg' }],
    });
    expect(html).toMatch(/<details class="sensitive"><summary>[\s\S]*?Sensitive media[\s\S]*?<\/summary><div class="media-grid/);
    expect(html).not.toContain('<meta property="og:image" content="https://cdn.example/nsfw.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary">');
  });

  it('puts media behind the content warning', () => {
    const html = page({
      content_warning: 'spoilers',
      media_attachments: [{ type: 'Image', url: 'https://cdn.example/s.jpg' }],
    });
    expect(html).toMatch(/<div class="content-warning">spoilers<\/div>\s*<details class="cw-body">[\s\S]*media-grid/);
  });

  it('hands a signed-in browser to the in-app post', () => {
    const html = page({});
    expect(html).toContain(`"/@alice/${POST_ID}"`);
    expect(html).toContain(`"/social/post/${POST_ID}"`);
  });
});

describe('content security policy', () => {
  it('allows the inline scripts and styles, media from HTTPS and the plain-HTTP storage origin', () => {
    const csp = pageContentSecurityPolicy();
    expect(csp).toContain("script-src 'self' 'unsafe-inline'");
    expect(csp).toContain("style-src 'self' 'unsafe-inline'");
    expect(csp).toContain("img-src 'self' data: https: http://localhost:54321");
    expect(csp).toContain("media-src 'self' data: https: http://localhost:54321");
    expect(csp).toContain("base-uri 'none'");
    expect(csp).toContain("form-action 'none'");
  });
});

interface Browser {
  local: Map<string, string>;
  session: Map<string, string>;
  cookie: string;
  written: string[];
  replaced: string[];
  protocol: string;
  now: number;
}

function storage(map: Map<string, string>) {
  return {
    get length() { return map.size; },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => { map.set(k, String(v)); },
    removeItem: (k: string) => { map.delete(k); },
  };
}

function browser(over: Partial<Browser> = {}): Browser {
  return { local: new Map(), session: new Map(), cookie: '', written: [], replaced: [], protocol: 'https:', now: 1_000_000, ...over };
}

function run(b: Browser, app = '/@alice', fallback = '/social/profile/alice'): void {
  const document = {
    get cookie() { return b.cookie; },
    set cookie(v: string) { b.written.push(v); b.cookie = v.split(';')[0]; },
  };
  const location = { protocol: b.protocol, pathname: '/@alice', replace: (url: string) => b.replaced.push(url) };
  const DateStub = { now: () => b.now };
  vm.runInNewContext(handOffScript(app, fallback), {
    localStorage: storage(b.local),
    sessionStorage: storage(b.session),
    document,
    location,
    Date: DateStub,
  });
}

const SESSION = JSON.stringify({ access_token: 'jwt', refresh_token: 'r' });

describe('handOffScript', () => {
  it('leaves a browser without a session on the page', () => {
    const b = browser({ local: new Map([['sb-har-auth-token-code-verifier', 'x'], ['other', SESSION]]) });
    run(b);
    expect(b.replaced).toEqual([]);
    expect(b.written).toEqual([]);
  });

  it('sets the app cookie and reloads to the app URL', () => {
    const b = browser({ local: new Map([['sb-har-auth-token', SESSION]]) });
    run(b);
    expect(b.written).toEqual([`${APP_SESSION_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax; Secure`]);
    expect(b.replaced).toEqual(['/@alice']);
    expect(b.session.get(HAND_OFF_KEY)).toBe(`/@alice ${b.now}`);
  });

  it('reads a session kept in sessionStorage', () => {
    const b = browser({ session: new Map([['sb-localhost-auth-token', SESSION]]), protocol: 'http:' });
    run(b);
    expect(b.written).toEqual([`${APP_SESSION_COOKIE}=1; Path=/; Max-Age=34560000; SameSite=Lax`]);
    expect(b.replaced).toEqual(['/@alice']);
  });

  it('goes to the fallback when the cookie was already sent', () => {
    const b = browser({ local: new Map([['sb-har-auth-token', SESSION]]), cookie: `theme=dark; ${APP_SESSION_COOKIE}=1` });
    run(b);
    expect(b.replaced).toEqual(['/social/profile/alice']);
  });

  it('follows a proxy that ignores the cookie: app, then fallback, then stays', () => {
    const b = browser({ local: new Map([['sb-har-auth-token', SESSION]]) });
    run(b);
    expect(b.replaced).toEqual(['/@alice']);
    b.now += 200;
    run(b);
    expect(b.replaced).toEqual(['/@alice', '/social/profile/alice']);
    b.now += 200;
    run(b);
    expect(b.replaced).toEqual(['/@alice', '/social/profile/alice']);
    expect(b.session.has(HAND_OFF_KEY)).toBe(false);
  });

  it('hands off again once the window has passed', () => {
    const b = browser({ local: new Map([['sb-har-auth-token', SESSION]]), cookie: `${APP_SESSION_COOKIE}=1` });
    b.session.set(HAND_OFF_KEY, `/social/profile/alice ${b.now - HAND_OFF_WINDOW_MS - 1}`);
    run(b);
    expect(b.replaced).toEqual(['/social/profile/alice']);
  });

  it('escapes the target URLs out of the script', () => {
    const script = handOffScript('/@x</script><script>alert(1)//', '/social/profile/x');
    expect(script).not.toContain('</script>');
  });
});
