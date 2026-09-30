import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  RemoteAudioMixer,
  clampVolume,
  effectiveGain,
  playbackPlan,
} from '../remoteAudioMixer';
import { closeVoiceAudioContext, setVoiceAudioSink } from '../voiceAudioContext';

describe('clampVolume', () => {
  it('rounds and clamps to 0-200', () => {
    expect(clampVolume(-5)).toBe(0);
    expect(clampVolume(250)).toBe(200);
    expect(clampVolume(49.6)).toBe(50);
  });

  it('reads non-finite input as unity', () => {
    expect(clampVolume(Number.NaN)).toBe(100);
    expect(clampVolume(Number.POSITIVE_INFINITY)).toBe(100);
  });
});

describe('effectiveGain', () => {
  const base = { volume: 100, localMuted: false, deafened: false, dryMuted: false };

  it('maps percent to linear gain', () => {
    expect(effectiveGain(base)).toBe(1);
    expect(effectiveGain({ ...base, volume: 50 })).toBe(0.5);
    expect(effectiveGain({ ...base, volume: 200 })).toBe(2);
  });

  it('multiplies by the master level', () => {
    expect(effectiveGain({ ...base, volume: 200, master: 50 })).toBe(1);
    expect(effectiveGain({ ...base, volume: 150, master: 200 })).toBe(3);
  });

  it('is zero when muted, deafened or dry-muted', () => {
    expect(effectiveGain({ ...base, localMuted: true })).toBe(0);
    expect(effectiveGain({ ...base, deafened: true })).toBe(0);
    expect(effectiveGain({ ...base, dryMuted: true })).toBe(0);
  });
});

describe('playbackPlan', () => {
  it('plays unity and below through the element', () => {
    expect(playbackPlan(1, true)).toEqual({ elementVolume: 1, boost: null });
    expect(playbackPlan(0.3, true)).toEqual({ elementVolume: 0.3, boost: null });
    expect(playbackPlan(0, true)).toEqual({ elementVolume: 0, boost: null });
  });

  it('silences the element and boosts above unity', () => {
    expect(playbackPlan(1.5, true)).toEqual({ elementVolume: 0, boost: 1.5 });
  });

  it('caps at unity without Web Audio', () => {
    expect(playbackPlan(1.5, false)).toEqual({ elementVolume: 1, boost: null });
  });

  it('treats invalid gain as unity', () => {
    expect(playbackPlan(Number.NaN, true)).toEqual({ elementVolume: 1, boost: null });
  });
});

// Minimal Web Audio stand-ins: enough for the mixer's graph wiring.
class FakeNode {
  connections: unknown[] = [];
  connect(target: unknown) { this.connections.push(target); return target; }
  disconnect() { this.connections = []; }
}
class FakeGain extends FakeNode {
  gain = { value: 1, setTargetAtTime: vi.fn((v: number) => { this.gain.value = v; }) };
}
class FakeContext {
  static instances: FakeContext[] = [];
  state: AudioContextState = 'running';
  currentTime = 0;
  destination = new FakeNode();
  sources: FakeNode[] = [];
  gains: FakeGain[] = [];
  sinkIds: string[] = [];
  constructor() { FakeContext.instances.push(this); }
  createMediaStreamSource() { const n = new FakeNode(); this.sources.push(n); return n; }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createMediaStreamDestination() { return Object.assign(new FakeNode(), { stream: {} }); }
  resume = vi.fn(async () => { this.state = 'running'; });
  close = vi.fn(async () => { this.state = 'closed'; });
  setSinkId = vi.fn(async (id: string) => { this.sinkIds.push(id); });
}

function fakeElement(trackId = 't1') {
  const track = { id: trackId, kind: 'audio' };
  return {
    volume: 1,
    muted: false,
    srcObject: { getAudioTracks: () => [track] },
    play: vi.fn(() => Promise.resolve()),
    pause: vi.fn(),
    setSinkId: vi.fn(() => Promise.resolve()),
    sinkId: '',
  } as unknown as HTMLMediaElement & { play: ReturnType<typeof vi.fn>; setSinkId: ReturnType<typeof vi.fn> };
}

