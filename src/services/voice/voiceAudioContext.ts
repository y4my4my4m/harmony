/**
 * The one AudioContext used by voice playback: per-user boost chains in
 * remoteAudioMixer and the spatial audio graph.
 *
 * Output device: AudioContext.setSinkId (Chrome 110+) routes everything
 * connected to `destination`. Browsers without it render to the system
 * default; remoteAudioMixer covers that case with an element fallback.
 */

import { debug } from '@/utils/debug';

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let context: SinkCapableContext | null = null;
let sinkId = '';

function contextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  return w.AudioContext ?? w.webkitAudioContext ?? null;
}

export function canCreateVoiceAudioContext(): boolean {
  return contextConstructor() !== null;
}

/** Existing context, or null. Never creates one. */
export function peekVoiceAudioContext(): AudioContext | null {
  return context && context.state !== 'closed' ? context : null;
}

/** Creates the context on first use. Null where Web Audio is unavailable. */
export function getVoiceAudioContext(): AudioContext | null {
  const existing = peekVoiceAudioContext();
  if (existing) return existing;
  const Ctor = contextConstructor();
  if (!Ctor) return null;
  try {
    context = new Ctor({ latencyHint: 'interactive' }) as SinkCapableContext;
  } catch (error) {
    debug.warn('[VoiceAudio] AudioContext creation failed:', error);
    context = null;
    return null;
  }
  if (sinkId) void applySink(context);
  return context;
}

export function contextSupportsSink(ctx: AudioContext | null): boolean {
  return !!ctx && typeof (ctx as SinkCapableContext).setSinkId === 'function';
}

// 'default' and '' both mean the system default; setSinkId('') selects it.
function normalizeSink(id: string): string {
  return id === 'default' ? '' : id;
}

async function applySink(ctx: SinkCapableContext): Promise<void> {
  if (typeof ctx.setSinkId !== 'function') return;
  try {
    await ctx.setSinkId(normalizeSink(sinkId));
  } catch (error) {
    debug.warn('[VoiceAudio] AudioContext.setSinkId failed:', error);
  }
}

/** Records the output device and applies it to the live context when supported. */
export async function setVoiceAudioSink(id: string | null): Promise<void> {
  sinkId = id ?? '';
  const ctx = peekVoiceAudioContext() as SinkCapableContext | null;
  if (ctx) await applySink(ctx);
}

export function getVoiceAudioSink(): string {
  return sinkId;
}

/** Resumes a suspended context. True when it ends up running. */
export async function resumeVoiceAudioContext(): Promise<boolean> {
  const ctx = peekVoiceAudioContext();
  if (!ctx) return true;
  if (ctx.state === 'running') return true;
  try {
    await ctx.resume();
  } catch (error) {
    debug.warn('[VoiceAudio] AudioContext.resume failed:', error);
  }
  // resume() changes state; the cast drops TypeScript's pre-await narrowing.
  return (ctx.state as AudioContextState) === 'running';
}

/** Closes the context; the next getVoiceAudioContext() creates a fresh one. */
export async function closeVoiceAudioContext(): Promise<void> {
  const ctx = context;
  context = null;
  if (!ctx || ctx.state === 'closed') return;
  try {
    await ctx.close();
  } catch (error) {
    debug.warn('[VoiceAudio] AudioContext.close failed:', error);
  }
}
