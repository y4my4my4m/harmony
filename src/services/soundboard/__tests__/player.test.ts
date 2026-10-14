import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUNDBOARD_MAX_CONCURRENT, SOUNDBOARD_MAX_DECODED, SoundboardPlayer, soundboardGain } from '../player';
import { setVoiceAudioSink } from '@/services/voice/voiceAudioContext';

class FakeAudio {
  src = '';
  volume = 1;
  preload = '';
  paused = true;
  sinkId = '';
  listeners: Record<string, Array<() => void>> = {};
  playResult: Promise<void> = Promise.resolve();
  addEventListener(type: string, cb: () => void) {
    (this.listeners[type] ??= []).push(cb);
  }
  play() {
    this.paused = false;
    return this.playResult;
  }
  pause() {
    this.paused = true;
  }
  removeAttribute(name: string) {
    if (name === 'src') this.src = '';
  }
  load() {}
  setSinkId = vi.fn(async (id: string) => {
    this.sinkId = id;
  });
  fire(type: string) {
    for (const cb of this.listeners[type] ?? []) cb();
  }
}

function makePlayer() {
  const created: FakeAudio[] = [];
  const player = new SoundboardPlayer(() => {
    const audio = new FakeAudio();
    created.push(audio);
    return audio as unknown as HTMLAudioElement;
  });
  return { player, created };
}

afterEach(async () => {
  await setVoiceAudioSink(null);
});

describe('soundboardGain', () => {
  it('multiplies the clip, soundboard and master levels', () => {
    expect(soundboardGain({ soundVolume: 1, soundboardVolume: 100, masterVolume: 100 })).toBe(1);
    expect(soundboardGain({ soundVolume: 0.5, soundboardVolume: 50, masterVolume: 100 })).toBe(0.25);
    expect(soundboardGain({ soundVolume: 0.5, soundboardVolume: 100, masterVolume: 150 })).toBe(0.75);
  });

  it('never exceeds unity or goes below zero', () => {
    expect(soundboardGain({ soundVolume: 1, soundboardVolume: 100, masterVolume: 200 })).toBe(1);
    expect(soundboardGain({ soundVolume: 2, soundboardVolume: 400, masterVolume: 100 })).toBe(1);
    expect(soundboardGain({ soundVolume: -1, soundboardVolume: 100, masterVolume: 100 })).toBe(0);
  });

  it('reads non-finite levels as their defaults', () => {
    expect(soundboardGain({ soundVolume: Number.NaN, soundboardVolume: Number.NaN, masterVolume: Number.NaN })).toBe(1);
  });
});

describe('SoundboardPlayer', () => {
  it('plays a clip at the given gain', () => {
    const { player, created } = makePlayer();
    const element = player.play('/a.mp3', 0.4);
    expect(element).not.toBeNull();
    expect(created[0].src).toBe('/a.mp3');
    expect(created[0].volume).toBe(0.4);
    expect(created[0].paused).toBe(false);
    expect(player.activeCount).toBe(1);
  });

  it('plays nothing at zero gain', () => {
    const { player, created } = makePlayer();
    expect(player.play('/a.mp3', 0)).toBeNull();
    expect(created).toHaveLength(0);
  });

  it('routes to the call output device', async () => {
    await setVoiceAudioSink('headset-1');
    const { player, created } = makePlayer();
    player.play('/a.mp3', 1);
    expect(created[0].setSinkId).toHaveBeenCalledWith('headset-1');
  });

  it('leaves the system default alone', async () => {
    await setVoiceAudioSink('default');
    const { player, created } = makePlayer();
    player.play('/a.mp3', 1);
    expect(created[0].setSinkId).not.toHaveBeenCalled();
  });

  it('stops the oldest clip past the concurrency cap', () => {
    const { player, created } = makePlayer();
    for (let i = 0; i <= SOUNDBOARD_MAX_CONCURRENT; i++) player.play(`/${i}.mp3`, 1);
    expect(player.activeCount).toBe(SOUNDBOARD_MAX_CONCURRENT);
    expect(created[0].paused).toBe(true);
    expect(created[SOUNDBOARD_MAX_CONCURRENT].paused).toBe(false);
  });

  it('forgets a clip once it ends', () => {
    const { player, created } = makePlayer();
    player.play('/a.mp3', 1);
    created[0].fire('ended');
    expect(player.activeCount).toBe(0);
  });

  it('forgets a clip the browser refuses to play', async () => {
    const refused = new SoundboardPlayer(() => {
      const audio = new FakeAudio();
      audio.playResult = Promise.reject(Object.assign(new Error('blocked'), { name: 'NotAllowedError' }));
      return audio as unknown as HTMLAudioElement;
    });
    refused.play('/a.mp3', 1);
    await Promise.resolve();
    await Promise.resolve();
    expect(refused.activeCount).toBe(0);
  });

  it('stops everything', () => {
    const { player, created } = makePlayer();
    player.play('/a.mp3', 1);
    player.play('/b.mp3', 1);
    player.stopAll();
    expect(player.activeCount).toBe(0);
    expect(created.every((a) => a.paused)).toBe(true);
  });
});

