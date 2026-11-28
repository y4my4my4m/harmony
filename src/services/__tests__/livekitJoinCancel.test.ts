import { beforeEach, describe, expect, it, vi } from 'vitest';

// A LiveKit join, with its own token or a remote host's, that is cancelled or whose call ends while it
// waits (for the library, the connection, the microphone prompt) connects and publishes nothing after,
// and leaves a join that came after it alone.

const tokens = vi.hoisted(() => ({ getLiveKitToken: vi.fn(async (roomName: string) => ({ token: 't', wsUrl: 'wss://own.test', roomName, identity: 'me' })) }));
vi.mock('../livekitTokens', () => tokens);
vi.mock('../voice/remoteAudioMixer', () => ({
  remoteAudioMixer: { setOutputDevice: vi.fn(async () => undefined), reset: vi.fn(), detach: vi.fn(), attach: vi.fn() },
}));

interface Deferred<T> { promise: Promise<T>; resolve: (value: T) => void; reject: (error: unknown) => void }
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

class FakeRoom {
  state = 'disconnected';
  remoteParticipants = new Map();
  connecting = deferred<void>();
  published: unknown[] = [];
  localParticipant = {
    identity: 'me',
    permissions: undefined,
    metadata: undefined,
    trackPublications: new Map(),
    audioTrackPublications: new Map(),
    videoTrackPublications: new Map(),
    on: vi.fn(),
    getTrackPublication: () => undefined,
    publishData: vi.fn(async () => {}),
    publishTrack: vi.fn(async (track: unknown) => { this.published.push(track); }),
    createScreenTracks: vi.fn(),
  };
  on = vi.fn(() => this);
  connect = vi.fn(() => this.connecting.promise.then(() => { this.state = 'connected'; }));
  disconnect = vi.fn(async () => { this.state = 'disconnected'; });
  constructor() { rooms.push(this); }
}

const track = () => ({ stop: vi.fn(), mute: vi.fn(), mediaStreamTrack: { getSettings: () => ({}), stop: vi.fn(), applyConstraints: async () => {} } });
const names = () => new Proxy({}, { get: (_t, name) => String(name) });
let rooms: FakeRoom[] = [];
let microphones: Array<Deferred<ReturnType<typeof track>>> = [];
let cameras: Array<Deferred<ReturnType<typeof track>>> = [];

async function load(gate: Promise<void> = Promise.resolve()) {
  vi.resetModules();
  vi.doMock('livekit-client', async () => {
    await gate;
    return {
      setLogLevel: () => {},
      LogLevel: { debug: 0, warn: 1 },
      Room: FakeRoom,
      RoomEvent: names(), ParticipantEvent: names(), DisconnectReason: names(),
      ConnectionState: { Connected: 'connected' },
      Track: { Source: names(), Kind: names() },
      VideoPresets: { h720: { resolution: { width: 1280, height: 720, frameRate: 30 } } },
      RemoteAudioTrack: class {},
      createLocalAudioTrack: vi.fn(() => { const d = deferred<ReturnType<typeof track>>(); microphones.push(d); return d.promise; }),
      createLocalVideoTrack: vi.fn(() => { const d = deferred<ReturnType<typeof track>>(); cameras.push(d); return d.promise; }),
    };
  });
  const { LiveKitWebRTCService } = await import('../livekitWebRTC');
  const svc = new LiveKitWebRTCService();
  const events: string[] = [];
  for (const event of ['channel-joined', 'error', 'microphone-unavailable']) svc.on(event, () => events.push(event));
  // happy-dom's MediaStream holds no tracks.
  vi.spyOn(svc, 'getLocalStream').mockReturnValue(null);
  return { svc, s: svc as any, events };
}

const outcome = (join: Promise<boolean>) => join.then((ok) => ok, (error: Error) => error.name);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

/** A join of `svc` that has connected and published `microphone`. */
async function connected(join: Promise<boolean>, room: () => FakeRoom, microphone = track()) {
  await vi.waitFor(() => expect(room()).toBeTruthy());
  room().connecting.resolve();
  await vi.waitFor(() => expect(microphones.length).toBeGreaterThan(0));
  microphones.at(-1)!.resolve(microphone);
  await expect(join).resolves.toBe(true);
  return microphone;
}

beforeEach(() => {
  rooms = [];
  microphones = [];
  cameras = [];
});

describe('a token join', () => {
  it.each(['cancelled', 'left with the session'])('%s while the library loads, makes no room and opens no microphone', async (how) => {
    const gate = deferred<void>();
    const { svc, events } = await load(gate.promise);
    const controller = new AbortController();
    const join = outcome(svc.joinWithToken('wss://remote.test', 't', 'c1', 'me', controller.signal));
    await tick();
    if (how === 'cancelled') controller.abort();
    else await svc.leaveChannel();
    gate.resolve();
    await expect(join).resolves.toBe('AbortError');
    expect(rooms).toEqual([]);
    expect(microphones).toEqual([]);
    expect(events).toEqual([]);
  });

  it('cancelled before it starts, touches nothing', async () => {
    const { svc } = await load();
    await expect(outcome(svc.joinWithToken('wss://remote.test', 't', 'c1', 'me', AbortSignal.abort()))).resolves.toBe('AbortError');
    expect(rooms).toEqual([]);
  });

  it.each(['cancelled', 'left with the session'])('%s while it connects, publishes nothing once connected', async (how) => {
    const { svc, events } = await load();
    const controller = new AbortController();
    const join = outcome(svc.joinWithToken('wss://remote.test', 't', 'c1', 'me', controller.signal));
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    if (how === 'cancelled') controller.abort();
    else await svc.leaveChannel();
    rooms[0].connecting.resolve();
    await expect(join).resolves.toBe('AbortError');
    expect(rooms[0].disconnect).toHaveBeenCalled();
    expect(microphones).toEqual([]);
    expect(rooms[0].published).toEqual([]);
    expect(events).toEqual([]);
  });

  it('left at its microphone prompt, stops the microphone answered late', async () => {
    const { svc, events } = await load();
    const join = outcome(svc.joinWithToken('wss://remote.test', 't', 'c1', 'me'));
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    rooms[0].connecting.resolve();
    await vi.waitFor(() => expect(microphones).toHaveLength(1));
    await svc.leaveChannel();
    const late = track();
    microphones[0].resolve(late);
    await expect(join).resolves.toBe('AbortError');
    expect(late.stop).toHaveBeenCalled();
    expect(rooms[0].published).toEqual([]);
    expect(events).toEqual([]);
  });

  it('that is not cancelled connects and publishes', async () => {
    const { svc, events } = await load();
    const microphone = await connected(svc.joinWithToken('wss://remote.test', 't', 'c1', 'me', new AbortController().signal), () => rooms[0]);
    expect(rooms[0].published).toEqual([microphone]);
    expect(events).toEqual(['channel-joined']);
    await svc.leaveChannel();
  });
});

