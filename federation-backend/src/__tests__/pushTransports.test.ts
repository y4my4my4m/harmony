import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync, createVerify } from 'crypto';
import express from 'express';
import supertest from 'supertest';

type Op = { table: string; action: string; filters: Array<[string, string, unknown]>; payload?: unknown; options?: unknown };

const { calls, state, rpc, webPushSend } = vi.hoisted(() => ({
  calls: [] as Op[],
  state: {
    respond: (_op: Op): { data: unknown; error: unknown } => ({ data: null, error: null }),
    subscriptions: [] as unknown[],
  },
  rpc: vi.fn(async (_name: string, _args?: unknown) => ({ data: null as unknown, error: null })),
  webPushSend: vi.fn(async (_sub: unknown, _body: string, _opts: unknown) => ({})),
}));

function builder(table: string) {
  const op: Op = { table, action: 'select', filters: [] };
  const settle = () => {
    calls.push(op);
    return Promise.resolve(state.respond(op));
  };
  const b: any = {
    select() { return b; },
    delete() { op.action = 'delete'; return b; },
    upsert(payload: unknown, options?: unknown) { op.action = 'upsert'; op.payload = payload; op.options = options; return b; },
    eq(col: string, val: unknown) { op.filters.push(['eq', col, val]); return b; },
    neq(col: string, val: unknown) { op.filters.push(['neq', col, val]); return b; },
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

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
    SUPABASE_URL: 'http://localhost:54321',
    VAPID_PUBLIC_KEY: 'pub',
    VAPID_PRIVATE_KEY: 'priv',
    VAPID_SUBJECT: 'admin@harmony.test',
  },
}));

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({ from: (table: string) => builder(table), rpc }),
}));

vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('web-push', () => ({
  default: { setVapidDetails: vi.fn(), sendNotification: webPushSend },
}));

vi.mock('../middleware/auth.js', () => ({
  localProfileIdFromBearer: async (header?: string) => (header === 'Bearer good' ? 'u1' : null),
}));

import {
  FcmSender,
  buildAssertion,
  classifyFcmError,
  parseServiceAccount,
  type ServiceAccount,
} from '../services/FcmSender.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import {
  APP_PAYLOAD_MAX_BYTES,
  appPushData,
  conversationTitle,
  dismissalMessages,
  isValidFcmToken,
} from '../services/pushPolicy.js';
import pushRouter from '../routes/push.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT: ServiceAccount = {
  project_id: 'harmony-test',
  client_email: 'fcm@harmony-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'kid-1',
  token_uri: 'https://oauth2.googleapis.com/token',
};

const TOKEN = 'fcm-token-' + 'a'.repeat(140);

interface Call { url: string; init: RequestInit }

function fakeFetch(responses: Array<(call: Call) => Response>) {
  const log: Call[] = [];
  const fn = vi.fn(async (url: string, init: RequestInit) => {
    const call = { url, init };
    log.push(call);
    const next = responses.shift();
    if (!next) throw new Error(`unexpected fetch ${url}`);
    return next(call);
  });
  return { fn, log };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), {
  status,
  headers: { 'Content-Type': 'application/json' },
});
const tokenOk = (token = 'at-1', expires = 3600) => () => json(200, { access_token: token, expires_in: expires, token_type: 'Bearer' });
const sendOk = () => () => json(200, { name: 'projects/harmony-test/messages/1' });

beforeEach(() => {
  calls.length = 0;
  state.respond = () => ({ data: null, error: null });
  state.subscriptions = [];
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => (
    name === 'get_user_push_subscriptions' ? { data: state.subscriptions, error: null } : { data: null, error: null }
  ));
  webPushSend.mockReset();
  webPushSend.mockImplementation(async () => ({}));
  PushNotificationService.initialize();
});

afterEach(() => {
  PushNotificationService.setFcmSender(null);
});

