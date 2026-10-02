import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const safeFetch = vi.fn();
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: (...args: any[]) => safeFetch(...args),
  validateExternalUrl: vi.fn(),
  validateExternalHostname: vi.fn(),
}));

const deliverEach = vi.fn().mockResolvedValue(undefined);
const followerInboxes = vi.fn().mockResolvedValue([]);
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { deliverEach, followerInboxes },
}));

type Row = Record<string, any>;
let tables: Record<string, Row[]> = {};

const rpcCalls: Array<{ fn: string; args: any }> = [];

/**
 * record_instance_software as 20261007200001 defines it: an admin value (no
 * software_source) stands, a document never replaces NodeInfo, a null answer stamps the
 * attempt.
 */
function recordInstanceSoftware(args: any): string | null {
  const domain = String(args.p_domain).toLowerCase();
  const software = args.p_software ? String(args.p_software).toLowerCase() : null;
  const rows = (tables.federated_instances ??= []);
  let row = rows.find((r) => r.domain === domain);
  if (!row) { row = { domain, software: null, metadata: {} }; rows.push(row); }
  const meta = row.metadata ?? {};
  const stored = row.software && row.software !== 'unknown' ? row.software : null;
  if (stored && !meta.software_source) return stored;
  if (args.p_source === 'nodeinfo') {
    row.metadata = { ...meta, software_checked_at: new Date().toISOString(), ...(software && { software_source: 'nodeinfo' }) };
    if (software) { row.software = software; row.version = args.p_version; }
    return software ?? stored;
  }
  if (!software || meta.software_source === 'nodeinfo' || software === stored) return stored ?? software;
  row.software = software;
  row.metadata = { ...meta, software_source: 'document' };
  return software;
}

/** In-memory double for the PostgREST chains postEngagement and instanceSoftware use. */
function fakeSupabase() {
  return {
    rpc(fn: string, args: any) {
      rpcCalls.push({ fn, args });
      if (fn === 'record_instance_software') return Promise.resolve({ data: recordInstanceSoftware(args), error: null });
      return Promise.resolve({ data: null, error: { message: `no rpc ${fn}` } });
    },
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let mode: 'select' | 'update' = 'select';
      let payload: Row | null = null;
      let limitN: number | undefined;
      const run = () => {
        const rows = (tables[table] ??= []);
        const matched = rows.filter((row) => filters.every((f) => f(row)));
        if (mode === 'update') matched.forEach((row) => Object.assign(row, payload));
        return { data: limitN === undefined ? matched : matched.slice(0, limitN), error: null };
      };
      const builder: any = {
        select() { return builder; },
        update(row: Row) { mode = 'update'; payload = row; return builder; },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder; },
        is(col: string, val: any) { filters.push((row) => (row[col] ?? null) === val); return builder; },
        in(col: string, vals: any[]) { filters.push((row) => vals.includes(row[col])); return builder; },
        order() { return builder; },
        limit(n: number) { limitN = n; return builder; },
        maybeSingle() {
          const { data } = run();
          return Promise.resolve({ data: data[0] ?? null, error: null });
        },
        then(resolve: any, reject: any) { return Promise.resolve(run()).then(resolve, reject); },
      };
      return builder;
    },
  };
}

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => fakeSupabase(),
}));

const { encodeEngagement, federatePostEngagement, resolveDeferredEngagement } = await import('../activitypub/postEngagement.js');
const {
  detectSoftwareFromDocument, engagementFamily, forgetInstanceSoftware, instanceSoftware, noteDocumentSoftware,
} = await import('../activitypub/instanceSoftware.js');
const { handleReactionJob } = await import('../queue/handlers/reactionHandler.js');

const ME = { username: 'me' };
const NOTE = 'https://remote.test/notes/1';
const BLOBCAT = { name: 'blobcat', url: 'https://harmony.test/emoji/blobcat.webp', domain: 'harmony.test' };
const NOW = 1_700_000_000_000;

const event = (fields: Record<string, any>) => ({
  post_id: 'p', user_id: 'me', interaction_id: 'int-1', ...fields,
}) as any;

const encode = (family: any, ev: any, state: any = null, eventEmoji: any = null) =>
  encodeEngagement(family, {
    user: ME, postApId: NOTE, targetHost: 'remote.test', to: ['https://remote.test/users/author'],
    event: ev, eventEmoji, state, now: NOW,
  });

