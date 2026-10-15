import { describe, expect, it } from 'vitest';
import {
  SOUNDBOARD_BURST,
  SOUNDBOARD_BURST_WINDOW_MS,
  SOUNDBOARD_LOCKOUT_MS,
  SOUNDBOARD_RECEIVE_WINDOW_MS,
  SoundboardRateLimiter,
  buildSoundboardMessage,
  checkIncomingPlay,
  createReceiveLimiter,
  isExternalPlay,
  isSoundId,
  parseSoundboardMessage,
  recordSenderPlay,
  senderLockoutRemaining,
  soundboardExternalGrant,
  soundboardGrant,
  type ReceiveContext,
  type SenderPlays,
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

/** The plays a sender makes when trying at each of `attempts`, ms, in order. */
function senderAllows(attempts: number[]): number[] {
  let state: SenderPlays = { sentAt: [], lockedUntil: 0 };
  const sent: number[] = [];
  for (const at of attempts) {
    const next = recordSenderPlay(state, at);
    if (!next) continue;
    state = next;
    sent.push(at);
  }
  return sent;
}

/** Deterministic PRNG (mulberry32), so a failure reproduces. */
function prng(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('sender rule', () => {
  const empty: SenderPlays = { sentAt: [], lockedUntil: 0 };

  it('is three plays within three seconds, then three seconds out', () => {
    expect([SOUNDBOARD_BURST, SOUNDBOARD_BURST_WINDOW_MS, SOUNDBOARD_LOCKOUT_MS]).toEqual([3, 3000, 3000]);
  });

  it('allows a burst of three, then locks out for three seconds from the third', () => {
    const first = recordSenderPlay(empty, 0)!;
    const second = recordSenderPlay(first, 200)!;
    expect(senderLockoutRemaining(second, 200)).toBe(0);
    const third = recordSenderPlay(second, 400)!;
    expect(third.lockedUntil).toBe(400 + SOUNDBOARD_LOCKOUT_MS);
    expect(senderLockoutRemaining(third, 1400)).toBe(2000);
    expect(recordSenderPlay(third, 3399)).toBeNull();
    expect(recordSenderPlay(third, 3400)).not.toBeNull();
  });

  it('never locks out a slower player', () => {
    expect(senderAllows([0, 1500, 3000, 4500, 6000, 7500, 9000])).toHaveLength(7);
    expect(senderAllows([0, 100, 3100, 3200, 6200, 6300])).toHaveLength(6);
  });

  it('locks out three plays inside the window, however spread', () => {
    expect(senderAllows([0, 1499, 2998, 3000, 5997, 5998])).toEqual([0, 1499, 2998, 5998]);
  });

  it('does not extend the lockout for refused plays', () => {
    expect(senderAllows([0, 10, 20, 1000, 2000, 3019, 3020])).toEqual([0, 10, 20, 3020]);
  });

  it('allows another burst after the lockout', () => {
    expect(senderAllows([0, 10, 20, 3020, 3030, 3040, 3050, 6040])).toEqual([0, 10, 20, 3020, 3030, 3040, 6040]);
  });
});

describe('receiver rule', () => {
  it('admits three plays of a sender within the window and drops a fourth', () => {
    const limiter = createReceiveLimiter();
    expect([0, 10, 20].map((t) => limiter.allow('bob', t))).toEqual([true, true, true]);
    expect(limiter.allow('bob', SOUNDBOARD_RECEIVE_WINDOW_MS - 1)).toBe(false);
    expect(limiter.allow('bob', SOUNDBOARD_RECEIVE_WINDOW_MS)).toBe(true);
    expect(limiter.allow('bob', SOUNDBOARD_RECEIVE_WINDOW_MS + 5)).toBe(false);
    expect(limiter.allow('bob', SOUNDBOARD_RECEIVE_WINDOW_MS + 10)).toBe(true);
  });

  it('counts each sender apart', () => {
    const limiter = createReceiveLimiter();
    for (const t of [0, 1, 2]) limiter.allow('bob', t);
    expect(limiter.allow('bob', 3)).toBe(false);
    expect(limiter.allow('carol', 3)).toBe(true);
  });

  it('does not count a refused play', () => {
    const limiter = new SoundboardRateLimiter(3, 2500);
    for (const t of [0, 1, 2]) limiter.allow('a', t);
    for (const t of [100, 200, 2000]) expect(limiter.allow('a', t)).toBe(false);
    expect(limiter.allow('a', 2500)).toBe(true);
  });

  it('forgets every sender on reset', () => {
    const limiter = createReceiveLimiter();
    for (const t of [0, 1, 2]) limiter.allow('a', t);
    limiter.reset();
    expect(limiter.allow('a', 3)).toBe(true);
  });
});

describe('sender and receiver rules together', () => {
  const JITTER_MS = SOUNDBOARD_BURST_WINDOW_MS - SOUNDBOARD_RECEIVE_WINDOW_MS;
  const GAPS = [0, 1, 499, 500, 1000, 1499, 1500, 2499, 2500, 2999, 3000, 3001];

  it('spaces any four consecutive allowed plays at least the burst window apart', () => {
    // Every attempt sequence of six plays with gaps from GAPS: 12^5 sequences.
    const attempts = [0, 0, 0, 0, 0, 0];
    let checked = 0;
    let narrowest = Infinity;
    const walk = (index: number) => {
      if (index === attempts.length) {
        const sent = senderAllows(attempts);
        for (let i = SOUNDBOARD_BURST; i < sent.length; i++) {
          narrowest = Math.min(narrowest, sent[i] - sent[i - SOUNDBOARD_BURST]);
        }
        checked++;
        return;
      }
      for (const gap of GAPS) {
        attempts[index] = attempts[index - 1] + gap;
        walk(index + 1);
      }
    };
    walk(1);
    expect(checked).toBe(GAPS.length ** 5);
    expect(narrowest).toBe(SOUNDBOARD_BURST_WINDOW_MS);
  });

  it('delivers every play the sender allows, under delivery jitter up to the window difference', () => {
    const random = prng(0x5b);
    for (let run = 0; run < 20000; run++) {
      const attempts: number[] = [];
      let at = 0;
      for (let i = 0; i < 12; i++) {
        at += random() < 0.3 ? Math.floor(random() * 4) * 500 : Math.floor(random() * 3200);
        attempts.push(at);
      }
      // Delivery delay per play: none, the full jitter, or anything between.
      const delay = () => {
        const r = random();
        return r < 0.25 ? 0 : r < 0.5 ? JITTER_MS : Math.floor(random() * (JITTER_MS + 1));
      };
      const arrivals = senderAllows(attempts).map((sentAt) => sentAt + delay()).sort((a, b) => a - b);
      const limiter = createReceiveLimiter();
      for (const arrival of arrivals) {
        if (!limiter.allow('bob', arrival)) {
          throw new Error(`dropped an allowed play at ${arrival}: attempts ${attempts.join(',')}, arrivals ${arrivals.join(',')}`);
        }
      }
    }
  });

  it('drops a modified client\'s fourth play inside the receive window', () => {
    const limiter = createReceiveLimiter();
    const arrivals = [0, 300, 600, 900, 2499, 2500];
    expect(arrivals.map((t) => limiter.allow('bob', t))).toEqual([true, true, true, false, false, true]);
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
  const check = (e: SoundboardTransportEvent, ctx = context, limiter = createReceiveLimiter(), now = 0) =>
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

  it('drops a sender\'s fourth play within the receive window', () => {
    const limiter = createReceiveLimiter();
    for (const now of [0, 500, 1000]) expect(check(event(), context, limiter, now).ok).toBe(true);
    expect(check(event(), context, limiter, 1500)).toEqual({ ok: false, reason: 'rate-limited' });
    expect(check(event(), context, limiter, SOUNDBOARD_RECEIVE_WINDOW_MS).ok).toBe(true);
  });

  it('a refused play does not count against the sender', () => {
    const limiter = createReceiveLimiter();
    for (let now = 0; now < 4; now++) {
      expect(check(event({ granted: false }), context, limiter, now).ok).toBe(false);
      expect(check(event({}, buildSoundboardMessage(SOUND, SERVER, ALICE)), context, limiter, now).ok).toBe(false);
    }
    for (const now of [4, 5, 6]) expect(check(event(), context, limiter, now).ok).toBe(true);
  });

  it('compares server ids case-insensitively', () => {
    expect(check(event({}, buildSoundboardMessage(SOUND, SERVER.toUpperCase(), BOB))).ok).toBe(true);
  });
});
