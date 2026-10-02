import { describe, it, expect, vi, beforeEach } from 'vitest';

// ActivityProcessor and the converters read config at module load.
vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
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
  },
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const sendToInbox = vi.fn().mockResolvedValue(undefined);
const broadcastToFollowers = vi.fn().mockResolvedValue(undefined);
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { sendToInbox, broadcastToFollowers },
}));

type Row = Record<string, any>;

let tables: Record<string, Row[]> = {};
let nextId = 0;

/**
 * In-memory double for the PostgREST chains these paths use. The post_interactions insert
 * enforces idx_post_interactions_unique (one favourite per user and post) as 23505.
 */
function fakeSupabase() {
  return {
    rpc: () => Promise.resolve({ data: null, error: null }),
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let mode: 'select' | 'delete' | 'update' | 'insert' = 'select';
      let payload: Row | null = null;

      const run = (): { data: any; error: any } => {
        const rows = (tables[table] ??= []);
        if (mode === 'insert') {
          const row: Row = { id: `row-${++nextId}`, ...payload };
          if (
            table === 'post_interactions' && row.interaction_type === 'favorite' &&
            rows.some((r) => r.interaction_type === 'favorite' && r.user_id === row.user_id && r.post_id === row.post_id)
          ) {
            return { data: null, error: { code: '23505', message: 'duplicate key' } };
          }
          rows.push(row);
          return { data: [row], error: null };
        }
        const matched = rows.filter((row) => filters.every((f) => f(row)));
        if (mode === 'delete') tables[table] = rows.filter((row) => !matched.includes(row));
        if (mode === 'update') matched.forEach((row) => Object.assign(row, payload));
        return { data: matched, error: null };
      };

      const builder: any = {
        select() { return builder; },
        insert(row: Row) { mode = 'insert'; payload = row; return builder; },
        update(row: Row) { mode = 'update'; payload = row; return builder; },
        delete() { mode = 'delete'; return builder; },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder; },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder; },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder; },
        maybeSingle() {
          const { data, error } = run();
          return Promise.resolve({ data: data?.[0] ?? null, error });
        },
        single() {
          const { data, error } = run();
          return Promise.resolve(
            data?.length === 1 ? { data: data[0], error } : { data: null, error: error ?? { message: 'no rows' } },
          );
        },
        then(resolve: any, reject: any) {
          return Promise.resolve(run()).then(resolve, reject);
        },
      };
      return builder;
    },
  };
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
}));

const { ActivityProcessor } = await import('../activitypub/ActivityProcessor.js');
const { isHeartReaction, isFavouriteLike } = await import('../utils/heartReaction.js');
const { buildPostInteractionLike } = await import('../activitypub/postInteractionLike.js');
const { createUndoLikeActivity } = await import('../listeners/FederationHandlers.js');
const { handleReactionJob } = await import('../queue/handlers/reactionHandler.js');

const AP = ActivityProcessor as any;
vi.spyOn(AP, 'ensureRemoteUser').mockResolvedValue({});

const MASTODON_BOB = 'https://mastodon.test/users/bob';
const MISSKEY_ALICE = 'https://misskey.test/users/9abc';
const AKKOMA_CAROL = 'https://akkoma.test/users/carol';
const POST_ID = '11111111-1111-4111-8111-111111111111';
const POST_AP_ID = `https://harmony.test/posts/${POST_ID}`;
const BLOBCAT_URL = 'https://misskey.test/files/blobcat.webp';

const rows = () =>
  (tables.post_interactions ?? []).map((r) =>
    `${r.user_id}:${r.interaction_type}:${r.emoji_id ?? r.custom_emoji_content ?? '-'}`);

const receive = (activity: any) => AP.processLike(activity);
const undo = (inner: any) => AP.processUndo({ type: 'Undo', actor: inner.actor, object: inner });

beforeEach(() => {
  nextId = 0;
  sendToInbox.mockClear();
  broadcastToFollowers.mockClear();
  tables = {
    profiles: [
      { id: 'bob', federated_id: MASTODON_BOB, is_local: false },
      { id: 'alice', federated_id: MISSKEY_ALICE, is_local: false },
      { id: 'carol', federated_id: AKKOMA_CAROL, is_local: false },
      { id: 'me', username: 'me', is_local: true },
      {
        id: 'mk-author', is_local: false, username: 'author', domain: 'misskey.test',
        federated_id: 'https://misskey.test/users/author', inbox_url: 'https://misskey.test/inbox',
      },
    ],
    posts: [
      { id: POST_ID, ap_id: POST_AP_ID },
      { id: 'remote-post', ap_id: 'https://misskey.test/notes/xyz', author_id: 'mk-author', is_local: false },
    ],
    emojis: [{ id: 'emoji-blobcat', name: 'blobcat', url: BLOBCAT_URL, domain: 'misskey.test' }],
    messages: [],
    post_interactions: [],
  };
});

