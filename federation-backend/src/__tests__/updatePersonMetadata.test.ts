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

// Update(Person) stores federation_metadata as an object: SQL readers (public profile and post
// pages) take its keys with ->, which a JSON-encoded string has none of.

const ALICE = 'https://mastodon.test/users/alice';
const BLOBCAT = 'https://mastodon.test/emoji/blobcat.png';

const person = () => ({
  type: 'Person',
  id: ALICE,
  preferredUsername: 'alice',
  name: 'Alice :blobcat:',
  summary: '<p>hi :blobcat:</p>',
  inbox: `${ALICE}/inbox`,
  tag: [{ type: 'Emoji', name: ':blobcat:', icon: { type: 'Image', url: BLOBCAT } }],
});

beforeEach(() => {
  tables = {
    profiles: [{ id: 'alice-id', federated_id: ALICE, federation_metadata: JSON.stringify({ url: 'https://mastodon.test/@alice' }) }],
  };
});

describe('Update(Person)', () => {
  it('stores federation_metadata as an object, keeping the keys it held as a string', async () => {
    await (ActivityProcessor as any).processUpdate({ type: 'Update', actor: ALICE, object: person() });
    const meta = tables.profiles[0].federation_metadata;
    expect(typeof meta).toBe('object');
    expect(meta.url).toBe('https://mastodon.test/@alice');
    expect(meta.bio_emojis).toEqual([expect.objectContaining({ url: BLOBCAT })]);
    expect(meta.display_name_emojis).toEqual([expect.objectContaining({ url: BLOBCAT })]);
  });
});
