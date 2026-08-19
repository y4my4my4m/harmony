import { describe, it, expect, vi, beforeEach } from 'vitest';

// ActivityProcessor calls parseEnv() at module load and exits when the
// federation env vars are absent.
vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
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
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

type Row = Record<string, any>;

let tables: Record<string, Row[]> = {};

/**
 * In-memory Supabase double covering the chain processUndoReaction uses:
 * .from(t).select(...).eq/.in(...) awaited as an array or via maybeSingle/
 * single, and .from(t).delete().eq/.in(...).
 */
function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let isDelete = false;

      const run = () => {
        const rows = tables[table] ?? [];
        const matched = rows.filter((row) => filters.every((f) => f(row)));
        if (isDelete) {
          tables[table] = rows.filter((row) => !matched.includes(row));
        }
        return matched;
      };

      const builder: any = {
        select() { return builder; },
        delete() { isDelete = true; return builder; },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder; },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder; },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder; },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
        single() {
          const rows = run();
          return Promise.resolve(
            rows.length === 1
              ? { data: rows[0], error: null }
              : { data: null, error: { message: 'no rows' } },
          );
        },
        then(resolve: any) { return resolve({ data: run(), error: null }); },
      };
      return builder;
    },
  };
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
}));

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js');

const undoReaction = (object: any) =>
  (ActivityProcessor as any).processUndoReaction(object, object.actor);

const ALICE = 'https://akkoma.test/users/alice';
const POST_AP_ID = 'https://harmony.test/posts/11111111-1111-4111-8111-111111111111';
const MESSAGE_URL = 'https://harmony.test/messages/22222222-2222-4222-8222-222222222222';

const interactions = () =>
  (tables.post_interactions ?? []).map((r) => `${r.interaction_type}:${r.custom_emoji_content ?? r.emoji_id}`);

beforeEach(() => {
  tables = {
    profiles: [
      { id: 'alice-id', federated_id: ALICE },
      { id: 'bob-id', federated_id: 'https://mastodon.test/users/bob' },
    ],
    posts: [{ id: 'post-1', ap_id: POST_AP_ID }],
    emojis: [],
    post_interactions: [],
    reactions: [],
  };
});

describe('Undo of one emoji reaction', () => {
  beforeEach(() => {
    // Akkoma/Misskey actors hold several distinct reactions on one post.
    tables.post_interactions = [
      { id: 'r1', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: null, custom_emoji_content: '🎉' },
      { id: 'r2', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: null, custom_emoji_content: '👀' },
      { id: 'r3', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: null, custom_emoji_content: '❤️' },
      { id: 'r4', user_id: 'bob-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: null, custom_emoji_content: '🎉' },
    ];
  });

  it('removes only the named emoji, not every reaction the actor holds', async () => {
    await undoReaction({
      type: 'EmojiReaction',
      actor: ALICE,
      object: POST_AP_ID,
      content: '🎉',
    });

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r2', 'r3', 'r4']);
  });

  it('removes the heart and the favourite for a plain Like carrying no emoji', async () => {
    tables.post_interactions.push({
      id: 'r5', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'favorite', emoji_id: null, custom_emoji_content: null,
    });

    await undoReaction({ type: 'Like', actor: ALICE, object: POST_AP_ID });

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r1', 'r2', 'r4']);
  });

  it('leaves the favourite alone when the Undo names an emoji', async () => {
    tables.post_interactions.push({
      id: 'r5', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'favorite', emoji_id: null, custom_emoji_content: null,
    });

    await undoReaction({
      type: 'EmojiReaction',
      actor: ALICE,
      object: POST_AP_ID,
      content: '👀',
    });

    expect(interactions()).toEqual(['emoji_reaction:🎉', 'emoji_reaction:❤️', 'emoji_reaction:🎉', 'favorite:null']);
  });

  it('treats the two heart variants as one reaction', async () => {
    await undoReaction({ type: 'Like', actor: ALICE, object: POST_AP_ID, content: '❤' });

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r1', 'r2', 'r4']);
  });

  it('deletes nothing when the actor never held the named emoji', async () => {
    await undoReaction({
      type: 'EmojiReaction',
      actor: ALICE,
      object: POST_AP_ID,
      content: '🔥',
    });

    expect(tables.post_interactions).toHaveLength(4);
  });
});

describe('Undo of a custom emoji reaction', () => {
  const BLOBCAT_URL = 'https://akkoma.test/emoji/blobcat.png';
  const undoBlobcat = {
    type: 'EmojiReaction',
    actor: ALICE,
    object: POST_AP_ID,
    content: ':blobcat@akkoma.test:',
    tag: [{ type: 'Emoji', name: ':blobcat@akkoma.test:', icon: { url: BLOBCAT_URL } }],
  };

  beforeEach(() => {
    tables.emojis = [{ id: 'emoji-blobcat', url: BLOBCAT_URL }];
    tables.post_interactions = [
      { id: 'r1', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: 'emoji-blobcat', custom_emoji_content: ':blobcat@akkoma.test:' },
      { id: 'r2', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: 'emoji-blobfox', custom_emoji_content: ':blobfox@akkoma.test:' },
      { id: 'r3', user_id: 'alice-id', post_id: 'post-1', interaction_type: 'emoji_reaction', emoji_id: null, custom_emoji_content: '🎉' },
    ];
  });

  it('matches the row by emoji_id', async () => {
    await undoReaction(undoBlobcat);

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('matches the other stored representation, emoji_id NULL with the same shortcode', async () => {
    tables.post_interactions[0].emoji_id = null;

    await undoReaction(undoBlobcat);

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('matches by shortcode when this instance has no emoji row for the URL', async () => {
    tables.emojis = [];

    await undoReaction(undoBlobcat);

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r2', 'r3']);
  });

  it('does not touch a different custom emoji', async () => {
    await undoReaction({
      ...undoBlobcat,
      content: ':blobfox@akkoma.test:',
      tag: [{ type: 'Emoji', name: ':blobfox@akkoma.test:', icon: { url: 'https://akkoma.test/emoji/blobfox.png' } }],
    });

    expect(tables.post_interactions.map((r) => r.id)).toEqual(['r1', 'r3']);
  });
});

describe('Undo of a DM reaction', () => {
  beforeEach(() => {
    tables.reactions = [
      { id: 'm1', user_id: 'alice-id', message_id: '22222222-2222-4222-8222-222222222222', emoji_id: null, custom_emoji_content: '🎉' },
      { id: 'm2', user_id: 'alice-id', message_id: '22222222-2222-4222-8222-222222222222', emoji_id: null, custom_emoji_content: '👀' },
    ];
  });

  it('removes only the named emoji', async () => {
    await undoReaction({
      type: 'EmojiReaction',
      actor: ALICE,
      object: MESSAGE_URL,
      content: '👀',
    });

    expect(tables.reactions.map((r) => r.id)).toEqual(['m1']);
  });
});
