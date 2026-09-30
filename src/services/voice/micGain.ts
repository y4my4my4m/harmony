/**
 * Outgoing microphone gain (the "Input volume" setting).
 *
 * The browser's echo cancellation, noise suppression and AGC run inside
 * getUserMedia; the stage takes that processed capture track and scales it:
 *
 *   capture track -> MediaStreamAudioSourceNode -> GainNode
 *     -> MediaStreamAudioDestinationNode (mono) -> published track
 *
 * on the shared voice AudioContext. At unity the stage is not built and the
 * capture track is published untouched: no resampling, no added latency.
 * The output track object survives source swaps (device change, processing
 * change), so the RTCRtpSender, and any E2EE transform on it, never changes.
 */

import { debug } from '@/utils/debug';
import { getVoiceAudioContext, resumeVoiceAudioContext } from './voiceAudioContext';

export const INPUT_VOLUME_MIN = 0;
export const INPUT_VOLUME_MAX = 200;
export const INPUT_VOLUME_UNITY = 100;

// setTargetAtTime time constant, seconds: tracks a dragged slider without zipper noise.
const GAIN_SMOOTHING_S = 0.02;

// A suspended context yields silence; resume() stays pending without a user
// activation, so the wait is bounded.
const RESUME_WAIT_MS = 400;

/** Unity is held this long before the stage is removed, so a drag across 100 % does not swap tracks per step. */
export const UNITY_RELEASE_MS = 1500;

/** Percent, rounded and clamped to 0-200. Non-numeric reads as unity. */
export function clampInputVolume(percent: unknown): number {
  const n = typeof percent === 'string' ? Number(percent) : (percent as number);
  if (typeof n !== 'number' || !Number.isFinite(n)) return INPUT_VOLUME_UNITY;
  return Math.round(Math.min(INPUT_VOLUME_MAX, Math.max(INPUT_VOLUME_MIN, n)));
}

/** Linear gain for an input volume percent. */
export function inputGain(percent: unknown): number {
  return clampInputVolume(percent) / INPUT_VOLUME_UNITY;
}

/** True when the percent needs the gain stage; unity publishes the capture track as is. */
export function needsGainStage(percent: unknown): boolean {
  return clampInputVolume(percent) !== INPUT_VOLUME_UNITY;
}

/** Linear gain to dB; 0 maps to -Infinity. */
export function gainToDb(gain: number): number {
  return gain > 0 ? 20 * Math.log10(gain) : -Infinity;
}

// Meter floor, dBFS: -60 reads as an empty bar, 0 as full.
const METER_FLOOR_DB = -60;

/** Meter position 0-100 for an RMS amplitude (full scale 1). Log scale, so 6 dB is a tenth of the bar. */
export function levelPercentFromRms(rms: number): number {
  if (!(rms > 0)) return 0;
  const db = 20 * Math.log10(rms);
  return Math.round(Math.min(100, Math.max(0, ((db - METER_FLOOR_DB) / -METER_FLOOR_DB) * 100)));
}

/** RMS amplitude of a block of float samples. */
export function rmsOf(samples: ArrayLike<number>): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
  return Math.sqrt(sum / samples.length);
}

export interface MicGainStageOptions {
  getContext?: () => AudioContext | null;
  resume?: () => Promise<boolean>;
  /** Called when the context stops running while the stage carries the mic. */
  onInterrupted?: () => void;
}

export class MicGainStage {
  private ctx: AudioContext | null = null;
  private source: MediaStreamAudioSourceNode | null = null;
  private gainNode: GainNode | null = null;
  private dest: MediaStreamAudioDestinationNode | null = null;
  private input: MediaStreamTrack | null = null;
  private gainValue = 1;
  private destroyed = false;
  private readonly getContext: () => AudioContext | null;
  private readonly resume: () => Promise<boolean>;
  private readonly onInterrupted?: () => void;

  constructor(options: MicGainStageOptions = {}) {
    this.getContext = options.getContext ?? getVoiceAudioContext;
    this.resume = options.resume ?? resumeVoiceAudioContext;
    this.onInterrupted = options.onInterrupted;
  }

  /** Published track, or null before connect() succeeds. */
  get output(): MediaStreamTrack | null {
    return this.dest?.stream.getAudioTracks()[0] ?? null;
  }

  get gain(): number {
    return this.gainValue;
  }

  /** Capture track currently feeding the stage. */
  get inputTrack(): MediaStreamTrack | null {
    return this.input;
  }

  setGain(value: number): void {
    this.gainValue = Math.max(0, value);
    if (this.gainNode && this.ctx) {
      this.gainNode.gain.setTargetAtTime(this.gainValue, this.ctx.currentTime, GAIN_SMOOTHING_S);
    }
  }

  /**
   * Feeds `track` into the stage and returns the output track, the same
   * object on every call. Null when no running AudioContext is available;
   * the caller then publishes `track` directly.
   */
  async connect(track: MediaStreamTrack): Promise<MediaStreamTrack | null> {
    if (this.destroyed) return null;
    const ctx = this.ctx ?? this.getContext();
    if (!ctx) return null;
    if (ctx.state !== 'running') {
      const running = await Promise.race([
        this.resume(),
        new Promise<boolean>(resolve => setTimeout(() => resolve(false), RESUME_WAIT_MS)),
      ]);
      // resume() changes state; the cast drops TypeScript's pre-await narrowing.
      if (!running || (ctx.state as AudioContextState) !== 'running' || this.destroyed) return null;
    }

    if (!this.dest || !this.gainNode) {
      this.ctx = ctx;
      this.gainNode = ctx.createGain();
      this.gainNode.gain.value = this.gainValue;
      this.gainNode.channelCount = 1;
      this.gainNode.channelCountMode = 'explicit';
      this.dest = ctx.createMediaStreamDestination();
      this.dest.channelCount = 1;
      this.dest.channelCountMode = 'explicit';
      this.gainNode.connect(this.dest);
      ctx.addEventListener('statechange', this.onStateChange);
    }

    if (this.input !== track || !this.source) {
      this.source?.disconnect();
      this.source = ctx.createMediaStreamSource(new MediaStream([track]));
      this.source.connect(this.gainNode);
      this.input = track;
    }
    return this.output;
  }

  /** Disconnects every node and ends the output track. The capture track is left to its owner. */
  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.ctx?.removeEventListener('statechange', this.onStateChange);
    try {
      this.source?.disconnect();
      this.gainNode?.disconnect();
    } catch {
      // Nodes of a closed context throw on disconnect.
    }
    this.output?.stop();
    this.source = null;
    this.gainNode = null;
    this.dest = null;
    this.input = null;
    this.ctx = null;
  }

  private onStateChange = (): void => {
    const ctx = this.ctx;
    if (!ctx || ctx.state === 'running' || this.destroyed) return;
    debug.warn('[MicGain] AudioContext left running state:', ctx.state);
    void this.resume().then(running => {
      if (!running && !this.destroyed) this.onInterrupted?.();
    });
  };
}
