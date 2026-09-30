/**
 * Remote audio mixer for the web transports (LiveKit and P2P).
 *
 * Owns the audibility of every remote audio element: microphone and stream
 * audio, per user, 0-200 %. Gating is by element volume, never `muted`:
 * livekit-client's Room.startAudio() sets `muted = false` on every attached
 * element, and it runs whenever a local audio stream is acquired (screen
 * share audio included).
 *
 * Gain up to 1 plays through the element. Above 1 the element is silenced
 * and a MediaStreamAudioSourceNode -> GainNode chain on the shared voice
 * AudioContext carries the signal. Chrome renders remote WebRTC audio in
 * Web Audio only while the track is also attached to a playing element, so
 * the element stays attached at volume 0.
 */

import { debug } from '@/utils/debug';
import {
  canCreateVoiceAudioContext,
  contextSupportsSink,
  getVoiceAudioContext,
  getVoiceAudioSink,
  peekVoiceAudioContext,
  resumeVoiceAudioContext,
  setVoiceAudioSink,
} from './voiceAudioContext';

export type RemoteAudioKind = 'mic' | 'screen';

export const VOLUME_MIN = 0;
export const VOLUME_MAX = 200;
export const VOLUME_UNITY = 100;

// setTargetAtTime time constant, seconds. Short enough to track a dragged
// slider, long enough to avoid zipper noise.
const GAIN_SMOOTHING_S = 0.02;

/** Percent, rounded and clamped to [0, 200]. Non-finite input reads as unity. */
export function clampVolume(volume: number): number {
  if (!Number.isFinite(volume)) return VOLUME_UNITY;
  return Math.round(Math.min(VOLUME_MAX, Math.max(VOLUME_MIN, volume)));
}

export interface GainInputs {
  /** Per-user percent, 0-200. */
  volume: number;
  /** Master output percent, 0-200. */
  master?: number;
  localMuted: boolean;
  deafened: boolean;
  /** Dry path silenced because another renderer (spatial audio) plays it. */
  dryMuted: boolean;
}

/** Linear gain for one remote track: per-user level times master level. 1 is unity. */
export function effectiveGain(inputs: GainInputs): number {
  if (inputs.deafened || inputs.localMuted || inputs.dryMuted) return 0;
  const master = inputs.master === undefined ? VOLUME_UNITY : clampVolume(inputs.master);
  return (clampVolume(inputs.volume) / VOLUME_UNITY) * (master / VOLUME_UNITY);
}

export interface PlaybackPlan {
  /** HTMLMediaElement.volume, [0, 1]. */
  elementVolume: number;
  /** GainNode value when the Web Audio path carries the signal, else null. */
  boost: number | null;
}

export function playbackPlan(gain: number, canBoost: boolean): PlaybackPlan {
  const g = Number.isFinite(gain) ? Math.max(0, gain) : 1;
  if (g <= 1 || !canBoost) return { elementVolume: Math.min(1, g), boost: null };
  return { elementVolume: 0, boost: g };
}

interface Slot {
  userId: string;
  kind: RemoteAudioKind;
  element: HTMLMediaElement;
  source: MediaStreamAudioSourceNode | null;
  gain: GainNode | null;
  trackId: string | null;
}

type SinkCapableElement = HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };

function slotKey(userId: string, kind: RemoteAudioKind): string {
  return `${kind}:${userId}`;
}

function firstAudioTrack(element: HTMLMediaElement): MediaStreamTrack | null {
  const stream = element.srcObject as MediaStream | null;
  if (!stream || typeof stream.getAudioTracks !== 'function') return null;
  return stream.getAudioTracks()[0] ?? null;
}

function isNotAllowed(error: unknown): boolean {
  return !!error && typeof error === 'object' && (error as { name?: string }).name === 'NotAllowedError';
}

export class RemoteAudioMixer {
  private slots = new Map<string, Slot>();
  private volumes: Record<RemoteAudioKind, Map<string, number>> = { mic: new Map(), screen: new Map() };
  private mutes: Record<RemoteAudioKind, Set<string>> = { mic: new Set(), screen: new Set() };
  private deafened = false;
  private dryMuted: Record<RemoteAudioKind, boolean> = { mic: false, screen: false };
  private masterVolume = VOLUME_UNITY;
  private blocked = false;
  private blockedListeners = new Set<(blocked: boolean) => void>();
  // Boost output for browsers whose AudioContext cannot pick a sink.
  private fallbackOut: { dest: MediaStreamAudioDestinationNode; element: HTMLAudioElement } | null = null;

  // PREFERENCES

  setVolume(userId: string, kind: RemoteAudioKind, volume: number): void {
    const v = clampVolume(volume);
    if (v === VOLUME_UNITY) this.volumes[kind].delete(userId);
    else this.volumes[kind].set(userId, v);
    this.applyUser(userId, kind);
  }

