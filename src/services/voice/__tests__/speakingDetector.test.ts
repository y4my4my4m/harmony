import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ctx = vi.hoisted(() => ({ current: null as any }));

vi.mock('../voiceAudioContext', () => ({
  getVoiceAudioContext: () => ctx.current,
  peekVoiceAudioContext: () => ctx.current,
}));

import {
  SPEAKING_LEVEL,
  SpeakingDetector,
  createVadState,
  dbfsToLevel,
  rmsToDbfs,
  stepVad,
} from '../speakingDetector';

const TICK = 50;

/** Feeds dB readings one tick apart; returns the speaking flag after each. */
function run(dbs: number[], state = createVadState(), start = 0) {
  return dbs.map((db, i) => stepVad(state, db, start + i * TICK));
}

describe('stepVad', () => {
  it('starts speaking on the second loud tick, not the first', () => {
    const out = run([-80, -25, -25]);
    expect(out.map((o) => o.speaking)).toEqual([false, false, true]);
  });

  it('ignores a single-tick click', () => {
    const out = run([-80, -20, -80, -80]);
    expect(out.some((o) => o.speaking)).toBe(false);
  });

  it('holds through short pauses and stops after the hangover', () => {
    const state = createVadState();
    run([-25, -25, -25], state);
    // 250 ms of silence: still speaking.
    const pause = run([-80, -80, -80, -80, -80], state, 3 * TICK);
    expect(pause.every((o) => o.speaking)).toBe(true);
    // Past 300 ms since the last voiced tick.
    const after = run([-80, -80], state, 8 * TICK);
    expect(after[after.length - 1].speaking).toBe(false);
  });

  it('keeps the level contract: above SPEAKING_LEVEL exactly while speaking', () => {
    const out = run([-80, -40, -40, -40, -80, -80, -80, -80, -80, -80, -80, -80]);
    for (const o of out) {
      expect(o.level > SPEAKING_LEVEL).toBe(o.speaking);
    }
  });

  it('adapts to a steady noise floor so constant hum stops reading as speech', () => {
    const state = createVadState();
    // Steady -50 dBFS hum is below the absolute -45 dBFS threshold.
    const hum = run(new Array(40).fill(-50), state);
    expect(hum.some((o) => o.speaking)).toBe(false);
    // Speech 20 dB over the hum still starts.
    const speech = run([-30, -30], state, 40 * TICK);
    expect(speech[1].speaking).toBe(true);
  });

  it('requires speech to clear the floor margin in a loud room', () => {
    const state = createVadState();
    state.floorDb = -40;
    // -35 is above the absolute threshold but within 10 dB of the floor.
    const out = run([-35, -35, -35], state, TICK);
    expect(out.some((o) => o.speaking)).toBe(false);
  });
});

describe('levels', () => {
  it('maps dBFS onto the mic test meter scale', () => {
    expect(dbfsToLevel(-60)).toBe(0);
    expect(dbfsToLevel(-30)).toBe(50);
    expect(dbfsToLevel(0)).toBe(100);
    expect(dbfsToLevel(-100)).toBe(0);
  });

  it('reads RMS of a full-scale square wave as 0 dBFS and silence as the floor', () => {
    expect(rmsToDbfs(Float32Array.from([1, -1, 1, -1]))).toBeCloseTo(0);
    expect(rmsToDbfs(new Float32Array(8))).toBe(-100);
  });
});

class FakeAnalyser {
  fftSize = 2048;
  smoothingTimeConstant = 0.8;
  amplitude = 0;
  getFloatTimeDomainData(buffer: Float32Array) {
    for (let i = 0; i < buffer.length; i += 1) buffer[i] = i % 2 ? -this.amplitude : this.amplitude;
  }
}

function fakeContext() {
  const analysers: FakeAnalyser[] = [];
  const sources: Array<{ disconnect: ReturnType<typeof vi.fn> }> = [];
  return {
    state: 'running',
    analysers,
    sources,
    createMediaStreamSource: vi.fn(() => {
      const source = { connect: vi.fn(), disconnect: vi.fn() };
      sources.push(source);
      return source;
    }),
    createAnalyser: vi.fn(() => {
      const analyser = new FakeAnalyser();
      analysers.push(analyser);
      return analyser;
    }),
  };
}

const track = (over: Partial<MediaStreamTrack> = {}) =>
  ({ readyState: 'live', enabled: true, muted: false, ...over }) as MediaStreamTrack;

describe('SpeakingDetector', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('MediaStream', class { constructor(public tracks: MediaStreamTrack[]) {} });
    ctx.current = fakeContext();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('reports speech within two ticks of it starting', () => {
    const detector = new SpeakingDetector();
    const listener = vi.fn();
    const mic = track();
    detector.watch('bob', () => mic, listener);

    vi.advanceTimersByTime(TICK);
    ctx.current.analysers[0].amplitude = 0.1; // -20 dBFS
    vi.advanceTimersByTime(2 * TICK);

    expect(listener).toHaveBeenLastCalledWith(expect.any(Number), true, expect.any(Number));
    expect(listener.mock.lastCall![0]).toBeGreaterThan(SPEAKING_LEVEL);
    detector.clear();
  });

  it('covers a key only while its analyser runs on a running context', () => {
    const detector = new SpeakingDetector();
    const mic = track();
    detector.watch('bob', () => mic, vi.fn());
    expect(detector.covers('bob')).toBe(false);
    vi.advanceTimersByTime(TICK);
    expect(detector.covers('bob')).toBe(true);
    ctx.current.state = 'suspended';
    expect(detector.covers('bob')).toBe(false);
    detector.clear();
  });

  it('rebuilds the source when the resolved track changes', () => {
    const detector = new SpeakingDetector();
    let current = track();
    detector.watch('me', () => current, vi.fn());
    vi.advanceTimersByTime(TICK);
    current = track();
    vi.advanceTimersByTime(TICK);
    expect(ctx.current.createMediaStreamSource).toHaveBeenCalledTimes(2);
    expect(ctx.current.sources[0].disconnect).toHaveBeenCalled();
    detector.clear();
  });

  it('reads a disabled or muted track as silence', () => {
    const detector = new SpeakingDetector();
    const listener = vi.fn();
    const mic = track({ enabled: false });
    detector.watch('me', () => mic, listener);
    vi.advanceTimersByTime(TICK);
    ctx.current.analysers[0].amplitude = 0.5;
    vi.advanceTimersByTime(5 * TICK);
    expect(listener.mock.calls.some(([, speaking]) => speaking)).toBe(false);
    detector.clear();
  });

  it('scopes unwatch to the owner that registered the watch', () => {
    const detector = new SpeakingDetector();
    const first = {};
    const second = {};
    const mic = track();
    detector.watch('bob', () => mic, vi.fn(), first);
    detector.watch('bob', () => mic, vi.fn(), second);
    detector.unwatch('bob', first);
    vi.advanceTimersByTime(TICK);
    expect(detector.covers('bob')).toBe(true);
    detector.unwatch('bob', second);
    expect(detector.covers('bob')).toBe(false);
    detector.clear();
  });
});
