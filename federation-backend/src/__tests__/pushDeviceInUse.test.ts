// "Only when I'm away" (notification_preferences.push_offline_only, on by default) holds push
// from every device, on every transport, while one of the user's devices is in use. Off, every
// device gets every push: production's one account with push on and the switch off received
// each DM on all four of its targets (three Web Push, one FCM) in the same second.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateKeyPairSync } from 'crypto';
import express from 'express';
import supertest from 'supertest';

type Op = { table: string; action: string; filters: Array<[string, string, unknown]> };

const { state, rpc, webPushSend } = vi.hoisted(() => ({
  state: {
    prefs: null as Record<string, unknown> | null,
    subscriptions: [] as unknown[],
    deviceInUse: false,
  },
  rpc: vi.fn(async (_name: string, _args?: unknown) => ({ data: null as unknown, error: null })),
  webPushSend: vi.fn(async (_sub: unknown, _body: string, _opts: unknown) => ({})),
}));

function builder(table: string) {
  const op: Op = { table, action: 'select', filters: [] };
  const settle = () => Promise.resolve(
    table === 'notification_preferences' ? { data: state.prefs, error: null }
      : table === 'profiles' ? { data: { status: 1 }, error: null }
        : { data: null, error: null });
  const b: any = {
    select() { return b; },
    delete() { op.action = 'delete'; return b; },
    upsert() { op.action = 'upsert'; return b; },
    eq(col: string, val: unknown) { op.filters.push(['eq', col, val]); return b; },
    neq() { return b; },
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
    PUSH_ALLOW_PRIVATE_ENDPOINTS: true,
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

import { FcmSender, type ServiceAccount } from '../services/FcmSender.js';
import { PushNotificationService } from '../services/PushNotificationService.js';
import { heldWhileDeviceInUse } from '../services/pushPolicy.js';
import pushRouter from '../routes/push.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const ACCOUNT: ServiceAccount = {
  project_id: 'harmony-test',
  client_email: 'fcm@harmony-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
  private_key_id: 'kid-1',
  token_uri: 'https://oauth2.googleapis.com/token',
};
const TOKEN = 'fcm-token-' + 'b'.repeat(140);

const TARGETS = {
  webpush: { subscription_id: 'w1', endpoint: 'https://push.test/w', p256dh: 'p', auth: 'a', push_enabled: true, transport: 'webpush' },
  unifiedpush: { subscription_id: 'u1', endpoint: 'https://ntfy.test/up1', p256dh: 'p2', auth: 'a2', push_enabled: true, transport: 'unifiedpush' },
  fcm: { subscription_id: 'f1', endpoint: TOKEN, p256dh: null, auth: null, push_enabled: true, transport: 'fcm' },
} as const;
type Transport = keyof typeof TARGETS;

// The production row: push on, "Only when I'm away" off.
const OWNER_PREFS = { push_notifications: true, push_offline_only: false, push_mentions: true, desktop_mentions: true };
const AWAY_ONLY_PREFS = { ...OWNER_PREFS, push_offline_only: true };

const mention = () => ({
  id: 'n1',
  user_id: 'u1',
  type: 'mention',
  data: {
    sender: { username: 'alice', display_name: 'Alice' },
    location: { server_id: 's1', channel_id: 'c1', server_name: 'Crew', channel_name: 'general' },
    message: { id: 'm1' },
    preview: 'hi @bob',
  },
});

let fcmFetch: ReturnType<typeof vi.fn>;

/** Each transport's sends, by target. */
function delivered(): Record<Transport, number> {
  const fcmSends = fcmFetch.mock.calls.filter(([url]) => String(url).includes('/messages:send')).length;
  const webPushTo = (endpoint: string) => webPushSend.mock.calls.filter(([sub]) => (sub as any).endpoint === endpoint).length;
  return { webpush: webPushTo(TARGETS.webpush.endpoint), unifiedpush: webPushTo(TARGETS.unifiedpush.endpoint), fcm: fcmSends };
}

beforeEach(() => {
  state.prefs = null;
  state.subscriptions = Object.values(TARGETS);
  state.deviceInUse = false;
  rpc.mockReset();
  rpc.mockImplementation(async (name: string) => {
    if (name === 'get_user_push_subscriptions') return { data: state.subscriptions, error: null };
    if (name === 'has_active_session') return { data: state.deviceInUse, error: null };
    if (name === 'is_user_viewing_push_context') return { data: false, error: null };
    return { data: null, error: null };
  });
  webPushSend.mockReset();
  webPushSend.mockImplementation(async () => ({}));
  fcmFetch = vi.fn(async (url: string) => new Response(JSON.stringify(
    String(url).includes('oauth2') ? { access_token: 'at', expires_in: 3600, token_type: 'Bearer' } : { name: 'projects/harmony-test/messages/1' },
  ), { status: 200, headers: { 'Content-Type': 'application/json' } }));
  PushNotificationService.setFcmSender(new FcmSender({ account: ACCOUNT, fetchImpl: fcmFetch as any }));
  PushNotificationService.initialize();
});

afterEach(() => {
  PushNotificationService.setFcmSender(null);
});

describe('push while a device is in use', () => {
  it('holds a mention from all three transports with "Only when I\'m away" on', async () => {
    state.prefs = AWAY_ONLY_PREFS;
    state.deviceInUse = true;
    await PushNotificationService.sendForNotification(mention());
    expect(delivered()).toEqual({ webpush: 0, unifiedpush: 0, fcm: 0 });
  });

  for (const transport of Object.keys(TARGETS) as Transport[]) {
    it(`holds a mention from ${transport} without a preferences row: the switch defaults to on`, async () => {
      state.subscriptions = [TARGETS[transport]];
      state.deviceInUse = true;
      await PushNotificationService.sendForNotification(mention());
      expect(delivered()[transport]).toBe(0);
    });
  }

  it('pushes to all three transports with "Only when I\'m away" off, as the production account has it', async () => {
    state.prefs = OWNER_PREFS;
    state.deviceInUse = true;
    await PushNotificationService.sendForNotification(mention());
    expect(delivered()).toEqual({ webpush: 1, unifiedpush: 1, fcm: 1 });
  });

  it('reaches every transport once no device is in use', async () => {
    state.prefs = AWAY_ONLY_PREFS;
    await PushNotificationService.sendForNotification(mention());
    expect(delivered()).toEqual({ webpush: 1, unifiedpush: 1, fcm: 1 });
  });

  it('pushes a security notice to every device while one is in use', async () => {
    state.prefs = AWAY_ONLY_PREFS;
    state.deviceInUse = true;
    await PushNotificationService.sendForNotification({ id: 'n2', user_id: 'u1', type: 'security', data: { event: 'new_sign_in' } });
    expect(delivered()).toEqual({ webpush: 1, unifiedpush: 1, fcm: 1 });
  });

  it('holds every type but security notices while the switch is on or unset', () => {
    for (const prefs of [AWAY_ONLY_PREFS, {}, null]) {
      expect(heldWhileDeviceInUse('security', prefs)).toBe(false);
      for (const type of ['mention', 'dm', 'reply', 'reaction', 'activitypub_mention', 'server_member_removed']) {
        expect(heldWhileDeviceInUse(type, prefs)).toBe(true);
      }
    }
    expect(heldWhileDeviceInUse('mention', OWNER_PREFS)).toBe(false);
  });
});

describe('test push from the device in use', () => {
  const app = express();
  app.use(express.json());
  app.use('/push', pushRouter);

  it('reaches the browser that asked, as type "test"', async () => {
    state.deviceInUse = true;
    const res = await supertest(app).post('/push/test').set('Authorization', 'Bearer good').send({ endpoint: TARGETS.webpush.endpoint });
    expect(res.body).toMatchObject({ success: true, sent: 1 });
    expect(delivered()).toEqual({ webpush: 1, unifiedpush: 0, fcm: 0 });
    expect(JSON.parse(webPushSend.mock.calls[0][1] as string)).toMatchObject({ type: 'test', title: 'Test notification' });
  });

  it('reaches the Android app over FCM as a displayable "test" notification', async () => {
    state.deviceInUse = true;
    const res = await supertest(app).post('/push/test').set('Authorization', 'Bearer good').send({ fcmToken: TOKEN });
    expect(res.body).toMatchObject({ success: true, sent: 1 });
    const send = fcmFetch.mock.calls.find(([url]) => String(url).includes('/messages:send'))!;
    const data = JSON.parse(String((send[1] as RequestInit).body)).message.data;
    expect(data).toMatchObject({ kind: 'notification', type: 'test', title: 'Test notification', body: 'Push notifications are working.' });
    expect(data.id).toMatch(/^harmony-test-\d+$/);
  });

  it('reaches the Android app over UnifiedPush as a displayable "test" notification', async () => {
    state.deviceInUse = true;
    const res = await supertest(app).post('/push/test').set('Authorization', 'Bearer good').send({ endpoint: TARGETS.unifiedpush.endpoint });
    expect(res.body).toMatchObject({ success: true, sent: 1 });
    expect(JSON.parse(webPushSend.mock.calls[0][1] as string)).toMatchObject({ kind: 'notification', type: 'test', title: 'Test notification' });
  });
});
