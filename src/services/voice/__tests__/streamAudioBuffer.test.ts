import { describe, expect, it } from 'vitest';
import { StereoJitterBuffer } from '../streamAudioBuffer';

/** Interleaved s16 frames whose left channel counts up from `start` and right is its negative. */
function frames(start: number, count: number): Int16Array {
  const out = new Int16Array(count * 2);
  for (let i = 0; i < count; i++) {
    out[2 * i] = start + i;
    out[2 * i + 1] = -(start + i);
  }
  return out;
}

function pull(buffer: StereoJitterBuffer, n: number): { left: number[]; right: number[]; got: number } {
  const left = new Float32Array(n);
  const right = new Float32Array(n);
  const got = buffer.pull(left, right);
  return { left: Array.from(left, x => Math.round(x * 32768)), right: Array.from(right, x => Math.round(x * 32768)), got };
}

describe('StereoJitterBuffer', () => {
  it('stays silent until the target latency is buffered, then plays in order', () => {
    const buffer = new StereoJitterBuffer({ capacityFrames: 64, targetFrames: 8, maxFrames: 32 });
    buffer.pushInterleavedS16(frames(1, 4));
    expect(pull(buffer, 4)).toEqual({ left: [0, 0, 0, 0], right: [0, 0, 0, 0], got: 0 });
    buffer.pushInterleavedS16(frames(5, 4));
    expect(pull(buffer, 4)).toEqual({ left: [1, 2, 3, 4], right: [-1, -2, -3, -4], got: 4 });
  });

  it('pads an underrun with silence and primes again', () => {
    const buffer = new StereoJitterBuffer({ capacityFrames: 64, targetFrames: 4, maxFrames: 32 });
    buffer.pushInterleavedS16(frames(1, 6));
    expect(pull(buffer, 8)).toMatchObject({ left: [1, 2, 3, 4, 5, 6, 0, 0], got: 6 });
    buffer.pushInterleavedS16(frames(7, 2));
    expect(pull(buffer, 2).got).toBe(0);
    buffer.pushInterleavedS16(frames(9, 2));
    expect(pull(buffer, 4)).toMatchObject({ left: [7, 8, 9, 10], got: 4 });
  });

  it('drops the oldest frames back to the target when the producer runs ahead', () => {
    const buffer = new StereoJitterBuffer({ capacityFrames: 64, targetFrames: 4, maxFrames: 10 });
    buffer.pushInterleavedS16(frames(1, 11));
    expect(buffer.bufferedFrames).toBe(4);
    expect(pull(buffer, 4)).toMatchObject({ left: [8, 9, 10, 11], got: 4 });
  });

  it('overwrites the oldest frames when the ring is full', () => {
    const buffer = new StereoJitterBuffer({ capacityFrames: 8, targetFrames: 8, maxFrames: 8 });
    buffer.pushInterleavedS16(frames(1, 10));
    expect(buffer.bufferedFrames).toBe(8);
    expect(pull(buffer, 8)).toMatchObject({ left: [3, 4, 5, 6, 7, 8, 9, 10], got: 8 });
  });

  it('scales s16 to [-1, 1)', () => {
    const buffer = new StereoJitterBuffer({ capacityFrames: 8, targetFrames: 1, maxFrames: 8 });
    buffer.pushInterleavedS16(new Int16Array([32767, -32768]));
    const left = new Float32Array(1);
    const right = new Float32Array(1);
    buffer.pull(left, right);
    expect(left[0]).toBeCloseTo(32767 / 32768, 6);
    expect(right[0]).toBe(-1);
  });
});