describe('service account', () => {
  it('reads raw JSON and base64 JSON', () => {
    const raw = JSON.stringify({ ...ACCOUNT, type: 'service_account' });
    expect(parseServiceAccount(raw)?.project_id).toBe('harmony-test');
    expect(parseServiceAccount(Buffer.from(raw).toString('base64'))?.client_email).toBe(ACCOUNT.client_email);
  });

  it('rejects anything that is not a service account', () => {
    expect(parseServiceAccount(undefined)).toBeNull();
    expect(parseServiceAccount('')).toBeNull();
    expect(parseServiceAccount('{"project_id":"x"}')).toBeNull();
    expect(parseServiceAccount('not json')).toBeNull();
  });

  it('signs an RS256 assertion for the messaging scope', () => {
    const jwt = buildAssertion(ACCOUNT, 1_700_000_000);
    const [h, c, sig] = jwt.split('.');
    const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    expect(decode(h)).toEqual({ alg: 'RS256', typ: 'JWT', kid: 'kid-1' });
    expect(decode(c)).toEqual({
      iss: ACCOUNT.client_email,
      scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token',
      iat: 1_700_000_000,
      exp: 1_700_003_600,
    });
    const valid = createVerify('RSA-SHA256').update(`${h}.${c}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    expect(valid).toBe(true);
  });
});

describe('FCM sender', () => {
  it('is off without a service account and sends nothing', async () => {
    const { fn } = fakeFetch([]);
    const sender = new FcmSender({ account: null, fetchImpl: fn });
    expect(sender.isConfigured()).toBe(false);
    expect(await sender.send(TOKEN, { kind: 'read', all: '1' }, { priority: 'normal', ttlSeconds: 60 }))
      .toMatchObject({ ok: false, prune: false });
    expect(fn).not.toHaveBeenCalled();
  });

  it('exchanges the assertion once and reuses the access token', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk(), sendOk()]);
    const sender = new FcmSender({ account: ACCOUNT, fetchImpl: fn });
    await sender.send(TOKEN, { a: '1' }, { priority: 'high', ttlSeconds: 86400 });
    await sender.send(TOKEN, { b: '2' }, { priority: 'normal', ttlSeconds: 60, collapseKey: 'k' });

    expect(log.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://fcm.googleapis.com/v1/projects/harmony-test/messages:send',
      'https://fcm.googleapis.com/v1/projects/harmony-test/messages:send',
    ]);
    const form = new URLSearchParams(String(log[0].init.body));
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');
    expect(form.get('assertion')?.split('.')).toHaveLength(3);

    expect((log[1].init.headers as Record<string, string>).Authorization).toBe('Bearer at-1');
    expect(JSON.parse(String(log[1].init.body))).toEqual({
      message: { token: TOKEN, data: { a: '1' }, android: { priority: 'HIGH', ttl: '86400s' } },
    });
    expect(JSON.parse(String(log[2].init.body)).message.android).toEqual({ priority: 'NORMAL', ttl: '60s', collapse_key: 'k' });
  });

  it('refreshes the access token a minute before it expires', async () => {
    let now = 1_000_000;
    const { fn, log } = fakeFetch([tokenOk('at-1', 3600), sendOk(), tokenOk('at-2', 3600), sendOk()]);
    const sender = new FcmSender({ account: ACCOUNT, fetchImpl: fn, now: () => now });
    await sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 });
    now += 3_541_000;
    await sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 });
    expect((log[3].init.headers as Record<string, string>).Authorization).toBe('Bearer at-2');
  });

  it('shares one token exchange between concurrent sends', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk(), sendOk()]);
    const sender = new FcmSender({ account: ACCOUNT, fetchImpl: fn });
    await Promise.all([
      sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 }),
      sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 }),
    ]);
    expect(log.filter((c) => c.url.includes('oauth2')).length).toBe(1);
  });

  it('retries once with a fresh access token after a 401', async () => {
    const { fn, log } = fakeFetch([tokenOk('at-1'), () => json(401, { error: { status: 'UNAUTHENTICATED' } }), tokenOk('at-2'), sendOk()]);
    const sender = new FcmSender({ account: ACCOUNT, fetchImpl: fn });
    expect(await sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 })).toEqual({ ok: true });
    expect((log[3].init.headers as Record<string, string>).Authorization).toBe('Bearer at-2');
  });

  const fcmError = (errorCode: string, extra: object[] = []) => ({
    error: {
      code: 400,
      status: errorCode === 'UNREGISTERED' ? 'NOT_FOUND' : errorCode,
      message: 'm',
      details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode }, ...extra],
    },
  });

  it('prunes tokens FCM no longer knows', async () => {
    const { fn } = fakeFetch([tokenOk(), () => json(404, fcmError('UNREGISTERED'))]);
    const sender = new FcmSender({ account: ACCOUNT, fetchImpl: fn });
    expect(await sender.send(TOKEN, {}, { priority: 'high', ttlSeconds: 1 })).toMatchObject({ ok: false, prune: true, status: 404 });
  });

  it('prunes an invalid token but not an invalid payload', () => {
    expect(classifyFcmError(400, fcmError('INVALID_ARGUMENT')).prune).toBe(true);
    expect(classifyFcmError(400, fcmError('INVALID_ARGUMENT', [{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'message.token' }],
    }])).prune).toBe(true);
    expect(classifyFcmError(400, fcmError('INVALID_ARGUMENT', [{
      '@type': 'type.googleapis.com/google.rpc.BadRequest',
      fieldViolations: [{ field: 'message.data[0].value' }],
    }])).prune).toBe(false);
    expect(classifyFcmError(403, fcmError('SENDER_ID_MISMATCH')).prune).toBe(true);
    expect(classifyFcmError(503, fcmError('UNAVAILABLE')).prune).toBe(false);
    expect(classifyFcmError(429, null)).toEqual({ prune: false, reason: 'HTTP_429' });
  });
});

describe('app payload', () => {
  it('carries what the Android app renders and routes by', () => {
    const data = appPushData({
      notificationId: 'n1',
      type: 'mention',
      data: { location: { server_id: 's1', server_name: 'Guild', channel_id: 'c1', channel_name: 'general' }, message_id: 'm1' },
      title: 'Alice mentioned you',
      body: 'hello',
      sender: 'Alice',
      avatarUrl: 'https://cdn.test/a.webp',
      iconUrl: 'https://cdn.test/s.webp',
    });
    expect(data).toEqual({
      kind: 'notification',
      id: 'n1',
      type: 'mention',
      title: 'Alice mentioned you',
      body: 'hello',
      url: '/chat/s1/c1?messageId=m1',
      server_id: 's1',
      channel_id: 'c1',
      message_id: 'm1',
      sender: 'Alice',
      conv: 'Guild #general',
      avatar: 'https://cdn.test/a.webp',
      icon: 'https://cdn.test/s.webp',
    });
    expect(Object.values(data).every((v) => typeof v === 'string')).toBe(true);
  });

  it('titles group DMs by name and one-to-one DMs not at all', () => {
    expect(conversationTitle({ conversation: { id: 'c', name: 'Crew' } })).toBe('Crew');
    expect(conversationTitle({ conversation: { id: 'c' } })).toBe('');
  });

  it('stays within the FCM and ntfy budget', () => {
    const wide = '😀'.repeat(500);
    const data = appPushData({
      notificationId: 'n1',
      type: 'dm',
      data: { conversation: { id: 'c1', name: wide }, message: { id: 'm1' } },
      title: wide,
      body: wide,
      sender: wide,
      avatarUrl: `https://cdn.test/${'a'.repeat(490)}`,
      iconUrl: `https://cdn.test/${'b'.repeat(490)}`,
    });
    expect(Buffer.byteLength(JSON.stringify(data))).toBeLessThanOrEqual(APP_PAYLOAD_MAX_BYTES);
    expect(data.url).toBe('/dm/c1?messageId=m1');
    expect(data.id).toBe('n1');
  });

  it('splits dismissals into messages that fit', () => {
    const ids = Array.from({ length: 170 }, (_, i) => `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`);
    const messages = dismissalMessages([...ids, ids[0]]);
    expect(messages.map((m) => m.ids.split(',').length)).toEqual([80, 80, 10]);
    expect(messages.every((m) => m.kind === 'read' && Buffer.byteLength(JSON.stringify(m)) < 3100)).toBe(true);
    expect(dismissalMessages(null)).toEqual([{ kind: 'read', all: '1' }]);
    expect(dismissalMessages([])).toEqual([]);
  });

  it('accepts FCM token shapes only', () => {
    expect(isValidFcmToken(TOKEN)).toBe(true);
    expect(isValidFcmToken('dGVzdA:APA91bH-_x.yZ012345')).toBe(true);
    expect(isValidFcmToken('short')).toBe(false);
    expect(isValidFcmToken('has space ' + 'a'.repeat(30))).toBe(false);
    expect(isValidFcmToken(42)).toBe(false);
  });
});

