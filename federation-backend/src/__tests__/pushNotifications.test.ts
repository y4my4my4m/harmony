import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

type Op = { table: string; action: string; filters: Array<[string, string, unknown]>; payload?: unknown };

const { calls, state, rpc } = vi.hoisted(() => ({
  calls: [] as Op[],
  state: { respond: (_op: Op): { data: unknown; error: unknown } => ({ data: null, error: null }) },
  rpc: vi.fn(async (_name: string, _args?: unknown) => ({ data: false as unknown, error: null })),
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
    upsert(payload: unknown) { op.action = 'upsert'; op.payload = payload; return b; },
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
  default: { setVapidDetails: vi.fn(), sendNotification: vi.fn(async () => ({})) },
}));

import { PushNotificationService } from '../services/PushNotificationService.js';
import {
  clip,
  compactPushData,
  isWithinQuietHours,
  notificationUrl,
  pushAllowedForType,
} from '../services/pushPolicy.js';

const SUB = { endpoint: 'https://push.example/new', keys: { p256dh: 'p', auth: 'a' } };

beforeEach(() => {
  calls.length = 0;
  state.respond = () => ({ data: null, error: null });
  rpc.mockReset();
  rpc.mockImplementation(async () => ({ data: false, error: null }));
});

describe('quiet hours', () => {
  const at = (h: number, m = 0) => new Date(Date.UTC(2026, 0, 1, h, m));

  it('is off without dnd_enabled', () => {
    expect(isWithinQuietHours({ dnd_enabled: false, dnd_start_time: '00:00', dnd_end_time: '23:59' }, at(12))).toBe(false);
    expect(isWithinQuietHours(null, at(12))).toBe(false);
  });

  it('wraps midnight when start is after end', () => {
    const prefs = { dnd_enabled: true, dnd_start_time: '22:00:00', dnd_end_time: '08:00:00' };
    expect(isWithinQuietHours(prefs, at(23, 30))).toBe(true);
    expect(isWithinQuietHours(prefs, at(3))).toBe(true);
    expect(isWithinQuietHours(prefs, at(12))).toBe(false);
  });

  it('reads times as UTC', () => {
    const prefs = { dnd_enabled: true, dnd_start_time: '09:00', dnd_end_time: '17:00' };
    expect(isWithinQuietHours(prefs, at(9))).toBe(true);
    expect(isWithinQuietHours(prefs, at(17, 1))).toBe(false);
  });
});

describe('per-type push gates', () => {
  it('allows everything without a preferences row', () => {
    expect(pushAllowedForType('activitypub_reblog', null)).toBe(true);
  });

  it('honours the master switch', () => {
    expect(pushAllowedForType('dm', { push_notifications: false })).toBe(false);
  });

  it('reads columns the old select omitted', () => {
    const prefs = { push_notifications: true, push_mentions: true, push_dms: true, desktop_replies: true };
    expect(pushAllowedForType('reply', prefs)).toBe(true);
    expect(pushAllowedForType('reply', { ...prefs, desktop_replies: false })).toBe(false);
  });

  it('gates mentions on the push and alert toggles', () => {
    expect(pushAllowedForType('mention', { push_mentions: false, desktop_mentions: true })).toBe(false);
    expect(pushAllowedForType('mention', { push_mentions: true, desktop_mentions: false })).toBe(false);
  });

  it('gates social types on the social alert toggles', () => {
    expect(pushAllowedForType('activitypub_favorite', { activitypub_desktop_favorites: false })).toBe(false);
    expect(pushAllowedForType('activitypub_follow', { activitypub_desktop_notifications: false })).toBe(false);
  });
});