const MISSKEY_ACTOR = {
  '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1', {
    toot: 'http://joinmastodon.org/ns#', misskey: 'https://misskey-hub.net/ns#',
    _misskey_quote: 'misskey:_misskey_quote', isCat: 'misskey:isCat',
  }],
  type: 'Person', isCat: false,
};
const SHARKEY_ACTOR = {
  '@context': ['https://www.w3.org/ns/activitystreams', {
    misskey: 'https://misskey-hub.net/ns#', isCat: 'misskey:isCat', sharkey: 'https://joinsharkey.org/ns#',
    firefish: 'https://joinfirefish.org/ns#', speakAsCat: 'firefish:speakAsCat',
  }],
  type: 'Person', isCat: true,
};

describe('detectSoftwareFromDocument', () => {
  it('names the software from actor and object documents', () => {
    expect(detectSoftwareFromDocument(MISSKEY_ACTOR)).toBe('misskey');
    expect(detectSoftwareFromDocument(SHARKEY_ACTOR)).toBe('sharkey');
    expect(detectSoftwareFromDocument({ '@context': ['https://www.w3.org/ns/activitystreams', { firefish: 'https://joinfirefish.org/ns#', misskey: 'https://misskey-hub.net/ns#', isCat: 'misskey:isCat' }] })).toBe('firefish');
    expect(detectSoftwareFromDocument({ type: 'Note', _misskey_content: 'hi' })).toBe('misskey');
    expect(detectSoftwareFromDocument({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://pl.test/schemas/litepub-0.1.jsonld', { '@language': 'und' }] })).toBe('pleroma');
    expect(detectSoftwareFromDocument({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://ak.test/schemas/litepub-0.1.jsonld', 'https://purl.archive.org/socialweb/webfinger', { sm: 'http://smithereen.software/ns#' }] })).toBe('akkoma');
    expect(detectSoftwareFromDocument({ '@context': ['https://gotosocial.org/ns', 'https://www.w3.org/ns/activitystreams'] })).toBe('gotosocial');
    expect(detectSoftwareFromDocument({ '@context': ['https://www.w3.org/ns/activitystreams', { toot: 'http://joinmastodon.org/ns#', featuredTags: { '@id': 'toot:featuredTags' }, indexable: 'toot:indexable' }] })).toBe('mastodon');
  });

  it('decides nothing from what Harmony and others borrow', () => {
    // postToNote's context and createLikeActivity's fields.
    expect(detectSoftwareFromDocument({
      '@context': ['https://www.w3.org/ns/activitystreams', { quoteUrl: 'as:quoteUrl', misskey: 'https://misskey-hub.net/ns#', _misskey_quote: 'misskey:_misskey_quote' }],
      type: 'Note', _misskey_quote: 'https://x.test/1',
    })).toBeNull();
    expect(detectSoftwareFromDocument({
      '@context': ['https://www.w3.org/ns/activitystreams', { toot: 'http://joinmastodon.org/ns#', misskey: 'https://misskey-hub.net/ns#', _misskey_reaction: 'misskey:_misskey_reaction' }],
      type: 'Like', _misskey_reaction: '🎉',
    })).toBeNull();
    expect(detectSoftwareFromDocument({ '@context': ['https://www.w3.org/ns/activitystreams', 'https://w3id.org/security/v1'], type: 'Person' })).toBeNull();
    expect(detectSoftwareFromDocument(null)).toBeNull();
  });
});

describe('engagementFamily', () => {
  it('maps NodeInfo software names to the three encodings', () => {
    expect(['mastodon', 'gotosocial', 'glitch-soc', 'Hometown'].map(engagementFamily))
      .toEqual(['mastodon', 'mastodon', 'mastodon', 'mastodon']);
    expect(['misskey', 'sharkey', 'Firefish', 'iceshrimp', 'cherrypick'].map(engagementFamily))
      .toEqual(['misskey', 'misskey', 'misskey', 'misskey', 'misskey']);
    expect(['pleroma', 'akkoma', 'harmony', 'iceshrimp.net', null, ''].map(engagementFamily))
      .toEqual(['emojiReact', 'emojiReact', 'emojiReact', 'emojiReact', 'emojiReact', 'emojiReact']);
  });
});

describe('mastodon family: favourites only', () => {
  it('sends the favourite as a bare Like', () => {
    const like = encode('mastodon', event({ type: 'create', interaction_type: 'favorite', implied: true }));

    expect(like).toMatchObject({
      type: 'Like', id: 'https://harmony.test/users/me/likes/int-1', object: NOTE,
      to: ['https://remote.test/users/author'],
    });
    expect(like).not.toHaveProperty('content');
    expect(like).not.toHaveProperty('_misskey_reaction');
  });

  it('undoes the favourite with its own Like', () => {
    const undo = encode('mastodon', event({ type: 'delete', interaction_type: 'favorite' }));

    expect(undo).toMatchObject({
      type: 'Undo', id: 'https://harmony.test/users/me/likes/int-1/undo',
      object: { type: 'Like', id: 'https://harmony.test/users/me/likes/int-1', object: NOTE },
    });
    expect(undo.object).not.toHaveProperty('to');
  });

  it('sends nothing for a reaction or its removal: any Undo Like would drop the favourite', () => {
    expect(encode('mastodon', event({ type: 'create', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' }))).toBeNull();
    expect(encode('mastodon', event({ type: 'delete', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' }))).toBeNull();
  });
});

describe('emojiReact family: Pleroma, Akkoma, unknown software', () => {
  it('sends a reaction as an EmojiReact under the row\'s id', () => {
    const react = encode('emojiReact', event({ type: 'create', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' }));

    expect(react).toMatchObject({
      type: 'EmojiReact', id: 'https://harmony.test/users/me/likes/int-1', content: '🎉', object: NOTE,
    });
    expect(react).not.toHaveProperty('_misskey_reaction');
  });

  it('sends a custom emoji with its Emoji tag, unqualified', () => {
    const react = encode('emojiReact',
      event({ type: 'create', interaction_type: 'emoji_reaction', emoji_id: 'e-1', custom_emoji_content: ':blobcat:' }),
      null, BLOBCAT);

    expect(react.content).toBe(':blobcat:');
    expect(react.tag).toEqual([expect.objectContaining({ type: 'Emoji', name: ':blobcat:', icon: expect.objectContaining({ url: BLOBCAT.url }) })]);
  });

  it('undoes one reaction by its EmojiReact, never the favourite\'s Like', () => {
    const undo = encode('emojiReact', event({ type: 'delete', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' }));

    expect(undo).toMatchObject({
      type: 'Undo', id: 'https://harmony.test/users/me/likes/int-1/undo',
      object: { type: 'EmojiReact', id: 'https://harmony.test/users/me/likes/int-1', content: '🎉' },
    });
  });

  it('sends the favourite as a bare Like and undoes it as one', () => {
    expect(encode('emojiReact', event({ type: 'create', interaction_type: 'favorite', implied: true })))
      .toMatchObject({ type: 'Like', id: 'https://harmony.test/users/me/likes/int-1' });
    expect(encode('emojiReact', event({ type: 'delete', interaction_type: 'favorite' })))
      .toMatchObject({ type: 'Undo', object: { type: 'Like', id: 'https://harmony.test/users/me/likes/int-1' } });
  });

  it('treats a heart reaction row queued before the fold as the favourite', () => {
    expect(encode('emojiReact', event({ type: 'create', interaction_type: 'emoji_reaction', custom_emoji_content: '❤️' })))
      .toMatchObject({ type: 'Like' });
  });
});

describe('misskey family: one reaction per actor, sent as state', () => {
  const reaction = (id: string, content: string, emoji: any = null) =>
    ({ id, emoji_id: emoji ? 'e-1' : null, custom_emoji_content: content, emoji });

  it('sends nothing for an implied favourite: its reaction\'s job sends the state', () => {
    const state = { favouriteId: 'fav', newestReaction: reaction('r1', '🎉') };
    expect(encode('misskey', event({ type: 'create', interaction_type: 'favorite', implied: true }), state)).toBeNull();
  });

  it('sends the newest reaction as Like + _misskey_reaction, replacing the held one', () => {
    const state = { favouriteId: 'fav', newestReaction: reaction('r2', '🔥') };
    const like = encode('misskey', event({ type: 'create', interaction_type: 'emoji_reaction', interaction_id: 'r2', custom_emoji_content: '🔥' }), state);

    expect(like).toMatchObject({
      type: 'Like', id: `https://harmony.test/users/me/likes/r2#${NOW}`, content: '🔥', _misskey_reaction: '🔥',
    });
  });

  it('answers the removal of one of several reactions with the next, not an Undo', () => {
    const state = { favouriteId: 'fav', newestReaction: reaction('r1', ':blobcat:', BLOBCAT) };
    const like = encode('misskey', event({ type: 'delete', interaction_type: 'emoji_reaction', interaction_id: 'r2', custom_emoji_content: '🔥' }), state);

    expect(like.type).toBe('Like');
    expect(like._misskey_reaction).toBe(':blobcat:');
    expect(like.tag).toEqual([expect.objectContaining({ name: ':blobcat:' })]);
  });

  it('answers the removal of the last reaction under an explicit favourite with a bare Like', () => {
    const like = encode('misskey', event({ type: 'delete', interaction_type: 'emoji_reaction', custom_emoji_content: '🔥' }),
      { favouriteId: 'fav', newestReaction: null });

    expect(like).toMatchObject({ type: 'Like', id: `https://harmony.test/users/me/likes/fav#${NOW}` });
    expect(like).not.toHaveProperty('_misskey_reaction');
  });

  it('leaves the Undo to the favourite\'s job once the favourite is gone', () => {
    const none = { favouriteId: null, newestReaction: null };
    expect(encode('misskey', event({ type: 'delete', interaction_type: 'emoji_reaction', custom_emoji_content: '🔥' }), none)).toBeNull();

    const undo = encode('misskey', event({ type: 'delete', interaction_type: 'favorite', interaction_id: 'fav' }), none);
    expect(undo).toMatchObject({
      type: 'Undo', object: { type: 'Like', id: 'https://harmony.test/users/me/likes/fav', object: NOTE },
    });
    expect(undo.object).not.toHaveProperty('_misskey_reaction');
  });

  it('sends an explicit favourite with no reaction as a bare Like', () => {
    const like = encode('misskey', event({ type: 'create', interaction_type: 'favorite', interaction_id: 'fav', implied: false }),
      { favouriteId: 'fav', newestReaction: null });
    expect(like).toMatchObject({ type: 'Like', id: `https://harmony.test/users/me/likes/fav#${NOW}` });
  });
});

describe('federate-reaction job', () => {
  const MISSKEY_INBOX = 'https://misskey.test/inbox';
  const MASTODON_INBOX = 'https://mastodon.test/inbox';
  const AKKOMA_INBOX = 'https://akkoma.test/inbox';

  beforeEach(() => {
    forgetInstanceSoftware();
    rpcCalls.length = 0;
    deliverEach.mockClear();
    followerInboxes.mockReset().mockResolvedValue([]);
    safeFetch.mockReset().mockRejectedValue(new Error('offline'));
    tables = {
      profiles: [
        { id: 'me', username: 'me', is_local: true },
        { id: 'remote-me', username: 'x', is_local: false },
        { id: 'author', username: 'author', is_local: true },
        { id: 'mk', username: 'mk', is_local: false, domain: 'misskey.test', federated_id: 'https://misskey.test/users/mk', inbox_url: 'https://misskey.test/users/mk/inbox' },
        { id: 'md', username: 'md', is_local: false, domain: 'mastodon.test', federated_id: 'https://mastodon.test/users/md', inbox_url: 'https://mastodon.test/users/md/inbox' },
        { id: 'ak', username: 'ak', is_local: false, domain: 'akkoma.test', federated_id: 'https://akkoma.test/users/ak', inbox_url: 'https://akkoma.test/users/ak/inbox' },
      ],
      posts: [
        { id: 'mk-post', author_id: 'mk', ap_id: 'https://misskey.test/notes/1', is_local: false },
        { id: 'md-post', author_id: 'md', ap_id: 'https://mastodon.test/statuses/1', is_local: false },
        { id: 'ak-post', author_id: 'ak', ap_id: 'https://akkoma.test/objects/1', is_local: false },
        { id: 'local-post', author_id: 'author', ap_id: 'https://harmony.test/posts/local-post', is_local: true },
      ],
      federated_instances: [
        { domain: 'misskey.test', software: 'misskey' },
        { domain: 'mastodon.test', software: 'mastodon' },
        { domain: 'akkoma.test', software: 'akkoma' },
      ],
      post_interactions: [],
      emojis: [],
    };
  });

  const delivered = () => deliverEach.mock.calls.flatMap(([items]) => items);

  // Misskey-family deliveries are built when each attempt is sent.
  const sent = async (item: any, now = NOW) =>
    item.activity?.type === 'harmony:DeferredEngagement' ? resolveDeferredEngagement(item.activity, now) : item.activity;

  it('sends a Mastodon author the implied favourite and nothing for the reaction', async () => {
    tables.post_interactions.push({ id: 'r1', post_id: 'md-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉' });
    await handleReactionJob({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'md-post', user_id: 'me', custom_emoji_content: '🎉', implied: false });
    await handleReactionJob({ type: 'create', interaction_id: 'fav', interaction_type: 'favorite', post_id: 'md-post', user_id: 'me', implied: true });

    expect(delivered()).toEqual([
      expect.objectContaining({ inbox: 'https://mastodon.test/users/md/inbox', priority: 1, activity: expect.objectContaining({ type: 'Like', id: 'https://harmony.test/users/me/likes/fav' }) }),
    ]);
    expect(deliverEach.mock.calls.every(([, sender]) => sender === 'me')).toBe(true);
    expect(tables.post_interactions[0].federation_status).toBe('completed');
  });

  it('sends a Misskey author the remaining reaction when one of two is removed', async () => {
    tables.post_interactions.push(
      { id: 'fav', post_id: 'mk-post', user_id: 'me', interaction_type: 'favorite', implied_by_reaction: true, created_at: '2026-10-01T10:00:00+00:00' },
      { id: 'r1', post_id: 'mk-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉', created_at: '2026-10-01T10:00:00+00:00' },
    );
    await handleReactionJob({ type: 'delete', interaction_id: 'r2', interaction_type: 'emoji_reaction', post_id: 'mk-post', user_id: 'me', custom_emoji_content: '🔥', implied: false });

    const [item] = delivered();
    expect(item.inbox).toBe('https://misskey.test/users/mk/inbox');
    expect(item.activity).toMatchObject({ type: 'harmony:DeferredEngagement', post_id: 'mk-post', user_id: 'me', username: 'me' });
    expect(item.activity).not.toHaveProperty('undo_favourite_id');
    expect(await sent(item)).toMatchObject({ type: 'Like', _misskey_reaction: '🎉', to: ['https://misskey.test/users/mk'] });
  });

  it('builds a Misskey delivery again at each attempt: a retry carries the state of its own moment', async () => {
    tables.post_interactions.push(
      { id: 'fav', post_id: 'mk-post', user_id: 'me', interaction_type: 'favorite', implied_by_reaction: true, created_at: '2026-10-01T10:00:00+00:00' },
      { id: 'r1', post_id: 'mk-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉', created_at: '2026-10-01T10:00:00+00:00' },
    );
    await handleReactionJob({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'mk-post', user_id: 'me', custom_emoji_content: '🎉', implied: false });
    const [item] = delivered();
    expect(await sent(item, NOW)).toMatchObject({ _misskey_reaction: '🎉' });

    tables.post_interactions.push(
      { id: 'r2', post_id: 'mk-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🔥', created_at: '2026-10-01T10:05:00+00:00' },
    );
    expect(await sent(item, NOW + 60_000)).toMatchObject({ type: 'Like', _misskey_reaction: '🔥', id: `https://harmony.test/users/me/likes/r2#${NOW + 60_000}` });

    tables.post_interactions = [];
    expect(await sent(item, NOW + 120_000)).toBeNull();
  });

  it('retries a Misskey Undo only while the person holds nothing; a re-reaction turns it into that state', async () => {
    await handleReactionJob({ type: 'delete', interaction_id: 'fav', interaction_type: 'favorite', post_id: 'mk-post', user_id: 'me', implied: true });
    const [item] = delivered();
    expect(item.activity.undo_favourite_id).toBe('fav');
    expect(await sent(item, NOW)).toMatchObject({ type: 'Undo', object: { type: 'Like', id: 'https://harmony.test/users/me/likes/fav' } });

    tables.post_interactions.push(
      { id: 'fav2', post_id: 'mk-post', user_id: 'me', interaction_type: 'favorite', implied_by_reaction: true, created_at: '2026-10-01T11:00:00+00:00' },
      { id: 'r3', post_id: 'mk-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '👀', created_at: '2026-10-01T11:00:00+00:00' },
    );
    expect(await sent(item, NOW + 60_000)).toMatchObject({ type: 'Like', _misskey_reaction: '👀' });
  });

  it('sends an Akkoma author an EmojiReact and the Undo of that EmojiReact', async () => {
    await handleReactionJob({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'ak-post', user_id: 'me', custom_emoji_content: '👀', implied: false });
    await handleReactionJob({ type: 'delete', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'ak-post', user_id: 'me', custom_emoji_content: '👀', implied: false });

    expect(delivered().map((d: any) => d.activity.type)).toEqual(['EmojiReact', 'Undo']);
    expect(delivered()[1].activity.object).toMatchObject({ type: 'EmojiReact', id: 'https://harmony.test/users/me/likes/r1' });
  });

  it('encodes a broadcast to followers per receiving software', async () => {
    followerInboxes.mockResolvedValue([MISSKEY_INBOX, MASTODON_INBOX, AKKOMA_INBOX]);
    tables.post_interactions.push(
      { id: 'fav', post_id: 'local-post', user_id: 'me', interaction_type: 'favorite', implied_by_reaction: true, created_at: '2026-10-01T10:00:00+00:00' },
      { id: 'r1', post_id: 'local-post', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉', created_at: '2026-10-01T10:00:00+00:00' },
    );
    await handleReactionJob({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'local-post', user_id: 'me', custom_emoji_content: '🎉', implied: false });

    expect(followerInboxes).toHaveBeenCalledWith('author');
    const byInbox = Object.fromEntries(await Promise.all(delivered().map(async (d: any) => [d.inbox, await sent(d)])));
    expect(Object.keys(byInbox).sort()).toEqual([AKKOMA_INBOX, MISSKEY_INBOX]);
    expect(byInbox[MISSKEY_INBOX]).toMatchObject({ type: 'Like', _misskey_reaction: '🎉' });
    expect(byInbox[AKKOMA_INBOX]).toMatchObject({ type: 'EmojiReact', content: '🎉' });
    expect(byInbox[AKKOMA_INBOX]).not.toHaveProperty('to');
  });

  it('federates nothing for a remote actor\'s row', async () => {
    tables.post_interactions.push({ id: 'r9', interaction_type: 'emoji_reaction', federation_status: 'queued' });
    await handleReactionJob({ type: 'create', interaction_id: 'r9', interaction_type: 'emoji_reaction', post_id: 'md-post', user_id: 'remote-me', custom_emoji_content: '🎉' });

    expect(deliverEach).not.toHaveBeenCalled();
    expect(tables.post_interactions[0].federation_status).toBe('skipped');
  });

  it('sends nothing for a reblog row: the boost post carries the Announce', async () => {
    tables.post_interactions.push({ id: 'int-9', interaction_type: 'reblog', federation_status: 'queued' });
    await handleReactionJob({ type: 'create', interaction_id: 'int-9', interaction_type: 'reblog', post_id: 'md-post', user_id: 'me' });

    expect(deliverEach).not.toHaveBeenCalled();
    expect(tables.post_interactions[0].federation_status).toBe('skipped');
  });

  const nodeinfo = (name: string, version = '1.0') => {
    safeFetch.mockReset()
      .mockResolvedValueOnce({ ok: true, json: async () => ({ links: [{ rel: 'http://nodeinfo.diaspora.software/ns/schema/2.0', href: 'https://x.test/nodeinfo/2.0' }] }) })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ software: { name, version } }) });
  };

  it('reads NodeInfo once for a host federated_instances does not name, and records it', async () => {
    tables.federated_instances.push({ domain: 'gts.test', software: null, metadata: {} });
    nodeinfo('gotosocial', '0.19.0');

    expect(await instanceSoftware('gts.test')).toBe('gotosocial');
    expect(await instanceSoftware('GTS.test')).toBe('gotosocial');
    expect(safeFetch).toHaveBeenCalledTimes(2);
    expect(tables.federated_instances.find((r) => r.domain === 'gts.test')).toMatchObject({
      software: 'gotosocial', version: '0.19.0', metadata: { software_source: 'nodeinfo' },
    });
  });

  it('uses an admin-set software as is, without NodeInfo', async () => {
    tables.federated_instances.push({ domain: 'admin.test', software: 'Pleroma', metadata: {} });

    expect(await instanceSoftware('admin.test')).toBe('pleroma');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('reads NodeInfo again once its answer is a week old, and not before', async () => {
    const day = 24 * 3600_000;
    tables.federated_instances.push(
      { domain: 'fresh.test', software: 'misskey', metadata: { software_source: 'nodeinfo', software_checked_at: new Date(Date.now() - day).toISOString() } },
      { domain: 'old.test', software: 'misskey', metadata: { software_source: 'nodeinfo', software_checked_at: new Date(Date.now() - 8 * day).toISOString() } },
    );
    expect(await instanceSoftware('fresh.test')).toBe('misskey');
    expect(safeFetch).not.toHaveBeenCalled();

    nodeinfo('sharkey');
    expect(await instanceSoftware('old.test')).toBe('sharkey');
    expect(tables.federated_instances.find((r) => r.domain === 'old.test')?.software).toBe('sharkey');
  });

  it('falls back to cached actor documents when NodeInfo cannot be read, and records the answer', async () => {
    tables.ap_actor_cache = [
      { domain: 'quiet.test', actor_data: { '@context': ['https://www.w3.org/ns/activitystreams'], type: 'Person' } },
      { domain: 'quiet.test', actor_data: MISSKEY_ACTOR },
    ];

    expect(await instanceSoftware('quiet.test')).toBe('misskey');
    expect(tables.federated_instances.find((r) => r.domain === 'quiet.test')).toMatchObject({
      software: 'misskey', metadata: { software_source: 'document' },
    });
    expect(rpcCalls.map((c) => c.args.p_source)).toEqual(['nodeinfo', 'document']);

    forgetInstanceSoftware();
    rpcCalls.length = 0;
    safeFetch.mockClear();
    expect(await instanceSoftware('quiet.test')).toBe('misskey');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('records the software a fetched document names, sharing it with every process', async () => {
    noteDocumentSoftware('https://shy.test/users/a', SHARKEY_ACTOR);
    noteDocumentSoftware('https://shy.test/users/b', SHARKEY_ACTOR);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(rpcCalls.filter((c) => c.fn === 'record_instance_software')).toHaveLength(1);
    expect(tables.federated_instances.find((r) => r.domain === 'shy.test')).toMatchObject({ software: 'sharkey' });
    expect(await instanceSoftware('shy.test')).toBe('sharkey');
    expect(safeFetch).not.toHaveBeenCalled();
  });

  it('encodes for Misskey a host only a document identified', async () => {
    tables.posts.push({ id: 'shy-post', author_id: 'shy', ap_id: 'https://shy.test/notes/1', is_local: false });
    tables.profiles.push({ id: 'shy', is_local: false, username: 'shy', domain: 'shy.test', federated_id: 'https://shy.test/users/shy', inbox_url: 'https://shy.test/users/shy/inbox' });
    tables.ap_actor_cache = [{ domain: 'shy.test', actor_data: SHARKEY_ACTOR }];

    await handleReactionJob({ type: 'delete', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'shy-post', user_id: 'me', custom_emoji_content: '🎉', implied: false });
    expect(delivered()).toHaveLength(0);
  });

  it('falls back to EmojiReact when the software cannot be learned', async () => {
    const result = await federatePostEngagement({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'local-post', user_id: 'me', custom_emoji_content: '🎉' });
    expect(result).toBe('completed');

    followerInboxes.mockResolvedValue(['https://unknown.test/inbox']);
    await federatePostEngagement({ type: 'create', interaction_id: 'r1', interaction_type: 'emoji_reaction', post_id: 'local-post', user_id: 'me', custom_emoji_content: '🎉' });
    expect(delivered()[0].activity.type).toBe('EmojiReact');
  });
});