describe('isHeartReaction', () => {
  it('accepts U+2764 and U+2665 with or without a variation selector', () => {
    for (const heart of ['\u2764', '\u2764\uFE0F', '\u2764\uFE0E', '\u2665', '\u2665\uFE0F']) {
      expect(isHeartReaction(heart)).toBe(true);
    }
  });

  it('rejects other hearts, shortcodes and empty input', () => {
    for (const other of ['💗', '💖', '🩷', '🧡', '👍', ':heart:', '', null, undefined]) {
      expect(isHeartReaction(other as any)).toBe(false);
    }
  });

  it('treats an image emoji named like a heart as a reaction', () => {
    expect(isFavouriteLike({ emoji: '❤', emojiName: ':heart:', emojiUrl: 'https://x.test/h.png' })).toBe(false);
    expect(isFavouriteLike({})).toBe(true);
  });
});

describe('inbound Like', () => {
  it('stores a Mastodon Like as a favourite', async () => {
    await receive({ type: 'Like', id: `${MASTODON_BOB}#likes/1`, actor: MASTODON_BOB, object: POST_AP_ID });

    expect(rows()).toEqual(['bob:favorite:-']);
  });

  it('stores a Misskey ❤ Like as a favourite, whatever the variation selector', async () => {
    await receive({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, content: '❤', _misskey_reaction: '❤' });
    await receive({ type: 'Like', actor: MASTODON_BOB, object: POST_AP_ID, content: '❤️' });
    await receive({ type: 'Like', actor: AKKOMA_CAROL, object: POST_AP_ID, _misskey_reaction: '♥' });

    expect(rows()).toEqual(['alice:favorite:-', 'bob:favorite:-', 'carol:favorite:-']);
  });

  it('dedups by actor and object: a plain Like after a ❤ Like holds one favourite', async () => {
    await receive({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, _misskey_reaction: '❤' });
    await receive({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID });
    await receive({ type: 'EmojiReact', actor: MISSKEY_ALICE, object: POST_AP_ID, content: '❤️' });

    expect(rows()).toEqual(['alice:favorite:-']);
  });

  it('stores a Misskey unicode reaction as a reaction chip', async () => {
    await receive({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, content: '🎉', _misskey_reaction: '🎉' });

    expect(rows()).toEqual(['alice:emoji_reaction:🎉']);
  });

  it('stores a Misskey custom emoji Like with its Emoji tag against the emoji row', async () => {
    await receive({
      type: 'Like',
      actor: MISSKEY_ALICE,
      object: POST_AP_ID,
      content: ':blobcat:',
      _misskey_reaction: ':blobcat:',
      tag: [{ type: 'Emoji', name: ':blobcat:', icon: { type: 'Image', url: BLOBCAT_URL } }],
    });

    expect(rows()).toEqual(['alice:emoji_reaction:emoji-blobcat']);
    expect(tables.post_interactions[0].custom_emoji_content).toBe(':blobcat:');
  });

  it('stores an EmojiReact as a reaction chip, separate from the favourite', async () => {
    await receive({ type: 'Like', actor: AKKOMA_CAROL, object: POST_AP_ID });
    await receive({ type: 'EmojiReact', actor: AKKOMA_CAROL, object: POST_AP_ID, content: '👀' });

    expect(rows()).toEqual(['carol:favorite:-', 'carol:emoji_reaction:👀']);
  });
});

describe('inbound Undo', () => {
  beforeEach(async () => {
    await receive({ type: 'Like', actor: MASTODON_BOB, object: POST_AP_ID });
    await receive({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, _misskey_reaction: '❤' });
    await receive({ type: 'EmojiReact', actor: AKKOMA_CAROL, object: POST_AP_ID, content: '👀' });
    await receive({ type: 'Like', actor: AKKOMA_CAROL, object: POST_AP_ID });
    await receive({
      type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, _misskey_reaction: ':blobcat:',
      tag: [{ type: 'Emoji', name: ':blobcat:', icon: { url: BLOBCAT_URL } }],
    });
  });

  it('removes the favourite on a Mastodon Undo Like', async () => {
    await undo({ type: 'Like', id: `${MASTODON_BOB}#likes/1`, actor: MASTODON_BOB, object: POST_AP_ID });

    expect(rows()).not.toContain('bob:favorite:-');
    expect(rows()).toHaveLength(4);
  });

  it('removes the favourite on a Misskey Undo of its ❤ Like, leaving its custom reaction', async () => {
    await undo({ type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, content: '❤', _misskey_reaction: '❤' });

    expect(rows()).toEqual(['bob:favorite:-', 'carol:emoji_reaction:👀', 'carol:favorite:-', 'alice:emoji_reaction:emoji-blobcat']);
  });

  it('removes only the custom emoji on an Undo of a custom emoji Like', async () => {
    await undo({
      type: 'Like', actor: MISSKEY_ALICE, object: POST_AP_ID, _misskey_reaction: ':blobcat:',
      tag: [{ type: 'Emoji', name: ':blobcat:', icon: { url: BLOBCAT_URL } }],
    });

    expect(rows()).toEqual(['bob:favorite:-', 'alice:favorite:-', 'carol:emoji_reaction:👀', 'carol:favorite:-']);
  });

  it('removes only the reaction on an Undo EmojiReact, leaving the same actor\'s favourite', async () => {
    await undo({ type: 'EmojiReact', actor: AKKOMA_CAROL, object: POST_AP_ID, content: '👀' });

    expect(rows()).toEqual(['bob:favorite:-', 'alice:favorite:-', 'carol:favorite:-', 'alice:emoji_reaction:emoji-blobcat']);
  });

  it('ignores an Undo signed by someone other than the Like\'s actor', async () => {
    await AP.processUndo({
      type: 'Undo',
      actor: MISSKEY_ALICE,
      object: { type: 'Like', actor: MASTODON_BOB, object: POST_AP_ID },
    });

    expect(rows()).toHaveLength(5);
  });
});

