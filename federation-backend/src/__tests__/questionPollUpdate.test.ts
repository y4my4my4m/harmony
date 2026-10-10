import { beforeEach, describe, expect, it, vi } from 'vitest';

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

/** In-memory Supabase double: select/eq, maybeSingle/single, update and insert. */
function fakeSupabase() {
  return {
    from(table: string) {
      const filters: Array<(row: Row) => boolean> = [];
      let patch: Row | null = null;
      let inserted: Row | null = null;

      const run = () => {
        if (inserted) {
          (tables[table] ??= []).push(inserted);
          return [inserted];
        }
        const matched = (tables[table] ?? []).filter((row) => filters.every((f) => f(row)));
        if (patch) matched.forEach((row) => Object.assign(row, patch));
        return matched;
      };

      const builder: any = {
        select() { return builder; },
        update(row: Row) { patch = row; return builder; },
        insert(row: Row) { inserted = { id: `new-${(tables[table] ?? []).length}`, ...row }; return builder; },
        eq(col: string, val: any) { filters.push((row) => row[col] === val); return builder; },
        maybeSingle() { return Promise.resolve({ data: run()[0] ?? null, error: null }); },
        single() {
          const rows = run();
          return Promise.resolve(rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'no rows' } });
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

const ALICE = 'https://mastodon.test/users/alice';
const MALLORY = 'https://mastodon.test/users/mallory';
const POLL_ID = 'https://mastodon.test/users/alice/statuses/1';

const question = (over: Record<string, unknown> = {}) => ({
  type: 'Question',
  id: POLL_ID,
  attributedTo: ALICE,
  content: '<p>Tea or coffee?</p>',
  published: '2026-10-10T10:00:00Z',
  endTime: '2099-10-11T10:00:00Z',
  votersCount: 9,
  oneOf: [
    { type: 'Note', name: 'Tea', replies: { type: 'Collection', totalItems: 5 } },
    { type: 'Note', name: 'Coffee', replies: { type: 'Collection', totalItems: 4 } },
  ],
  ...over,
});

const post = () => tables.posts.find((p) => p.ap_id === POLL_ID)!;

beforeEach(() => {
  tables = {
    profiles: [
      { id: 'alice-id', federated_id: ALICE },
      { id: 'mallory-id', federated_id: MALLORY },
    ],
    posts: [{
      id: 'post-1',
      ap_id: POLL_ID,
      ap_type: 'Question',
      author_id: 'alice-id',
      profiles: { federated_id: ALICE },
      content: [{ type: 'text', text: 'Tea or coffee?' }],
      updated_at: '2026-10-10T10:00:00Z',
      metadata: {
        is_poll: true,
        poll_options: [{ name: 'Tea', votes: 1 }, { name: 'Coffee', votes: 0 }],
        poll_multiple_choice: false,
        poll_end_time: '2099-10-11T10:00:00Z',
        poll_voters_count: 1,
        poll_closed: false,
        custom_emojis: [{ name: 'blobcat', url: 'https://mastodon.test/emoji/blobcat.png' }],
      },
    }],
  };
});

describe('Update(Question)', () => {
  const update = (actor: string, object: Record<string, unknown>) =>
    (ActivityProcessor as any).processUpdate({ type: 'Update', actor, object });

  it('refreshes the counts and keeps the other metadata keys', async () => {
    await update(ALICE, question());
    expect(post().metadata).toMatchObject({
      poll_options: [{ name: 'Tea', votes: 5 }, { name: 'Coffee', votes: 4 }],
      poll_voters_count: 9,
      poll_closed: false,
      custom_emojis: [{ name: 'blobcat', url: 'https://mastodon.test/emoji/blobcat.png' }],
    });
  });

  it('marks the poll closed', async () => {
    await update(ALICE, question({ closed: '2026-10-10T12:00:00Z' }));
    expect(post().metadata.poll_closed).toBe(true);
  });

  it('leaves the content and edit time alone unless the Update is an edit', async () => {
    await update(ALICE, question({ content: '<p>Changed?</p>' }));
    expect(post().content).toEqual([{ type: 'text', text: 'Tea or coffee?' }]);
    expect(post().updated_at).toBe('2026-10-10T10:00:00Z');

    await update(ALICE, question({ content: '<p>Changed?</p>', updated: '2026-10-10T11:00:00Z' }));
    expect(JSON.stringify(post().content)).toContain('Changed?');
    expect(post().updated_at).not.toBe('2026-10-10T10:00:00Z');
  });

  it('refuses an actor who does not own the poll', async () => {
    await update(MALLORY, question({ votersCount: 1000 }));
    expect(post().metadata.poll_voters_count).toBe(1);
  });
});

describe('repeated Create(Question)', () => {
  beforeEach(() => {
    vi.spyOn(ActivityProcessor as any, 'ensureRemoteUser').mockResolvedValue({ id: 'alice-id' });
  });

  it('merges the poll keys into the existing metadata', async () => {
    await (ActivityProcessor as any).processCreatePoll({ type: 'Create', actor: ALICE }, question());
    expect(tables.posts).toHaveLength(1);
    expect(post().metadata).toMatchObject({
      poll_voters_count: 9,
      custom_emojis: [{ name: 'blobcat', url: 'https://mastodon.test/emoji/blobcat.png' }],
    });
  });

  it('stores a new poll with its poll keys', async () => {
    tables.posts = [];
    await (ActivityProcessor as any).processCreatePoll({ type: 'Create', actor: ALICE }, question());
    expect(post()).toMatchObject({
      ap_type: 'Question',
      author_id: 'alice-id',
      metadata: { is_poll: true, poll_voters_count: 9, poll_multiple_choice: false },
    });
  });
});
