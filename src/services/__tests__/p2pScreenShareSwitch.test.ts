import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnifiedWebRTCService } from '../unifiedWebRTC';

class FakeTrack {
  stopped = false;
  onended: (() => void) | null = null;
  constructor(public kind: 'audio' | 'video', public id: string) {}
  stop() { this.stopped = true; }
}
class FakeMediaStream {
  id = 'screen-stream';
  constructor(public tracks: FakeTrack[] = []) {}
  getVideoTracks() { return this.tracks.filter(t => t.kind === 'video'); }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getTracks() { return this.tracks; }
  addTrack(t: FakeTrack) { this.tracks.push(t); }
  removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

function sender(track: FakeTrack) {
  const s = { track: track as FakeTrack | null, replaceTrack: vi.fn(async (t: FakeTrack) => { s.track = t; }) };
  return s;
}

/** A P2P call sharing `tracks` with one peer; the next picker answers `picked`. */
function sharing(tracks: FakeTrack[], picked: () => Promise<FakeMediaStream>) {
  const svc = new UnifiedWebRTCService();
  const s = svc as any;
  const screen = new FakeMediaStream([...tracks]);
  const senders = tracks.map(sender);
  const added: Array<{ track: FakeTrack; stream: FakeMediaStream }> = [];
  const removed: unknown[] = [];
  s.localScreenStream = screen;
  s.localMediaState.isScreenSharing = true;
  s.connections.set('peer', {
    peerConnection: {
      getSenders: () => senders,
      addTrack: (track: FakeTrack, stream: FakeMediaStream) => { added.push({ track, stream }); },
      removeTrack: (x: unknown) => { removed.push(x); },
    },
  });
  s.getVideoConstraints = () => ({ width: 1280, height: 720, frameRate: 30 });
  const renegotiate = vi.fn(async () => {});
  s.renegotiateWithPeer = renegotiate;
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: vi.fn(picked) } });
  return { svc, screen, senders, added, removed, renegotiate };
}

afterEach(() => vi.unstubAllGlobals());

describe('P2P screen share switch', () => {
  it('swaps tracks in place on the same screen stream, without renegotiating', async () => {
    const oldVideo = new FakeTrack('video', 'v1');
    const oldAudio = new FakeTrack('audio', 'a1');
    const newVideo = new FakeTrack('video', 'v2');
    const newAudio = new FakeTrack('audio', 'a2');
    const { svc, screen, senders, renegotiate } = sharing(
      [oldVideo, oldAudio],
      async () => new FakeMediaStream([newVideo, newAudio]),
    );

    expect(await svc.switchScreenShare()).toBe(true);
    expect(senders.map(s => s.track)).toEqual([newVideo, newAudio]);
    expect(screen.getTracks()).toEqual([newVideo, newAudio]);
    expect([oldVideo.stopped, oldAudio.stopped]).toEqual([true, true]);
    expect(renegotiate).not.toHaveBeenCalled();
    expect((svc as any).localMediaState.isScreenSharing).toBe(true);
  });

  it('adds or removes the audio sender when the new surface gains or loses audio', async () => {
    const gain = sharing([new FakeTrack('video', 'v1')], async () => new FakeMediaStream([
      new FakeTrack('video', 'v2'),
      new FakeTrack('audio', 'a2'),
    ]));
    expect(await gain.svc.switchScreenShare()).toBe(true);
    expect(gain.added.map(a => [a.track.id, a.stream])).toEqual([['a2', gain.screen]]);
    expect(gain.renegotiate).toHaveBeenCalledTimes(1);

    const lose = sharing(
      [new FakeTrack('video', 'v1'), new FakeTrack('audio', 'a1')],
      async () => new FakeMediaStream([new FakeTrack('video', 'v2')]),
    );
    expect(await lose.svc.switchScreenShare()).toBe(true);
    expect(lose.removed).toEqual([lose.senders[1]]);
    expect(lose.renegotiate).toHaveBeenCalledTimes(1);
  });

  it('a dismissed picker keeps the current share', async () => {
    const video = new FakeTrack('video', 'v1');
    const { svc, senders, screen } = sharing([video], async () => {
      throw new DOMException('dismissed', 'NotAllowedError');
    });
    expect(await svc.switchScreenShare()).toBe(false);
    expect(senders[0].track).toBe(video);
    expect(screen.getTracks()).toEqual([video]);
    expect(video.stopped).toBe(false);
  });
});
