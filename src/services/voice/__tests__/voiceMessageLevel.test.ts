import { afterEach, describe, expect, it, vi } from 'vitest';
import { MAX_BOOST_DB, TARGET_PEAK_DB, boostGain, levelChain, measureClip, peakDb } from '../voiceMessageLevel';

function buffer(...channels: number[][]): AudioBuffer {
  return {
    numberOfChannels: channels.length,
    getChannelData: (c: number) => Float32Array.from(channels[c]),
  } as unknown as AudioBuffer;
}

const db = (gain: number) => 20 * Math.log10(gain);

describe('peakDb', () => {
  it('reads the highest magnitude over every channel', () => {
    expect(peakDb(buffer([0.1, -0.25], [0.5, -0.03]))).toBeCloseTo(db(0.5));
  });

  it('is -Infinity for silence', () => {
    expect(peakDb(buffer([0, 0]))).toBe(-Infinity);
  });
});

describe('boostGain', () => {
  it('raises a quiet clip to the target peak', () => {
    expect(db(boostGain(-15))).toBeCloseTo(TARGET_PEAK_DB + 15);
  });

  it('caps the boost; the -30.5 dBFS recording from the report gains 24 dB', () => {
    expect(db(boostGain(-30.5))).toBeCloseTo(MAX_BOOST_DB);
  });

  it('never attenuates and leaves silence alone', () => {
    expect(boostGain(-1)).toBe(1);
    expect(boostGain(-Infinity)).toBe(1);
  });
});

describe('levelChain', () => {
  it('runs compressor, makeup gain and limiter in order', () => {
    const connections: Array<[string, string]> = [];
    const node = (name: string, extra: object = {}) => ({
      name,
      connect: (to: { name: string }) => { connections.push([name, to.name]); return to; },
      ...extra,
    });
    const param = () => ({ value: 0 });
    const compressors = ['compressor', 'limiter'];
    const ctx = {
      createDynamicsCompressor: () => node(compressors.shift()!, {
        threshold: param(), knee: param(), ratio: param(), attack: param(), release: param(),
      }),
      createGain: () => node('makeup', { gain: param() }),
    } as unknown as BaseAudioContext;

    const last = levelChain(ctx, node('mic') as unknown as AudioNode) as unknown as {
      name: string; threshold: { value: number }; ratio: { value: number };
    };
    expect(connections).toEqual([['mic', 'compressor'], ['compressor', 'makeup'], ['makeup', 'limiter']]);
    expect(last.name).toBe('limiter');
    expect(last.threshold.value).toBe(-9);
    expect(last.ratio.value).toBe(20);
  });
});

describe('measureClip', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('decodes a clip once per URL', async () => {
    const fetch = vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) }));
    vi.stubGlobal('fetch', fetch);
    const ctx = { decodeAudioData: vi.fn(async () => ({ ...buffer([0.03, -0.02]), duration: 9.5 })) } as unknown as BaseAudioContext;

    const first = await measureClip('https://storage/clip-a.webm', ctx);
    const second = await measureClip('https://storage/clip-a.webm', ctx);
    expect(first?.duration).toBe(9.5);
    expect(first?.peak).toBeCloseTo(db(0.03));
    expect(second).toBe(first);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is null when the clip cannot be decoded', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, arrayBuffer: async () => new ArrayBuffer(8) })));
    const ctx = { decodeAudioData: vi.fn(async () => { throw new Error('EncodingError'); }) } as unknown as BaseAudioContext;
    expect(await measureClip('https://storage/clip-b.webm', ctx)).toBeNull();
  });
});
