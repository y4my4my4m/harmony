import { afterEach, describe, expect, it, vi } from 'vitest';
import { SOUNDBOARD_MAX_CONCURRENT, SoundboardPlayer, soundboardGain } from '../player';
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