describe('FCM token registry', () => {
  it('moves the token to the caller and replaces the refreshed one', async () => {
    state.respond = (op) => op.action === 'upsert' ? { data: { id: 'row-1' }, error: null } : { data: null, error: null };
    const result = await PushNotificationService.saveFcmToken('u1', TOKEN, { previousToken: 'old-' + TOKEN, deviceName: 'Pixel' });
    expect(result).toEqual({ success: true, id: 'row-1' });

    const deletes = calls.filter((c) => c.action === 'delete');
    expect(deletes[0].filters).toEqual([['eq', 'transport', 'fcm'], ['eq', 'endpoint', TOKEN], ['neq', 'user_id', 'u1']]);
    expect(deletes[1].filters).toEqual([['eq', 'user_id', 'u1'], ['eq', 'transport', 'fcm'], ['eq', 'endpoint', 'old-' + TOKEN]]);
    const upsert = calls.find((c) => c.action === 'upsert');
    expect(upsert?.payload).toMatchObject({ user_id: 'u1', endpoint: TOKEN, transport: 'fcm', p256dh: null, auth: null, device_name: 'Pixel', failure_count: 0 });
    expect(upsert?.options).toEqual({ onConflict: 'user_id,endpoint' });
  });

  it('claims again when another account won the race', async () => {
    let upserts = 0;
    state.respond = (op) => {
      if (op.action !== 'upsert') return { data: null, error: null };
      upserts++;
      return upserts === 1 ? { data: null, error: { code: '23505', message: 'dup' } } : { data: { id: 'row-2' }, error: null };
    };
    expect(await PushNotificationService.saveFcmToken('u1', TOKEN)).toEqual({ success: true, id: 'row-2' });
    expect(calls.filter((c) => c.action === 'delete' && c.filters.some(([op]) => op === 'neq'))).toHaveLength(2);
  });

  it('refuses malformed tokens without touching the table', async () => {
    expect(await PushNotificationService.saveFcmToken('u1', 'nope')).toEqual({ success: false, error: 'Invalid token' });
    expect(calls).toHaveLength(0);
  });

  it('unregisters only the caller\'s row', async () => {
    await PushNotificationService.removeFcmToken('u1', TOKEN);
    expect(calls[0]).toMatchObject({ action: 'delete', filters: [['eq', 'user_id', 'u1'], ['eq', 'transport', 'fcm'], ['eq', 'endpoint', TOKEN]] });
  });

  it('stores UnifiedPush endpoints as Web Push rows marked unifiedpush', async () => {
    const sub = { endpoint: 'https://ntfy.test/upABC?up=1', keys: { p256dh: 'p', auth: 'a' } };
    await PushNotificationService.saveSubscription('u1', sub as any, 'UA', 'Pixel', undefined, 'unifiedpush');
    expect(calls.find((c) => c.action === 'upsert')?.payload).toMatchObject({ endpoint: sub.endpoint, transport: 'unifiedpush' });
  });
});

