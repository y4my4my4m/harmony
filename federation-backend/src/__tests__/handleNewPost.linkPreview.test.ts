/**
 * Regression test for the "local posts with external URLs never get
 * link embeds" bug.
 *
 * Root cause: `handleNewPost()` in `DatabaseListener.ts` federated the
 * post (broadcastToFollowers) but never ran `enrichPostLinkPreviews()`.
 * The DB-side `process_local_link_previews` trigger only enriches URLs
 * whose host equals the local instance domain (Harmony post embeds),
 * not external sites — so an arstechnica URL on a fresh local public
 * post produced no preview card.
 *
 * The fix wires `enrichPostLinkPreviews(post)` as a fire-and-forget
 * call after the federation broadcast for any non-reblog local public
 * post (quote posts SHOULD enrich; pure reblogs SHOULD NOT). The same
 * pattern also runs in `handlePostEdit` when `content` changes.
 *
 * This test mocks `getSupabaseClient` and `linkPreviewService` to
 * verify the wiring: a local public post with an external URL triggers
 * exactly one `linkPreviewService.getPreview` call and one
 * `supabase.rpc('update_post_embeds', ...)` write.
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
    USE_BULLMQ_QUEUE: false,
    CORS_ORIGIN: 'http://localhost:5173',
    REQUIRE_VALID_SIGNATURES: true,
    ALLOW_FEDERATED_VOICE: true,
    WEBRTC_MODE: 'hybrid',
    FEDERATION_MODE: 'unified',
    environment: 'test',
  },
}));

/**
 * Shape `update_post_embeds` arguments captured per call so the test
 * can assert on the exact embed payload that was written.
 */
type RpcCall = { fn: string; args: Record<string, any> };
const rpcCalls: RpcCall[] = [];

const fakePost = {
  id: 'post-1',
  author_id: 'author-1',
  is_local: true,
  visibility: 'public',
  ap_id: null,
  content: [
    { type: 'url', url: 'https://arstechnica.com/security/foo', preview: true },
  ],
  metadata: {},
};

const fakeAuthor = {
  id: 'author-1',
  username: 'poring',
  domain: 'harmony.test',
  is_local: true,
};

/**
 * Minimal Supabase mock — implements only the chained query shape used
 * by `handleNewPost` (`from(...).select(...).eq(...).single()`) and the
 * RPC entrypoint used by `enrichPostLinkPreviews`. Each `.select(...)`
 * is keyed off the table name so the right row comes back.
 */
function buildQuery(table: string) {
  const row = table === 'posts' ? fakePost : table === 'profiles' ? fakeAuthor : null;
  const result = { data: row, error: null };
  const chain: any = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn(() => Promise.resolve(result)),
    update: vi.fn(() => ({
      eq: vi.fn(() => Promise.resolve({ data: null, error: null })),
    })),
  };
  return chain;
}

