import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LIVE_REACTION_LIFETIME_MS,
  LiveReactionController,
  MAX_LIVE_REACTION_BYTES,
  MAX_ON_SCREEN,
  RECEIVE_BURST,
  SEND_BURST,
  SEND_WINDOW_MS,
  TokenBucket,
  decodeLiveReaction,
  encodeLiveReaction,
  isUnicodeEmoji,
  liveReactionsAvailable,
  parseLiveReaction,
  type LiveReactionDeps,
} from '../liveReactions';

// Reactions are ephemeral room data: validated on arrival, rate limited on
// both ends, capped on screen, and custom emoji render only from ids the
// receiver already knows.

const KNOWN_EMOJI = '6f9619ff-8b86-d011-b42d-00cf4fc964ff';

const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));
const reaction = (extra: Record<string, unknown> = {}) =>
  bytes({ type: 'live_reaction', emoji: { kind: 'unicode', value: '🔥' }, ...extra });

interface Harness {
  controller: LiveReactionController;
  published: Uint8Array[];
  clock: { now: number };
  members: Set<string>;
  showOthers: { value: boolean };
}

function harness(overrides: Partial<LiveReactionDeps> = {}): Harness {
  const controller = new LiveReactionController();
  const published: Uint8Array[] = [];
  const clock = { now: 1_000 };
  const members = new Set(['bob', 'carol']);
  const showOthers = { value: true };
  // Room identities differ from profile ids, as for federated users.
  const identities: Record<string, string> = { me: 'id-me', bob: 'id-bob', carol: 'id-carol' };
  controller.connect({
    publish: payload => { published.push(payload); return true; },
    toWireId: userId => identities[userId] ?? null,
    fromWireId: wireId => Object.keys(identities).find(k => identities[k] === wireId) ?? null,
    localUserId: () => 'me',
    isParticipant: userId => members.has(userId),
    showOthers: () => showOthers.value,
    resolveUnicode: value => ({ kind: 'text', text: value, label: value }),
    resolveCustom: id => (id === KNOWN_EMOJI ? { src: '/emoji/party.webp', label: 'party' } : null),
    now: () => clock.now,
    random: () => 0.5,
    ...overrides,
  });
  return { controller, published, clock, members, showOthers };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('validation', () => {
  it('accepts single emoji graphemes, including sequences', () => {
    for (const value of ['🔥', '❤️', '👍🏽', '👨‍👩‍👧‍👦', '🇯🇵', '1️⃣', '🏴󠁧󠁢󠁳󠁣󠁴󠁿']) {
      expect(isUnicodeEmoji(value), value).toBe(true);
    }
  });

  it('refuses text, several emoji and oversized strings', () => {
    for (const value of ['', 'lol', '1', '🔥🔥', '🔥a', '<img>', '🔥'.repeat(20)]) {
      expect(isUnicodeEmoji(value), value).toBe(false);
    }
  });

  it('parses the wire shape and drops unknown fields, including a url', () => {
    const parsed = parseLiveReaction({
      type: 'live_reaction',
      emoji: { kind: 'custom', value: KNOWN_EMOJI, url: 'https://evil.test/x.png' },
      targetParticipant: 'id-bob',
      targetSource: 'screen',
      extra: true,
    });
    expect(parsed).toEqual({
      type: 'live_reaction',
      emoji: { kind: 'custom', value: KNOWN_EMOJI },
      targetParticipant: 'id-bob',
      targetSource: 'screen',
    });
  });

  it('rejects malformed messages', () => {
    const bad: unknown[] = [
      null,
      'live_reaction',
      { type: 'media-state', emoji: { kind: 'unicode', value: '🔥' } },
      { type: 'live_reaction' },
      { type: 'live_reaction', emoji: { kind: 'image', value: '🔥' } },
      { type: 'live_reaction', emoji: { kind: 'unicode', value: 42 } },
      { type: 'live_reaction', emoji: { kind: 'custom', value: 'https://evil.test/x.png' } },
      { type: 'live_reaction', emoji: { kind: 'custom', value: 'a'.repeat(65) } },
      { type: 'live_reaction', emoji: { kind: 'unicode', value: '🔥' }, targetParticipant: 7 },
      { type: 'live_reaction', emoji: { kind: 'unicode', value: '🔥' }, targetParticipant: 'x'.repeat(300) },
      { type: 'live_reaction', emoji: { kind: 'unicode', value: '🔥' }, targetSource: 'mic' },
    ];
    for (const raw of bad) expect(parseLiveReaction(raw), JSON.stringify(raw)).toBeNull();
  });

  it('round-trips and refuses oversized or non-JSON payloads', () => {
    const message = { type: 'live_reaction' as const, emoji: { kind: 'unicode' as const, value: '🎉' } };
    expect(decodeLiveReaction(encodeLiveReaction(message))).toEqual(message);
    expect(decodeLiveReaction(new TextEncoder().encode('{nope'))).toBeNull();
    const padded = bytes({ ...message, pad: 'x'.repeat(MAX_LIVE_REACTION_BYTES) });
    expect(decodeLiveReaction(padded)).toBeNull();
  });
});

describe('TokenBucket', () => {
  it('allows a burst, then refills at capacity per window', () => {
    const bucket = new TokenBucket(5, 2000, 0);
    for (let i = 0; i < 5; i++) expect(bucket.take(0)).toBe(true);
    expect(bucket.take(0)).toBe(false);
    expect(bucket.take(399)).toBe(false);
    expect(bucket.take(400)).toBe(true);
    expect(bucket.take(2000)).toBe(true);
    expect(bucket.take(100_000)).toBe(true);
  });
});

describe('availability', () => {
  const p = (video: boolean, screen: boolean) => ({ isVideoEnabled: video, isScreenSharing: screen });

  it('needs LiveKit and some video in the call', () => {
    expect(liveReactionsAvailable('livekit', [p(false, false), p(false, true)])).toBe(true);
    expect(liveReactionsAvailable('livekit', [p(true, false)])).toBe(true);
    expect(liveReactionsAvailable('livekit', [p(false, false), p(false, false)])).toBe(false);
    expect(liveReactionsAvailable('p2p', [p(true, true)])).toBe(false);
    expect(liveReactionsAvailable(null, [p(true, true)])).toBe(false);
  });
});

describe('sending', () => {
  it('publishes the target by room identity and shows the reaction locally', () => {
    const { controller, published } = harness();
    expect(controller.send({ kind: 'unicode', value: '🔥' }, { userId: 'bob', source: 'screen' })).toBe('sent');
    expect(decodeLiveReaction(published[0])).toEqual({
      type: 'live_reaction',
      emoji: { kind: 'unicode', value: '🔥' },
      targetParticipant: 'id-bob',
      targetSource: 'screen',
    });
    expect(controller.active.value.map(r => [r.key, r.senderId])).toEqual([['bob:screen', 'me']]);
  });

  it('without a target lands on the sender camera tile', () => {
    const { controller, published } = harness();
    controller.send({ kind: 'unicode', value: '👍' });
    expect(decodeLiveReaction(published[0])?.targetParticipant).toBeUndefined();
    expect(controller.active.value[0].key).toBe('me:camera');
  });

  it('allows a burst of five per two seconds', () => {
    const { controller, published, clock } = harness();
    const results = Array.from({ length: SEND_BURST + 2 }, () => controller.send({ kind: 'unicode', value: '🔥' }));
    expect(results.filter(r => r === 'sent')).toHaveLength(SEND_BURST);
    expect(results.slice(SEND_BURST)).toEqual(['rate_limited', 'rate_limited']);
    expect(published).toHaveLength(SEND_BURST);

    clock.now += SEND_WINDOW_MS / SEND_BURST;
    expect(controller.send({ kind: 'unicode', value: '🔥' })).toBe('sent');
  });

  it('refuses emoji this client cannot render, without spending the budget', () => {
    const { controller, published } = harness();
    expect(controller.send({ kind: 'custom', value: 'unknown-id' })).toBe('invalid');
    expect(controller.send({ kind: 'unicode', value: 'hello' })).toBe('invalid');
    expect(published).toHaveLength(0);
    expect(controller.send({ kind: 'custom', value: KNOWN_EMOJI })).toBe('sent');
  });

  it('reports a transport that cannot carry the packet and shows nothing', () => {
    const { controller } = harness({ publish: () => false });
    expect(controller.send({ kind: 'unicode', value: '🔥' })).toBe('unavailable');
    expect(controller.active.value).toHaveLength(0);
  });

  it('is unavailable before the transport is connected', () => {
    expect(new LiveReactionController().send({ kind: 'unicode', value: '🔥' })).toBe('unavailable');
  });
});

describe('receiving', () => {
  it('maps the target identity back to the local user id', () => {
    const { controller } = harness();
    controller.receive('bob', reaction({ targetParticipant: 'id-carol', targetSource: 'screen' }));
    expect(controller.active.value.map(r => [r.key, r.senderId])).toEqual([['carol:screen', 'bob']]);
  });

  it('puts an untargeted reaction on the sender camera tile', () => {
    const { controller } = harness();
    controller.receive('bob', reaction());
    expect(controller.active.value[0].key).toBe('bob:camera');
  });

  it('drops a target that is not in the room', () => {
    const { controller } = harness();
    expect(controller.receive('bob', reaction({ targetParticipant: 'id-mallory' }))).toBeNull();
  });

  it('ignores senders not in the room and its own echo', () => {
    const { controller } = harness();
    expect(controller.receive('mallory', reaction())).toBeNull();
    expect(controller.receive('me', reaction())).toBeNull();
    expect(controller.active.value).toHaveLength(0);
  });

  it('renders custom emoji only from ids it can resolve, never a URL from the message', () => {
    const { controller } = harness();
    const unknown = bytes({ type: 'live_reaction', emoji: { kind: 'custom', value: 'not-ours', url: 'https://evil.test/a.png' } });
    expect(controller.receive('bob', unknown)).toBeNull();

    const known = bytes({ type: 'live_reaction', emoji: { kind: 'custom', value: KNOWN_EMOJI, url: 'https://evil.test/a.png' } });
    expect(controller.receive('bob', known)?.display).toEqual({ kind: 'image', src: '/emoji/party.webp', label: 'party' });
  });

  it('drops a flood from one sender without starving another', () => {
    const { controller, clock } = harness();
    let accepted = 0;
    for (let i = 0; i < 50; i++) if (controller.receive('bob', reaction())) accepted++;
    expect(accepted).toBe(RECEIVE_BURST);
    expect(controller.receive('carol', reaction())).not.toBeNull();

    clock.now += 1_000;
    expect(controller.receive('bob', reaction())).not.toBeNull();
  });

  it('drops oversized payloads and malformed JSON', () => {
    const { controller } = harness();
    expect(controller.receive('bob', reaction({ pad: 'x'.repeat(MAX_LIVE_REACTION_BYTES) }))).toBeNull();
    expect(controller.receive('bob', new TextEncoder().encode('not json'))).toBeNull();
  });

  it('shows nothing from others while hidden', () => {
    const { controller, showOthers } = harness();
    showOthers.value = false;
    expect(controller.receive('bob', reaction())).toBeNull();
    expect(controller.send({ kind: 'unicode', value: '🔥' })).toBe('sent');
    expect(controller.active.value).toHaveLength(1);
  });
});

describe('on screen', () => {
  it(`keeps at most ${MAX_ON_SCREEN}, dropping the oldest`, () => {
    const members = Array.from({ length: 10 }, (_, i) => `user${i}`);
    const { controller } = harness({ isParticipant: id => members.includes(id) });
    const ids: number[] = [];
    for (let round = 0; round < 6; round++) {
      for (const member of members) {
        const r = controller.receive(member, reaction());
        if (r) ids.push(r.id);
      }
    }
    expect(ids).toHaveLength(60);
    expect(controller.active.value).toHaveLength(MAX_ON_SCREEN);
    expect(controller.active.value.map(r => r.id)).toEqual(ids.slice(-MAX_ON_SCREEN));
  });

  it('expires each reaction after its flight', () => {
    const { controller } = harness();
    controller.receive('bob', reaction());
    vi.advanceTimersByTime(LIVE_REACTION_LIFETIME_MS - 1);
    expect(controller.active.value).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(controller.active.value).toHaveLength(0);
  });

  it('clear drops everything in flight and the flood state', () => {
    const { controller } = harness();
    for (let i = 0; i < RECEIVE_BURST; i++) controller.receive('bob', reaction());
    expect(controller.receive('bob', reaction())).toBeNull();
    controller.clear();
    expect(controller.active.value).toHaveLength(0);
    expect(controller.receive('bob', reaction())).not.toBeNull();
  });
});
