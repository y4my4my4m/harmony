import { describe, expect, it } from 'vitest';
import {
  SOUNDBOARD_RECEIVE_INTERVAL_MS,
  SoundboardRateLimiter,
  buildSoundboardMessage,
  checkIncomingPlay,
  isExternalPlay,
  isSoundId,
  parseSoundboardMessage,
  soundboardExternalGrant,
  soundboardGrant,
  type ReceiveContext,
  type SoundboardTransportEvent,
} from '../protocol';

const SERVER = '55555555-0000-0000-0000-000000000005';
const SOUND = 'b1160000-0000-0000-0000-000000000001';
const ALICE = '11111111-0000-0000-0000-000000000001';
const BOB = '22222222-0000-0000-0000-000000000002';
const OTHER = '77777777-0000-0000-0000-000000000007';

describe('soundboard messages', () => {
  it('round-trips a play', () => {
    const message = buildSoundboardMessage(SOUND, SERVER, ALICE);
    expect(parseSoundboardMessage(JSON.parse(JSON.stringify(message)))).toEqual(message);
  });

  it('names the sound\'s server only for another server\'s sound', () => {
    const external = buildSoundboardMessage(SOUND, SERVER, ALICE, OTHER);
    expect(external.soundServerId).toBe(OTHER);
    expect(isExternalPlay(external)).toBe(true);
    expect(parseSoundboardMessage(JSON.parse(JSON.stringify(external)))).toEqual(external);
    expect(buildSoundboardMessage(SOUND, SERVER, ALICE, SERVER)).not.toHaveProperty('soundServerId');
    expect(buildSoundboardMessage(SOUND, SERVER, ALICE, SERVER.toUpperCase())).not.toHaveProperty('soundServerId');
    expect(buildSoundboardMessage('default:ding', SERVER, ALICE, OTHER)).not.toHaveProperty('soundServerId');
    expect(isExternalPlay(buildSoundboardMessage(SOUND, SERVER, ALICE))).toBe(false);
    expect(parseSoundboardMessage({ ...external, soundServerId: OTHER.toUpperCase() })?.soundServerId).toBe(OTHER);
  });

  it('accepts built-in ids', () => {
    expect(isSoundId('default:sad-trombone')).toBe(true);
    expect(parseSoundboardMessage(buildSoundboardMessage('default:ding', SERVER, ALICE))?.soundId).toBe('default:ding');
  });

  it('refuses anything else', () => {
    const good = buildSoundboardMessage(SOUND, SERVER, ALICE);
    for (const bad of [
      null,
      'soundboard',
      [],
      { ...good, type: 'media-state' },
      { ...good, v: 2 },
      { ...good, soundId: 'default:../../x' },
      { ...good, soundId: 'not-a-sound' },
      { ...good, serverId: 'dm' },
      { ...good, userId: '' },
      { ...good, userId: 42 },
      { ...good, soundServerId: 'elsewhere' },
      { ...good, soundServerId: null },
    ]) {
      expect(parseSoundboardMessage(bad)).toBeNull();
    }
  });

  it('reads the token grant from participant metadata', () => {
    expect(soundboardGrant(JSON.stringify({ profileId: ALICE, soundboard: true }))).toBe(true);
    expect(soundboardGrant(JSON.stringify({ soundboard: false }))).toBe(false);
    expect(soundboardGrant(JSON.stringify({ profileId: ALICE }))).toBeNull();
    expect(soundboardGrant(JSON.stringify({ soundboard: 'yes' }))).toBeNull();
    expect(soundboardGrant('not json')).toBeNull();
    expect(soundboardGrant(undefined)).toBeNull();
  });

  it('reads the external sounds grant from participant metadata', () => {
    expect(soundboardExternalGrant(JSON.stringify({ soundboard: true, soundboardExternal: true }))).toBe(true);
    expect(soundboardExternalGrant(JSON.stringify({ soundboard: true, soundboardExternal: false }))).toBe(false);
    expect(soundboardExternalGrant(JSON.stringify({ soundboard: true }))).toBeNull();
    expect(soundboardExternalGrant(null)).toBeNull();
  });
});

