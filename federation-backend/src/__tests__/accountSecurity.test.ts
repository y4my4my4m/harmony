import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'crypto';

type Op = { table: string; action: string; filters: Array<[string, string, unknown]>; payload?: unknown };

const { calls, state, storageCalls, enqueue, createClientMock } = vi.hoisted(() => ({
  calls: [] as Op[],
  state: {
    respond: (_op: Op): { data: unknown; error: unknown } => ({ data: null, error: null }),
    objects: {} as Record<string, Array<{ name: string; id: string | null }>>,
  },
  storageCalls: [] as Array<{ bucket: string; action: string; arg: unknown }>,
  enqueue: vi.fn(async (_activity: unknown, _inbox: string, _sender: string) => {}),
  createClientMock: vi.fn(),
}));

function builder(table: string) {
  const op: Op = { table, action: 'select', filters: [] };
  const settle = () => {
    calls.push(op);
    return Promise.resolve(state.respond(op));
  };
  const b: any = {
    select() { return b; },
    update(payload: unknown) { op.action = 'update'; op.payload = payload; return b; },
    eq(col: string, val: unknown) { op.filters.push(['eq', col, val]); return b; },
    is(col: string, val: unknown) { op.filters.push(['is', col, val]); return b; },
    ilike(col: string, val: unknown) { op.filters.push(['ilike', col, val]); return b; },
    order() { return b; },
    limit() { return b; },
    maybeSingle: settle,
    single: settle,
    then(resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) {
      return settle().then(resolve, reject);
    },
  };
  return b;
}

const storage = {
  from: (bucket: string) => ({
    list: async (folder: string) => {
      storageCalls.push({ bucket, action: 'list', arg: folder });
      return { data: state.objects[`${bucket}/${folder}`] ?? [], error: null };
    },
    remove: async (paths: string[]) => {
      storageCalls.push({ bucket, action: 'remove', arg: paths });
      return { data: null, error: null };
    },
  }),
};

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_ANON_KEY: 'anon',
    SUPABASE_SERVICE_ROLE_KEY: 'service',
  },
}));
vi.mock('@supabase/supabase-js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@supabase/supabase-js')>()),
  createClient: createClientMock,
}));
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../activitypub/DeliveryQueue.js', () => ({
  DeliveryQueue: { enqueue },
}));

const tokenWith = (claims: Record<string, unknown>) =>
  `h.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.s`;

import { bearerToken, decodeClaims, meetsAssurance, sessionIdFromToken } from '../utils/sessionAssurance.js';
import { describeUserAgent, notificationUrl, securityNoticeText } from '../services/pushPolicy.js';
import { actorTombstone, buildActorDelete } from '../activitypub/deletedActors.js';
import { SignatureService } from '../activitypub/SignatureService.js';
import { handleAccountDeletedJob } from '../queue/handlers/accountDeletedHandler.js';
import { getSupabaseClientWithAuth } from '../config/supabase.js';

beforeEach(() => {
  calls.length = 0;
  storageCalls.length = 0;
  state.respond = () => ({ data: null, error: null });
  state.objects = {};
  enqueue.mockClear();
  createClientMock.mockReset();
  createClientMock.mockImplementation(() => ({ from: (t: string) => builder(t), storage, auth: {} }));
});

describe('session assurance', () => {
  const verified = { factors: [{ status: 'verified' }] };

  it('serves accounts without a verified factor at any level', () => {
    expect(meetsAssurance({ factors: [] }, tokenWith({ aal: 'aal1' }))).toBe(true);
    expect(meetsAssurance({ factors: [{ status: 'unverified' }] }, tokenWith({ aal: 'aal1' }))).toBe(true);
    expect(meetsAssurance({}, 'not-a-jwt')).toBe(true);
  });

  it('requires aal2 once a factor is verified', () => {
    expect(meetsAssurance(verified, tokenWith({ aal: 'aal1' }))).toBe(false);
    expect(meetsAssurance(verified, tokenWith({}))).toBe(false);
    expect(meetsAssurance(verified, 'garbage')).toBe(false);
    expect(meetsAssurance(verified, tokenWith({ aal: 'aal2' }))).toBe(true);
  });

  it('reads the session id and bearer token', () => {
    const sid = '1fac1f8a-d0f5-46fb-9180-e6e7cd0935a2';
    expect(sessionIdFromToken(tokenWith({ session_id: sid }))).toBe(sid);
    expect(sessionIdFromToken(tokenWith({ session_id: 'x; drop' }))).toBeNull();
    expect(sessionIdFromToken(undefined)).toBeNull();
    expect(bearerToken('Bearer abc')).toBe('abc');
    expect(bearerToken('Basic abc')).toBeNull();
    expect(decodeClaims('a.b')).toBeNull();
  });

  it('answers no user from the per-request client below the account level', async () => {
    const user = { id: 'u1', factors: [{ status: 'verified' }] };
    createClientMock.mockImplementation(() => ({
      auth: { getUser: async () => ({ data: { user }, error: null }) },
    }));
    const low = await getSupabaseClientWithAuth(tokenWith({ aal: 'aal1' })).auth.getUser();
    expect(low.data.user).toBeNull();
    expect(low.error?.message).toBe('insufficient_aal');
    const high = await getSupabaseClientWithAuth(tokenWith({ aal: 'aal2' })).auth.getUser();
    expect(high.data.user).toBe(user);
  });
});

