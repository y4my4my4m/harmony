import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A P2P join that does not complete releases everything it opened: the microphone, the peers and
// the signalling topic. Nothing later arriving on that topic is answered, so a member who joins
// after it gets no offer. A page that goes leaves the call; a download's beforeunload does not.

const topics = vi.hoisted(() => ({ opened: [] as any[] }));
vi.mock('../rebuildingChannel', () => ({
  openRebuildingChannel: (options: any) => {
    const channel = { options, send: vi.fn(async () => 'ok'), close: vi.fn(async () => {}) };
    topics.opened.push(channel);
    return channel;
  },
}));
vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => true }));
vi.mock('../voice/iceServers', () => ({ DEFAULT_ICE_SERVERS: [], loadIceServers: async () => [] }));

import { supabase } from '@/supabase';
import { UnifiedWebRTCService } from '../unifiedWebRTC';

const ALICE = '11111111-0000-0000-0000-000000000001';
const BOB = '22222222-0000-0000-0000-000000000002';

const rpc = () => vi.mocked(supabase.rpc);
const sentTypes = () => rpc().mock.calls
  .filter(([, args]) => (args as any).p_topic === 'harmony-voice-room-1')
  .flatMap(([, args]) => (args as any).p_payload.messages.map((m: any) => m.type));
const made: unknown[] = [];

class FakePeerConnection {
  connectionState = 'new';
  iceConnectionState = 'new';
  signalingState = 'stable';
  remoteDescription = null;
  constructor() { made.push(this); }
  addTrack() {}
  createOffer = async () => ({ type: 'offer', sdp: 'v=0' });
  setLocalDescription = async () => {};
  close() {}
}

let tracks: Array<{ kind: string; id: string; enabled: boolean; stop: ReturnType<typeof vi.fn> }> = [];

function service() {
  const svc = new UnifiedWebRTCService();
  const events: string[] = [];
  for (const event of ['channel-left', 'channel-joined', 'connection-lost', 'error']) svc.on(event, () => events.push(event));
  return { svc, s: svc as any, events };
}

async function joined() {
  const made = service();
  const join = made.svc.joinChannel('room-1', ALICE);
  await vi.waitFor(() => expect(topics.opened).toHaveLength(1));
  topics.opened[0].options.onSubscribed(false);
  await expect(join).resolves.toBe(true);
  return made;
}