describe('SoundboardRateLimiter', () => {
  it('admits one event per key per interval', () => {
    const limiter = new SoundboardRateLimiter(3000);
    expect(limiter.allow('a', 0)).toBe(true);
    expect(limiter.allow('a', 2999)).toBe(false);
    expect(limiter.allow('b', 10)).toBe(true);
    expect(limiter.remaining('a', 1000)).toBe(2000);
    expect(limiter.allow('a', 3000)).toBe(true);
  });

  it('a refused event does not extend the wait', () => {
    const limiter = new SoundboardRateLimiter(3000);
    limiter.allow('a', 0);
    limiter.allow('a', 2000);
    expect(limiter.allow('a', 3000)).toBe(true);
  });

  it('forgets every key on reset', () => {
    const limiter = new SoundboardRateLimiter(3000);
    limiter.allow('a', 0);
    limiter.reset();
    expect(limiter.allow('a', 1)).toBe(true);
  });
});

describe('checkIncomingPlay', () => {
  const context: ReceiveContext = { selfId: ALICE, serverId: SERVER, participants: new Set([BOB]) };
  const event = (overrides: Partial<SoundboardTransportEvent> = {}, message = buildSoundboardMessage(SOUND, SERVER, BOB)) => ({
    userId: BOB,
    message,
    granted: null,
    ...overrides,
  });
  const check = (e: SoundboardTransportEvent, ctx = context, limiter = new SoundboardRateLimiter(SOUNDBOARD_RECEIVE_INTERVAL_MS), now = 0) =>
    checkIncomingPlay(e, ctx, limiter, now);

  it('admits a play from a participant of the call', () => {
    expect(check(event())).toEqual({ ok: true, message: buildSoundboardMessage(SOUND, SERVER, BOB) });
    expect(check(event({ granted: true })).ok).toBe(true);
  });

  it('names why a play is dropped', () => {
    expect(check(event({ message: { type: 'soundboard' } }))).toEqual({ ok: false, reason: 'malformed' });
    expect(check(event(), { ...context, serverId: null })).toEqual({ ok: false, reason: 'no-channel' });
    expect(check(event({ userId: ALICE }, buildSoundboardMessage(SOUND, SERVER, ALICE)))).toEqual({ ok: false, reason: 'self' });
    expect(check(event({}, buildSoundboardMessage(SOUND, '66666666-0000-0000-0000-000000000006', BOB))))
      .toEqual({ ok: false, reason: 'wrong-server' });
    expect(check(event({}, buildSoundboardMessage(SOUND, SERVER, ALICE)))).toEqual({ ok: false, reason: 'sender-mismatch' });
    expect(check(event(), { ...context, participants: new Set() })).toEqual({ ok: false, reason: 'not-in-call' });
    expect(check(event({ granted: false }))).toEqual({ ok: false, reason: 'not-permitted' });
  });

  it('drops an external play the token withholds, and only that', () => {
    const external = buildSoundboardMessage(SOUND, SERVER, BOB, OTHER);
    expect(check(event({ externalGranted: false }, external))).toEqual({ ok: false, reason: 'not-permitted' });
    expect(check(event({ externalGranted: true }, external)).ok).toBe(true);
    expect(check(event({ externalGranted: null }, external)).ok).toBe(true);
    expect(check(event({ externalGranted: false })).ok).toBe(true);
    expect(check(event({ granted: false, externalGranted: true }, external))).toEqual({ ok: false, reason: 'not-permitted' });
  });

  it('drops a sender\'s plays faster than the receive interval', () => {
    const limiter = new SoundboardRateLimiter(SOUNDBOARD_RECEIVE_INTERVAL_MS);
    expect(check(event(), context, limiter, 0).ok).toBe(true);
    expect(check(event(), context, limiter, 1000)).toEqual({ ok: false, reason: 'rate-limited' });
    expect(check(event(), context, limiter, SOUNDBOARD_RECEIVE_INTERVAL_MS).ok).toBe(true);
  });

  it('a refused play does not count against the sender', () => {
    const limiter = new SoundboardRateLimiter(SOUNDBOARD_RECEIVE_INTERVAL_MS);
    expect(check(event({ granted: false }), context, limiter, 0).ok).toBe(false);
    expect(check(event({}, buildSoundboardMessage(SOUND, SERVER, ALICE)), context, limiter, 1).ok).toBe(false);
    expect(check(event(), context, limiter, 2).ok).toBe(true);
  });

  it('compares server ids case-insensitively', () => {
    expect(check(event({}, buildSoundboardMessage(SOUND, SERVER.toUpperCase(), BOB))).ok).toBe(true);
  });
});
