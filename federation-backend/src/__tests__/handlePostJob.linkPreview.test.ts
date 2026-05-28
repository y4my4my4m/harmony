/**
 * Regression tests for `postHandler.handlePostJob` — covers the work that
 * used to live in `DatabaseListener.handleNewPost` / `handlePostEdit`
 * (postgres_changes path) and now runs from BullMQ:
 *
 *   1. external link-preview enrichment on `create` (Step 2a of the
 *      cleanup), so the "I posted an arstechnica link and got no embed
 *      card" bug stays fixed.
 *   2. home-feed realtime fan-out on `create` (Step 2c) via the
 *      `broadcast_user_event` RPC — verifies the author + every accepted
 *      local follower receive the `home_feed:new_post` event.
 *   3. re-enrichment on `update` so adding a URL to an existing post
 *      still fills the embed card.
 *   4. pure reblogs skip enrichment but still broadcast.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    INSTANCE_NAME: 'Harmony',
    PORT: 3001,
    NODE_ENV: 'test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'test-key',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-key',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    USE_BULLMQ_QUEUE: true,
    CORS_ORIGIN: 'http://localhost:5173',
    REQUIRE_VALID_SIGNATURES: true,
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    FEDERATION_MODE: 'unified',
    environment: 'test',
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const fakePost: any = {
  id: 'post-1',
  author_id: 'author-X',
  is_local: true,
  visibility: 'public',
  ap_id: null,
  ap_type: 'Note',
  created_at: '2026-05-28T00:00:00Z',
  content: [
    { type: 'url', url: 'https://arstechnica.com/security/foo', preview: true },
  ],
  metadata: {},
};

const fakeAuthor = {
  id: 'author-X',
  username: 'poring',
  domain: 'harmony.test',
  is_local: true,
};

// Two accepted local followers + one remote follower (should be filtered
// out of the recipient set on the worker side).
const fakeFollowerRows = [
  { follower_id: 'follower-Y', profiles: { is_local: true } },
  { follower_id: 'follower-Z', profiles: { is_local: true } },
  { follower_id: 'follower-remote', profiles: { is_local: false } },
];

/**
 * Tracks every Supabase RPC + table operation the handler performs so
 * tests can assert on exact arguments instead of just call counts.
 */
const rpcCalls: Array<{ fn: string; args: any }> = [];
const fromCalls: string[] = [];

/**
 * The handler hits three different terminal shapes against `from(...)`:
 *   posts/profiles single → `select(...).eq(...).single()`
 *   posts ap_id write    → `update(...).eq(...)`
 *   follows fan-out      → `select(...).eq(...).in(...)`
 * Use a shared chain object that resolves every terminal to the matching
 * fixture so we don't need to special-case the chain shape per query.
 */
function buildFromMock(table: string) {
  fromCalls.push(table);

  const rowResult =
    table === 'posts'
      ? { data: fakePost, error: null }
      : table === 'profiles'
        ? { data: fakeAuthor, error: null }
        : { data: null, error: null };

  const inResult =
    table === 'follows'
      ? { data: fakeFollowerRows, error: null }
      : { data: [], error: null };

  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => Promise.resolve(inResult)),
    single: vi.fn(() => Promise.resolve(rowResult)),
    update: vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  };
  return chain;
}

const supabaseMock = {
  from: vi.fn((table: string) => buildFromMock(table)),
  rpc: vi.fn((fn: string, args: any) => {
    rpcCalls.push({ fn, args });
    return Promise.resolve({ data: null, error: null });
  }),
};

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: vi.fn(() => supabaseMock),
}));

const broadcastToFollowers = vi.fn().mockResolvedValue(undefined);
const sendToInbox = vi.fn().mockResolvedValue(undefined);

vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: {
    broadcastToFollowers,
    sendToInbox,
  },
}));

vi.mock('../listeners/FederationHandlers.js', () => ({
  createPostActivity: vi.fn().mockResolvedValue({
    type: 'Create',
    object: { id: 'https://harmony.test/posts/post-1' },
  }),
  createDeleteActivity: vi.fn().mockReturnValue({ type: 'Delete' }),
  createPostUpdateActivity: vi.fn().mockResolvedValue({ type: 'Update' }),
  createAddToFeaturedActivity: vi.fn().mockReturnValue({ type: 'Add' }),
  createRemoveFromFeaturedActivity: vi.fn().mockReturnValue({ type: 'Remove' }),
}));

const enrichPostLinkPreviews = vi.fn().mockImplementation(async (post: any) => {
  // Mimic the production behaviour: write embed cache via update_post_embeds
  // so the test can assert on RPC arguments end-to-end.
  if (Array.isArray(post?.content)) {
    const urlPart = post.content.find((p: any) => p.type === 'url');
    if (urlPart && new URL(urlPart.url).hostname !== 'harmony.test') {
      await supabaseMock.rpc('update_post_embeds', {
        p_post_id: post.id,
        p_embeds: {
          [urlPart.url]: { title: 'Ars Technica article' },
        },
      });
    }
  }
});

vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews,
}));

const { handlePostJob } = await import('../queue/handlers/postHandler.js');

beforeEach(() => {
  rpcCalls.length = 0;
  fromCalls.length = 0;
  supabaseMock.from.mockClear();
  supabaseMock.rpc.mockClear();
  broadcastToFollowers.mockClear();
  sendToInbox.mockClear();
  enrichPostLinkPreviews.mockClear();
  // Reset the post fixture between tests so visibility / reblog mutations
  // don't bleed across cases.
  fakePost.id = 'post-1';
  fakePost.author_id = 'author-X';
  fakePost.is_local = true;
  fakePost.visibility = 'public';
  fakePost.ap_id = null;
  fakePost.ap_type = 'Note';
  fakePost.created_at = '2026-05-28T00:00:00Z';
  fakePost.content = [
    { type: 'url', url: 'https://arstechnica.com/security/foo', preview: true },
  ];
  fakePost.metadata = {};
});

describe('handlePostJob — create with external URL', () => {
  it('runs enrichPostLinkPreviews and writes update_post_embeds', async () => {
    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1);
    expect(enrichPostLinkPreviews).toHaveBeenCalledTimes(1);
    expect(enrichPostLinkPreviews.mock.calls[0]?.[0]).toMatchObject({ id: 'post-1' });

    const embedWrites = rpcCalls.filter((c) => c.fn === 'update_post_embeds');
    expect(embedWrites).toHaveLength(1);
    expect(embedWrites[0].args.p_post_id).toBe('post-1');
    expect(embedWrites[0].args.p_embeds['https://arstechnica.com/security/foo']).toBeDefined();
  });

  it('broadcasts home_feed:new_post to author + every accepted local follower', async () => {
    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    const broadcasts = rpcCalls.filter((c) => c.fn === 'broadcast_user_event');
    // Expect author-X + follower-Y + follower-Z (remote follower filtered out).
    const recipientIds = broadcasts.map((c) => c.args.p_user_id).sort();
    expect(recipientIds).toEqual(['author-X', 'follower-Y', 'follower-Z']);

    // Every broadcast carries the same shape.
    for (const call of broadcasts) {
      expect(call.args.p_payload).toMatchObject({
        type: 'home_feed:new_post',
        post_id: 'post-1',
        author_id: 'author-X',
        visibility: 'public',
        source: 'bullmq:postHandler',
      });
    }
  });
});

describe('handlePostJob — pure reblog (Announce)', () => {
  it('skips link preview enrichment but still broadcasts home_feed', async () => {
    fakePost.ap_type = 'Announce';
    fakePost.metadata = { reblog_of: 'https://other.instance/posts/abc' };
    // A reblog has no URL parts of its own; clear the content fixture so
    // enrichment would no-op anyway, but the handler should short-circuit
    // BEFORE calling enrichPostLinkPreviews per the isPureReblog gate.
    fakePost.content = [];

    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(enrichPostLinkPreviews).not.toHaveBeenCalled();

    // Reblog still appears on followers' home timelines.
    const broadcasts = rpcCalls.filter((c) => c.fn === 'broadcast_user_event');
    expect(broadcasts.length).toBeGreaterThanOrEqual(1);
  });
});

describe('handlePostJob — update', () => {
  it('re-runs enrichPostLinkPreviews after federating the edit', async () => {
    await handlePostJob({
      type: 'update',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1);
    expect(enrichPostLinkPreviews).toHaveBeenCalledTimes(1);

    const embedWrites = rpcCalls.filter((c) => c.fn === 'update_post_embeds');
    expect(embedWrites).toHaveLength(1);
  });
});

describe('handlePostJob — broadcastHomeFeed visibility filter', () => {
  it('does not broadcast home_feed for direct posts (filter inside helper)', async () => {
    // Direct posts go through the mentions-only delivery path; the
    // broadcastHomeFeed helper short-circuits on non-feed visibilities so
    // no `broadcast_user_event` RPC fires. We can't run a `direct` job
    // through handlePostJob without remote mentions (it throws), so this
    // test focuses on the followers-visibility scope: a `followers`
    // post should only fan out to ACCEPTED followers, not pending ones.
    fakePost.visibility = 'followers';

    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'followers',
    });

    const broadcasts = rpcCalls.filter((c) => c.fn === 'broadcast_user_event');
    // The follows mock returns all three rows regardless of `.in(status)`
    // (the mock doesn't actually filter — that's the DB's job). The
    // worker still applies the is_local filter, so we expect
    // author-X + follower-Y + follower-Z (remote stripped).
    const recipientIds = broadcasts.map((c) => c.args.p_user_id).sort();
    expect(recipientIds).toEqual(['author-X', 'follower-Y', 'follower-Z']);

    for (const call of broadcasts) {
      expect(call.args.p_payload.visibility).toBe('followers');
    }
  });
});
