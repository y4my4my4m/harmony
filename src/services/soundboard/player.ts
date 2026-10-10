/**
 * Local playback of soundboard clips on the call's output device.
 *
 * Each play is its own HTMLAudioElement routed with setSinkId to the voice
 * output (voiceAudioContext's sink). Elements play at most unity, so the
 * product of the levels is clamped to 1.
 */

import { debug } from '@/utils/debug';
import { getVoiceAudioSink } from '@/services/voice/voiceAudioContext';

/** Clips playing at once; a further play stops the oldest. */
export const SOUNDBOARD_MAX_CONCURRENT = 4;

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

export class SoundboardPlayer {
  private playing: HTMLAudioElement[] = [];

  constructor(private readonly createElement: () => HTMLAudioElement = () => new Audio()) {}

  /** Starts a clip; null when the gain is zero. */
  play(url: string, gain: number): HTMLAudioElement | null {
    if (!(gain > 0)) return null;
    while (this.playing.length >= SOUNDBOARD_MAX_CONCURRENT) {
      const oldest = this.playing.shift();
      if (oldest) this.release(oldest);
    }

    const element = this.createElement() as SinkCapableElement;
    element.preload = 'auto';
    element.volume = Math.min(1, gain);
    const sink = getVoiceAudioSink();
    if (sink && sink !== 'default' && typeof element.setSinkId === 'function') {
      element.setSinkId(sink).catch((error: unknown) => {
        debug.warn('[Soundboard] setSinkId failed:', error);
      });
    }
    element.addEventListener('ended', () => this.forget(element));
    element.addEventListener('error', () => this.forget(element));
    element.src = url;
    this.playing.push(element);

    try {
      const started = element.play();
      if (started && typeof started.catch === 'function') {
        started.catch((error: unknown) => {
          debug.warn('[Soundboard] play refused:', error);
          this.forget(element);
        });
      }
    } catch (error) {
      debug.warn('[Soundboard] play failed:', error);
      this.forget(element);
      return null;
    }
    return element;
  }

  get activeCount(): number {
    return this.playing.length;
  }

  stopAll(): void {
    const elements = this.playing;
    this.playing = [];
    for (const element of elements) this.release(element);
  }

  private forget(element: HTMLAudioElement): void {
    const index = this.playing.indexOf(element);
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
