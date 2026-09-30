import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { UnifiedWebRTCService } from '../unifiedWebRTC';
import { closeVoiceAudioContext } from '../voice/voiceAudioContext';
import { UNITY_RELEASE_MS } from '../voice/micGain';

class FakeNode {
  connect() {}
  disconnect() {}
  channelCount = 2;
  channelCountMode = 'max';
}
class FakeTrack {
  kind = 'audio';
  enabled = true;
  stopped = false;
  constructor(public id: string) {}
  stop() { this.stopped = true; }
}
let gains: Array<FakeNode & { gain: { value: number; setTargetAtTime: (v: number) => void } }> = [];
class FakeAudioContext {
  state = 'running';
  currentTime = 0;
  createMediaStreamSource() { return new FakeNode(); }
  createAnalyser() { return Object.assign(new FakeNode(), { fftSize: 256, frequencyBinCount: 128, getByteFrequencyData() {} }); }
  createGain() {
    const g = Object.assign(new FakeNode(), { gain: { value: 1, setTargetAtTime(v: number) { g.gain.value = v; } } });
    gains.push(g);
    return g;
  }
  createMediaStreamDestination() {
    const track = new FakeTrack('processed');
    return Object.assign(new FakeNode(), { stream: { getAudioTracks: () => [track] } });
  }
  addEventListener() {}
  removeEventListener() {}
  async resume() {}
  async close() { this.state = 'closed'; }
}
class FakeMediaStream {
  tracks: FakeTrack[];
  constructor(tracks: FakeTrack[] = []) { this.tracks = [...tracks]; }
  getAudioTracks() { return this.tracks.filter(t => t.kind === 'audio'); }
  getTracks() { return this.tracks; }
  addTrack(t: FakeTrack) { this.tracks.push(t); }
  removeTrack(t: FakeTrack) { this.tracks = this.tracks.filter(x => x !== t); }
}

function p2pWithMic() {
  const svc = new UnifiedWebRTCService();
  const raw = new FakeTrack('capture');
  const screenAudio = new FakeTrack('screen-audio');
  const micSender = { track: raw as FakeTrack, replaceTrack: vi.fn(async (t: FakeTrack) => { micSender.track = t; }) };
  const screenSender = { track: screenAudio, replaceTrack: vi.fn() };
  const s = svc as any;
  s.localStream = new FakeMediaStream([raw]);
  s.rawMicTrack = raw;
  s.connections.set('peer', { peerConnection: { getSenders: () => [screenSender, micSender] } });
  return { svc, raw, micSender, screenSender };
}

const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};

describe('P2P input gain', () => {
  beforeEach(async () => {
    gains = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaStream', FakeMediaStream);
    vi.stubGlobal('requestAnimationFrame', () => 0);
    vi.stubGlobal('cancelAnimationFrame', () => {});
    await closeVoiceAudioContext();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeVoiceAudioContext();
    vi.unstubAllGlobals();
  });

  it('routes the mic through the gain stage and swaps only the mic sender', async () => {
    const { svc, raw, micSender, screenSender } = p2pWithMic();
    svc.setInputVolume(50);
    await flush();
    const s = svc as any;
    const outgoing = s.localStream.getAudioTracks()[0];
    expect(outgoing).not.toBe(raw);
    expect(outgoing.id).toBe('processed');
    expect(micSender.replaceTrack).toHaveBeenCalledWith(outgoing);
    expect(screenSender.replaceTrack).not.toHaveBeenCalled();
    expect(gains[0].gain.value).toBe(0.5);
    expect(raw.stopped).toBe(false);
  });

  it('adjusts the live stage without another swap', async () => {
    const { svc, micSender } = p2pWithMic();
    svc.setInputVolume(50);
    await flush();
    svc.setInputVolume(175);
    await flush();
    expect(micSender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBeCloseTo(1.75);
  });

  it('returns to the capture track after settling at 100 %', async () => {
    vi.useFakeTimers();
    const { svc, raw, micSender } = p2pWithMic();
    svc.setInputVolume(50);
    await flush();
    const processed = (svc as any).localStream.getAudioTracks()[0];
    svc.setInputVolume(100);
    expect(gains[0].gain.value).toBe(1);
    await vi.advanceTimersByTimeAsync(UNITY_RELEASE_MS + 10);
    await flush();
    expect((svc as any).localStream.getAudioTracks()[0]).toBe(raw);
    expect(micSender.track).toBe(raw);
    expect(processed.stopped).toBe(true);
  });

  it('mute gates the outgoing processed track', async () => {
    const { svc } = p2pWithMic();
    svc.setInputVolume(150);
    await flush();
    svc.setMuted(true);
    const outgoing = (svc as any).localStream.getAudioTracks()[0];
    expect(outgoing.id).toBe('processed');
    expect(outgoing.enabled).toBe(false);
    expect(gains[0].gain.value).toBe(1.5);
  });

  it('a new capture (device switch) feeds the same outgoing track and stops the old capture', async () => {
    const { svc, raw, micSender } = p2pWithMic();
    svc.setInputVolume(60);
    await flush();
    const outgoing = (svc as any).localStream.getAudioTracks()[0];
    const next = new FakeTrack('capture-2');
    await (svc as any).installCapturedMic(next);
    expect((svc as any).localStream.getAudioTracks()[0]).toBe(outgoing);
    expect(micSender.replaceTrack).toHaveBeenCalledTimes(1);
    expect(raw.stopped).toBe(true);
    expect((svc as any).rawMicTrack).toBe(next);
  });
});
