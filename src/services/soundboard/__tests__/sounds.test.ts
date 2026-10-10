import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => ({
  upload: vi.fn(),
  remove: vi.fn(),
  insert: vi.fn(),
  del: vi.fn(),
  insertResult: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/supabase', () => {
  const storageBucket = {
    upload: (...args: unknown[]) => {
      calls.upload(...args);
      return Promise.resolve({ error: null });
    },
    remove: (...args: unknown[]) => {
      calls.remove(...args);
      return Promise.resolve({ error: null });
    },
    getPublicUrl: (path: string) => ({ data: { publicUrl: `https://cdn.test/soundboard/${path}` } }),
  };
  const table = {
    insert: (row: unknown) => {
      calls.insert(row);
      return { select: () => ({ single: () => Promise.resolve(calls.insertResult) }) };
    },
    delete: () => ({
      eq: (col: string, value: string) => {
        calls.del(col, value);
        return Promise.resolve({ error: null });
      },
    }),
  };
  return { supabase: { storage: { from: () => storageBucket }, from: () => table } };
});

import {
  DEFAULT_SOUNDS,
  SOUNDBOARD_LIMITS,
  checkSoundFile,
  createServerSound,
  deleteServerSound,
  normalizeSoundEmoji,
  normalizeSoundVolume,
  sniffAudioType,
  soundboardErrorKey,
} from '../sounds';
import { isSoundId } from '../protocol';

const SERVER = '55555555-0000-0000-0000-000000000005';
const bytes = (...values: Array<number | string>) =>
  new Uint8Array(values.flatMap((v) => (typeof v === 'string' ? Array.from(v, (c) => c.charCodeAt(0)) : [v])));

describe('sniffAudioType', () => {
  it('knows MP3, Ogg and WAV by their first bytes', () => {
    expect(sniffAudioType(bytes('ID3', 4, 0))).toEqual({ mime: 'audio/mpeg', ext: 'mp3' });
    expect(sniffAudioType(bytes(0xff, 0xfb, 0x90))).toEqual({ mime: 'audio/mpeg', ext: 'mp3' });
    expect(sniffAudioType(bytes('OggS', 0))).toEqual({ mime: 'audio/ogg', ext: 'ogg' });
    expect(sniffAudioType(bytes('RIFF', 0, 0, 0, 0, 'WAVE'))).toEqual({ mime: 'audio/wav', ext: 'wav' });
  });

  it('refuses other containers', () => {
    expect(sniffAudioType(bytes(0xff, 0xf1))).toBeNull(); // AAC ADTS
    expect(sniffAudioType(bytes('RIFF', 0, 0, 0, 0, 'AVI '))).toBeNull();
    expect(sniffAudioType(bytes('<html>'))).toBeNull();
    expect(sniffAudioType(bytes())).toBeNull();
  });
});

describe('checkSoundFile', () => {
  const mp3 = (size = 1000) => new Blob([bytes('ID3'), new Uint8Array(Math.max(0, size - 3))], { type: 'audio/mpeg' });

  it('accepts a short sound within the size limit', async () => {
    await expect(checkSoundFile(mp3(), async () => 2100)).resolves.toEqual({
      ok: true,
      file: { type: { mime: 'audio/mpeg', ext: 'mp3' }, durationMs: 2100 },
    });
  });

  it('refuses a file over 512 KB before decoding it', async () => {
    const measure = vi.fn(async () => 1000);
    await expect(checkSoundFile(mp3(SOUNDBOARD_LIMITS.bytes + 1), measure)).resolves.toEqual({ ok: false, problem: 'tooLarge' });
    expect(measure).not.toHaveBeenCalled();
  });

  it('refuses a sound over 5.2 s', async () => {
    await expect(checkSoundFile(mp3(), async () => 5201)).resolves.toEqual({ ok: false, problem: 'tooLong' });
    await expect(checkSoundFile(mp3(), async () => 5200)).resolves.toMatchObject({ ok: true });
  });

  it('refuses what is not audio or does not decode', async () => {
    await expect(checkSoundFile(new Blob(['<script>']), async () => 100)).resolves.toEqual({ ok: false, problem: 'unsupported' });
    await expect(checkSoundFile(mp3(), async () => { throw new Error('decode'); })).resolves.toEqual({ ok: false, problem: 'unsupported' });
    await expect(checkSoundFile(mp3(), async () => 0)).resolves.toEqual({ ok: false, problem: 'unsupported' });
  });
});

