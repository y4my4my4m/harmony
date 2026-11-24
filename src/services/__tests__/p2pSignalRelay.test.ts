import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const capabilities = vi.hoisted(() => ({ relay: true }));
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: (name: string) => name === 'signal-relay' && capabilities.relay }));
import { supabase } from '@/supabase';
import { UnifiedWebRTCService } from '../unifiedWebRTC';
import { DEFAULT_ICE_SERVERS } from '../voice/iceServers';

// P2P signals on an instance with send_signal (20261124100001): sent through the RPC, received as
// one 'signals' broadcast whose sender the database set. A rejoining peer's old connection closes.

const ALICE = '11111111-0000-0000-0000-000000000001';
const BOB = '22222222-0000-0000-0000-000000000002';
const MALLORY = '33333333-0000-0000-0000-000000000003';

class FakePeerConnection {
  static made: FakePeerConnection[] = [];
  static refuse: ((config: RTCConfiguration) => boolean) | null = null;
  closed = false;
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  remoteDescription: RTCSessionDescriptionInit | null = null;
  ontrack: unknown = null;
  onicecandidate: unknown = null;
  onconnectionstatechange: unknown = null;
  oniceconnectionstatechange: unknown = null;
  constructor(public config: RTCConfiguration) {
    if (FakePeerConnection.refuse?.(config)) throw new DOMException('bad url', 'SyntaxError');
    FakePeerConnection.made.push(this);
  }
  addTrack = vi.fn();
  createOffer = vi.fn(async () => ({ type: 'offer', sdp: 'v=0' }));
  createAnswer = vi.fn(async () => ({ type: 'answer', sdp: 'v=0' }));
  setLocalDescription = vi.fn(async () => {});
  setRemoteDescription = vi.fn(async (d: RTCSessionDescriptionInit) => { this.remoteDescription = d; });
  addIceCandidate = vi.fn(async () => {});
  close() { this.closed = true; this.signalingState = 'closed'; }
}

function joined(room = 'room-1') {
  const svc = new UnifiedWebRTCService();
  const s = svc as any;
  s.channelId = room;
  s.currentUserId = ALICE;
  s.signalChannel = { send: vi.fn() };
  return { svc, s };
}

const rpc = () => vi.mocked(supabase.rpc);

