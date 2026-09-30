import { describe, expect, it } from 'vitest';
import {
  LOCAL_MUTES_KEY,
  MIC_VOLUMES_KEY,
  STREAM_VOLUMES_KEY,
  loadAudioPrefs,
  parseMutes,
  parseVolumeMap,
  saveMutes,
  saveVolumes,
  serializeVolumeMap,
} from '../voiceAudioPrefs';

class MemoryStorage {
  data = new Map<string, string>();
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
}

describe('parseVolumeMap', () => {
  it('reads valid entries and clamps them', () => {
    const map = parseVolumeMap('{"a": 50, "b": 250, "c": -3}');
    expect([...map]).toEqual([['a', 50], ['b', 200], ['c', 0]]);
  });

  it('drops unity, non-numeric and malformed entries', () => {
    expect([...parseVolumeMap('{"a": 100, "b": "80", "c": null}')]).toEqual([]);
    expect(parseVolumeMap('not json').size).toBe(0);
    expect(parseVolumeMap('[1,2]').size).toBe(0);
    expect(parseVolumeMap(null).size).toBe(0);
  });
});

describe('serializeVolumeMap', () => {
  it('omits unity and rounds', () => {
    const map = new Map([['a', 100], ['b', 33.4]]);
    expect(serializeVolumeMap(map)).toBe('{"b":33}');
  });
});

describe('parseMutes', () => {
  it('reads both kinds and ignores junk', () => {
    const mutes = parseMutes('{"mic": ["a", 3, ""], "screen": ["b"], "extra": ["c"]}');
    expect([...mutes.mic]).toEqual(['a']);
    expect([...mutes.screen]).toEqual(['b']);
  });

  it('returns empty sets for missing or malformed input', () => {
    const mutes = parseMutes('{');
    expect(mutes.mic.size + mutes.screen.size).toBe(0);
  });
});

describe('round trip', () => {
  it('saves and loads every preference', () => {
    const storage = new MemoryStorage();
    saveVolumes(storage, 'mic', new Map([['u1', 150]]));
    saveVolumes(storage, 'screen', new Map([['u2', 20]]));
    saveMutes(storage, { mic: new Set(['u3']), screen: new Set(['u1']) });

    expect(storage.data.has(MIC_VOLUMES_KEY)).toBe(true);
    expect(storage.data.has(STREAM_VOLUMES_KEY)).toBe(true);
    expect(storage.data.has(LOCAL_MUTES_KEY)).toBe(true);

    const prefs = loadAudioPrefs(storage);
    expect(prefs.micVolumes.get('u1')).toBe(150);
    expect(prefs.streamVolumes.get('u2')).toBe(20);
    expect(prefs.mutes.mic.has('u3')).toBe(true);
    expect(prefs.mutes.screen.has('u1')).toBe(true);
  });

  it('reads the pre-existing volume format', () => {
    const storage = new MemoryStorage();
    storage.setItem(MIC_VOLUMES_KEY, JSON.stringify({ u1: 0, u2: 100, u3: 175 }));
    const prefs = loadAudioPrefs(storage);
    expect(prefs.micVolumes.get('u1')).toBe(0);
    expect(prefs.micVolumes.has('u2')).toBe(false);
    expect(prefs.micVolumes.get('u3')).toBe(175);
  });
});
