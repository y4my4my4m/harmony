import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('livekit-client', () => ({
  setLogLevel: () => {},
  LogLevel: { debug: 0, warn: 1 },
  Track: { Source: { Microphone: 'microphone' } },
  ConnectionState: { Connected: 'connected' },
}));

import { LiveKitWebRTCService, loadLiveKit } from '../livekitWebRTC';
import { closeVoiceAudioContext } from '../voice/voiceAudioContext';
import { UNITY_RELEASE_MS } from '../voice/micGain';

class FakeNode {
  connect() {}
  disconnect() {}
  channelCount = 2;
  channelCountMode = 'max';
}
class FakeTrack {
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
  createGain() {
    const g = Object.assign(new FakeNode(), {
      gain: { value: 1, setTargetAtTime(v: number) { g.gain.value = v; } },
    });
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

// Mirrors the parts of livekit-client's LocalAudioTrack the service drives.
class FakeLocalAudioTrack {
  raw = new FakeTrack('capture');
  processor: any;
  audioContext: unknown;
  muted = false;
  getProcessor() { return this.processor; }
  setAudioContext(ctx: unknown) { this.audioContext = ctx; }
  async setProcessor(p: any) {
    await p.init({ kind: 'audio', track: this.raw, audioContext: this.audioContext });
    this.processor = p;
  }
  async stopProcessor() {
    this.processor?.processedTrack?.stop();
    await this.processor?.destroy();
    this.processor = undefined;
  }
  async mute() { this.muted = true; this.raw.enabled = false; }
  async unmute() { this.muted = false; this.raw.enabled = true; }
  get mediaStreamTrack() { return this.processor?.processedTrack ?? this.raw; }
}

function connectedService(track: FakeLocalAudioTrack): LiveKitWebRTCService {
  const svc = new LiveKitWebRTCService();
  (svc as any).room = {
    state: 'disconnected',
    localParticipant: { getTrackPublication: (source: string) => (source === 'microphone' ? { track } : undefined) },
  };
  return svc;
}

const settle = (svc: LiveKitWebRTCService) => (svc as any).micGainChain as Promise<void>;

describe('LiveKit input gain', () => {
  beforeEach(async () => {
    gains = [];
    vi.stubGlobal('AudioContext', FakeAudioContext);
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    await loadLiveKit();
    await closeVoiceAudioContext();
  });

  afterEach(async () => {
    vi.useRealTimers();
    await closeVoiceAudioContext();
    vi.unstubAllGlobals();
  });

  it('sends the capture track untouched at 100 %', async () => {
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setInputVolume(100);
    await settle(svc);
    expect(track.getProcessor()).toBeUndefined();
    expect(track.mediaStreamTrack).toBe(track.raw);
    expect(gains).toHaveLength(0);
  });

  it('attaches a gain stage off unity and adjusts it in place', async () => {
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setInputVolume(50);
    await settle(svc);
    const processor = track.getProcessor();
    expect(processor?.name).toBe('harmony-input-gain');
    expect(track.mediaStreamTrack).not.toBe(track.raw);
    expect(gains[0].gain.value).toBe(0.5);

    svc.setInputVolume(180);
    await settle(svc);
    expect(track.getProcessor()).toBe(processor);
    expect(gains).toHaveLength(1);
    expect(gains[0].gain.value).toBeCloseTo(1.8);
  });

  it('returns to the capture track once 100 % has settled', async () => {
    vi.useFakeTimers();
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setInputVolume(70);
    await settle(svc);
    const processed = track.mediaStreamTrack as unknown as FakeTrack;

    svc.setInputVolume(100);
    await settle(svc);
    expect(gains[0].gain.value).toBe(1);
    expect(track.getProcessor()).toBeDefined();

    await vi.advanceTimersByTimeAsync(UNITY_RELEASE_MS + 10);
    await settle(svc);
    expect(track.getProcessor()).toBeUndefined();
    expect(track.mediaStreamTrack).toBe(track.raw);
    expect(processed.stopped).toBe(true);
  });

  it('a drag across 100 % keeps the stage', async () => {
    vi.useFakeTimers();
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setInputVolume(90);
    await settle(svc);
    const processor = track.getProcessor();
    svc.setInputVolume(100);
    await settle(svc);
    svc.setInputVolume(110);
    await settle(svc);
    await vi.advanceTimersByTimeAsync(UNITY_RELEASE_MS + 10);
    await settle(svc);
    expect(track.getProcessor()).toBe(processor);
    expect(gains[0].gain.value).toBeCloseTo(1.1);
  });

  it('mute gates both the capture and the processed track', async () => {
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setInputVolume(150);
    await settle(svc);
    const processed = track.mediaStreamTrack as unknown as FakeTrack;

    svc.setMuted(true);
    await Promise.resolve();
    expect(track.muted).toBe(true);
    expect(track.raw.enabled).toBe(false);
    expect(processed.enabled).toBe(false);
    expect(gains[0].gain.value).toBe(1.5);

    svc.setMuted(false);
    await Promise.resolve();
    expect(processed.enabled).toBe(true);
    expect(track.raw.enabled).toBe(true);
  });

  it('attaches with the processed track already gated when muted', async () => {
    const track = new FakeLocalAudioTrack();
    const svc = connectedService(track);
    svc.setMuted(true);
    svc.setInputVolume(40);
    await settle(svc);
    expect((track.mediaStreamTrack as unknown as FakeTrack).enabled).toBe(false);
  });

  it('leaves the capture track in place when the gain stage cannot run', async () => {
    const track = new FakeLocalAudioTrack();
    track.setProcessor = async () => { throw new Error('no context'); };
    const svc = connectedService(track);
    svc.setInputVolume(60);
    await settle(svc);
    expect(track.mediaStreamTrack).toBe(track.raw);
  });
});
