/**
 * Stereo jitter buffer between native program-audio blocks (20 ms of s16 at 48 kHz, arriving
 * with IPC jitter) and the AudioWorklet render quantum (128 frames). Capture and the
 * AudioContext run on different clocks: the buffer fills to `targetFrames` before playing,
 * trims back to it when the producer gets more than `maxFrames` ahead, and re-primes after an
 * underrun instead of playing every late block as a click.
 */

/** registerProcessor name of streamAudio.worklet.ts. */
export const STREAM_AUDIO_PROCESSOR = 'harmony-stream-audio';

export interface JitterBufferOptions {
  capacityFrames: number;
  targetFrames: number;
  maxFrames: number;
}

/** 48 kHz: 80 ms target, 200 ms ceiling, 1 s ring. */
export const STREAM_AUDIO_BUFFER: JitterBufferOptions = {
  capacityFrames: 48_000,
  targetFrames: 3_840,
  maxFrames: 9_600,
};

const S16_SCALE = 1 / 32768;

export class StereoJitterBuffer {
  private readonly left: Float32Array;
  private readonly right: Float32Array;
  private readonly capacity: number;
  private readonly target: number;
  private readonly max: number;
  private read = 0;
  private size = 0;
  private priming = true;

  constructor(options: JitterBufferOptions = STREAM_AUDIO_BUFFER) {
    this.capacity = options.capacityFrames;
    this.target = Math.min(options.targetFrames, options.capacityFrames);
    this.max = Math.min(Math.max(options.maxFrames, this.target), options.capacityFrames);
    this.left = new Float32Array(this.capacity);
    this.right = new Float32Array(this.capacity);
  }

  get bufferedFrames(): number {
    return this.size;
  }

  /** Appends interleaved stereo s16 frames. */
  pushInterleavedS16(samples: Int16Array): void {
    const frames = samples.length >> 1;
    for (let i = 0; i < frames; i++) {
      if (this.size === this.capacity) {
        this.read = (this.read + 1) % this.capacity;
        this.size--;
      }
      const at = (this.read + this.size) % this.capacity;
      this.left[at] = samples[2 * i] * S16_SCALE;
      this.right[at] = samples[2 * i + 1] * S16_SCALE;
      this.size++;
    }
    if (this.size > this.max) {
      const drop = this.size - this.target;
      this.read = (this.read + drop) % this.capacity;
      this.size -= drop;
    }
  }

  /**
   * Fills both outputs. Silence while priming; an underrun pads with silence and re-primes.
   * Returns the frames of buffered audio written.
   */
  pull(outLeft: Float32Array, outRight: Float32Array): number {
    const n = outLeft.length;
    if (this.priming) {
      if (this.size < this.target) {
        outLeft.fill(0);
        outRight.fill(0);
        return 0;
      }
      this.priming = false;
    }
    const k = Math.min(n, this.size);
    for (let i = 0; i < k; i++) {
      outLeft[i] = this.left[this.read];
      outRight[i] = this.right[this.read];
      this.read = (this.read + 1) % this.capacity;
    }
    this.size -= k;
    if (k < n) {
      outLeft.fill(0, k);
      outRight.fill(0, k);
      this.priming = true;
    }
    return k;
  }
}
