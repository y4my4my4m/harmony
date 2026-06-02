/**
 * Regression tests for `postHandler.handlePostJob`:
 *   1. create with external URL runs enrichPostLinkPreviews; when it writes
 *      embeds, the author gets `post:embeds_ready` via broadcast_user_event.
 *   2. update re-runs enrichPostLinkPreviews and pushes the same event.
 *   3. pure reblogs skip enrichment and do not push embeds_ready.
 *
 * Home-feed fan-out is handled by the `trg_broadcast_home_feed_entry` DB
 * trigger and is not exercised through this handler anymore.
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

const rpcCalls: Array<{ fn: string; args: any }> = [];

function buildFromMock(table: string) {
  const rowResult =
    table === 'posts'
      ? { data: fakePost, error: null }
      : table === 'profiles'
        ? { data: fakeAuthor, error: null }
        : { data: null, error: null };

  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    in: vi.fn(() => Promise.resolve({ data: [], error: null })),
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

// Default to "wrote embeds" so the success path is the default.
const enrichPostLinkPreviews = vi.fn().mockResolvedValue(true);

vi.mock('../listeners/DatabaseListener.js', () => ({
  enrichPostLinkPreviews,
}));

const { handlePostJob } = await import('../queue/handlers/postHandler.js');

beforeEach(() => {
  rpcCalls.length = 0;
  supabaseMock.from.mockClear();
  supabaseMock.rpc.mockClear();
  broadcastToFollowers.mockClear();
  sendToInbox.mockClear();
  enrichPostLinkPreviews.mockClear();
  enrichPostLinkPreviews.mockResolvedValue(true);

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

describe('handlePostJob - create', () => {
  it('runs enrichPostLinkPreviews and pushes post:embeds_ready when embeds were written', async () => {
    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1);
    expect(enrichPostLinkPreviews).toHaveBeenCalledTimes(1);

    const embedReadyCalls = rpcCalls.filter(
      (c) => c.fn === 'broadcast_user_event' && c.args.p_payload?.type === 'post:embeds_ready'
    );
    expect(embedReadyCalls).toHaveLength(1);
    expect(embedReadyCalls[0].args.p_user_id).toBe('author-X');
    expect(embedReadyCalls[0].args.p_payload.post_id).toBe('post-1');
  });

  it('does not push post:embeds_ready when enrichment wrote nothing', async () => {
    enrichPostLinkPreviews.mockResolvedValue(false);

    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(enrichPostLinkPreviews).toHaveBeenCalledTimes(1);
    const embedReadyCalls = rpcCalls.filter(
      (c) => c.fn === 'broadcast_user_event' && c.args.p_payload?.type === 'post:embeds_ready'
    );
    expect(embedReadyCalls).toHaveLength(0);
  });
});

describe('handlePostJob - pure reblog (Announce)', () => {
  it('skips link preview enrichment entirely', async () => {
    fakePost.ap_type = 'Announce';
    fakePost.metadata = { reblog_of: 'https://other.instance/posts/abc' };
    fakePost.content = [];

    await handlePostJob({
      type: 'create',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(enrichPostLinkPreviews).not.toHaveBeenCalled();
    const embedReadyCalls = rpcCalls.filter(
      (c) => c.fn === 'broadcast_user_event' && c.args.p_payload?.type === 'post:embeds_ready'
    );
    expect(embedReadyCalls).toHaveLength(0);
  });
});

describe('handlePostJob - update', () => {
  it('re-runs enrichPostLinkPreviews after federating the edit and pushes embeds_ready on write', async () => {
    await handlePostJob({
      type: 'update',
      post_id: 'post-1',
      author_id: 'author-X',
      visibility: 'public',
    });

    expect(broadcastToFollowers).toHaveBeenCalledTimes(1);
    expect(enrichPostLinkPreviews).toHaveBeenCalledTimes(1);

    const embedReadyCalls = rpcCalls.filter(
      (c) => c.fn === 'broadcast_user_event' && c.args.p_payload?.type === 'post:embeds_ready'
    );
    expect(embedReadyCalls).toHaveLength(1);
  });
});
