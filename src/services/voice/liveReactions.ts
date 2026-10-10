/**
 * Live reactions: emoji that float over a stream or video tile for everyone
 * in the call. Carried as lossy LiveKit data on LIVE_REACTION_TOPIC; nothing
 * is stored.
 *
 * Wire message, JSON in UTF-8, at most MAX_LIVE_REACTION_BYTES:
 *   { type: 'live_reaction',
 *     emoji: { kind: 'unicode' | 'custom', value: string },
 *     targetParticipant?: string,          room identity of the tile owner
 *     targetSource?: 'camera' | 'screen' } default 'camera'
 * Without targetParticipant the reaction lands on the sender's camera tile.
 * A custom emoji travels as its id; a receiver renders it only from its own
 * emoji cache, never from a URL in the message.
 */

import { shallowRef, type ShallowRef } from 'vue';

export const LIVE_REACTION_TOPIC = 'harmony-live-reaction';
export const LIVE_REACTION_TYPE = 'live_reaction';

export const MAX_LIVE_REACTION_BYTES = 512;
/** UTF-16 code units; the longest RGI sequences (tag flags) are 14. */
export const MAX_EMOJI_VALUE_LENGTH = 32;
const MAX_CUSTOM_ID_LENGTH = 64;
const MAX_IDENTITY_LENGTH = 256;

/** Sender: 5 reactions per 2 s, refilled continuously. */
export const SEND_BURST = 5;
export const SEND_WINDOW_MS = 2000;
/** Receiver, per sender: above the send rate so network bunching is not dropped. */
export const RECEIVE_BURST = 8;
export const RECEIVE_WINDOW_MS = 2000;
/** Floating at once across every tile; the oldest goes first. */
export const MAX_ON_SCREEN = 40;
/** Flight time, ms. */
export const LIVE_REACTION_LIFETIME_MS = 3000;

export type LiveReactionSource = 'camera' | 'screen';

export type LiveReactionEmoji =
  | { kind: 'unicode'; value: string }
  | { kind: 'custom'; value: string };

export interface LiveReactionMessage {
  type: typeof LIVE_REACTION_TYPE;
  emoji: LiveReactionEmoji;
  targetParticipant?: string;
  targetSource?: LiveReactionSource;
}

export interface LiveReactionTarget {
  userId: string;
  source: LiveReactionSource;
}

export type LiveReactionDisplay =
  | { kind: 'image'; src: string; label: string }
  | { kind: 'text'; text: string; label: string };

export interface LiveReaction {
  id: number;
  /** Tile it floats over: `${userId}:${source}`. */
  key: string;
  senderId: string;
  display: LiveReactionDisplay;
  /** Start position across the layer, fraction of its width. */
  x: number;
  /** Sideways travel over the flight, fraction of the layer width, signed. */
  drift: number;
  /** Height of an in-place (reduced motion) reaction, fraction of the layer height. */
  rise: number;
}

export type SendResult = 'sent' | 'rate_limited' | 'unavailable' | 'invalid';

/** LiveKit carries the reactions, and they show only over video: audio-only calls get none. */
export function liveReactionsAvailable(
  transport: 'livekit' | 'p2p' | null,
  participants: Iterable<{ isVideoEnabled: boolean; isScreenSharing: boolean }>,
): boolean {
  if (transport !== 'livekit') return false;
  for (const p of participants) {
    if (p.isVideoEnabled || p.isScreenSharing) return true;
  }
  return false;
}

export function liveReactionKey(userId: string, source: LiveReactionSource): string {
  return `${userId}:${source}`;
}

