import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A member gone without a user-left (a crash, a closed page, a session that ended) leaves once its
// connection has failed and it signals no more. One still signalling stays, and a leave is heard once.

const capabilities = vi.hoisted(() => ({ relay: true }));
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }));
import { supabase } from '@/supabase';
import { UnifiedWebRTCService } from '../unifiedWebRTC';

const ALICE = '11111111-0000-0000-0000-000000000001';
const BOB = '22222222-0000-0000-0000-000000000002';
const GRACE_MS = 6_000;
const RECHECK_MS = 30_000;

class FakePeerConnection {
  static made: FakePeerConnection[] = [];
  closed = false;
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  onconnectionstatechange: (() => void) | null = null;
  constructor() { FakePeerConnection.made.push(this); }
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'v=0' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.remoteDescription = d; });
  addIceCandidate = vi.fn(async () => {});
  close() { this.closed = true; this.signalingState = 'closed'; }
  /** As the browser moves it; pc.close() fires no event. */
  move(state: string) {
    this.connectionState = state;
    this.onconnectionstatechange?.();
  }
}

const rpc = () => vi.mocked(supabase.rpc);
const sent = () => rpc().mock.calls.flatMap(([, args]) => (args as any).p_payload.messages as Array<{ type: string; to?: string; data?: any }>);
const asked = () => sent().filter((m) => m.type === 'state-sync' && m.data?.action === 'request' && m.to === BOB).length;