describe('delivery by transport', () => {
  const browser = { subscription_id: 'w1', endpoint: 'https://push.test/w', p256dh: 'p', auth: 'a', push_enabled: true, push_offline_only: false, transport: 'webpush' };
  const up = { subscription_id: 'u1', endpoint: 'https://ntfy.test/up1', p256dh: 'p2', auth: 'a2', push_enabled: true, push_offline_only: false, transport: 'unifiedpush' };
  const fcm = { subscription_id: 'f1', endpoint: TOKEN, p256dh: null, auth: null, push_enabled: true, push_offline_only: false, transport: 'fcm' };
  const payload = { title: 'T', body: 'B', type: 'dm', data: { notification_id: 'n9', type: 'dm', url: '/dm/c', conversation_id: 'c' } };
  const app = { kind: 'notification', id: 'n9', type: 'dm', title: 'T', body: 'B', url: '/dm/c' };

  it('sends the worker payload to browsers, the app payload to UnifiedPush and FCM', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk()]);
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fn }));
    state.subscriptions = [browser, up, fcm];

    const result = await PushNotificationService.sendToUser('u1', payload, undefined, () => app);
    expect(result).toEqual({ sent: 3, failed: 0 });

    const bodies = new Map(webPushSend.mock.calls.map(([sub, body, opts]) => [(sub as any).endpoint, { body: JSON.parse(body), opts }]));
    expect(bodies.get(browser.endpoint)?.body).toEqual(payload);
    expect(bodies.get(up.endpoint)?.body).toEqual(app);
    expect(bodies.get(up.endpoint)?.opts).toMatchObject({ urgency: 'high', TTL: 86400 });
    expect(JSON.parse(String(log[1].init.body)).message).toMatchObject({ token: TOKEN, data: app, android: { priority: 'HIGH' } });
    expect(rpc).toHaveBeenCalledWith('record_push_success', { p_subscription_id: 'f1' });
  });

  it('skips FCM targets when FCM is not configured', async () => {
    PushNotificationService.setFcmSender(new FcmSender({ account: null }));
    state.subscriptions = [browser, fcm];
    expect(await PushNotificationService.sendToUser('u1', payload, undefined, () => app)).toEqual({ sent: 1, failed: 0 });
  });

  it('builds the app payload only when an app target is eligible', async () => {
    const build = vi.fn(() => app);
    state.subscriptions = [browser];
    await PushNotificationService.sendToUser('u1', payload, undefined, build);
    expect(build).not.toHaveBeenCalled();
  });

  it('deletes an FCM row whose token FCM rejects', async () => {
    const { fn } = fakeFetch([tokenOk(), () => json(404, { error: { status: 'NOT_FOUND', details: [{ '@type': 'type.googleapis.com/google.firebase.fcm.v1.FcmError', errorCode: 'UNREGISTERED' }] } })]);
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fn }));
    state.subscriptions = [fcm];
    expect(await PushNotificationService.sendToUser('u1', payload, undefined, () => app)).toEqual({ sent: 0, failed: 1 });
    expect(calls).toContainEqual(expect.objectContaining({ table: 'push_subscriptions', action: 'delete', filters: [['eq', 'id', 'f1']] }));
  });

  it('dismisses on app transports only, at normal priority', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk(), sendOk()]);
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fn }));
    state.subscriptions = [browser, up, fcm];
    const ids = Array.from({ length: 81 }, (_, i) => `id-${i}`);

    const result = await PushNotificationService.sendDismissal('u1', ids);
    expect(result).toEqual({ sent: 4, failed: 0 });
    expect(webPushSend.mock.calls.map(([sub]) => (sub as any).endpoint)).toEqual([up.endpoint, up.endpoint]);
    expect(webPushSend.mock.calls[0][2]).toMatchObject({ urgency: 'normal' });
    expect(JSON.parse(webPushSend.mock.calls[0][1] as string)).toEqual({ kind: 'read', ids: ids.slice(0, 80).join(',') });
    const fcmBodies = log.slice(1).map((c) => JSON.parse(String(c.init.body)).message);
    expect(fcmBodies.map((m) => m.android.priority)).toEqual(['NORMAL', 'NORMAL']);
    expect(fcmBodies[1].data).toEqual({ kind: 'read', ids: 'id-80' });
    expect(rpc).not.toHaveBeenCalledWith('record_push_success', expect.anything());
  });

  it('collapses "read all" dismissals', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk()]);
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fn }));
    state.subscriptions = [fcm];
    await PushNotificationService.sendDismissal('u1', null);
    expect(JSON.parse(String(log[1].init.body)).message).toMatchObject({
      data: { kind: 'read', all: '1' },
      android: { priority: 'NORMAL', collapse_key: 'harmony-read-all' },
    });
  });

  it('pushes a notification to FCM when only FCM is configured', async () => {
    const { fn, log } = fakeFetch([tokenOk(), sendOk()]);
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fn }));
    (PushNotificationService as any).isInitialized = false;
    try {
      state.subscriptions = [browser, fcm];
      state.respond = (op) => {
        if (op.table === 'notification_preferences') return { data: { push_offline_only: false }, error: null };
        if (op.table === 'profiles') return { data: { status: 1 }, error: null };
        if (op.table === 'servers') return { data: { icon: null }, error: null };
        return { data: null, error: null };
      };
      await PushNotificationService.sendForNotification({
        id: 'n1', user_id: 'u1', type: 'dm',
        data: { sender: { username: 'alice', display_name: 'Alice :wave:' }, conversation: { id: 'c1' }, message: { id: 'm1' }, preview: 'hey' },
      });
      expect(webPushSend).not.toHaveBeenCalled();
      const sent = JSON.parse(String(log[1].init.body)).message.data;
      expect(sent).toMatchObject({ kind: 'notification', id: 'n1', type: 'dm', sender: 'Alice', body: 'hey', url: '/dm/c1?messageId=m1', conversation_id: 'c1' });
    } finally {
      (PushNotificationService as any).isInitialized = true;
    }
  });
});

