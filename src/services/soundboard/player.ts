/**
 * Local playback of soundboard clips on the call's output device.
 *
 * A clip plays from memory once decoded: an AudioBufferSourceNode on the voice AudioContext,
 * whose setSinkId already routes to the voice output. Clips decode ahead of their first play
 * (prewarm: the soundboard's lists as they load) and stay decoded, MAX_DECODED at most, least
 * recently played dropped first.
 *
 * A clip not decoded yet, or a context that cannot reach a non-default output device
 * (no AudioContext.setSinkId), plays through its own HTMLAudioElement routed with
 * setSinkId, as before; its decode starts alongside. Gains are at most unity.
 */

import { debug } from '@/utils/debug';
import {
  canCreateVoiceAudioContext,
  contextSupportsSink,
  getVoiceAudioContext,
  getVoiceAudioSink,
} from '@/services/voice/voiceAudioContext';

/** Clips playing at once; a further play stops the oldest. */
export const SOUNDBOARD_MAX_CONCURRENT = 4;

/** Decoded clips kept. A 5.2 s stereo clip at 48 kHz decodes to about 2 MB. */
export const SOUNDBOARD_MAX_DECODED = 64;

export interface SoundboardLevels {
  /** The clip's own volume, 0-1. */
  soundVolume: number;
  /** The listener's soundboard volume, percent 0-100. */
  soundboardVolume: number;
  /** The listener's master output, percent 0-200. */
  masterVolume: number;
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/** HTMLMediaElement.volume for a clip, [0, 1]. */
export function soundboardGain(levels: SoundboardLevels): number {
  const sound = Math.min(1, Math.max(0, finiteOr(levels.soundVolume, 1)));
  const board = Math.min(100, Math.max(0, finiteOr(levels.soundboardVolume, 100))) / 100;
  const master = Math.min(200, Math.max(0, finiteOr(levels.masterVolume, 100))) / 100;
  return Math.min(1, sound * board * master);
}

type SinkCapableElement = HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> };

/** A clip being played: from memory, or by an element (which `element` names). */
export interface PlayingClip {
  stop(): void;
  element?: HTMLAudioElement;
}

function defaultContext(): AudioContext | null {
  return canCreateVoiceAudioContext() ? getVoiceAudioContext() : null;
}

async function defaultFetch(url: string): Promise<ArrayBuffer> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return response.arrayBuffer();
}