beforeEach(() => {
  FakePeerConnection.made = [];
  FakePeerConnection.refuse = null;
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  capabilities.relay = true;
  rpc().mockReset();
  rpc().mockResolvedValue({ data: null, error: null } as never);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('P2P signal relay', () => {
  it('a relayed message is the database sender\'s, whatever the message claims', async () => {
    const { svc, s } = joined();
    const left: string[] = [];
    svc.on('user-left', (e: { userId: string }) => left.push(e.userId));
    s.allUserStates.set(BOB, { userId: BOB });
    s.allUserStates.set(MALLORY, { userId: MALLORY });

    s.handleRelayed({ from: MALLORY, messages: [{ type: 'user-left', from: BOB, data: {}, timestamp: 1 }] });
    await Promise.resolve();

    expect(left).toEqual([MALLORY]);
    expect(s.allUserStates.has(BOB)).toBe(true);
  });

  it('an offer claiming another member opens no connection under that member\'s name', async () => {
    const { s } = joined();
    s.handleRelayed({ from: MALLORY, messages: [{ type: 'offer', from: BOB, to: ALICE, data: { type: 'offer', sdp: 'v=0' } }] });
    await vi.waitFor(() => expect(s.connections.has(MALLORY)).toBe(true));
    expect(s.connections.has(BOB)).toBe(false);
  });

  it('messages are sent in order through send_signal without a sender, batched while a request is in flight', async () => {
    const { s } = joined();
    let release!: () => void;
    rpc().mockImplementationOnce(() => new Promise((resolve) => { release = () => resolve({ data: null, error: null } as never); }) as never);

    s.broadcastMessage({ type: 'user-joined', from: ALICE, data: { mediaState: {} }, timestamp: 1 });
    s.sendDirectMessage(BOB, { type: 'offer', from: ALICE, to: BOB, data: { sdp: 'v=0' }, timestamp: 2 });
    s.sendDirectMessage(BOB, { type: 'ice-candidate', from: ALICE, to: BOB, data: { candidate: 'c' }, timestamp: 3 });
    expect(rpc()).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(rpc()).toHaveBeenCalledTimes(2));

    expect(rpc().mock.calls.map(([name, args]) => [name, (args as any).p_topic, (args as any).p_payload.messages.map((m: any) => m.type)]))
      .toEqual([
        ['send_signal', 'harmony-voice-room-1', ['user-joined']],
        ['send_signal', 'harmony-voice-room-1', ['offer', 'ice-candidate']],
      ]);
    for (const [, args] of rpc().mock.calls) {
      for (const message of (args as any).p_payload.messages) expect(message).not.toHaveProperty('from');
    }
    expect((rpc().mock.calls[1][1] as any).p_payload.messages[0].to).toBe(BOB);
    expect(s.signalChannel.send).not.toHaveBeenCalled();
  });

  it('a refused request does not stop the messages after it', async () => {
    const { s } = joined();
    rpc().mockResolvedValueOnce({ data: null, error: { message: 'not admitted' } } as never);
    s.broadcastMessage({ type: 'user-joined', from: ALICE, data: {}, timestamp: 1 });
    await vi.waitFor(() => expect(rpc()).toHaveBeenCalledTimes(1));
    s.broadcastMessage({ type: 'user-left', from: ALICE, data: {}, timestamp: 2 });
    await vi.waitFor(() => expect(rpc()).toHaveBeenCalledTimes(2));
  });

  it('on an instance without send_signal, messages are client broadcasts', () => {
    const { s } = joined();
    capabilities.relay = false;
    s.sendDirectMessage(BOB, { type: 'answer', from: ALICE, data: {}, timestamp: 1 });
    expect(rpc()).not.toHaveBeenCalled();
    expect(s.signalChannel.send).toHaveBeenCalledWith({
      type: 'broadcast', event: 'signal', payload: { type: 'answer', from: ALICE, to: BOB, data: {}, timestamp: 1, session: '' },
    });
  });

  it('a member answers for itself: states it reports of others, or under another id, are not read', async () => {
    const { s } = joined();
    s.handleRelayed({
      from: BOB,
      messages: [{
        type: 'state-sync', to: ALICE,
        data: {
          action: 'response',
          mediaState: { userId: MALLORY, isMuted: true },
          allStates: [{ userId: MALLORY, isMuted: false }, { userId: 'ghost', isMuted: false }],
        },
      }],
    });
    await Promise.resolve();
    expect([...s.allUserStates.keys()]).toEqual([BOB]);
    expect(s.allUserStates.get(BOB)).toMatchObject({ userId: BOB, isMuted: true });
  });
});

describe('P2P peer connections', () => {
  it('a peer joining again replaces its connection: the old one closes with its audio', async () => {
    const { svc, s } = joined();
    const cleanup = vi.spyOn(s, 'cleanupRemoteAudio');
    const joinedEvents: string[] = [];
    svc.on('user-joined', (e: { userId: string }) => joinedEvents.push(e.userId));

    await s.handleUserJoined(BOB, { userId: BOB });
    const first = FakePeerConnection.made[0];
    const firstConnection = s.connections.get(BOB);
    await s.handleUserJoined(BOB, { userId: BOB });
    const second = FakePeerConnection.made[1];

    expect(first.closed).toBe(true);
    expect(cleanup).toHaveBeenCalledWith(firstConnection);
    expect(second.closed).toBe(false);
    expect(s.connections.get(BOB).peerConnection).toBe(second);
    expect(s.connections.size).toBe(1);
    expect(joinedEvents).toEqual([BOB, BOB]);
  });

  it('a peer back with a new session: its old connection closes on its first message, its announcement opens one', async () => {
    const { s } = joined();
    const relay = (messages: unknown[]) => s.handleRelayed({ from: BOB, messages })
    relay([{ type: 'user-joined', session: 'bob-1', data: { mediaState: { userId: BOB } } }]);
    await vi.waitFor(() => expect(FakePeerConnection.made).toHaveLength(1));
    const first = FakePeerConnection.made[0];

    relay([{ type: 'state-sync', session: 'bob-2', data: { action: 'request' } }]);
    await Promise.resolve();
    expect(first.closed).toBe(true);
    expect(s.connections.has(BOB)).toBe(false);

    relay([{ type: 'user-joined', session: 'bob-2', data: { mediaState: { userId: BOB } } }]);
    await vi.waitFor(() => expect(FakePeerConnection.made).toHaveLength(2));
    expect(s.connections.get(BOB).peerConnection).toBe(FakePeerConnection.made[1]);
  });

  it('a late announcement of a session already connected leaves the connection alone', async () => {
    const { s } = joined();
    s.handleRelayed({ from: BOB, messages: [{ type: 'offer', session: 'bob-1', to: ALICE, data: { type: 'offer', sdp: 'v=0' } }] });
    await vi.waitFor(() => expect(FakePeerConnection.made).toHaveLength(1));
    s.handleRelayed({ from: BOB, messages: [{ type: 'user-joined', session: 'bob-1', data: { mediaState: { userId: BOB } } }] });
    await Promise.resolve();
    expect(FakePeerConnection.made).toHaveLength(1);
    expect(FakePeerConnection.made[0].closed).toBe(false);
  });

  it('crossed offers: the greater id rolls its offer back and answers, the lesser keeps its own', async () => {
    // ALICE < BOB: as ALICE, the incoming offer is ignored.
    const { s } = joined();
    await s.handleUserJoined(BOB, { userId: BOB });
    const pc = FakePeerConnection.made[0] as any;
    pc.signalingState = 'have-local-offer';
    await s.handleOffer(BOB, { type: 'offer', sdp: 'v=0' });
    expect(pc.setRemoteDescription).not.toHaveBeenCalled();

    // As BOB, the offer from ALICE wins: rollback, then answer.
    const other = joined();
    other.s.currentUserId = BOB;
    await other.s.handleUserJoined(ALICE, { userId: ALICE });
    const bobs = FakePeerConnection.made[1] as any;
    bobs.signalingState = 'have-local-offer';
    rpc().mockClear();
    await other.s.handleOffer(ALICE, { type: 'offer', sdp: 'v=0' });
    expect(bobs.setLocalDescription).toHaveBeenCalledWith({ type: 'rollback' });
    expect(bobs.setRemoteDescription).toHaveBeenCalledWith({ type: 'offer', sdp: 'v=0' });
    await vi.waitFor(() => expect(rpc().mock.calls.flatMap(([, args]) => (args as any).p_payload.messages.map((m: any) => m.type))).toContain('answer'));
  });

  it('every message carries this client\'s session', async () => {
    const { s } = joined();
    s.sessionId = 'alice-1';
    s.broadcastMessage({ type: 'media-state', from: ALICE, data: {}, timestamp: 1 });
    await vi.waitFor(() => expect(rpc()).toHaveBeenCalled());
    expect((rpc().mock.calls[0][1] as any).p_payload.messages[0].session).toBe('alice-1');
  });

  it('an initiator\'s candidates gathered before its offer is sent follow the offer', async () => {
    const { s } = joined();
    const pending = s.handleUserJoined(BOB, { userId: BOB });
    const pc = FakePeerConnection.made[0] as any;
    pc.setLocalDescription.mockImplementation(async () => {
      pc.onicecandidate({ candidate: { candidate: 'pooled', toJSON: () => ({ candidate: 'pooled' }) } });
    });
    await pending;
    pc.onicecandidate({ candidate: { candidate: 'later', toJSON: () => ({ candidate: 'later' }) } });
    await vi.waitFor(() => expect(rpc().mock.calls.flatMap(([, args]) => (args as any).p_payload.messages)).toHaveLength(3));
    const sent = rpc().mock.calls.flatMap(([, args]) => (args as any).p_payload.messages);
    expect(sent.map((m: any) => m.type)).toEqual(['offer', 'ice-candidate', 'ice-candidate']);
  });

  it('an offer on a live connection renegotiates it', async () => {
    const { s } = joined();
    await s.handleUserJoined(BOB, { userId: BOB });
    await s.handleOffer(BOB, { type: 'offer', sdp: 'v=0' });
    expect(FakePeerConnection.made).toHaveLength(1);
    expect(FakePeerConnection.made[0].closed).toBe(false);
  });

  it('peer connections use the instance\'s ICE servers', async () => {
    const { s } = joined();
    const servers = [{ urls: ['stun:stun.example.org:3478'] }, { urls: ['turn:turn.example.org:3478'], username: 'u', credential: 'c' }];
    s.iceServers = servers;
    await s.handleUserJoined(BOB, { userId: BOB });
    expect(FakePeerConnection.made[0].config.iceServers).toEqual(servers);
  });

  it('ICE servers RTCPeerConnection refuses give way to the defaults', async () => {
    const { s } = joined();
    s.iceServers = [{ urls: ['turn:turn.example.org'] }];
    FakePeerConnection.refuse = (config) => (config.iceServers ?? []).some((server) => !server.credential && String(server.urls).startsWith('turn'));
    await s.handleUserJoined(BOB, { userId: BOB });
    expect(FakePeerConnection.made[0].config.iceServers).toEqual([...DEFAULT_ICE_SERVERS]);
  });

  it('a new service starts on the default ICE servers: Google STUN, no TURN', () => {
    const { s } = joined();
    expect(s.iceServers).toEqual([{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }]);
  });
});