describe('push routes', () => {
  const app = express();
  app.use(express.json());
  app.use('/push', pushRouter);

  it('reports each transport', async () => {
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT }));
    const res = await supertest(app).get('/push/status');
    expect(res.body).toEqual({ available: true, configured: true, fcm: true, unifiedpush: true });
  });

  it('registers an FCM token for the bearer', async () => {
    PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT }));
    state.respond = (op) => op.action === 'upsert' ? { data: { id: 'row-7' }, error: null } : { data: null, error: null };
    expect((await supertest(app).post('/push/fcm/register').send({ token: TOKEN })).status).toBe(401);
    expect((await supertest(app).post('/push/fcm/register').set('Authorization', 'Bearer good').send({ token: 'x' })).status).toBe(400);
    const ok = await supertest(app).post('/push/fcm/register').set('Authorization', 'Bearer good').send({ token: TOKEN, deviceName: 'Pixel' });
    expect(ok.status).toBe(200);
    expect(ok.body).toEqual({ success: true, id: 'row-7' });
  });

  it('declines FCM registration when the server has no service account', async () => {
    PushNotificationService.setFcmSender(new FcmSender({ account: null }));
    const res = await supertest(app).post('/push/fcm/register').set('Authorization', 'Bearer good').send({ token: TOKEN });
    expect(res.status).toBe(503);
  });

  it('unregisters an FCM token', async () => {
    const res = await supertest(app).post('/push/fcm/unregister').set('Authorization', 'Bearer good').send({ token: TOKEN });
    expect(res.status).toBe(200);
    expect(calls[0]).toMatchObject({ action: 'delete', filters: [['eq', 'user_id', 'u1'], ['eq', 'transport', 'fcm'], ['eq', 'endpoint', TOKEN]] });
  });

  it('lists devices without exposing FCM tokens', async () => {
    state.respond = (op) => op.table === 'push_subscriptions'
      ? { data: [
          { id: 'a', endpoint: 'https://push.test/w', transport: 'webpush' },
          { id: 'b', endpoint: TOKEN, transport: 'fcm' },
          { id: 'c', endpoint: 'https://ntfy.test/up', transport: 'unifiedpush' },
        ], error: null }
      : { data: null, error: null };
    const res = await supertest(app).get('/push/subscriptions').set('Authorization', 'Bearer good');
    expect(res.body.subscriptions.map((s: any) => [s.endpoint, s.transport])).toEqual([
      ['https://push.test/w', 'webpush'],
      ['fcm:b', 'fcm'],
      ['https://ntfy.test/up', 'unifiedpush'],
    ]);
  });

  it('passes the UnifiedPush transport through subscribe', async () => {
    const res = await supertest(app).post('/push/subscribe').set('Authorization', 'Bearer good').send({
      subscription: { endpoint: 'https://ntfy.test/upXYZ', keys: { p256dh: 'p', auth: 'a' } },
      transport: 'unifiedpush',
    });
    expect(res.status).toBe(200);
    expect(calls.find((c) => c.action === 'upsert')?.payload).toMatchObject({ transport: 'unifiedpush' });
  });
});

