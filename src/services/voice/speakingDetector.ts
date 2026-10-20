/**
 * Client-side voice activity detection for the speaking indicator.
 *
 * livekit-client sets isSpeaking and participant.audioLevel, the local
 * participant's included, only from SFU speaker updates
 * (Room.handleActiveSpeakersUpdate / handleSpeakersChanged). Those arrive at
 * the server's audio update interval, 0.5-1 s after speech starts. Analysing
 * the local capture track and each subscribed remote track here marks a
 * speaker within ATTACK_TICKS ticks.
 *
 * Contract with the voice store: an emitted level above SPEAKING_LEVEL means
 * speaking; at or below it means silent.
 */

import { rmsOf } from './micGain';
import { getVoiceAudioContext, peekVoiceAudioContext } from './voiceAudioContext';

export const SPEAKING_LEVEL = 20;

const TICK_MS = 50;
// 21.3 ms window at 48 kHz.
const FFT_SIZE = 1024;
// RMS dBFS. Speech through browser AGC sits around -30 to -20; suppressed room noise below -60.
const ON_DBFS = -45;
// Above the tracked noise floor, so a steady fan or hum never reads as speech.
const FLOOR_MARGIN_DB = 10;
const OFF_MARGIN_DB = 6;
// Consecutive ticks above threshold before speech starts: a single key click spans one tick.
const ATTACK_TICKS = 2;
const HANGOVER_MS = 300;
// Floor rises 0.4 dB/s while sound persists and drops to any quieter reading.
const FLOOR_RISE_DB_PER_TICK = 0.02;
const SILENCE_DBFS = -100;
// Emitted level changes below this are not reported between speaking transitions.
const LEVEL_EPSILON = 3;
const LEVEL_INTERVAL_MS = 100;

export interface VadState {
  floorDb: number;
  aboveTicks: number;
  speaking: boolean;
  lastVoiceAt: number;
}

export function createVadState(): VadState {
  return { floorDb: -70, aboveTicks: 0, speaking: false, lastVoiceAt: 0 };
}

export function rmsToDbfs(samples: ArrayLike<number>): number {
  const rms = rmsOf(samples);
  return rms > 0 ? Math.max(SILENCE_DBFS, 20 * Math.log10(rms)) : SILENCE_DBFS;
}

/** Display level 0-100 on the mic test meter's scale: -60 dBFS is 0, 0 dBFS is 100. */
export function dbfsToLevel(db: number): number {
  return Math.round(Math.min(100, Math.max(0, ((db + 60) / 60) * 100)));
}

/**
 * One detector tick. Mutates state; returns the speaking flag and a level
 * clamped to the store contract (above SPEAKING_LEVEL only while speaking).
 * `manualOnDb` replaces the adaptive threshold with a fixed one.
 */
export function stepVad(
  state: VadState,
  db: number,
  now: number,
  manualOnDb: number | null = null,
): { speaking: boolean; level: number } {
  if (db < state.floorDb) state.floorDb = db;
  else state.floorDb = Math.min(state.floorDb + FLOOR_RISE_DB_PER_TICK, db);

  const onDb = manualOnDb ?? Math.max(ON_DBFS, state.floorDb + FLOOR_MARGIN_DB);
  const offDb = onDb - OFF_MARGIN_DB;

  if (db >= onDb) {
    state.aboveTicks += 1;
  } else {
    state.aboveTicks = 0;
  }

  if (!state.speaking && state.aboveTicks >= ATTACK_TICKS) {
    state.speaking = true;
  }
  if (state.speaking && db >= offDb) {
    state.lastVoiceAt = now;
  }
  if (state.speaking && now - state.lastVoiceAt > HANGOVER_MS) {
    state.speaking = false;
  }

  const raw = dbfsToLevel(db);
  const level = state.speaking ? Math.max(raw, SPEAKING_LEVEL + 1) : Math.min(raw, SPEAKING_LEVEL);
  return { speaking: state.speaking, level };
}

/** `rawLevel` is the unclamped 0-100 input level, for meters. */
export type SpeakingListener = (level: number, speaking: boolean, rawLevel: number) => void;

interface Watch {
  owner: unknown;
  resolve: () => MediaStreamTrack | null;
  listener: SpeakingListener;
  track: MediaStreamTrack | null;
  source: MediaStreamAudioSourceNode | null;
  analyser: AnalyserNode | null;
  buffer: Float32Array;
  vad: VadState;
  manualOnDb: number | null;
  rawLevel: number;
  emittedLevel: number;
  emittedSpeaking: boolean;
  emittedAt: number;
}