describe('a join cancelled while it waits, and the one after it', () => {
  async function cancelledThenJoined(start: (svc: any, signal: AbortSignal) => Promise<boolean>) {
    const made = await load();
    const controller = new AbortController();
    const first = outcome(start(made.svc, controller.signal));
    await vi.waitFor(() => expect(rooms).toHaveLength(1));
    return { ...made, controller, first };
  }

  it.each([
    ['a local room', (svc: any, signal: AbortSignal) => svc.joinChannel('c1', 'me', 'voice_channel', signal)],
    ['a remote host', (svc: any, signal: AbortSignal) => svc.joinWithToken('wss://remote.test', 't', 'c1', 'me', signal)],
  ])('%s: the microphone answered during the next join is stopped, and that call goes on', async (_where, start) => {
    const { svc, s, controller, first } = await cancelledThenJoined(start);
    rooms[0].connecting.resolve();
    await vi.waitFor(() => expect(microphones).toHaveLength(1));
    // A local join captures before it connects; it waits for the answer once connected.
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await svc.leaveChannel();

    const own = track();
    await connected(svc.joinChannel('c2', 'me'), () => rooms[1], own);
    const late = track();
    microphones[0].resolve(late);
    await expect(first).resolves.toBe('AbortError');
    await tick();

    expect(late.stop).toHaveBeenCalled();
    expect(rooms[1].published).toEqual([own]);
    expect(own.stop).not.toHaveBeenCalled();
    expect(rooms[1].disconnect).not.toHaveBeenCalled();
    expect(s.room).toBe(rooms[1]);
    expect(s.channelId).toBe('c2');
    await svc.leaveChannel();
  });

  it('a connection that fails during the next join is not that join\'s', async () => {
    const { svc, s, controller, first, events } = await cancelledThenJoined((svc, signal) => svc.joinChannel('c1', 'me', 'voice_channel', signal));
    controller.abort();
    await svc.leaveChannel();
    await connected(svc.joinChannel('c2', 'me'), () => rooms[1]);
    rooms[0].connecting.reject(new Error('Client initiated disconnect'));
    await expect(first).resolves.toBe('AbortError');
    expect(s.room).toBe(rooms[1]);
    expect(rooms[1].disconnect).not.toHaveBeenCalled();
    expect(events).toEqual(['channel-joined']);
    await svc.leaveChannel();
  });

  it('a leave whose disconnect ends during the next join leaves its state alone', async () => {
    const { svc, s } = await load();
    await connected(svc.joinChannel('c1', 'me'), () => rooms[0]);
    const slow = deferred<void>();
    rooms[0].disconnect.mockImplementationOnce(() => slow.promise);
    const left = svc.leaveChannel();
    await connected(svc.joinChannel('c2', 'me'), () => rooms[1]);
    slow.resolve();
    await left;
    expect(s.room).toBe(rooms[1]);
    expect(s.channelId).toBe('c2');
    await svc.leaveChannel();
  });
});

describe('a camera or screen prompt that outlives the call', () => {
  it('the camera answered during the next call is stopped and not published there', async () => {
    const { svc } = await load();
    await connected(svc.joinChannel('c1', 'me'), () => rooms[0]);
    const toggled = svc.toggleVideo();
    await vi.waitFor(() => expect(cameras).toHaveLength(1));
    await svc.leaveChannel();
    const microphone = await connected(svc.joinChannel('c2', 'me'), () => rooms[1]);
    const camera = track();
    cameras[0].resolve(camera);
    await expect(toggled).resolves.toBe(false);
    expect(camera.stop).toHaveBeenCalled();
    expect(rooms[1].published).toEqual([microphone]);
    await svc.leaveChannel();
  });

  it('the screen picked during the next call is stopped and not published there', async () => {
    const { svc } = await load();
    await connected(svc.joinChannel('c1', 'me'), () => rooms[0]);
    const picked = deferred<unknown[]>();
    rooms[0].localParticipant.createScreenTracks.mockReturnValue(picked.promise);
    const toggled = svc.toggleScreenShare();
    await svc.leaveChannel();
    await connected(svc.joinChannel('c2', 'me'), () => rooms[1]);
    const screen = { ...track(), kind: 'Video' };
    picked.resolve([screen]);
    await expect(toggled).resolves.toBe(false);
    expect(screen.stop).toHaveBeenCalled();
    expect(svc.getLocalState().isScreenSharing).toBe(false);
    await svc.leaveChannel();
  });
});