describe('outbound Like', () => {
  const me = { username: 'me' };
  const favourite = { interaction_id: 'int-1', interaction_type: 'favorite' };

  it('sends a favourite as a bare Like, which Misskey maps to its like', async () => {
    const like = await buildPostInteractionLike(me, POST_AP_ID, favourite);

    expect(like).toMatchObject({ type: 'Like', id: 'https://harmony.test/users/me/likes/int-1', object: POST_AP_ID });
    expect(like).not.toHaveProperty('content');
    expect(like).not.toHaveProperty('_misskey_reaction');
    expect(like).not.toHaveProperty('tag');
  });

  it('sends a unicode reaction in content and _misskey_reaction', async () => {
    const like = await buildPostInteractionLike(me, POST_AP_ID, {
      interaction_id: 'int-2', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉',
    });

    expect(like).toMatchObject({ type: 'Like', content: '🎉', _misskey_reaction: '🎉' });
    expect(like).not.toHaveProperty('tag');
  });

  it('sends a custom emoji reaction with an Emoji tag and an unqualified shortcode', async () => {
    const like = await buildPostInteractionLike(me, POST_AP_ID, {
      interaction_id: 'int-3', interaction_type: 'emoji_reaction', emoji_id: 'emoji-blobcat', custom_emoji_content: ':blobcat:',
    }, 'mastodon.test');

    expect(like._misskey_reaction).toBe(':blobcat:');
    expect(like.tag).toEqual([
      expect.objectContaining({ type: 'Emoji', name: ':blobcat:', icon: expect.objectContaining({ url: BLOBCAT_URL }) }),
    ]);
  });

  it('sends a heart reaction row queued before the fold as a bare Like', async () => {
    const like = await buildPostInteractionLike(me, POST_AP_ID, {
      interaction_id: 'int-4', interaction_type: 'emoji_reaction', custom_emoji_content: '❤️',
    });

    expect(like).not.toHaveProperty('_misskey_reaction');
  });

  it('undoes a Like by embedding it under the same id', async () => {
    const like = await buildPostInteractionLike(me, POST_AP_ID, {
      interaction_id: 'int-2', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉',
    }, undefined, ['https://misskey.test/users/author']);
    const undoActivity = createUndoLikeActivity(me, POST_AP_ID, like);

    expect(undoActivity.type).toBe('Undo');
    expect(undoActivity.id).toBe('https://harmony.test/users/me/likes/int-2/undo');
    expect(undoActivity.object).toEqual({
      id: 'https://harmony.test/users/me/likes/int-2',
      type: 'Like',
      actor: 'https://harmony.test/users/me',
      object: POST_AP_ID,
      content: '🎉',
      _misskey_reaction: '🎉',
    });
  });
});

describe('federate-reaction job', () => {
  const job = (fields: Record<string, any>) => ({
    post_id: 'remote-post', user_id: 'me', interaction_id: 'int-9', ...fields,
  }) as any;

  it('delivers a favourite to the remote author as a bare Like', async () => {
    await handleReactionJob(job({ type: 'create', interaction_type: 'favorite' }));

    expect(sendToInbox).toHaveBeenCalledTimes(1);
    const [inbox, activity] = sendToInbox.mock.calls[0];
    expect(inbox).toBe('https://misskey.test/inbox');
    expect(activity).toMatchObject({ type: 'Like', id: 'https://harmony.test/users/me/likes/int-9', to: ['https://misskey.test/users/author'] });
    expect(activity).not.toHaveProperty('_misskey_reaction');
  });

  it('undoes a reaction with the Like it sent', async () => {
    await handleReactionJob(job({ type: 'delete', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' }));

    const [, activity] = sendToInbox.mock.calls[0];
    expect(activity.type).toBe('Undo');
    expect(activity.object).toMatchObject({ id: 'https://harmony.test/users/me/likes/int-9', _misskey_reaction: '🎉' });
  });

  it('sends nothing for a reblog row: the boost post carries the Announce', async () => {
    tables.post_interactions.push({ id: 'int-9', interaction_type: 'reblog', federation_status: 'queued' });

    await handleReactionJob(job({ type: 'create', interaction_type: 'reblog' }));

    expect(sendToInbox).not.toHaveBeenCalled();
    expect(broadcastToFollowers).not.toHaveBeenCalled();
    expect(tables.post_interactions[0].federation_status).toBe('skipped');
  });
});