export class SpeakingDetector {
  private watches = new Map<string, Watch>();
  private timer: ReturnType<typeof setInterval> | null = null;

  /**
   * Tracks one audio source under `key`. `resolve` runs every tick, so a
   * replaced track (device switch, republish) is picked up without a rewatch.
   * `owner` scopes a later unwatch to this watch.
   */
  watch(key: string, resolve: () => MediaStreamTrack | null, listener: SpeakingListener, owner?: unknown): void {
    this.unwatch(key);
    this.watches.set(key, {
      owner,
      resolve,
      listener,
      track: null,
      source: null,
      analyser: null,
      buffer: new Float32Array(FFT_SIZE),
      vad: createVadState(),
      manualOnDb: null,
      rawLevel: 0,
      emittedLevel: 0,
      emittedSpeaking: false,
      emittedAt: 0,
    });
    this.start();
  }

  /** With `owner`, removes the watch only if that owner registered it. */
  unwatch(key: string, owner?: unknown): void {
    const watch = this.watches.get(key);
    if (!watch) return;
    if (owner !== undefined && watch.owner !== owner) return;
    this.disconnect(watch);
    this.watches.delete(key);
    if (this.watches.size === 0) this.stop();
  }

  clear(): void {
    for (const watch of this.watches.values()) this.disconnect(watch);
    this.watches.clear();
    this.stop();
  }

  /** Fixed speech threshold for `key`, dBFS RMS; null restores the adaptive one. */
  setManualThreshold(key: string, db: number | null): void {
    const watch = this.watches.get(key);
    if (watch) watch.manualOnDb = db;
  }

  /** Latest unclamped input level of `key`, 0-100; 0 when not analysed. */
  rawLevel(key: string): number {
    return this.covers(key) ? this.watches.get(key)?.rawLevel ?? 0 : 0;
  }

  /** True while `key` is analysed on a running context; SFU speaker updates are then ignored for it. */
  covers(key: string): boolean {
    const watch = this.watches.get(key);
    return !!watch?.analyser && peekVoiceAudioContext()?.state === 'running';
  }

  private start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  private stop(): void {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private disconnect(watch: Watch): void {
    try {
      watch.source?.disconnect();
    } catch {
      /* already disconnected */
    }
    watch.source = null;
    watch.analyser = null;
    watch.track = null;
  }

  private connect(watch: Watch, track: MediaStreamTrack): void {
    this.disconnect(watch);
    watch.track = track;
    const ctx = getVoiceAudioContext();
    if (!ctx) return;
    try {
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      const analyser = ctx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0;
      source.connect(analyser);
      watch.source = source;
      watch.analyser = analyser;
      watch.vad = createVadState();
    } catch {
      watch.source = null;
      watch.analyser = null;
    }
  }

  private tick(): void {
    const ctx = peekVoiceAudioContext();
    const running = ctx?.state === 'running';
    const now = performance.now();
    for (const watch of this.watches.values()) {
      let track: MediaStreamTrack | null = null;
      try {
        track = watch.resolve();
      } catch {
        track = null;
      }
      if (track && track.readyState === 'ended') track = null;
      if (track !== watch.track) {
        if (track) this.connect(watch, track);
        else this.disconnect(watch);
      }
      if (!watch.analyser || !running) continue;

      watch.analyser.getFloatTimeDomainData(watch.buffer);
      const db = track && track.enabled && !track.muted ? rmsToDbfs(watch.buffer) : SILENCE_DBFS;
      const { speaking, level } = stepVad(watch.vad, db, now, watch.manualOnDb);
      watch.rawLevel = dbfsToLevel(db);

      const transition = speaking !== watch.emittedSpeaking;
      const moved = Math.abs(level - watch.emittedLevel) >= LEVEL_EPSILON
        && now - watch.emittedAt >= LEVEL_INTERVAL_MS;
      const settled = level === 0 && watch.emittedLevel !== 0;
      if (!transition && !moved && !settled) continue;

      watch.emittedLevel = level;
      watch.emittedSpeaking = speaking;
      watch.emittedAt = now;
      try {
        watch.listener(level, speaking, watch.rawLevel);
      } catch {
        /* listener errors never stop the other watches */
      }
    }
  }
}

export const speakingDetector = new SpeakingDetector();