describe('RemoteAudioMixer', () => {
  let mixer: RemoteAudioMixer;

  beforeEach(async () => {
    FakeContext.instances = [];
    vi.stubGlobal('AudioContext', FakeContext);
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
    await closeVoiceAudioContext();
    await setVoiceAudioSink(null);
    mixer = new RemoteAudioMixer();
  });

  afterEach(async () => {
    await closeVoiceAudioContext();
    vi.unstubAllGlobals();
  });

  it('applies a stored volume when the element arrives', () => {
    mixer.setVolume('u1', 'mic', 40);
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    expect(el.volume).toBeCloseTo(0.4);
    expect(el.play).toHaveBeenCalled();
  });

  it('keeps mic and stream volumes independent', () => {
    const mic = fakeElement('m');
    const screen = fakeElement('s');
    mixer.attach('u1', 'mic', mic);
    mixer.attach('u1', 'screen', screen);
    mixer.setVolume('u1', 'screen', 25);
    expect(mic.volume).toBe(1);
    expect(screen.volume).toBeCloseTo(0.25);
  });

  it('boosts through a GainNode above 100 % and returns to the element below', () => {
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    mixer.setVolume('u1', 'mic', 180);
    const ctx = FakeContext.instances[0];
    expect(el.volume).toBe(0);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0].gain.value).toBeCloseTo(1.8);
    expect(ctx.gains[0].connections).toContain(ctx.destination);

    mixer.setVolume('u1', 'mic', 150);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(1.5, 0, expect.any(Number));

    mixer.setVolume('u1', 'mic', 70);
    expect(el.volume).toBeCloseTo(0.7);
    expect(ctx.gains[0].connections).toHaveLength(0);
  });

  it('shares one AudioContext across users', () => {
    mixer.attach('a', 'mic', fakeElement('a'));
    mixer.attach('b', 'screen', fakeElement('b'));
    mixer.setVolume('a', 'mic', 200);
    mixer.setVolume('b', 'screen', 200);
    expect(FakeContext.instances).toHaveLength(1);
    expect(FakeContext.instances[0].gains).toHaveLength(2);
  });

  it('local mute silences without losing the volume', () => {
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    mixer.setVolume('u1', 'mic', 60);
    mixer.setLocalMute('u1', 'mic', true);
    expect(el.volume).toBe(0);
    expect(mixer.getVolume('u1', 'mic')).toBe(60);
    expect(mixer.getEffectiveVolume('u1', 'mic')).toBe(0);
    mixer.setLocalMute('u1', 'mic', false);
    expect(el.volume).toBeCloseTo(0.6);
  });

  it('deafen silences boosted tracks too', () => {
    const el = fakeElement();
    mixer.attach('u1', 'screen', el);
    mixer.setVolume('u1', 'screen', 200);
    mixer.setDeafened(true);
    expect(el.volume).toBe(0);
    expect(FakeContext.instances[0].gains[0].connections).toHaveLength(0);
  });

  it('dry mute applies to mic only', () => {
    const mic = fakeElement('m');
    const screen = fakeElement('s');
    mixer.attach('u1', 'mic', mic);
    mixer.attach('u1', 'screen', screen);
    mixer.setDryMuted('mic', true);
    expect(mic.volume).toBe(0);
    expect(screen.volume).toBe(1);
  });

  it('master volume scales every track', () => {
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    mixer.setVolume('u1', 'mic', 80);
    mixer.setMasterVolume(50);
    expect(el.volume).toBeCloseTo(0.4);
    expect(mixer.getEffectiveVolume('u1', 'mic')).toBe(40);
  });

  it('detach restores the element for reuse and forgets it', () => {
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    mixer.setVolume('u1', 'mic', 10);
    mixer.detach('u1', 'mic', el);
    expect(el.volume).toBe(1);
    expect(mixer.has('u1', 'mic')).toBe(false);
  });

  it('ignores a detach for an element that was replaced', () => {
    const first = fakeElement('a');
    const second = fakeElement('b');
    mixer.attach('u1', 'mic', first);
    mixer.attach('u1', 'mic', second);
    mixer.detach('u1', 'mic', first);
    expect(mixer.has('u1', 'mic')).toBe(true);
  });

  it('reset keeps preferences but drops elements and session flags', () => {
    mixer.setVolume('u1', 'mic', 30);
    mixer.setLocalMute('u2', 'screen', true);
    mixer.attach('u1', 'mic', fakeElement());
    mixer.setDeafened(true);
    mixer.reset();
    expect(mixer.has('u1', 'mic')).toBe(false);
    expect(mixer.getVolume('u1', 'mic')).toBe(30);
    expect(mixer.isLocalMuted('u2', 'screen')).toBe(true);
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    expect(el.volume).toBeCloseTo(0.3);
  });

  it('reports autoplay refusal and clears it on resume', async () => {
    const listener = vi.fn();
    mixer.onBlockedChange(listener);
    const el = fakeElement();
    const refusal = Object.assign(new Error('blocked'), { name: 'NotAllowedError' });
    el.play.mockReturnValueOnce(Promise.reject(refusal));
    mixer.attach('u1', 'mic', el);
    await Promise.resolve();
    await Promise.resolve();
    expect(mixer.isBlocked()).toBe(true);
    expect(listener).toHaveBeenLastCalledWith(true);

    await expect(mixer.resume()).resolves.toBe(true);
    expect(mixer.isBlocked()).toBe(false);
    expect(listener).toHaveBeenLastCalledWith(false);
  });

  it('routes elements and the context to the chosen output device', async () => {
    const el = fakeElement();
    mixer.attach('u1', 'mic', el);
    mixer.setVolume('u1', 'mic', 200);
    await mixer.setOutputDevice('speaker-2');
    expect(el.setSinkId).toHaveBeenCalledWith('speaker-2');
    expect(FakeContext.instances[0].sinkIds).toContain('speaker-2');
  });
});