describe('notification deep links', () => {
  it('opens a DM at the message', () => {
    expect(notificationUrl('dm', { conversation: { id: 'c1' }, message: { id: 'm1' } })).toBe('/dm/c1?messageId=m1');
  });

  it('opens a channel mention at the message', () => {
    expect(notificationUrl('mention', { location: { server_id: 's1', channel_id: 'ch1' }, message_id: 'm2' }))
      .toBe('/chat/s1/ch1?messageId=m2');
  });

  it('opens a thread reply in its thread', () => {
    expect(notificationUrl('thread_reply', { server_id: 's1', channel_id: 'ch1', thread_id: 't1', message_id: 'm3' }))
      .toBe('/chat/s1/thread/t1?messageId=m3');
  });

  it('opens social posts and profiles', () => {
    expect(notificationUrl('activitypub_reply', { post_id: 'p1' })).toBe('/social/post/p1');
    expect(notificationUrl('activitypub_follow', { follower: { username: 'bob', domain: 'remote.social', is_local: false } }))
      .toBe('/social/profile/bob@remote.social');
    expect(notificationUrl('activitypub_follow', { follower: { username: 'amy', is_local: true, domain: 'harmony.test' } }))
      .toBe('/social/profile/amy');
    expect(notificationUrl('activitypub_follow_request', {})).toBe('/social/follow-requests');
  });

  it('falls back to a section instead of a dead route', () => {
    expect(notificationUrl('server_update', { server_id: 's1' })).toBe('/chat');
    expect(notificationUrl('activitypub_reblog', {})).toBe('/social/home');
  });
});

describe('push payload', () => {
  it('keeps routing ids and drops content', () => {
    const data = compactPushData('n1', 'mention', {
      location: { server_id: 's1', channel_id: 'ch1' },
      message: { id: 'm1', content: [{ type: 'text', text: 'x'.repeat(10000) }] },
      sender: { username: 'alice' },
    });
    expect(data).toEqual({
      notification_id: 'n1',
      type: 'mention',
      url: '/chat/s1/ch1?messageId=m1',
      server_id: 's1',
      channel_id: 'ch1',
      message_id: 'm1',
    });
  });

  it('stays under the Web Push size limit for large notifications', () => {
    const payload = (PushNotificationService as any).buildPayloadFromNotification({
      id: 'n1',
      user_id: 'u1',
      type: 'activitypub_reply',
      data: {
        sender: { username: 'alice', display_name: 'A'.repeat(500) },
        post_id: 'p1',
        post: { id: 'p1', content: 'y'.repeat(20000), content_preview: 'z'.repeat(5000) },
      },
    });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(3000);
    expect(payload.data.url).toBe('/social/post/p1');
  });

  it('titles group chat and thread replies', () => {
    const chat = (PushNotificationService as any).buildPayloadFromNotification({
      id: 'n2', user_id: 'u1', type: 'chat_message',
      data: { sender: { username: 'alice' }, conversation: { id: 'c1', name: 'Crew' }, preview: 'hi' },
    });
    expect(chat.title).toBe('alice in Crew');
    const thread = (PushNotificationService as any).buildPayloadFromNotification({
      id: 'n3', user_id: 'u1', type: 'thread_reply',
      data: { sender: { username: 'bob' }, location: { channel_name: 'general' }, preview: 'yo' },
    });
    expect(thread.title).toBe('bob replied in a thread in #general');
  });

  it('clips by code point', () => {
    expect(clip('ab😀cd', 4)).toBe('ab😀…');
  });
});

