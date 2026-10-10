import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  Track: {
    Source: { Microphone: 'microphone', ScreenShare: 'screen_share', ScreenShareAudio: 'screen_share_audio' },
    Kind: { Video: 'video', Audio: 'audio' },
  },
  ConnectionState: { Connected: 'connected' },
  LocalAudioTrack: class {
    kind = 'audio';
    constructor(public mediaStreamTrack: unknown, public constraints: unknown, public userProvidedTrack: boolean) {}
    stop() {}
  },
}));

const native = vi.hoisted(() => ({
  supported: false,
  started: [] as Array<{ label: string; displaySurface: string }>,
  disposed: 0,
  stopped: 0,
  failWith: null as unknown,
  failures: [] as unknown[],
}));
vi.mock('../voice/nativeStreamAudio', () => ({
  probeNativeStreamAudio: async () => ({ supported: native.supported, reason: null }),
  nativeStreamAudioSupported: () => native.supported,
  notifyStreamAudioFailed: (e: unknown) => native.failures.push(e),
  PreparedStreamAudio: class {
    async start(surface: { label: string; displaySurface: string }) {
      native.started.push(surface);
      if (native.failWith) throw native.failWith;
      return {
        track: { id: 'native-audio' },
        scope: 'app',
        app: 'Spotify',
        detail: 'app: pid 7',
        stop: async () => { native.stopped++; },
      };
    }
    dispose() { native.disposed++; }
  },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';

function videoTrack(label: string, displaySurface: string) {
  return {
    kind: 'video',
    stopped: false,
    stop() { this.stopped = true; },
    mediaStreamTrack: { label, getSettings: () => ({ width: 1920, height: 1080, frameRate: 30, displaySurface }) },
  };
}

function service(capture: () => Promise<unknown[]>) {
  const svc = new LiveKitWebRTCService();
  const published: Array<{ track: any; options: any }> = [];
  const unpublished: unknown[] = [];
  const createScreenTracks = vi.fn(async (_options: any) => capture());
  (svc as any).room = {
    localParticipant: {
      createScreenTracks,
      publishTrack: vi.fn(async (track: unknown, options: unknown) => { published.push({ track, options }); }),
      unpublishTrack: vi.fn(async (track: unknown) => { unpublished.push(track); }),
      getTrackPublication: (source: string) => {
        const hit = published.find(p => p.options.source === source);
        return hit ? { track: hit.track } : undefined;
      },
    },
  };
  return { svc, published, unpublished, createScreenTracks };
}

beforeAll(async () => {
  await loadLiveKit();
});

beforeEach(() => {
  Object.assign(native, { supported: false, started: [], disposed: 0, stopped: 0, failWith: null, failures: [] });
});

describe('screen share audio', () => {
  it('desktop: asks the picker for no audio and publishes the native capture as stream audio', async () => {
    native.supported = true;
    const { svc, published, createScreenTracks } = service(async () => [videoTrack('window:42:0', 'window')]);
    await (svc as any).startScreenShare();

    expect(createScreenTracks.mock.calls[0][0].audio).toBe(false);
    expect(native.started).toEqual([{ label: 'window:42:0', displaySurface: 'window' }]);
    expect(published.map(p => p.options.source)).toEqual(['screen_share', 'screen_share_audio']);
    const audio = published[1];
    expect(audio.track.mediaStreamTrack).toEqual({ id: 'native-audio' });
    expect(audio.track.userProvidedTrack).toBe(true);
    expect(audio.options).toMatchObject({ dtx: false, red: false, forceStereo: true });
  });

  it('stopping the share stops native capture', async () => {
    native.supported = true;
    const { svc } = service(async () => [videoTrack('screen:0:0', 'monitor')]);
    await (svc as any).startScreenShare();
    await (svc as any).stopScreenShare();
    expect(native.stopped).toBe(1);
  });

  it('desktop with Share audio off: no audio from the picker or natively', async () => {
    native.supported = true;
    const { svc, published, createScreenTracks } = service(async () => [videoTrack('screen:0:0', 'monitor')]);
    await svc.updateStreamQuality({ shareAudio: false });
    await (svc as any).startScreenShare();
    expect(createScreenTracks.mock.calls[0][0].audio).toBe(false);
    expect(native.started).toEqual([]);
    expect(published.map(p => p.options.source)).toEqual(['screen_share']);
  });

  it('browser: the picker supplies audio as before', async () => {
    const { svc, createScreenTracks } = service(async () => [videoTrack('screen:0:0', 'monitor')]);
    await (svc as any).startScreenShare();
    expect(createScreenTracks.mock.calls[0][0].audio).toMatchObject({ echoCancellation: false, restrictOwnAudio: true });
    expect(native.started).toEqual([]);
  });

  it('a failed native capture streams video alone and says why', async () => {
    native.supported = true;
    native.failWith = new Error('permission: declined');
    const { svc, published } = service(async () => [videoTrack('screen:0:0', 'monitor')]);
    await (svc as any).startScreenShare();
    expect(native.failures).toEqual([native.failWith]);
    expect(published.map(p => p.options.source)).toEqual(['screen_share']);
  });

  it('a dismissed picker releases the prepared audio context', async () => {
    native.supported = true;
    const dismissed = new DOMException('dismissed', 'NotAllowedError');
    const { svc } = service(async () => { throw dismissed; });
    await expect((svc as any).startScreenShare()).rejects.toBe(dismissed);
    expect(native.disposed).toBe(1);
  });
});
