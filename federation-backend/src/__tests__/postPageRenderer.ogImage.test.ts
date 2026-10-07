import { describe, it, expect, vi } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'https://db.harmony.test',
  },
}));

import { renderPostPage } from '../activitypub/postPageRenderer.js';

const post = {
  id: '00000000-0000-0000-0000-000000000001',
  content: [{ type: 'text', content: 'hello' }],
  content_warning: null,
  visibility: 'public',
  created_at: '2026-01-01T00:00:00Z',
  favorites_count: 0,
  reblogs_count: 0,
  replies_count: 0,
};

const author = (avatar_url: string | null) => ({
  username: 'alice',
  display_name: 'Alice',
  avatar_url,
  federation_metadata: null,
});

const ogImage = (html: string) => html.match(/<meta property="og:image" content="([^"]*)">/)?.[1];

describe('post page og:image without a post image', () => {
  it('points at the original avatar object, not a render', () => {
    const html = renderPostPage(post, author('u1/avatar.png'));
    expect(ogImage(html)).toBe('https://db.harmony.test/storage/v1/object/public/avatars/u1/avatar.png');
    expect(html).toContain('/storage/v1/render/image/public/avatars/u1/avatar.png?width=96');
  });

  it('turns a stored render URL into its object URL', () => {
    const html = renderPostPage(post, author(
      'https://db.harmony.test/storage/v1/render/image/public/avatars/u1/a.png?width=256&height=256&resize=contain&quality=80'));
    expect(ogImage(html)).toBe('https://db.harmony.test/storage/v1/object/public/avatars/u1/a.png');
  });

  it('keeps a remote avatar URL as is', () => {
    const html = renderPostPage(post, author('https://remote.example/media/a.jpg'));
    expect(ogImage(html)).toBe('https://remote.example/media/a.jpg');
  });

  it('falls back to the default avatar', () => {
    expect(ogImage(renderPostPage(post, author(null)))).toBe('https://harmony.test/default-avatar.png');
  });
});
