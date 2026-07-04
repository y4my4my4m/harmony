import { describe, it, expect, vi, beforeEach } from 'vitest';

// verifyActorMatch is pure URL-equality (with optional same-domain delegation);
// stub it with a faithful minimal implementation so the helpers exercise real
// comparison logic without pulling in crypto/config.
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: {
    verifyActorMatch: (a: string, b: string, allowSameDomain = false) => {
      const norm = (u: string) => u.replace(/\/$/, '');
      if (norm(a) === norm(b)) return true;
      if (allowSameDomain) {
        try {
          return new URL(a).host === new URL(b).host;
        } catch {
          return false;
        }
      }
      return false;
    },
  },
}));

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test' },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}));

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  actorIsAcceptedMember,
  actorIsServerModerator,
  actorOwnsMessage,
} from '../activitypub/ServerInboxHandler.js';

/**
 * Minimal table-keyed fake Supabase supporting the chained calls the helpers
 * use: .from(t).select(...).eq(...).eq(...).maybeSingle() and a terminal
 * .select().eq().eq() array result for user_roles.
 */
function makeSupabase(tables: Record<string, any>) {
  return {
    from(table: string) {
      const result = tables[table];
      const builder: any = {
        _rows: Array.isArray(result) ? result : result != null ? [result] : [],
        select() { return builder; },
        eq() { return builder; },
        maybeSingle() {
          return Promise.resolve({ data: builder._rows[0] ?? null, error: null });
        },
        then(resolve: any) {
          // terminal array await (user_roles query has no maybeSingle)
          return resolve({ data: builder._rows, error: null });
        },
      };
      return builder;
    },
  };
}

const ALICE = 'https://remote.test/users/alice';
const BOB = 'https://remote.test/users/bob';
const SERVER_ID = '00000000-0000-0000-0000-0000000000aa';

describe('actorIsAcceptedMember', () => {
  it('accepts a member with status accepted', async () => {
    const sb = makeSupabase({
      profiles: { id: 'alice-id' },
      user_servers: { status: 'accepted' },
    });
    const r = await actorIsAcceptedMember(sb, SERVER_ID, ALICE);
    expect(r.ok).toBe(true);
    expect(r.userId).toBe('alice-id');
  });

  it('rejects a non-member (unknown actor)', async () => {
    const sb = makeSupabase({ profiles: null, user_servers: null });
    const r = await actorIsAcceptedMember(sb, SERVER_ID, ALICE);
    expect(r.ok).toBe(false);
    expect(r.userId).toBeNull();
  });

  it('rejects a pending member', async () => {
    const sb = makeSupabase({
      profiles: { id: 'alice-id' },
      user_servers: { status: 'pending' },
    });
    const r = await actorIsAcceptedMember(sb, SERVER_ID, ALICE);
    expect(r.ok).toBe(false);
  });
});

describe('actorIsServerModerator', () => {
  const MANAGE_CHANNELS = 2n;

  it('grants host authority when actor matches server ap_id', async () => {
    const sb = makeSupabase({});
    const server = { ap_id: 'https://remote.test/servers/x', owner: null };
    const ok = await actorIsServerModerator(sb, SERVER_ID, server, 'https://remote.test/servers/x', MANAGE_CHANNELS);
    expect(ok).toBe(true);
  });

  it('grants the server owner', async () => {
    const sb = makeSupabase({ profiles: { id: 'owner-id' }, user_roles: [] });
    const server = { ap_id: null, owner: 'owner-id' };
    const ok = await actorIsServerModerator(sb, SERVER_ID, server, ALICE, MANAGE_CHANNELS);
    expect(ok).toBe(true);
  });

  it('grants a member holding the required permission bit', async () => {
    const sb = makeSupabase({
      profiles: { id: 'alice-id' },
      user_roles: [{ server_roles: { is_admin: false, permissions: (1n << 2n).toString() } }],
    });
    const server = { ap_id: null, owner: 'someone-else' };
    const ok = await actorIsServerModerator(sb, SERVER_ID, server, ALICE, MANAGE_CHANNELS);
    expect(ok).toBe(true);
  });

  it('grants a member with is_admin role', async () => {
    const sb = makeSupabase({
      profiles: { id: 'alice-id' },
      user_roles: [{ server_roles: { is_admin: true, permissions: '0' } }],
    });
    const server = { ap_id: null, owner: null };
    const ok = await actorIsServerModerator(sb, SERVER_ID, server, ALICE, MANAGE_CHANNELS);
    expect(ok).toBe(true);
  });

  it('rejects a plain member with no relevant permission', async () => {
    const sb = makeSupabase({
      profiles: { id: 'bob-id' },
      user_roles: [{ server_roles: { is_admin: false, permissions: '0' } }],
    });
    const server = { ap_id: 'https://remote.test/servers/x', owner: 'owner-id' };
    const ok = await actorIsServerModerator(sb, SERVER_ID, server, BOB, MANAGE_CHANNELS);
    expect(ok).toBe(false);
  });
});

describe('actorOwnsMessage', () => {
  it('confirms author owns their own message', async () => {
    const sb = makeSupabase({ messages: { profiles: { federated_id: ALICE } } });
    expect(await actorOwnsMessage(sb, 'msg-1', ALICE)).toBe(true);
  });

  it('rejects a different actor', async () => {
    const sb = makeSupabase({ messages: { profiles: { federated_id: ALICE } } });
    expect(await actorOwnsMessage(sb, 'msg-1', BOB)).toBe(false);
  });

  it('rejects when message/author is missing', async () => {
    const sb = makeSupabase({ messages: null });
    expect(await actorOwnsMessage(sb, 'msg-1', ALICE)).toBe(false);
  });
});