const supabaseMock = {
  from: vi.fn((table: string) => buildQuery(table)),
  rpc: vi.fn((fn: string, args: Record<string, any>) => {
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

// `vi.mock` paths are resolved relative to the test file, not the
// module-under-test, so use `../listeners/...` here even though
// `DatabaseListener.ts` imports it as `./FederationHandlers.js`.
vi.mock('../listeners/FederationHandlers.js', () => ({
  createPostActivity: vi.fn().mockResolvedValue({
    type: 'Create',
    object: { id: 'https://harmony.test/posts/post-1' },
  }),
  createReblogActivity: vi.fn().mockResolvedValue({ type: 'Announce' }),
  createPostUpdateActivity: vi.fn().mockResolvedValue({ type: 'Update' }),
  createFlagActivity: vi.fn().mockReturnValue({ type: 'Flag' }),
}));

const getPreview = vi.fn().mockResolvedValue({
  cacheKey: 'arstechnica',
  url: 'https://arstechnica.com/security/foo',
  normalizedUrl: 'https://arstechnica.com/security/foo',
  provider: 'generic',
  title: 'Ars Technica article',
  description: 'A security headline',
  fetchedAt: '2026-05-28T00:00:00Z',
  expiresAt: '2026-05-29T00:00:00Z',
});

vi.mock('../services/LinkPreviewService.js', () => ({
  linkPreviewService: { getPreview },
}));

// `handleNewPost` also pulls in `ActivityProcessor` and `contentUtils`;
// they aren't on the link-preview path so just stub them out.
vi.mock('../activitypub/ActivityProcessor.js', () => ({
  ActivityProcessor: { fetchAndCreateRemotePost: vi.fn() },
}));

vi.mock('../utils/contentUtils.js', () => ({
  convertContentToHTML: vi.fn(() => ''),
  extractActivityPubTags: vi.fn(() => []),
  extractAttachments: vi.fn(() => []),
}));

vi.mock('../activitypub/converters/toActivityPub.js', () => ({
  createLikeActivity: vi.fn(),
  postToNote: vi.fn().mockResolvedValue({ type: 'Note' }),
  profileToActor: vi.fn().mockReturnValue({ type: 'Person' }),
  createUpdateActivity: vi.fn(),
  extractAnnounceData: vi.fn(),
  extractDeleteData: vi.fn(),
}));

vi.mock('../utils/emojiResolvers.js', () => ({
  resolveOutboundEmoji: vi.fn().mockResolvedValue({ content: '👍', emojiData: null }),
}));

const { handleNewPost } = await import('../listeners/DatabaseListener.js');

describe('handleNewPost — external link preview enrichment', () => {
  beforeEach(() => {
    rpcCalls.length = 0;
    getPreview.mockClear();
    broadcastToFollowers.mockClear();
    supabaseMock.from.mockClear();
    supabaseMock.rpc.mockClear();
  });

  it('runs enrichPostLinkPreviews for a local public post with an external URL', async () => {
    await handleNewPost({
      id: 'post-1',
      is_local: true,
      visibility: 'public',
      author_id: 'author-1',
    });

    // The Create activity went out first (federation isn't blocked on
    // the link preview HTTP fetch).
    expect(broadcastToFollowers).toHaveBeenCalledTimes(1);

    // `enrichPostLinkPreviews` is fire-and-forget; wait one microtask
    // cycle to let the promise resolve before asserting on it.
    await new Promise((resolve) => setImmediate(resolve));

    expect(getPreview).toHaveBeenCalledTimes(1);
    expect(getPreview).toHaveBeenCalledWith('https://arstechnica.com/security/foo');

    // The preview gets written through the `update_post_embeds` RPC,
    // keyed off the URL string the user pasted.
    const writeCalls = rpcCalls.filter((c) => c.fn === 'update_post_embeds');
    expect(writeCalls).toHaveLength(1);
    expect(writeCalls[0].args.p_post_id).toBe('post-1');
    expect(writeCalls[0].args.p_embeds['https://arstechnica.com/security/foo']).toBeDefined();
    expect(writeCalls[0].args.p_embeds['https://arstechnica.com/security/foo'].title).toBe(
      'Ars Technica article',
    );
  });

  it('skips enrichment for posts whose only URL targets the local instance', async () => {
    // Repoint `fakePost.content` to a URL on `harmony.test` so the
    // existing local-host filter inside `enrichPostLinkPreviews` rejects
    // it. We don't add `harmonyembed.test` to NON_AP_DOMAINS — the
    // function rejects every URL whose hostname matches our own.
    fakePost.content = [
      { type: 'url', url: 'https://harmony.test/posts/abc', preview: true },
    ];

    await handleNewPost({
      id: 'post-1',
      is_local: true,
      visibility: 'public',
      author_id: 'author-1',
    });

    await new Promise((resolve) => setImmediate(resolve));

    expect(getPreview).not.toHaveBeenCalled();
    const writeCalls = rpcCalls.filter((c) => c.fn === 'update_post_embeds');
    expect(writeCalls).toHaveLength(0);

    // Restore the fixture for the next test.
    fakePost.content = [
      { type: 'url', url: 'https://arstechnica.com/security/foo', preview: true },
    ];
  });
});
