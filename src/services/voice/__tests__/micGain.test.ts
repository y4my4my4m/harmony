import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MicGainStage,
  clampInputVolume,
  gainToDb,
  inputGain,
  levelPercentFromRms,
  needsGainStage,
  rmsOf,
} from '../micGain';
import { MicGainProcessor } from '../micGainProcessor';

describe('input volume mapping', () => {
  it('clamps percent to 0-200 and parses slider strings', () => {
    expect(clampInputVolume(250)).toBe(200);
    expect(clampInputVolume(-3)).toBe(0);
    expect(clampInputVolume('150')).toBe(150);
    expect(clampInputVolume(undefined)).toBe(100);
    expect(clampInputVolume(Number.NaN)).toBe(100);
  });

  it('maps percent to linear gain', () => {
    expect(inputGain(100)).toBe(1);
    expect(inputGain(50)).toBe(0.5);
    expect(inputGain(200)).toBe(2);
    expect(inputGain(0)).toBe(0);
  });

  it('50 % is -6 dB and 200 % is +6 dB', () => {
    expect(gainToDb(inputGain(50))).toBeCloseTo(-6.02, 2);
    expect(gainToDb(inputGain(200))).toBeCloseTo(6.02, 2);
    expect(gainToDb(inputGain(100))).toBe(0);
    expect(gainToDb(0)).toBe(-Infinity);
  });

  it('needs the gain stage only off unity', () => {
    expect(needsGainStage(100)).toBe(false);
    expect(needsGainStage('100')).toBe(false);
    expect(needsGainStage(undefined)).toBe(false);
    expect(needsGainStage(99)).toBe(true);
    expect(needsGainStage(0)).toBe(true);
  });
});

describe('meter', () => {
  it('computes RMS', () => {
    expect(rmsOf([])).toBe(0);
    expect(rmsOf([0.5, -0.5, 0.5, -0.5])).toBeCloseTo(0.5);
  });

  it('maps RMS to a log bar: -60 dBFS empty, 0 dBFS full, 6 dB a tenth', () => {
    expect(levelPercentFromRms(0)).toBe(0);
    expect(levelPercentFromRms(0.001)).toBe(0);
    expect(levelPercentFromRms(1)).toBe(100);
    const at = levelPercentFromRms(0.1);
    const doubled = levelPercentFromRms(0.2);
    expect(doubled - at).toBe(10);
  });
});

// Web Audio stand-ins with enough surface for the stage's wiring.
class FakeNode {
  connections: unknown[] = [];
  channelCount = 2;
  channelCountMode = 'max';
  connect(target: unknown) { this.connections.push(target); return target; }
  disconnect = vi.fn(() => { this.connections = []; });
}
class FakeGain extends FakeNode {
  gain = { value: 1, setTargetAtTime: vi.fn((v: number) => { this.gain.value = v; }) };
}
class FakeTrack {
  enabled = true;
  stopped = false;
  constructor(public id: string) {}
  stop() { this.stopped = true; }
}
class FakeDest extends FakeNode {
  track = new FakeTrack('processed');
  stream = { getAudioTracks: () => [this.track] };
}
class FakeContext {
  state: AudioContextState = 'running';
  currentTime = 0;
  sources: FakeNode[] = [];
  gains: FakeGain[] = [];
  dests: FakeDest[] = [];
  listeners = new Map<string, () => void>();
  createMediaStreamSource() { const n = new FakeNode(); this.sources.push(n); return n; }
  createGain() { const g = new FakeGain(); this.gains.push(g); return g; }
  createMediaStreamDestination() { const d = new FakeDest(); this.dests.push(d); return d; }
  addEventListener(type: string, fn: () => void) { this.listeners.set(type, fn); }
  removeEventListener(type: string) { this.listeners.delete(type); }
}

const asTrack = (t: FakeTrack) => t as unknown as MediaStreamTrack;