describe('push endpoint address check', () => {
  it('refuses loopback, private and link-local endpoints', async () => {
    const { assertPushEndpointAllowed } = await import('../services/PushNotificationService.js');
    for (const endpoint of [
      'https://127.0.0.1/push',
      'https://10.1.2.3/push',
      'https://192.168.1.5:8443/up',
      'https://169.254.169.254/latest',
      'https://[::1]/push',
      'https://localhost/push',
    ]) {
      await expect(assertPushEndpointAllowed(endpoint), endpoint).rejects.toThrow();
    }
  });

  it('refuses a public name that resolves to a private address', async () => {
    const dns = (await import('dns')).default;
    const v4 = vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['10.0.0.7']);
    const v6 = vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const { assertPushEndpointAllowed } = await import('../services/PushNotificationService.js');
    await expect(assertPushEndpointAllowed('https://rebind.example/up/abc')).rejects.toThrow(/private/);
    v4.mockRestore();
    v6.mockRestore();
  });

  it('accepts a public push service', async () => {
    const dns = (await import('dns')).default;
    const v4 = vi.spyOn(dns.promises, 'resolve4').mockResolvedValue(['142.250.72.10']);
    const v6 = vi.spyOn(dns.promises, 'resolve6').mockRejectedValue(new Error('ENODATA'));
    const { assertPushEndpointAllowed } = await import('../services/PushNotificationService.js');
    await expect(assertPushEndpointAllowed('https://fcm.googleapis.com/fcm/send/abc')).resolves.toBeUndefined();
    v4.mockRestore();
    v6.mockRestore();
  });
});