const idle = (): Promise<void> => new Promise((resolve) => {
  const ric = (globalThis as { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
  if (ric) ric(() => resolve(), { timeout: 500 });
  else setTimeout(resolve, 16);
});

export class SoundboardPlayer {
  private playing: PlayingClip[] = [];
  private readonly decoded = new Map<string, AudioBuffer>();
  private readonly decoding = new Map<string, Promise<AudioBuffer | null>>();
  private readonly failed = new Set<string>();
  private readonly warmQueue: string[] = [];
  private warming = false;

  constructor(
    private readonly createElement: () => HTMLAudioElement = () => new Audio(),
    private readonly context: () => AudioContext | null = defaultContext,
    private readonly fetchBytes: (url: string) => Promise<ArrayBuffer> = defaultFetch,
  ) {}

  /** Starts a clip; null when the gain is zero. */
  play(url: string, gain: number): PlayingClip | null {
    if (!(gain > 0)) return null;
    while (this.playing.length >= SOUNDBOARD_MAX_CONCURRENT) {
      this.playing.shift()?.stop();
    }

    const buffer = this.decoded.get(url);
    const ctx = buffer ? this.context() : null;
    if (buffer && ctx && this.reachesOutput(ctx)) {
      // Most recently played last: the eviction order.
      this.decoded.delete(url);
      this.decoded.set(url, buffer);
      return this.playBuffer(ctx, buffer, gain);
    }
    const clip = this.playElement(url, gain);
    if (!buffer) void this.decode(url);
    return clip;
  }

  /** Fetches and decodes clips ahead of their first play, one at a time while the page is idle. */
  prewarm(urls: Iterable<string>): void {
    for (const url of urls) {
      if (!url || this.decoded.has(url) || this.decoding.has(url) || this.failed.has(url)) continue;
      if (this.warmQueue.includes(url)) continue;
      if (this.warmQueue.length + this.decoded.size >= SOUNDBOARD_MAX_DECODED) break;
      this.warmQueue.push(url);
    }
    if (!this.warming && this.warmQueue.length > 0) void this.drainWarmQueue();
  }

  /** Decoded clips held. */
  get decodedCount(): number {
    return this.decoded.size;
  }

  get activeCount(): number {
    return this.playing.length;
  }

  stopAll(): void {
    const clips = this.playing;
    this.playing = [];
    for (const clip of clips) clip.stop();
  }

  private async drainWarmQueue(): Promise<void> {
    this.warming = true;
    try {
      while (this.warmQueue.length > 0) {
        const url = this.warmQueue.shift()!;
        await this.decode(url);
        await idle();
      }
    } finally {
      this.warming = false;
    }
  }

  private decode(url: string): Promise<AudioBuffer | null> {
    const known = this.decoded.get(url);
    if (known) return Promise.resolve(known);
    const pending = this.decoding.get(url);
    if (pending) return pending;
    const ctx = this.context();
    if (!ctx || this.failed.has(url)) return Promise.resolve(null);
    const work = (async () => {
      try {
        const buffer = await ctx.decodeAudioData(await this.fetchBytes(url));
        this.decoded.set(url, buffer);
        while (this.decoded.size > SOUNDBOARD_MAX_DECODED) {
          const oldest = this.decoded.keys().next().value;
          if (oldest === undefined) break;
          this.decoded.delete(oldest);
        }
        return buffer;
      } catch (error) {
        debug.warn('[Soundboard] decode failed:', url, error);
        this.failed.add(url);
        return null;
      } finally {
        this.decoding.delete(url);
      }
    })();
    this.decoding.set(url, work);
    return work;
  }

  // Without AudioContext.setSinkId the context renders to the system default only.
  private reachesOutput(ctx: AudioContext): boolean {
    const sink = getVoiceAudioSink();
    return !sink || sink === 'default' || contextSupportsSink(ctx);
  }

  private playBuffer(ctx: AudioContext, buffer: AudioBuffer, gain: number): PlayingClip {
    if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const level = ctx.createGain();
    level.gain.value = Math.min(1, gain);
    source.connect(level);
    level.connect(ctx.destination);
    let stopped = false;
    const clip: PlayingClip = {
      stop: () => {
        if (stopped) return;
        stopped = true;
        try { source.stop(); } catch { /* already ended */ }
        source.disconnect();
        level.disconnect();
      },
    };
    source.onended = () => {
      this.forget(clip);
      clip.stop();
    };
    this.playing.push(clip);
    source.start();
    return clip;
  }

  private playElement(url: string, gain: number): PlayingClip | null {
    const element = this.createElement() as SinkCapableElement;
    element.preload = 'auto';
    element.volume = Math.min(1, gain);
    const sink = getVoiceAudioSink();
    if (sink && sink !== 'default' && typeof element.setSinkId === 'function') {
      element.setSinkId(sink).catch((error: unknown) => {
        debug.warn('[Soundboard] setSinkId failed:', error);
      });
    }
    const clip: PlayingClip = { element, stop: () => this.release(element) };
    element.addEventListener('ended', () => this.forget(clip));
    element.addEventListener('error', () => this.forget(clip));
    element.src = url;
    this.playing.push(clip);

    try {
      const started = element.play();
      if (started && typeof started.catch === 'function') {
        started.catch((error: unknown) => {
          debug.warn('[Soundboard] play refused:', error);
          this.forget(clip);
        });
      }
    } catch (error) {
      debug.warn('[Soundboard] play failed:', error);
      this.forget(clip);
      return null;
    }
    return clip;
  }

  private forget(clip: PlayingClip): void {
    const index = this.playing.indexOf(clip);
    if (index >= 0) this.playing.splice(index, 1);
  }

  private release(element: HTMLAudioElement): void {
    try {
      element.pause();
      element.removeAttribute('src');
      element.load();
    } catch {
      // Detached elements throw in some engines; nothing left to stop.
    }
  }
}

export const soundboardPlayer = new SoundboardPlayer();