async function inCallWithBob() {
  const svc = new UnifiedWebRTCService();
  const s = svc as any;
  s.channelId = 'room-1';
  s.currentUserId = ALICE;
  s.sessionId = 'alice-1';
  s.signalChannel = { send: vi.fn(async () => 'ok'), close: vi.fn(async () => {}) };
  const left: string[] = [];
  const joined: string[] = [];
  svc.on('user-left', (e: { userId: string }) => left.push(e.userId));
  svc.on('user-joined', (e: { userId: string }) => joined.push(e.userId));
  const relay = (message: Record<string, unknown>, session = 'bob-1') => s.handleRelayed({ from: BOB, messages: [{ session, ...message }] });
  relay({ type: 'user-joined', data: { mediaState: { userId: BOB } } });
  await vi.advanceTimersByTimeAsync(0);
  const pc = FakePeerConnection.made.at(-1)!;
  pc.move('connected');
  return { svc, s, left, joined, relay, pc };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakePeerConnection.made = [];
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  capabilities.relay = true;
  rpc().mockReset();
  rpc().mockResolvedValue({ data: null, error: null } as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a member whose connection is lost', () => {
  it.each(['failed', 'closed'])('%s, and silent: it leaves 6 s later, with its connection and audio, once', async (state) => {
    const { s, left, relay, pc } = await inCallWithBob();
    const audio = vi.spyOn(s, 'cleanupRemoteAudio');
    pc.move(state);
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
    expect(left).toEqual([]);
    expect(s.allUserStates.has(BOB)).toBe(true);
    // Asked whether it is still there, and there is no answer.
    expect(asked()).toBe(1);

    await vi.advanceTimersByTimeAsync(200);
    expect(left).toEqual([BOB]);
    expect(pc.closed).toBe(true);
    expect(audio).toHaveBeenCalledTimes(1);
    expect(s.connections.size).toBe(0);
    expect(s.allUserStates.has(BOB)).toBe(false);

    // Its own leave, late.
    relay({ type: 'user-left', data: {} });
    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(left).toEqual([BOB]);
  });

  it('disconnected alone, for any time, drops no one', async () => {
    const { left, pc } = await inCallWithBob();
    pc.move('disconnected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(left).toEqual([]);
    expect(asked()).toBe(0);
  });

  it('connected again within the grace, it stays', async () => {
    const { left, pc } = await inCallWithBob();
    pc.move('failed');
    await vi.advanceTimersByTimeAsync(GRACE_MS - 100);
    pc.move('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(left).toEqual([]);
  });

  it('still signalling, it stays; silent at a later check, it leaves', async () => {
    const { s, svc, left, relay, pc } = await inCallWithBob();
    const synced = vi.fn();
    svc.on('channel-state-synced', synced);
    pc.move('failed');
    await vi.advanceTimersByTimeAsync(1_000);
    relay({ type: 'state-sync', to: ALICE, data: { action: 'response', mediaState: { userId: BOB, isMuted: true } } });
    await vi.advanceTimersByTimeAsync(GRACE_MS);
    expect(left).toEqual([]);
    expect(s.allUserStates.get(BOB)).toMatchObject({ isMuted: true });
    // Its answer is no new roster.
    expect(synced).not.toHaveBeenCalled();
    expect(asked()).toBe(2);

    await vi.advanceTimersByTimeAsync(RECHECK_MS);
    expect(left).toEqual([BOB]);
  });

  it('back with a new session before the grace ends, its new connection is not dropped for the old one', async () => {
    const { s, left, relay, pc } = await inCallWithBob();
    pc.move('failed');
    relay({ type: 'user-joined', data: { mediaState: { userId: BOB } } }, 'bob-2');
    await vi.advanceTimersByTimeAsync(0);
    FakePeerConnection.made.at(-1)!.move('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(left).toEqual([]);
    expect(s.connections.get(BOB).peerConnection.closed).toBe(false);
  });

  it('a leave of the call ends the wait', async () => {
    const { svc, left, pc } = await inCallWithBob();
    pc.move('failed');
    await svc.leaveChannel({ silent: true });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(left).toEqual([]);
    expect(sent().filter((m) => m.type === 'user-left')).toEqual([]);
  });
});

describe('a connection lost with the signalling topic', () => {
  it('is opened again once the topic resumes and the member answers; it did not join twice', async () => {
    const { s, left, joined, relay, pc } = await inCallWithBob();
    joined.length = 0;
    pc.move('failed');
    s.resyncUntil = Date.now() + 10_000;
    relay({ type: 'state-sync', to: ALICE, data: { action: 'response', mediaState: { userId: BOB } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.closed).toBe(true);
    expect(FakePeerConnection.made).toHaveLength(2);
    expect(sent().filter((m) => m.type === 'offer').length).toBe(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(left).toEqual([]);
    expect(joined).toEqual([]);
  });

  it('an offer for it is answered on a new one', async () => {
    const { s, relay, pc } = await inCallWithBob();
    pc.move('failed');
    relay({ type: 'offer', to: ALICE, data: { type: 'offer', sdp: 'v=0' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(pc.closed).toBe(true);
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();
    expect(s.connections.get(BOB).peerConnection.setRemoteDescription).toHaveBeenCalled();
    expect(sent().some((m) => m.type === 'answer')).toBe(true);
  });
});

describe('a user-left', () => {
  it('of a session the member has replaced is the reload\'s, and ignored', async () => {
    const { s, left, relay } = await inCallWithBob();
    relay({ type: 'user-joined', data: { mediaState: { userId: BOB } } }, 'bob-2');
    await vi.advanceTimersByTimeAsync(0);
    relay({ type: 'user-left', data: {} }, 'bob-1');
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toEqual([]);
    expect(s.connections.has(BOB)).toBe(true);

    relay({ type: 'user-left', data: {} }, 'bob-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toEqual([BOB]);
  });

  it('is the session\'s last word: what it sent before lists no one', async () => {
    const { s, svc, left, relay } = await inCallWithBob();
    const changed = vi.fn();
    svc.on('user-state-changed', changed);
    relay({ type: 'user-left', data: {} });
    relay({ type: 'media-state', data: { mediaState: { userId: BOB } } });
    await vi.advanceTimersByTimeAsync(0);
    expect(left).toEqual([BOB]);
    expect(changed).not.toHaveBeenCalled();
    expect(s.allUserStates.has(BOB)).toBe(false);

    relay({ type: 'user-joined', data: { mediaState: { userId: BOB } } }, 'bob-2');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.allUserStates.has(BOB)).toBe(true);
  });
});

describe('a page in a P2P call that goes', () => {
  const pagehide = () => window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));

  it('says user-left in a keepalive request with the token Realtime holds, past the signal queue', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    (supabase as any).realtime = { accessTokenValue: 'member-token' };
    const { s } = await inCallWithBob();
    s.channelId = 'room-of-this-page';
    // A request under way that never ends, as the ones of an unloading page.
    rpc().mockReturnValue(new Promise(() => {}) as never);
    s.broadcastMessage({ type: 'media-state', from: ALICE, data: {}, timestamp: 1 });
    pagehide();

    const calls = fetch.mock.calls.filter(([, init]) => String(init.body).includes('room-of-this-page'));
    expect(calls).toHaveLength(1);
    const [url, init] = calls[0];
    expect(url).toBe('http://localhost:54321/rest/v1/rpc/send_signal');
    expect(init).toMatchObject({
      method: 'POST',
      keepalive: true,
      headers: { apikey: 'test-anon-key', Authorization: 'Bearer member-token', 'Content-Type': 'application/json' },
    });
    expect(JSON.parse(String(init.body))).toEqual({
      p_topic: 'harmony-voice-room-of-this-page',
      p_event: 'signals',
      p_payload: { messages: [{ type: 'user-left', data: {}, timestamp: expect.any(Number), session: 'alice-1' }] },
    });
    expect(s.channelId).toBeNull();
    delete (supabase as any).realtime;
  });

  it('signed out, it says nothing: Realtime holds the anon key', async () => {
    const fetch = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', fetch);
    (supabase as any).realtime = { accessTokenValue: 'test-anon-key' };
    const { s } = await inCallWithBob();
    pagehide();
    expect(fetch).not.toHaveBeenCalled();
    expect(s.channelId).toBeNull();
    delete (supabase as any).realtime;
  });

  it('on an instance without send_signal, it is a client broadcast before the topic closes', async () => {
    capabilities.relay = false;
    rpc().mockResolvedValue({ data: null, error: { code: 'PGRST202', message: 'absent' } } as never);
    const { s } = await inCallWithBob();
    const channel = s.signalChannel;
    pagehide();
    expect(channel.send).toHaveBeenCalledWith({
      type: 'broadcast', event: 'signal',
      payload: { type: 'user-left', from: ALICE, data: {}, timestamp: expect.any(Number), session: 'alice-1' },
    }, { timeout: 5000 });
    await vi.advanceTimersByTimeAsync(0);
    const order = channel.send.mock.invocationCallOrder.at(-1)!;
    expect(order).toBeLessThan(channel.close.mock.invocationCallOrder[0]);
  });
});