  getVolume(userId: string, kind: RemoteAudioKind): number {
    return this.volumes[kind].get(userId) ?? VOLUME_UNITY;
  }

  setLocalMute(userId: string, kind: RemoteAudioKind, muted: boolean): void {
    if (muted) this.mutes[kind].add(userId);
    else this.mutes[kind].delete(userId);
    this.applyUser(userId, kind);
  }

  isLocalMuted(userId: string, kind: RemoteAudioKind): boolean {
    return this.mutes[kind].has(userId);
  }

  /**
   * Percent a renderer outside the mixer (spatial audio, native playout)
   * should use: per-user level times master, 0 when locally muted.
   */
  getEffectiveVolume(userId: string, kind: RemoteAudioKind): number {
    if (this.isLocalMuted(userId, kind)) return 0;
    return clampVolume(this.getVolume(userId, kind) * this.masterVolume / VOLUME_UNITY);
  }

  /** Master output percent (0-200) applied on top of every per-user level. */
  setMasterVolume(volume: number): void {
    const v = clampVolume(volume);
    if (v === this.masterVolume) return;
    this.masterVolume = v;
    this.applyAll();
  }

  getMasterVolume(): number {
    return this.masterVolume;
  }

  setDeafened(deafened: boolean): void {
    if (this.deafened === deafened) return;
    this.deafened = deafened;
    this.applyAll();
  }

  setDryMuted(kind: RemoteAudioKind, muted: boolean): void {
    if (this.dryMuted[kind] === muted) return;
    this.dryMuted[kind] = muted;
    this.applyAll();
  }

  // ELEMENTS

  /** Registers the playing element for a user's track, replacing any previous one. */
  attach(userId: string, kind: RemoteAudioKind, element: HTMLMediaElement): void {
    const key = slotKey(userId, kind);
    const previous = this.slots.get(key);
    if (previous && previous.element !== element) {
      this.teardownBoost(previous);
      previous.element.volume = 1;
    }
    const slot: Slot = previous?.element === element
      ? previous
      : { userId, kind, element, source: null, gain: null, trackId: null };
    this.slots.set(key, slot);
    this.applySinkToElement(element);
    this.apply(slot);
    this.play(element);
  }

  /** Unregisters; with `element`, only when it is still the registered one. */
  detach(userId: string, kind: RemoteAudioKind, element?: HTMLMediaElement): void {
    const key = slotKey(userId, kind);
    const slot = this.slots.get(key);
    if (!slot || (element && slot.element !== element)) return;
    this.teardownBoost(slot);
    // livekit-client recycles detached audio elements.
    slot.element.volume = 1;
    this.slots.delete(key);
  }

  has(userId: string, kind: RemoteAudioKind): boolean {
    return this.slots.has(slotKey(userId, kind));
  }

  /** Drops every element and the session flags. Volumes and mutes persist. */
  reset(): void {
    for (const slot of this.slots.values()) {
      this.teardownBoost(slot);
      slot.element.volume = 1;
    }
    this.slots.clear();
    this.deafened = false;
    this.dryMuted = { mic: false, screen: false };
    this.teardownFallbackOut();
    this.setBlocked(false);
  }

  // OUTPUT DEVICE

  async setOutputDevice(deviceId: string | null): Promise<void> {
    await setVoiceAudioSink(deviceId);
    for (const slot of this.slots.values()) this.applySinkToElement(slot.element);
    if (this.fallbackOut) this.applySinkToElement(this.fallbackOut.element);
    // Boost chains follow the new route.
    for (const slot of this.slots.values()) {
      if (slot.gain) {
        slot.gain.disconnect();
        const destination = this.boostDestination();
        if (destination) slot.gain.connect(destination);
      }
    }
    if (!this.needsFallbackOut()) this.teardownFallbackOut();
  }

  // AUTOPLAY

  isBlocked(): boolean {
    return this.blocked;
  }

  onBlockedChange(listener: (blocked: boolean) => void): () => void {
    this.blockedListeners.add(listener);
    return () => this.blockedListeners.delete(listener);
  }

  /** Marks playback blocked; the transport reports autoplay failures it detects itself. */
  setBlocked(blocked: boolean): void {
    if (this.blocked === blocked) return;
    this.blocked = blocked;
    for (const listener of this.blockedListeners) {
      try {
        listener(blocked);
      } catch (error) {
        debug.warn('[Mixer] blocked listener failed:', error);
      }
    }
  }

  /** Retries playback; call from a user gesture. True when everything plays. */
  async resume(): Promise<boolean> {
    const contextRunning = await resumeVoiceAudioContext();
    const elements = [...this.slots.values()].map(s => s.element);
    if (this.fallbackOut) elements.push(this.fallbackOut.element);
    const results = await Promise.all(elements.map(el => {
      try {
        return Promise.resolve(el.play()).then(() => true, (e: unknown) => !isNotAllowed(e));
      } catch {
        return Promise.resolve(true);
      }
    }));
    const ok = contextRunning && results.every(Boolean);
    this.setBlocked(!ok);
    return ok;
  }