describe('subscription lifecycle', () => {
  it('claims the endpoint from other accounts and replaces only the previous endpoint', async () => {
    const result = await PushNotificationService.saveSubscription('u1', SUB as any, 'UA', undefined, 'https://push.example/old');
    expect(result.success).toBe(true);

    const deletes = calls.filter((c) => c.action === 'delete');
    expect(deletes).toContainEqual(expect.objectContaining({
      filters: [['eq', 'endpoint', SUB.endpoint], ['eq', 'auth', SUB.keys.auth], ['neq', 'user_id', 'u1']],
    }));
    expect(deletes).toContainEqual(expect.objectContaining({
      filters: [['eq', 'user_id', 'u1'], ['eq', 'endpoint', 'https://push.example/old']],
    }));
    expect(deletes.some((c) => c.filters.some(([, col]) => col === 'user_agent'))).toBe(false);
    expect(calls.find((c) => c.action === 'upsert')?.payload).toMatchObject({ user_id: 'u1', endpoint: SUB.endpoint, failure_count: 0 });
  });

  it('rejects non-https endpoints', async () => {
    const result = await PushNotificationService.saveSubscription('u1', { endpoint: 'http://x', keys: { p256dh: 'p', auth: 'a' } } as any);
    expect(result.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('rotates a subscription identified by endpoint and auth secret', async () => {
    state.respond = (op) => op.table === 'push_subscriptions' && op.action === 'select'
      ? { data: [{ id: 's1', user_id: 'u9', user_agent: 'UA', device_name: null }], error: null }
      : { data: null, error: null };
    const result = await PushNotificationService.rotateSubscription('https://push.example/old', 'a-old', SUB as any);
    expect(result.success).toBe(true);
    const lookup = calls.find((c) => c.action === 'select');
    expect(lookup?.filters).toEqual([['eq', 'endpoint', 'https://push.example/old'], ['eq', 'auth', 'a-old']]);
    expect(calls.find((c) => c.action === 'upsert')?.payload).toMatchObject({ user_id: 'u9', endpoint: SUB.endpoint });
  });

  it('refuses a rotation it cannot authenticate', async () => {
    state.respond = () => ({ data: [], error: null });
    const result = await PushNotificationService.rotateSubscription('https://push.example/old', 'wrong', SUB as any);
    expect(result).toEqual({ success: false, error: 'Unknown subscription' });
    expect(calls.some((c) => c.action === 'upsert')).toBe(false);
  });
});

describe('sendForNotification gating', () => {
  let sendToUser: MockInstance<typeof PushNotificationService.sendToUser>;

  beforeEach(() => {
    PushNotificationService.initialize();
    sendToUser = vi.spyOn(PushNotificationService, 'sendToUser').mockResolvedValue({ sent: 1, failed: 0 });
  });

  const withPrefs = (prefs: Record<string, unknown> | null, status = 1) => {
    state.respond = (op) => {
      if (op.table === 'notification_preferences') return { data: prefs, error: null };
      if (op.table === 'profiles') return { data: { status }, error: null };
      return { data: null, error: null };
    };
  };

  const reply = { id: 'n1', user_id: 'u1', type: 'reply', data: { sender: { username: 'a' }, location: { server_id: 's', channel_id: 'c' } } };

  it('sends a reply when a preferences row exists', async () => {
    withPrefs({ push_notifications: true, push_offline_only: false, desktop_replies: true });
    await PushNotificationService.sendForNotification({ ...reply });
    expect(sendToUser).toHaveBeenCalledTimes(1);
    expect(sendToUser.mock.calls[0][1].data?.url).toBe('/chat/s/c');
  });

  it('holds push during quiet hours', async () => {
    withPrefs({ dnd_enabled: true, dnd_start_time: '00:00', dnd_end_time: '23:59:59' });
    await PushNotificationService.sendForNotification({ ...reply });
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('holds push while the recipient is Busy', async () => {
    withPrefs(null, 3);
    await PushNotificationService.sendForNotification({ ...reply });
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('holds push while another device is active and offline-only is on', async () => {
    withPrefs({ push_offline_only: true });
    rpc.mockImplementation(async (name: string) => ({ data: name === 'has_active_session', error: null }));
    await PushNotificationService.sendForNotification({ ...reply });
    expect(sendToUser).not.toHaveBeenCalled();
  });

  it('treats a missing preferences row as offline-only', async () => {
    withPrefs(null);
    rpc.mockImplementation(async (name: string) => ({ data: name === 'has_active_session', error: null }));
    await PushNotificationService.sendForNotification({ ...reply });
    expect(sendToUser).not.toHaveBeenCalled();
  });
});