describe('security notices', () => {
  it('route to the security settings', () => {
    expect(notificationUrl('security', { event: 'new_sign_in' })).toBe('/settings/security');
  });

  it('name the device of a new sign-in', () => {
    const text = securityNoticeText({
      event: 'new_sign_in',
      user_agent: 'Mozilla/5.0 (X11; Linux x86_64; rv:131.0) Gecko/20100101 Firefox/131.0',
    });
    expect(text.title).toBe('New sign-in to your account');
    expect(text.body.startsWith('Firefox on Linux.')).toBe(true);
  });

  it('say why two-factor turned off', () => {
    expect(securityNoticeText({ event: 'mfa_disabled', reason: 'recovery_code' }).body).toMatch(/recovery code/);
    expect(securityNoticeText({ event: 'unknown' }).title).toBe('Account security');
  });

  it('describe common user agents', () => {
    expect(describeUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0'))
      .toBe('Edge on Windows');
    expect(describeUserAgent('Mozilla/5.0 (Linux; Android 14; Pixel 8; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/130.0 Mobile Safari/537.36'))
      .toBe('Harmony app on Android');
    expect(describeUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'))
      .toBe('Safari on iOS');
    expect(describeUserAgent(null)).toBeNull();
  });
});

describe('deleted actors', () => {
  const actor = 'https://harmony.test/users/bob';

  it('build the Delete Mastodon sends for a removed account', () => {
    expect(buildActorDelete(actor)).toEqual({
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${actor}#delete`,
      type: 'Delete',
      actor,
      to: ['https://www.w3.org/ns/activitystreams#Public'],
      object: actor,
    });
    expect(actorTombstone(actor, '2026-10-01T00:00:00Z')).toMatchObject({ id: actor, type: 'Tombstone', formerType: 'Person' });
  });

  it('sign with the retained key under the original keyId', async () => {
    const { privateKey, publicKey } = await SignatureService.generateKeyPair();
    state.respond = (op) => {
      if (op.table === 'profiles') return { data: { username: 'deleted_abc', domain: 'harmony.test', deleted_at: '2026-10-01' }, error: null };
      if (op.table === 'deleted_actors') return { data: { actor_uri: actor, private_key: privateKey }, error: null };
      return { data: null, error: null };
    };
    const { headers } = await SignatureService.signRequest('https://remote.test/inbox', 'POST', { a: 1 }, 'p1');
    const params = SignatureService.parseSignatureHeader(headers.Signature);
    expect(params.keyId).toBe(`${actor}#main-key`);
    const signingString = [
      '(request-target): post /inbox',
      `host: ${headers.Host}`,
      `date: ${headers.Date}`,
      `digest: ${headers.Digest}`,
    ].join('\n');
    const verify = crypto.createVerify('SHA256');
    verify.update(signingString);
    expect(verify.verify(publicKey, params.signature, 'base64')).toBe(true);
    expect(calls.some((c) => c.table === 'user_private_keys')).toBe(false);
  });

  it('refuse to sign once the key is purged, without generating one', async () => {
    state.respond = (op) => {
      if (op.table === 'profiles') return { data: { username: 'deleted_abc', domain: 'harmony.test', deleted_at: '2026-10-01' }, error: null };
      if (op.table === 'deleted_actors') return { data: { actor_uri: actor, private_key: null }, error: null };
      return { data: null, error: null };
    };
    await expect(SignatureService.signRequest('https://remote.test/inbox', 'POST', {}, 'p1')).rejects.toThrow('Actor deleted');
    expect(calls.some((c) => c.action === 'update' || c.table === 'user_private_keys')).toBe(false);
  });
});

describe('account-deleted job', () => {
  const tombstone = {
    profile_id: 'p1', username: 'bob', domain: 'harmony.test', actor_uri: 'https://harmony.test/users/bob',
    private_key: 'key', inboxes: ['https://a.test/inbox', 'https://b.test/inbox'],
    deleted_at: '2026-10-01', delivered_at: null as string | null,
  };

  it('sends the Delete to each captured inbox, marks it delivered and removes profile media', async () => {
    state.respond = (op) => op.table === 'deleted_actors' && op.action === 'select'
      ? { data: tombstone, error: null } : { data: null, error: null };
    state.objects['avatars/u1'] = [{ name: 'me.webp', id: 'o1' }, { name: 'sub', id: null }];
    state.objects['banners/p1'] = [{ name: 'p1_banner.png', id: 'o2' }];

    await handleAccountDeletedJob({ profile_id: 'p1', auth_user_id: 'u1' });

    expect(enqueue.mock.calls.map((c) => c[1])).toEqual(tombstone.inboxes);
    expect(enqueue.mock.calls[0][0]).toMatchObject({ type: 'Delete', object: tombstone.actor_uri });
    expect(enqueue.mock.calls[0][2]).toBe('p1');
    const update = calls.find((c) => c.action === 'update');
    expect(update?.table).toBe('deleted_actors');
    expect(update?.payload).toHaveProperty('delivered_at');
    expect(storageCalls.filter((c) => c.action === 'remove')).toEqual([
      { bucket: 'avatars', action: 'remove', arg: ['u1/me.webp'] },
      { bucket: 'banners', action: 'remove', arg: ['p1/p1_banner.png'] },
    ]);
  });

  it('does not send twice', async () => {
    state.respond = (op) => op.table === 'deleted_actors' && op.action === 'select'
      ? { data: { ...tombstone, delivered_at: '2026-10-01' }, error: null } : { data: null, error: null };
    await handleAccountDeletedJob({ profile_id: 'p1', auth_user_id: 'u1' });
    expect(enqueue).not.toHaveBeenCalled();
    expect(calls.some((c) => c.action === 'update')).toBe(false);
  });
});
