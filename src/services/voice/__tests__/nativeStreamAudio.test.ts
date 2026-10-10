import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const invoke = vi.fn();
const channels: Array<{ onmessage: (m: string) => void }> = [];
vi.mock('@tauri-apps/api/core', () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  Channel: class {
    onmessage: (m: string) => void = () => {};
    constructor() { channels.push(this); }
  },
}));
const warning = vi.fn();
vi.mock('vue-toastification', () => ({ useToast: () => ({ warning }) }));

import { PreparedStreamAudio, StreamAudioError, activeStreamAudio, notifyStreamAudioFailed } from '../nativeStreamAudio';

const posted: unknown[] = [];
let contexts: FakeAudioContext[] = [];

class FakeTrack {
  kind = 'audio';
  stopped = false;
  stop() { this.stopped = true; }
}
class FakeAudioContext {
  state = 'suspended';
  closed = false;
  modules: string[] = [];
  track = new FakeTrack();
  audioWorklet = { addModule: async (url: string) => { this.modules.push(url); } };
  constructor(public options: unknown) { contexts.push(this); }
  createMediaStreamDestination() {
    const track = this.track;
    return { channelCount: 1, stream: { getAudioTracks: () => [track] } };
  }
  async resume() { this.state = 'running'; }
  async close() { this.closed = true; this.state = 'closed'; }
}
class FakeWorkletNode {
  disconnected = false;
  port = { postMessage: (data: unknown) => posted.push(data) };
  constructor(public context: unknown, public name: string, public options: unknown) {}
  connect() {}
  disconnect() { this.disconnected = true; }
}

const STARTED = { sampleRate: 48000, channels: 2, blockFrames: 960, scope: 'app', app: 'Spotify', detail: 'app: pid 7' };

beforeEach(() => {
  vi.stubGlobal('AudioContext', FakeAudioContext);
  vi.stubGlobal('AudioWorkletNode', FakeWorkletNode);
  invoke.mockReset();
  channels.length = 0;
  posted.length = 0;
  contexts = [];
  warning.mockReset();
});
afterEach(() => vi.unstubAllGlobals());

describe('StreamAudioError.from', () => {
  it('reads the kind prefix of command errors', () => {
    expect(StreamAudioError.from('permission: SCStreamErrorUserDeclined')).toMatchObject({ kind: 'permission', message: 'SCStreamErrorUserDeclined' });
    expect(StreamAudioError.from(new Error('unsupported: macOS 12'))).toMatchObject({ kind: 'unsupported', message: 'macOS 12' });
    expect(StreamAudioError.from('something else')).toMatchObject({ kind: 'failed', message: 'something else' });
  });
});