beforeEach(() => {
  topics.opened.length = 0;
  made.length = 0;
  tracks = [];
  rpc().mockReset();
  rpc().mockResolvedValue({ data: null, error: null } as never);
  vi.stubGlobal('RTCPeerConnection', FakePeerConnection);
  vi.stubGlobal('navigator', {
    mediaDevices: {
      getUserMedia: vi.fn(async () => {
        const track = { kind: 'audio', id: `mic-${tracks.length}`, enabled: true, stop: vi.fn() };
        tracks.push(track);
        return { getTracks: () => [track], getAudioTracks: () => [track], getVideoTracks: () => [] };
      }),
    },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('a P2P join whose topic does not answer', () => {
  it('fails with the microphone stopped and the topic closed, and answers no later joiner', async () => {
    vi.useFakeTimers();
    const { svc, s, events } = service();
    const join = svc.joinChannel('room-1', ALICE);
    await vi.advanceTimersByTimeAsync(0);
    expect(topics.opened).toHaveLength(1);
    expect(tracks).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(15_001);
    await expect(join).resolves.toBe(false);

    expect(tracks[0].stop).toHaveBeenCalled();
    expect(topics.opened[0].close).toHaveBeenCalledTimes(1);
    expect(svc.getLocalStream()).toBeNull();
    expect(s.channelId).toBeNull();
    // The join never reached the room: nobody is told it left, here or there.
    expect(events).toEqual(['error']);

    s.handleRelayed({ from: BOB, messages: [{ type: 'user-joined', session: 'bob-1', data: { mediaState: { userId: BOB } } }] });
    s.handleRelayed({ from: BOB, messages: [{ type: 'state-sync', session: 'bob-1', data: { action: 'request' } }] });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(made).toHaveLength(0);
    expect(sentTypes()).toEqual([]);
  });

  it('is left once: leaving again finds nothing', async () => {
    vi.useFakeTimers();
    const { svc } = service();
    const join = svc.joinChannel('room-1', ALICE);
    await vi.advanceTimersByTimeAsync(15_001);
    await join;
    const stops = tracks[0].stop.mock.calls.length;
    await svc.leaveChannel();
    expect(topics.opened[0].close).toHaveBeenCalledTimes(1);
    expect(tracks[0].stop).toHaveBeenCalledTimes(stops);
    expect(sentTypes()).toEqual([]);
  });

  it('cancelled while it waits, ends at once', async () => {
    const { svc } = service();
    const join = svc.joinChannel('room-1', ALICE);
    const settled = join.then(() => 'joined', (error: Error) => error.name);
    await vi.waitFor(() => expect(topics.opened).toHaveLength(1));
    await svc.leaveChannel();
    await expect(settled).resolves.toBe('AbortError');
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(topics.opened[0].close).toHaveBeenCalledTimes(1);
  });

  it('refused, and followed by another join, leaves the newer one alone', async () => {
    const { svc, s } = service();
    const first = svc.joinChannel('room-1', ALICE).catch(() => false);
    await vi.waitFor(() => expect(topics.opened).toHaveLength(1));
    const second = svc.joinChannel('room-2', ALICE);
    await vi.waitFor(() => expect(topics.opened).toHaveLength(2));
    await first;
    topics.opened[0].options.onRefused(new Error('not admitted'));
    topics.opened[1].options.onSubscribed(false);
    await expect(second).resolves.toBe(true);
    expect(topics.opened[0].close).toHaveBeenCalled();
    expect(topics.opened[1].close).not.toHaveBeenCalled();
    expect(s.channelId).toBe('room-2');
    expect(tracks[1].stop).not.toHaveBeenCalled();
  });
});

/** getUserMedia answers when the test says; the microphone and camera prompts of a page. */
function prompts() {
  const asked: Array<{ constraints: any; allow: () => any; refuse: () => void }> = [];
  (navigator as any).mediaDevices.getUserMedia = vi.fn((constraints: any) => new Promise((resolve, reject) => {
    asked.push({
      constraints,
      allow: () => {
        const track = { kind: constraints.video ? 'video' : 'audio', id: `t-${asked.length}`, enabled: true, stop: vi.fn(), getSettings: () => ({}) };
        resolve({
          getTracks: () => [track],
          getAudioTracks: () => (constraints.video ? [] : [track]),
          getVideoTracks: () => (constraints.video ? [track] : []),
          addTrack: vi.fn(),
          removeTrack: vi.fn(),
        });
        return track;
      },
      refuse: () => reject(new DOMException('denied', 'NotAllowedError')),
    });
  }));
  return asked;
}

describe('a P2P join cancelled at its microphone prompt', () => {
  async function cancelledThenJoined() {
    const asked = prompts();
    const made = service();
    const controller = new AbortController();
    const first = made.svc.joinChannel('room-1', ALICE, controller.signal).then(() => 'joined', (error: Error) => error.name);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    controller.abort();
    await made.svc.leaveChannel();

    const second = made.svc.joinChannel('room-2', ALICE);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    const microphone = asked[1].allow();
    await vi.waitFor(() => expect(topics.opened).toHaveLength(1));
    topics.opened[0].options.onSubscribed(false);
    await expect(second).resolves.toBe(true);
    return { ...made, asked, first, microphone };
  }

  it('and answered during the next join, stops its own microphone alone and leaves that call up', async () => {
    const { svc, s, asked, first, microphone } = await cancelledThenJoined();
    const late = asked[0].allow();
    await expect(first).resolves.toBe('AbortError');
    expect(late.stop).toHaveBeenCalled();
    expect(microphone.stop).not.toHaveBeenCalled();
    expect(svc.getLocalStream()!.getAudioTracks()).toEqual([microphone]);
    expect(s.rawMicTrack).toBe(microphone);
    expect(s.channelId).toBe('room-2');
    expect(topics.opened).toHaveLength(1);
    expect(topics.opened[0].close).not.toHaveBeenCalled();
    await svc.leaveChannel();
  });

  it('and refused during the next join, prompts no second time', async () => {
    const { svc, s, asked, first, microphone } = await cancelledThenJoined();
    s.selectedInputDevice = 'headset';
    asked[0].refuse();
    await expect(first).resolves.toBe('AbortError');
    expect(asked).toHaveLength(2);
    expect(s.selectedInputDevice).toBe('headset');
    expect(microphone.stop).not.toHaveBeenCalled();
    await svc.leaveChannel();
  });

  it('with no join after it, stops the microphone answered late and opens nothing', async () => {
    const asked = prompts();
    const { svc, events } = service();
    const controller = new AbortController();
    const join = svc.joinChannel('room-1', ALICE, controller.signal).then(() => 'joined', (error: Error) => error.name);
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    controller.abort();
    await svc.leaveChannel();
    const late = asked[0].allow();
    await expect(join).resolves.toBe('AbortError');
    expect(late.stop).toHaveBeenCalled();
    expect(svc.getLocalStream()).toBeNull();
    expect(topics.opened).toHaveLength(0);
    expect(events).not.toContain('channel-joined');
  });
});

describe('a capture prompt that outlives the call', () => {
  it('the camera answered after it is stopped, and no later call sends it', async () => {
    const { svc, s } = await joined();
    const asked = prompts();
    const toggled = svc.toggleVideo();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await svc.leaveChannel();

    const next = svc.joinChannel('room-2', ALICE);
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    const microphone = asked[1].allow();
    await vi.waitFor(() => expect(topics.opened).toHaveLength(2));
    topics.opened[1].options.onSubscribed(false);
    await next;

    const camera = asked[0].allow();
    await expect(toggled).resolves.toBe(false);
    expect(camera.stop).toHaveBeenCalled();
    expect(svc.getLocalState().isVideoEnabled).toBe(false);
    expect(svc.getLocalStream()!.getTracks()).toEqual([microphone]);
    expect((s.localStream.addTrack as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
    await svc.leaveChannel();
  });

  it('the camera answered with no call is stopped', async () => {
    const { svc } = await joined();
    const asked = prompts();
    const toggled = svc.toggleVideo();
    await vi.waitFor(() => expect(asked).toHaveLength(1));
    await svc.leaveChannel({ silent: true });
    const camera = asked[0].allow();
    await expect(toggled).resolves.toBe(false);
    expect(camera.stop).toHaveBeenCalled();
    expect(svc.getLocalState().isVideoEnabled).toBe(false);
  });

  it('the screen picked after it is stopped', async () => {
    const { svc, s } = await joined();
    let pick!: () => void;
    const screen = { kind: 'video', id: 'screen', stop: vi.fn() };
    (navigator as any).mediaDevices.getDisplayMedia = vi.fn(() => new Promise((resolve) => {
      pick = () => resolve({ getTracks: () => [screen], getVideoTracks: () => [screen], getAudioTracks: () => [] });
    }));
    const toggled = svc.toggleScreenShare();
    await svc.leaveChannel();
    pick();
    await expect(toggled).resolves.toBe(false);
    expect(screen.stop).toHaveBeenCalled();
    expect(s.localScreenStream).toBeNull();
    expect(svc.getLocalState().isScreenSharing).toBe(false);
  });
});

describe('a P2P leave', () => {
  it('sends user-left, closes the topic and says it left', async () => {
    const { svc, events } = await joined();
    await svc.leaveChannel();
    expect(sentTypes()).toContain('user-left');
    expect(topics.opened[0].close).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['channel-joined', 'channel-left']);
  });

  it('silent, sends nothing, queued signals included, and stops the microphone at once', async () => {
    const { svc, s, events } = await joined();
    await vi.waitFor(() => expect(sentTypes()).toContain('state-sync'));
    rpc().mockClear();
    let answer!: () => void;
    rpc().mockImplementationOnce(() => new Promise((resolve) => { answer = () => resolve({ data: null, error: null } as never); }) as never);
    s.broadcastMessage({ type: 'media-state', from: ALICE, data: {}, timestamp: 1 });
    s.broadcastMessage({ type: 'call-start-time', from: ALICE, data: {}, timestamp: 2 });

    const left = svc.leaveChannel({ silent: true });
    expect(tracks[0].stop).toHaveBeenCalled();
    expect(svc.getLocalStream()).toBeNull();
    await left;
    answer();
    await new Promise((resolve) => setTimeout(resolve, 250));
    // The request already under way is the last one.
    expect(sentTypes()).toEqual(['media-state']);
    expect(topics.opened[0].close).toHaveBeenCalledTimes(1);
    expect(events).toContain('channel-left');
  });

  it('waits for user-left at most 2 s', async () => {
    const { svc } = await joined();
    await vi.waitFor(() => expect(sentTypes()).toContain('state-sync'));
    vi.useFakeTimers();
    rpc().mockImplementation(() => new Promise(() => {}) as never);
    const left = vi.fn();
    void svc.leaveChannel().then(left);
    await vi.advanceTimersByTimeAsync(1_900);
    expect(left).not.toHaveBeenCalled();
    // The microphone is released before the wait.
    expect(tracks[0].stop).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(200);
    expect(left).toHaveBeenCalled();
  });
});

describe('a page in a P2P call', () => {
  const pagehide = (persisted: boolean) => {
    const event = new Event('pagehide');
    Object.defineProperty(event, 'persisted', { value: persisted });
    window.dispatchEvent(event);
  };

  it('stays in it on beforeunload: a navigation that becomes a download', async () => {
    const { svc, s, events } = await joined();
    window.dispatchEvent(new Event('beforeunload', { cancelable: true }));
    await Promise.resolve();
    expect(s.channelId).toBe('room-1');
    expect(tracks[0].stop).not.toHaveBeenCalled();
    expect(events).not.toContain('channel-left');
    await svc.leaveChannel();
  });

  it('leaves on pagehide', async () => {
    const { s, events } = await joined();
    pagehide(false);
    expect(s.channelId).toBeNull();
    expect(tracks[0].stop).toHaveBeenCalled();
    await vi.waitFor(() => expect(events).toContain('channel-left'));
    expect(events).not.toContain('connection-lost');
  });

  it('reports the lost call when it can be restored from the back/forward cache', async () => {
    const { events } = await joined();
    pagehide(true);
    await vi.waitFor(() => expect(events).toContain('connection-lost'));
  });
});