// A Web Audio context that records what it decodes and plays.
function fakeContext(options: { sink?: boolean } = {}) {
  const started: string[] = [];
  const stopped: string[] = [];
  const decodes: string[] = [];
  const ctx = {
    state: 'running',
    destination: {},
    decodeAudioData: vi.fn(async (bytes: ArrayBuffer) => {
      const url = new TextDecoder().decode(bytes);
      decodes.push(url);
      return { url } as unknown as AudioBuffer;
    }),
    createGain: () => ({ gain: { value: 1 }, connect: vi.fn(), disconnect: vi.fn() }),
    createBufferSource: () => {
      const source = {
        buffer: null as unknown as { url: string } | null,
        onended: null as null | (() => void),
        connect: vi.fn(),
        disconnect: vi.fn(),
        start: vi.fn(() => started.push(source.buffer!.url)),
        stop: vi.fn(() => stopped.push(source.buffer!.url)),
      };
      return source;
    },
    resume: vi.fn(async () => {}),
    ...(options.sink ? { setSinkId: vi.fn(async () => {}) } : {}),
  };
  return { ctx: ctx as unknown as AudioContext, started, stopped, decodes };
}

const settle = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 20));
};

function makeWebAudioPlayer(options: { sink?: boolean } = {}) {
  const audio = fakeContext(options);
  const created: FakeAudio[] = [];
  const player = new SoundboardPlayer(
    () => {
      const element = new FakeAudio();
      created.push(element);
      return element as unknown as HTMLAudioElement;
    },
    () => audio.ctx,
    async (url) => new TextEncoder().encode(url).buffer as ArrayBuffer,
  );
  return { player, created, ...audio };
}

describe('SoundboardPlayer from memory', () => {
  it('plays a prewarmed clip from its decoded buffer, without an element', async () => {
    const { player, created, started, decodes } = makeWebAudioPlayer();
    player.prewarm(['/a.mp3', '/b.mp3']);
    await settle();
    expect(decodes).toEqual(['/a.mp3', '/b.mp3']);
    expect(player.play('/a.mp3', 0.5)).not.toBeNull();
    expect(started).toEqual(['/a.mp3']);
    expect(created).toHaveLength(0);
    expect(player.activeCount).toBe(1);
  });

  it('plays a clip not yet decoded by element and decodes it for the next play', async () => {
    const { player, created, started, decodes } = makeWebAudioPlayer();
    player.play('/a.mp3', 1);
    expect(created).toHaveLength(1);
    await settle();
    expect(decodes).toEqual(['/a.mp3']);
    player.play('/a.mp3', 1);
    expect(started).toEqual(['/a.mp3']);
    expect(created).toHaveLength(1);
  });

  it('decodes a clip once however often it is prewarmed', async () => {
    const { player, decodes } = makeWebAudioPlayer();
    player.prewarm(['/a.mp3']);
    player.prewarm(['/a.mp3', '/a.mp3']);
    await settle();
    player.prewarm(['/a.mp3']);
    await settle();
    expect(decodes).toEqual(['/a.mp3']);
  });

  it('uses an element for a device the context cannot reach', async () => {
    await setVoiceAudioSink('headset-1');
    const { player, created, started } = makeWebAudioPlayer({ sink: false });
    player.prewarm(['/a.mp3']);
    await settle();
    player.play('/a.mp3', 1);
    expect(started).toEqual([]);
    expect(created[0].setSinkId).toHaveBeenCalledWith('headset-1');
  });

  it('plays from memory on a device the context routes to', async () => {
    await setVoiceAudioSink('headset-1');
    const { player, created, started } = makeWebAudioPlayer({ sink: true });
    player.prewarm(['/a.mp3']);
    await settle();
    player.play('/a.mp3', 1);
    expect(started).toEqual(['/a.mp3']);
    expect(created).toHaveLength(0);
  });

  it('stops the oldest clip past the concurrency cap', async () => {
    const { player, stopped } = makeWebAudioPlayer();
    const urls = Array.from({ length: SOUNDBOARD_MAX_CONCURRENT + 1 }, (_, i) => `/${i}.mp3`);
    player.prewarm(urls);
    await settle();
    for (const url of urls) player.play(url, 1);
    expect(player.activeCount).toBe(SOUNDBOARD_MAX_CONCURRENT);
    expect(stopped).toEqual(['/0.mp3']);
  });

  it(`keeps at most ${SOUNDBOARD_MAX_DECODED} decoded clips`, async () => {
    const { player } = makeWebAudioPlayer();
    const urls = Array.from({ length: SOUNDBOARD_MAX_DECODED + 5 }, (_, i) => `/${i}.mp3`);
    for (const url of urls) player.play(url, 1);
    for (let i = 0; i < 20; i++) await settle();
    expect(player.decodedCount).toBe(SOUNDBOARD_MAX_DECODED);
  }, 20000);
});
