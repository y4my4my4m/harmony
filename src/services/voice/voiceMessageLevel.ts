/**
 * Voice message loudness. Recording: a compressor, makeup gain and a limiter sit in front of the
 * encoder, so a quiet microphone still yields an audible clip (WebKit applies no automatic gain
 * to getUserMedia audio). Playback: a clip whose peak sits below TARGET_PEAK_DB is raised, by at
 * most MAX_BOOST_DB, through a GainNode on its media element; earlier quiet clips included.
 */
import { getVoiceAudioSink } from './voiceAudioContext';

/** dBFS. */
export const TARGET_PEAK_DB = -3;
/** dB. */
export const MAX_BOOST_DB = 24;
/**
 * dB after the recording compressor, on top of the compressor's own automatic makeup gain.
 * Measured in Chromium on a recording peaking at -30.5 dBFS (RMS -53 dB): out peak -2.8 dBFS,
 * RMS -20 dB; the same clip 26 dB louder: peak -1.2 dBFS, RMS -14 dB.
 */
const MAKEUP_DB = 12;

/** Highest |sample| over every channel, in dBFS; -Infinity for silence. */
export function peakDb(buffer: AudioBuffer): number {
  let peak = 0;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) {
      const v = Math.abs(data[i]);
      if (v > peak) peak = v;
    }
  }
  return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
}

/** Linear gain bringing `peak` (dBFS) to TARGET_PEAK_DB; never attenuates, capped at MAX_BOOST_DB. */
export function boostGain(peak: number): number {
  if (!Number.isFinite(peak)) return 1;
  const db = Math.min(MAX_BOOST_DB, TARGET_PEAK_DB - peak);
  return db > 0 ? 10 ** (db / 20) : 1;
}

/**
 * Recording chain from `input`: compressor (threshold -40 dB, ratio 6), MAKEUP_DB of gain, then a
 * limiter at -9 dB. Returns the last node; the caller connects it to the recorder's destination.
 */
export function levelChain(ctx: BaseAudioContext, input: AudioNode): AudioNode {
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -40;
  compressor.knee.value = 10;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.25;
  const makeup = ctx.createGain();
  makeup.gain.value = 10 ** (MAKEUP_DB / 20);
  const limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -9;
  limiter.knee.value = 0;
  limiter.ratio.value = 20;
  limiter.attack.value = 0.001;
  limiter.release.value = 0.1;
  input.connect(compressor);
  compressor.connect(makeup);
  makeup.connect(limiter);
  return limiter;
}

type SinkCapableContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let playback: SinkCapableContext | null = null;

/**
 * The context voice messages play through, on the selected output device where setSinkId exists.
 * Separate from the voice call context, which closes when a call ends and would silence every
 * element bound to it.
 */
export function voiceMessageContext(): AudioContext | null {
  if (playback && playback.state !== 'closed') return playback;
  if (typeof window === 'undefined') return null;
  const w = window as unknown as { AudioContext?: typeof AudioContext; webkitAudioContext?: typeof AudioContext };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) return null;
  try {
    playback = new Ctor() as SinkCapableContext;
  } catch {
    return null;
  }
  const sink = getVoiceAudioSink();
  if (sink && sink !== 'default' && typeof playback.setSinkId === 'function') {
    void playback.setSinkId(sink).catch(() => {});
  }
  return playback;
}

export interface MeasuredClip {
  /** dBFS. */
  peak: number;
  /** Seconds. */
  duration: number;
}

const measured = new Map<string, Promise<MeasuredClip | null>>();

/** Peak and duration of an audio file, decoded once per URL; null when it cannot be fetched or decoded. */
export function measureClip(src: string, ctx: BaseAudioContext): Promise<MeasuredClip | null> {
  let pending = measured.get(src);
  if (!pending) {
    pending = (async () => {
      try {
        const response = await fetch(src);
        if (!response.ok) return null;
        const buffer = await ctx.decodeAudioData(await response.arrayBuffer());
        return { peak: peakDb(buffer), duration: buffer.duration };
      } catch {
        return null;
      }
    })();
    measured.set(src, pending);
  }
  return pending;
}
