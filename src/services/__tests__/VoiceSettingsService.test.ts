import { describe, expect, it } from 'vitest';
import {
  SETTINGS_VERSION,
  migrateVoiceSettings,
  normalizeOutputVolume,
  type VoiceSettings,
} from '../VoiceSettingsService';

describe('migrateVoiceSettings', () => {
  it('moves an untouched v1 master volume to 100', () => {
    const stored: Partial<VoiceSettings> = { inputVolume: 75, outputVolume: 75 };
    expect(migrateVoiceSettings(stored)).toBe(true);
    expect(stored.outputVolume).toBe(100);
    expect(stored.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('recognises string values written by the v1 sliders', () => {
    const stored = { inputVolume: '75', outputVolume: '75' } as unknown as Partial<VoiceSettings>;
    migrateVoiceSettings(stored);
    expect(stored.outputVolume).toBe(100);
  });

  it('moves the v1 input default to unity, which is what every v1 user sent', () => {
    const untouched: Partial<VoiceSettings> = { inputVolume: 75, outputVolume: 60 };
    migrateVoiceSettings(untouched);
    expect(untouched.inputVolume).toBe(100);
    expect(untouched.outputVolume).toBe(60);

    const chosen: Partial<VoiceSettings> = { inputVolume: 140, outputVolume: 75 };
    migrateVoiceSettings(chosen);
    expect(chosen.inputVolume).toBe(140);
    expect(chosen.outputVolume).toBe(75);
  });

  it('keeps a master volume the user chose', () => {
    const stored: Partial<VoiceSettings> = { inputVolume: 75, outputVolume: 40 };
    migrateVoiceSettings(stored);
    expect(stored.outputVolume).toBe(40);
  });

  it('keeps 75 when the input slider was moved, since the sliders were touched', () => {
    const stored: Partial<VoiceSettings> = { inputVolume: 90, outputVolume: 75 };
    migrateVoiceSettings(stored);
    expect(stored.outputVolume).toBe(75);
    expect(stored.settingsVersion).toBe(SETTINGS_VERSION);
  });

  it('runs once', () => {
    const stored: Partial<VoiceSettings> = { inputVolume: 75, outputVolume: 75, settingsVersion: SETTINGS_VERSION };
    expect(migrateVoiceSettings(stored)).toBe(false);
    expect(stored.outputVolume).toBe(75);
  });
});

describe('normalizeOutputVolume', () => {
  it('clamps to 0-200 and parses strings', () => {
    expect(normalizeOutputVolume('150')).toBe(150);
    expect(normalizeOutputVolume(500)).toBe(200);
    expect(normalizeOutputVolume(-1)).toBe(0);
    expect(normalizeOutputVolume(undefined)).toBe(100);
  });
});