  // INTERNALS

  private applyUser(userId: string, kind: RemoteAudioKind): void {
    const slot = this.slots.get(slotKey(userId, kind));
    if (slot) this.apply(slot);
  }

  private applyAll(): void {
    for (const slot of this.slots.values()) this.apply(slot);
  }

  private apply(slot: Slot): void {
    const gain = effectiveGain({
      volume: this.getVolume(slot.userId, slot.kind),
      master: this.masterVolume,
      localMuted: this.isLocalMuted(slot.userId, slot.kind),
      deafened: this.deafened,
      dryMuted: this.dryMuted[slot.kind],
    });
    const plan = playbackPlan(gain, canCreateVoiceAudioContext());
    if (plan.boost === null) {
      this.teardownBoost(slot);
      slot.element.volume = plan.elementVolume;
      return;
    }
    if (this.ensureBoost(slot, plan.boost)) {
      slot.element.volume = 0;
    } else {
      // No Web Audio path: unity is the ceiling.
      slot.element.volume = 1;
    }
  }

  private ensureBoost(slot: Slot, gainValue: number): boolean {
    const ctx = getVoiceAudioContext();
    const track = firstAudioTrack(slot.element);
    if (!ctx || !track) return false;

    if (slot.source && slot.trackId !== track.id) this.teardownBoost(slot);

    if (!slot.source || !slot.gain) {
      const destination = this.boostDestination();
      if (!destination) return false;
      try {
        const source = ctx.createMediaStreamSource(new MediaStream([track]));
        const gain = ctx.createGain();
        gain.gain.value = gainValue;
        source.connect(gain);
        gain.connect(destination);
        slot.source = source;
        slot.gain = gain;
        slot.trackId = track.id;
      } catch (error) {
        debug.warn('[Mixer] boost chain failed:', error);
        this.teardownBoost(slot);
        return false;
      }
    } else {
      slot.gain.gain.setTargetAtTime(gainValue, ctx.currentTime, GAIN_SMOOTHING_S);
    }

    if (ctx.state !== 'running') {
      void resumeVoiceAudioContext().then(running => {
        if (!running) this.setBlocked(true);
      });
    }
    return true;
  }

  private teardownBoost(slot: Slot): void {
    try {
      slot.gain?.disconnect();
      slot.source?.disconnect();
    } catch {
      // Nodes of a closed context throw on disconnect; nothing left to free.
    }
    slot.gain = null;
    slot.source = null;
    slot.trackId = null;
  }

  private needsFallbackOut(): boolean {
    const sink = getVoiceAudioSink();
    if (!sink || sink === 'default') return false;
    return !contextSupportsSink(peekVoiceAudioContext());
  }

  private boostDestination(): AudioNode | null {
    const ctx = getVoiceAudioContext();
    if (!ctx) return null;
    if (!this.needsFallbackOut()) return ctx.destination;
    if (!this.fallbackOut) {
      try {
        const dest = ctx.createMediaStreamDestination();
        const element = document.createElement('audio');
        element.autoplay = true;
        element.srcObject = dest.stream;
        this.fallbackOut = { dest, element };
        this.applySinkToElement(element);
        this.play(element);
      } catch (error) {
        debug.warn('[Mixer] fallback output failed:', error);
        return ctx.destination;
      }
    }
    return this.fallbackOut.dest;
  }

  private teardownFallbackOut(): void {
    if (!this.fallbackOut) return;
    try {
      this.fallbackOut.dest.disconnect();
    } catch {
      // Closed context.
    }
    this.fallbackOut.element.pause();
    this.fallbackOut.element.srcObject = null;
    this.fallbackOut = null;
  }

  private applySinkToElement(element: HTMLMediaElement): void {
    const el = element as SinkCapableElement;
    if (typeof el.setSinkId !== 'function') return;
    const sink = getVoiceAudioSink();
    const target = sink === 'default' ? '' : sink;
    if ((el as unknown as { sinkId?: string }).sinkId === target) return;
    el.setSinkId(target).catch((error: unknown) => {
      debug.warn('[Mixer] setSinkId failed:', error);
    });
  }

  private play(element: HTMLMediaElement): void {
    try {
      const result = element.play();
      if (result && typeof result.catch === 'function') {
        result.catch((error: unknown) => {
          if (isNotAllowed(error)) this.setBlocked(true);
        });
      }
    } catch {
      // Detached or srcObject-less elements throw synchronously in some engines.
    }
  }
}

export const remoteAudioMixer = new RemoteAudioMixer();