/** Refills continuously at capacity per windowMs. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(private readonly capacity: number, private readonly windowMs: number, now: number) {
    this.tokens = capacity;
    this.last = now;
  }

  take(now: number): boolean {
    const elapsed = Math.max(0, now - this.last);
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + (elapsed * this.capacity) / this.windowMs);
    if (this.tokens < 1) return false;
    this.tokens -= 1;
    return true;
  }
}

const EMOJI_CHARS = /^[\p{Extended_Pictographic}\p{Emoji_Component}]+$/u;
const EMOJI_BASE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u20E3]/u;
const CUSTOM_ID = /^[A-Za-z0-9_-]+$/;

// Intl.Segmenter is ES2022; the configured lib stops short of it.
type GraphemeSegmenterCtor = new (locale?: string, options?: { granularity: 'grapheme' }) => {
  segment(input: string): Iterable<unknown>;
};
const Segmenter = (Intl as unknown as { Segmenter?: GraphemeSegmenterCtor }).Segmenter;
const segmenter = Segmenter ? new Segmenter(undefined, { granularity: 'grapheme' }) : null;

/** One emoji grapheme: pictographs, flags, keycaps, with modifiers and joiners. */
export function isUnicodeEmoji(value: string): boolean {
  if (!value || value.length > MAX_EMOJI_VALUE_LENGTH) return false;
  if (!EMOJI_CHARS.test(value) || !EMOJI_BASE.test(value)) return false;
  return !segmenter || [...segmenter.segment(value)].length === 1;
}

export function isCustomEmojiId(value: string): boolean {
  return !!value && value.length <= MAX_CUSTOM_ID_LENGTH && CUSTOM_ID.test(value);
}

export function parseLiveReactionEmoji(raw: unknown): LiveReactionEmoji | null {
  if (!raw || typeof raw !== 'object') return null;
  const { kind, value } = raw as Record<string, unknown>;
  if (typeof value !== 'string') return null;
  if (kind === 'unicode') return isUnicodeEmoji(value) ? { kind, value } : null;
  if (kind === 'custom') return isCustomEmojiId(value) ? { kind, value } : null;
  return null;
}

/** Validated message, or null. Unknown fields are dropped. */
export function parseLiveReaction(raw: unknown): LiveReactionMessage | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== LIVE_REACTION_TYPE) return null;
  const emoji = parseLiveReactionEmoji(m.emoji);
  if (!emoji) return null;
  const message: LiveReactionMessage = { type: LIVE_REACTION_TYPE, emoji };
  if (m.targetParticipant !== undefined) {
    const target = m.targetParticipant;
    if (typeof target !== 'string' || !target || target.length > MAX_IDENTITY_LENGTH) return null;
    message.targetParticipant = target;
  }
  if (m.targetSource !== undefined) {
    if (m.targetSource !== 'camera' && m.targetSource !== 'screen') return null;
    message.targetSource = m.targetSource;
  }
  return message;
}

export function encodeLiveReaction(message: LiveReactionMessage): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(message));
}

export function decodeLiveReaction(payload: Uint8Array): LiveReactionMessage | null {
  if (payload.byteLength > MAX_LIVE_REACTION_BYTES) return null;
  try {
    return parseLiveReaction(JSON.parse(new TextDecoder().decode(payload)));
  } catch {
    return null;
  }
}

export interface LiveReactionDeps {
  /** Publishes one encoded message; false when the transport cannot carry it. */
  publish(payload: Uint8Array): boolean;
  /** Room identity of a local user id; null when not in the room. */
  toWireId(userId: string): string | null;
  /** Local user id of a room identity; null when unknown. */
  fromWireId(wireId: string): string | null;
  localUserId(): string | null;
  /** Remote user currently in the room. */
  isParticipant(userId: string): boolean;
  /** Reactions from others are rendered. */
  showOthers(): boolean;
  resolveUnicode(value: string): LiveReactionDisplay;
  /** Display for an emoji id this client knows; null for any other id. */
  resolveCustom(id: string): { src: string; label: string } | null;
  now?(): number;
  random?(): number;
}

export class LiveReactionController {
  /** Reactions in flight, oldest first. Replaced on every change. */
  readonly active: ShallowRef<readonly LiveReaction[]> = shallowRef([]);

  private deps: LiveReactionDeps | null = null;
  private sendBucket: TokenBucket | null = null;
  private receiveBuckets = new Map<string, TokenBucket>();
  private timers = new Map<number, ReturnType<typeof setTimeout>>();
  private nextId = 1;

  connect(deps: LiveReactionDeps): void {
    this.deps = deps;
    this.sendBucket = null;
  }

  disconnect(): void {
    this.clear();
    this.deps = null;
  }

