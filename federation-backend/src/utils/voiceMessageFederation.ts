/**
 * Federate Harmony voice-message UI metadata (duration + waveform) over ActivityPub.
 * Client renders VoiceMessagePlayer when message.metadata.voice_message is set.
 */

export function harmonyVoiceMessageFromObject(object: unknown): {
  voice_message: { duration: number; waveform: number[] };
} | null {
  if (!object || typeof object !== 'object') return null;
  const vm = (object as Record<string, unknown>)['harmony:voiceMessage'];
  if (!vm || typeof vm !== 'object') return null;
  const o = vm as Record<string, unknown>;
  const duration =
    typeof o.duration === 'number' && !Number.isNaN(o.duration)
      ? o.duration
      : Number(o.duration) || 0;
  const raw = o.waveform;
  const waveform = Array.isArray(raw)
    ? raw
        .map((n) => (typeof n === 'number' ? n : Number(n)))
        .filter((n) => typeof n === 'number' && !Number.isNaN(n))
    : [];
  return { voice_message: { duration, waveform } };
}

export function harmonyVoiceMessageExtension(metadata: unknown): {
  duration: number;
  waveform: number[];
} | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const vm = (metadata as Record<string, unknown>).voice_message;
  if (!vm || typeof vm !== 'object') return undefined;
  const o = vm as Record<string, unknown>;
  const duration =
    typeof o.duration === 'number' && !Number.isNaN(o.duration)
      ? o.duration
      : Number(o.duration) || 0;
  const raw = o.waveform;
  const waveform = Array.isArray(raw)
    ? raw
        .map((n) => (typeof n === 'number' ? n : Number(n)))
        .filter((n) => typeof n === 'number' && !Number.isNaN(n))
    : [];
  return { duration, waveform };
}