describe('PreparedStreamAudio', () => {
  it('starts capture for the shared surface and feeds blocks to the worklet in order', async () => {
    invoke.mockResolvedValueOnce(STARTED);
    const prepared = new PreparedStreamAudio();
    const audio = await prepared.start({ label: 'window:42:0', displaySurface: 'window' });

    expect(contexts[0].options).toMatchObject({ sampleRate: 48000 });
    expect(contexts[0].modules).toHaveLength(1);
    expect(invoke).toHaveBeenCalledWith('stream_audio_start', {
      surface: { label: 'window:42:0', displaySurface: 'window' },
      onAudio: channels[0],
    });
    expect(audio).toMatchObject({ scope: 'app', app: 'Spotify', track: contexts[0].track });

    // s16le [1, -2] and [300, -300]
    channels[0].onmessage(btoa(String.fromCharCode(1, 0, 0xfe, 0xff)));
    channels[0].onmessage(btoa(String.fromCharCode(0x2c, 0x01, 0xd4, 0xfe)));
    expect(posted.map(b => Array.from(new Int16Array(b as ArrayBuffer)))).toEqual([[1, -2], [300, -300]]);
  });

  it('stop ends native capture, the track and the context; later blocks are dropped', async () => {
    invoke.mockResolvedValueOnce(STARTED).mockResolvedValueOnce(undefined);
    const audio = await new PreparedStreamAudio().start({ label: 'screen:0:0', displaySurface: 'monitor' });
    expect(activeStreamAudio.value).toEqual({ scope: 'app', app: 'Spotify', detail: 'app: pid 7' });
    await audio.stop();
    expect(activeStreamAudio.value).toBeNull();
    expect(invoke).toHaveBeenLastCalledWith('stream_audio_stop');
    expect(contexts[0].track.stopped).toBe(true);
    expect(contexts[0].closed).toBe(true);
    channels[0].onmessage(btoa('\u0001\u0000\u0001\u0000'));
    expect(posted).toHaveLength(0);
  });

  it('closes the context and reports the kind when capture fails', async () => {
    invoke.mockRejectedValueOnce('permission: Screen Recording not granted');
    const error = await new PreparedStreamAudio().start({ label: '', displaySurface: 'monitor' }).catch(e => e);
    expect(error).toBeInstanceOf(StreamAudioError);
    expect(error.kind).toBe('permission');
    expect(contexts[0].closed).toBe(true);
  });

  it('does not wait on a context WebKit holds suspended; the next press resumes it', async () => {
    class HeldAudioContext extends FakeAudioContext {
      resumes = 0;
      resume() {
        this.resumes++;
        return new Promise<void>(() => {});
      }
    }
    vi.stubGlobal('AudioContext', HeldAudioContext);
    invoke.mockResolvedValueOnce(STARTED);
    const audio = await new PreparedStreamAudio().start({ label: 'screen:0:0', displaySurface: 'monitor' });
    const held = contexts[0] as HeldAudioContext;
    expect(audio.track).toBe(held.track);

    const resumes = held.resumes;
    window.dispatchEvent(new Event('pointerdown'));
    expect(held.resumes).toBe(resumes + 1);
    window.dispatchEvent(new Event('keydown'));
    expect(held.resumes).toBe(resumes + 1);
  });

  it('retarget restarts capture on a new channel into the same track', async () => {
    invoke.mockResolvedValueOnce(STARTED).mockResolvedValueOnce({ ...STARTED, scope: 'system', app: null, detail: 'system' });
    const audio = await new PreparedStreamAudio().start({ label: 'VLC', displaySurface: 'window' });
    await audio.retarget({ label: 'screen:0:0', displaySurface: 'monitor' });

    expect(invoke).toHaveBeenLastCalledWith('stream_audio_start', {
      surface: { label: 'screen:0:0', displaySurface: 'monitor' },
      onAudio: channels[1],
    });
    expect(audio).toMatchObject({ scope: 'system', app: null, track: contexts[0].track });
    expect(activeStreamAudio.value).toEqual({ scope: 'system', app: null, detail: 'system' });
    channels[0].onmessage(btoa('\u0001\u0000\u0001\u0000'));
    channels[1].onmessage(btoa(String.fromCharCode(1, 0, 0xfe, 0xff)));
    expect(posted.map(b => Array.from(new Int16Array(b as ArrayBuffer)))).toEqual([[1, -2]]);
  });

  it('a failed retarget reports its kind and leaves no active source', async () => {
    invoke.mockResolvedValueOnce(STARTED).mockRejectedValueOnce('permission: declined');
    const audio = await new PreparedStreamAudio().start({ label: 'VLC', displaySurface: 'window' });
    const error = await audio.retarget({ label: 'screen:0:0', displaySurface: 'monitor' }).catch(e => e);
    expect(error).toMatchObject({ kind: 'permission' });
    expect(activeStreamAudio.value).toBeNull();
  });

  it('dispose releases a context that never started', () => {
    new PreparedStreamAudio().dispose();
    expect(contexts[0].closed).toBe(true);
  });
});

describe('notifyStreamAudioFailed', () => {
  it('points at the macOS permission for a permission error', () => {
    notifyStreamAudioFailed('permission: declined');
    notifyStreamAudioFailed('failed: device lost');
    expect(warning).toHaveBeenNthCalledWith(1, expect.stringContaining('Screen'));
    expect(warning).toHaveBeenNthCalledWith(2, expect.stringContaining('without sound'));
  });
});