describe('built-in sounds', () => {
  it('have wire-valid ids and ship as files', () => {
    for (const sound of DEFAULT_SOUNDS) {
      expect(isSoundId(sound.id)).toBe(true);
      const file = resolve(__dirname, '../../../../public', `.${sound.url}`);
      expect(existsSync(file)).toBe(true);
      expect(sniffAudioType(new Uint8Array(readFileSync(file).subarray(0, 12)))?.ext).toBe('mp3');
      expect(sound.durationMs).toBeLessThanOrEqual(SOUNDBOARD_LIMITS.durationMs);
    }
  });
});

describe('server sounds', () => {
  beforeEach(() => {
    calls.upload.mockReset();
    calls.remove.mockReset();
    calls.insert.mockReset();
    calls.del.mockReset();
    calls.insertResult = { data: null, error: null };
  });

  const checked = { type: { mime: 'audio/ogg' as const, ext: 'ogg' as const }, durationMs: 1500 };

  it('uploads under the server folder, then records the sound', async () => {
    calls.insertResult = {
      data: {
        id: 'b1', server_id: SERVER, name: 'Horn', emoji: '📯', volume: '0.80', duration_ms: 1500,
        storage_path: `${SERVER}/x.ogg`, created_by: 'me', created_at: '2026-10-10T00:00:00Z',
      },
      error: null,
    };
    const sound = await createServerSound(SERVER, new Blob(['OggS']), checked, { name: '  Horn ', emoji: ' 📯 ', volume: 0.8 });

    const [path, , options] = calls.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${SERVER}/[0-9a-f-]{36}\\.ogg$`));
    expect(options).toMatchObject({ contentType: 'audio/ogg', upsert: false });
    expect(calls.insert).toHaveBeenCalledWith({
      server_id: SERVER, name: 'Horn', emoji: '📯', volume: 0.8, duration_ms: 1500, storage_path: path,
    });
    expect(sound).toMatchObject({ id: 'b1', volume: 0.8, url: `https://cdn.test/soundboard/${SERVER}/x.ogg` });
  });

  it('removes the upload when the record is refused', async () => {
    calls.insertResult = { data: null, error: { code: '23514', message: 'SOUNDBOARD_FULL: a server holds at most 48 sounds' } };
    await expect(createServerSound(SERVER, new Blob(['OggS']), checked, { name: 'x', emoji: null, volume: 1 }))
      .rejects.toMatchObject({ code: '23514' });
    expect(calls.remove).toHaveBeenCalledWith([calls.upload.mock.calls[0][0]]);
  });

  it('deletes the record before the file', async () => {
    await deleteServerSound({
      id: 'b1', serverId: SERVER, name: 'x', emoji: null, volume: 1, durationMs: 1, url: '', storagePath: `${SERVER}/x.ogg`,
    });
    expect(calls.del).toHaveBeenCalledWith('id', 'b1');
    expect(calls.remove).toHaveBeenCalledWith([`${SERVER}/x.ogg`]);
    expect(calls.del.mock.invocationCallOrder[0]).toBeLessThan(calls.remove.mock.invocationCallOrder[0]);
  });
});

describe('input normalization', () => {
  it('stores volume in hundredths within 0-1', () => {
    expect(normalizeSoundVolume(0.456)).toBe(0.46);
    expect(normalizeSoundVolume(3)).toBe(1);
    expect(normalizeSoundVolume(-1)).toBe(0);
    expect(normalizeSoundVolume(Number.NaN)).toBe(1);
  });

  it('keeps a trimmed emoji or none', () => {
    expect(normalizeSoundEmoji('  🔔 ')).toBe('🔔');
    expect(normalizeSoundEmoji('   ')).toBeNull();
    expect(normalizeSoundEmoji(null)).toBeNull();
    expect(Array.from(normalizeSoundEmoji('🔔'.repeat(20)) ?? '')).toHaveLength(SOUNDBOARD_LIMITS.emoji);
  });
});

describe('soundboardErrorKey', () => {
  it('maps database and storage refusals', () => {
    expect(soundboardErrorKey({ code: '23514', message: 'SOUNDBOARD_FULL: a server holds at most 48 sounds' })).toBe('full');
    expect(soundboardErrorKey({ code: '22023', message: 'SOUNDBOARD_FILE_TOO_LARGE: 600000 bytes' })).toBe('tooLarge');
    expect(soundboardErrorKey({ statusCode: '413', message: 'The object exceeded the maximum allowed size' })).toBe('tooLarge');
    expect(soundboardErrorKey({ statusCode: 415, message: 'mime type audio/flac is not supported' })).toBe('unsupported');
    expect(soundboardErrorKey({ code: '42501', message: 'new row violates row-level security policy' })).toBe('permission');
    expect(soundboardErrorKey({ code: '23514', message: 'server_sounds_name_check' })).toBe('invalid');
    expect(soundboardErrorKey(new Error('network'))).toBe('generic');
    expect(soundboardErrorKey(null)).toBe('generic');
  });
});
