/**
 * Per-listener audio preferences for other users: microphone and stream
 * volume (percent, 0-200) and local mutes. Stored in user-scoped storage,
 * keyed by profile UUID.
 *
 * Storage keys:
 *   user-volumes             {"<uuid>": <percent>}  microphone
 *   user-screenshare-volumes {"<uuid>": <percent>}  stream audio
 *   user-audio-mutes         {"mic": ["<uuid>"], "screen": ["<uuid>"]}
 *
 * Unity (100) entries are dropped on write.
 */

import { clampVolume, VOLUME_UNITY, type RemoteAudioKind } from './remoteAudioMixer';

export const MIC_VOLUMES_KEY = 'user-volumes';
export const STREAM_VOLUMES_KEY = 'user-screenshare-volumes';
export const LOCAL_MUTES_KEY = 'user-audio-mutes';

export interface KeyValueStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface AudioPrefs {
  micVolumes: Map<string, number>;
  streamVolumes: Map<string, number>;
  mutes: Record<RemoteAudioKind, Set<string>>;
}

function parseJson(raw: string | null): unknown {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function parseVolumeMap(raw: string | null): Map<string, number> {
  const out = new Map<string, number>();
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const [userId, volume] of Object.entries(value as Record<string, unknown>)) {
    if (!userId || typeof volume !== 'number' || !Number.isFinite(volume)) continue;
    const v = clampVolume(volume);
    if (v !== VOLUME_UNITY) out.set(userId, v);
  }
  return out;
}

export function serializeVolumeMap(map: Map<string, number>): string {
  const out: Record<string, number> = {};
  for (const [userId, volume] of map) {
    const v = clampVolume(volume);
    if (v !== VOLUME_UNITY) out[userId] = v;
  }
  return JSON.stringify(out);
}

export function parseMutes(raw: string | null): Record<RemoteAudioKind, Set<string>> {
  const out: Record<RemoteAudioKind, Set<string>> = { mic: new Set(), screen: new Set() };
  const value = parseJson(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return out;
  for (const kind of ['mic', 'screen'] as const) {
    const list = (value as Record<string, unknown>)[kind];
    if (!Array.isArray(list)) continue;
    for (const id of list) {
      if (typeof id === 'string' && id) out[kind].add(id);
    }
  }
  return out;
}

export function serializeMutes(mutes: Record<RemoteAudioKind, Set<string>>): string {
  return JSON.stringify({ mic: [...mutes.mic].sort(), screen: [...mutes.screen].sort() });
}

export function loadAudioPrefs(storage: KeyValueStorage): AudioPrefs {
  return {
    micVolumes: parseVolumeMap(storage.getItem(MIC_VOLUMES_KEY)),
    streamVolumes: parseVolumeMap(storage.getItem(STREAM_VOLUMES_KEY)),
    mutes: parseMutes(storage.getItem(LOCAL_MUTES_KEY)),
  };
}

export function saveVolumes(storage: KeyValueStorage, kind: RemoteAudioKind, map: Map<string, number>): void {
  storage.setItem(kind === 'mic' ? MIC_VOLUMES_KEY : STREAM_VOLUMES_KEY, serializeVolumeMap(map));
}

export function saveMutes(storage: KeyValueStorage, mutes: Record<RemoteAudioKind, Set<string>>): void {
  storage.setItem(LOCAL_MUTES_KEY, serializeMutes(mutes));
}