  /** Drops every reaction in flight and the per-sender state. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.receiveBuckets.clear();
    if (this.active.value.length) this.active.value = [];
  }

  private now(): number {
    return this.deps?.now?.() ?? Date.now();
  }

  private display(emoji: LiveReactionEmoji): LiveReactionDisplay | null {
    if (!this.deps) return null;
    if (emoji.kind === 'unicode') return this.deps.resolveUnicode(emoji.value);
    const custom = this.deps.resolveCustom(emoji.value);
    return custom ? { kind: 'image', src: custom.src, label: custom.label } : null;
  }

  /** How `emoji` renders here; null when it is invalid or unknown to this client. */
  preview(emoji: LiveReactionEmoji): LiveReactionDisplay | null {
    const valid = parseLiveReactionEmoji(emoji);
    return valid && this.display(valid);
  }

  send(emoji: LiveReactionEmoji, target: LiveReactionTarget | null = null): SendResult {
    const deps = this.deps;
    const self = deps?.localUserId();
    if (!deps || !self) return 'unavailable';
    const valid = parseLiveReactionEmoji(emoji);
    const display = valid && this.display(valid);
    if (!valid || !display) return 'invalid';

    const message: LiveReactionMessage = { type: LIVE_REACTION_TYPE, emoji: valid };
    let key = liveReactionKey(self, 'camera');
    if (target) {
      const wireId = deps.toWireId(target.userId);
      if (wireId) {
        message.targetParticipant = wireId;
        message.targetSource = target.source;
        key = liveReactionKey(target.userId, target.source);
      }
    }
    const payload = encodeLiveReaction(message);
    if (payload.byteLength > MAX_LIVE_REACTION_BYTES) return 'invalid';

    const now = this.now();
    this.sendBucket ??= new TokenBucket(SEND_BURST, SEND_WINDOW_MS, now);
    if (!this.sendBucket.take(now)) return 'rate_limited';
    if (!deps.publish(payload)) return 'unavailable';
    this.add(key, self, display);
    return 'sent';
  }

  /** One data packet from `senderId`, a room member already resolved by the transport. */
  receive(senderId: string, payload: Uint8Array): LiveReaction | null {
    const deps = this.deps;
    if (!deps || !deps.showOthers()) return null;
    if (payload.byteLength > MAX_LIVE_REACTION_BYTES) return null;
    if (senderId === deps.localUserId() || !deps.isParticipant(senderId)) return null;

    const now = this.now();
    let bucket = this.receiveBuckets.get(senderId);
    if (!bucket) {
      bucket = new TokenBucket(RECEIVE_BURST, RECEIVE_WINDOW_MS, now);
      this.receiveBuckets.set(senderId, bucket);
    }
    if (!bucket.take(now)) return null;

    const message = decodeLiveReaction(payload);
    const display = message && this.display(message.emoji);
    if (!message || !display) return null;

    let key = liveReactionKey(senderId, 'camera');
    if (message.targetParticipant) {
      const targetId = deps.fromWireId(message.targetParticipant);
      if (!targetId) return null;
      key = liveReactionKey(targetId, message.targetSource ?? 'camera');
    }
    return this.add(key, senderId, display);
  }

  private add(key: string, senderId: string, display: LiveReactionDisplay): LiveReaction {
    const random = this.deps?.random ?? Math.random;
    const reaction: LiveReaction = {
      id: this.nextId++,
      key,
      senderId,
      display,
      x: 0.15 + random() * 0.7,
      drift: (random() - 0.5) * 0.3,
      rise: random(),
    };
    const next = [...this.active.value, reaction];
    while (next.length > MAX_ON_SCREEN) {
      const dropped = next.shift()!;
      clearTimeout(this.timers.get(dropped.id));
      this.timers.delete(dropped.id);
    }
    this.active.value = next;
    this.timers.set(reaction.id, setTimeout(() => this.remove(reaction.id), LIVE_REACTION_LIFETIME_MS));
    return reaction;
  }

  private remove(id: number): void {
    this.timers.delete(id);
    this.active.value = this.active.value.filter(r => r.id !== id);
  }
}

export const liveReactions = new LiveReactionController();