describe('MicGainStage wiring', () => {
  let ctx: FakeContext;
  let resume: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    ctx = new FakeContext();
    resume = vi.fn(async () => true);
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeStage = (onInterrupted?: () => void) =>
    new MicGainStage({ getContext: () => ctx as unknown as AudioContext, resume, onInterrupted });

  it('wires capture -> gain -> mono destination and returns the destination track', async () => {
    const stage = makeStage();
    stage.setGain(0.5);
    const out = await stage.connect(asTrack(new FakeTrack('mic-1')));
    expect(out).toBe(ctx.dests[0].track);
    expect(ctx.sources[0].connections).toContain(ctx.gains[0]);
    expect(ctx.gains[0].connections).toContain(ctx.dests[0]);
    expect(ctx.gains[0].gain.value).toBe(0.5);
    expect(ctx.dests[0].channelCount).toBe(1);
    expect(ctx.dests[0].channelCountMode).toBe('explicit');
  });

  it('keeps the same output track when the capture is swapped', async () => {
    const stage = makeStage();
    const first = await stage.connect(asTrack(new FakeTrack('mic-1')));
    const second = await stage.connect(asTrack(new FakeTrack('mic-2')));
    expect(second).toBe(first);
    expect(ctx.dests).toHaveLength(1);
    expect(ctx.gains).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[0].disconnect).toHaveBeenCalled();
    expect(stage.inputTrack).toEqual(expect.objectContaining({ id: 'mic-2' }));
  });

  it('does not rebuild the source for the same capture track', async () => {
    const stage = makeStage();
    const mic = asTrack(new FakeTrack('mic-1'));
    await stage.connect(mic);
    await stage.connect(mic);
    expect(ctx.sources).toHaveLength(1);
  });

  it('ramps gain changes once connected', async () => {
    const stage = makeStage();
    await stage.connect(asTrack(new FakeTrack('mic-1')));
    stage.setGain(2);
    expect(ctx.gains[0].gain.setTargetAtTime).toHaveBeenCalledWith(2, 0, expect.any(Number));
    expect(stage.gain).toBe(2);
  });

  it('refuses when the context cannot run, so the capture is sent instead of silence', async () => {
    ctx.state = 'suspended';
    resume.mockResolvedValue(false);
    const stage = makeStage();
    expect(await stage.connect(asTrack(new FakeTrack('mic-1')))).toBeNull();
    expect(ctx.gains).toHaveLength(0);
  });

  it('refuses without a context', async () => {
    const stage = new MicGainStage({ getContext: () => null, resume });
    expect(await stage.connect(asTrack(new FakeTrack('mic-1')))).toBeNull();
  });

  it('destroy disconnects the graph and ends only the output track', async () => {
    const stage = makeStage();
    const mic = new FakeTrack('mic-1');
    const out = await stage.connect(asTrack(mic));
    stage.destroy();
    expect(ctx.sources[0].disconnect).toHaveBeenCalled();
    expect(ctx.gains[0].disconnect).toHaveBeenCalled();
    expect((out as unknown as FakeTrack).stopped).toBe(true);
    expect(mic.stopped).toBe(false);
    expect(ctx.listeners.has('statechange')).toBe(false);
    expect(await stage.connect(asTrack(mic))).toBeNull();
  });

  it('reports an interruption the context cannot recover from', async () => {
    const onInterrupted = vi.fn();
    const stage = makeStage(onInterrupted);
    await stage.connect(asTrack(new FakeTrack('mic-1')));
    ctx.state = 'suspended';
    resume.mockResolvedValue(false);
    ctx.listeners.get('statechange')?.();
    await Promise.resolve();
    await Promise.resolve();
    expect(onInterrupted).toHaveBeenCalledTimes(1);
  });
});

describe('MicGainProcessor', () => {
  let ctx: FakeContext;

  beforeEach(() => {
    ctx = new FakeContext();
    vi.stubGlobal('MediaStream', class { constructor(public tracks: unknown[]) {} });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const makeProcessor = () => new MicGainProcessor(
    new MicGainStage({ getContext: () => ctx as unknown as AudioContext, resume: async () => true }),
  );

  it('exposes the stage output as processedTrack and keeps it across restarts', async () => {
    const processor = makeProcessor();
    const opts = (id: string) => ({ kind: 'audio', track: asTrack(new FakeTrack(id)), audioContext: ctx }) as never;
    await processor.init(opts('mic-1'));
    const processed = processor.processedTrack;
    expect(processed).toBe(ctx.dests[0].track);
    await processor.restart(opts('mic-2'));
    expect(processor.processedTrack).toBe(processed);
    await processor.destroy();
    expect(processor.processedTrack).toBeUndefined();
    expect(ctx.dests[0].track.stopped).toBe(true);
  });

  it('init fails when no running context exists, leaving the track unprocessed', async () => {
    const processor = new MicGainProcessor(new MicGainStage({ getContext: () => null }));
    await expect(processor.init({ kind: 'audio', track: asTrack(new FakeTrack('mic')), audioContext: ctx } as never))
      .rejects.toThrow();
    expect(processor.processedTrack).toBeUndefined();
  });
});
