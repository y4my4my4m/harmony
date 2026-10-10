/**
 * Soundboard plays on the wire, and the rules a receiver applies before
 * playing one.
 *
 * A play is one JSON message to everyone in the call: LiveKit data on topic
 * SOUNDBOARD_TOPIC, or the 'soundboard' broadcast event of the P2P signalling
 * channel, as { from, message }.
 *
 *   { "type": "soundboard", "v": 1, "soundId": string, "serverId": uuid, "userId": uuid }
 *
 * soundId is a server_sounds id, or "default:<name>" for a built-in clip.
 * userId must equal the sender the transport reports: the LiveKit participant
 * identity resolved to a profile, or the P2P `from`.
 *
 * Permission: LiveKit tokens carry metadata.soundboard (USE_SOUNDBOARD and
 * SPEAK on the channel), set by the token server; false drops the play. A
 * token without the key, from a server predating it, and every P2P sender
 * are trusted to have checked USE_SOUNDBOARD themselves.
 */

export const SOUNDBOARD_TOPIC = 'harmony-soundboard';
export const SOUNDBOARD_P2P_EVENT = 'soundboard';

/** Sender cooldown between plays, ms. */
export const SOUNDBOARD_COOLDOWN_MS = 3000;
/** Receiver floor between plays of one sender, ms: the cooldown less delivery jitter. */
export const SOUNDBOARD_RECEIVE_INTERVAL_MS = 2500;
/** Larger payloads are dropped unparsed; a play encodes to under 200 bytes. */
export const SOUNDBOARD_MESSAGE_MAX_BYTES = 1024;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_ID = /^default:[a-z0-9-]{1,32}$/;

export interface SoundboardMessage {
  type: 'soundboard';
  v: 1;
  soundId: string;
  serverId: string;
  userId: string;
}

/** What a transport reports for one received play. */
export interface SoundboardTransportEvent {
  /** Sender as the transport authenticates it. */
  userId: string;
  message: unknown;
  /** metadata.soundboard of the sender's LiveKit token; null when absent or P2P. */
  granted: boolean | null;
}

export function isSoundId(id: unknown): id is string {
  return typeof id === 'string' && (UUID.test(id) || DEFAULT_ID.test(id));
}

export function buildSoundboardMessage(soundId: string, serverId: string, userId: string): SoundboardMessage {
  return { type: 'soundboard', v: 1, soundId, serverId, userId };
}

/** The message, or null when it is not a well-formed soundboard play. */
export function parseSoundboardMessage(raw: unknown): SoundboardMessage | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const m = raw as Record<string, unknown>;
  if (m.type !== 'soundboard' || m.v !== 1) return null;
  if (!isSoundId(m.soundId)) return null;
  if (typeof m.serverId !== 'string' || !UUID.test(m.serverId)) return null;
  if (typeof m.userId !== 'string' || m.userId.length === 0 || m.userId.length > 128) return null;
  return buildSoundboardMessage(m.soundId, m.serverId.toLowerCase(), m.userId);
}

/** metadata.soundboard of a LiveKit participant: true, false, or null when absent or unreadable. */
export function soundboardGrant(metadata: string | undefined | null): boolean | null {
  if (!metadata) return null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (!parsed || typeof parsed !== 'object') return null;
    const value = (parsed as Record<string, unknown>).soundboard;
    return typeof value === 'boolean' ? value : null;
  } catch {
    return null;
  }
}

/** At most one event per key per interval. */
export class SoundboardRateLimiter {
  private last = new Map<string, number>();

  constructor(private readonly intervalMs: number) {}

  /** Records the event and returns true when the key's interval has passed. */
  allow(key: string, now: number): boolean {
    if (this.remaining(key, now) > 0) return false;
    this.last.set(key, now);
    return true;
  }

  /** Milliseconds until the key may fire again; 0 when it may now. */
  remaining(key: string, now: number): number {
    const previous = this.last.get(key);
    if (previous === undefined) return 0;
    return Math.max(0, previous + this.intervalMs - now);
  }

  reset(): void {
    this.last.clear();
  }
}

export interface ReceiveContext {
  /** Profile id of this client. */
  selfId: string | null;
  /** Server of the voice channel this client is in; null outside a local server channel. */
  serverId: string | null;
  /** Profile ids of the other participants of the call. */
  participants: ReadonlySet<string>;
}

export type SoundboardRejection =
  | 'malformed'
  | 'no-channel'
  | 'self'
  | 'wrong-server'
  | 'sender-mismatch'
  | 'not-in-call'
  | 'not-permitted'
  | 'rate-limited';

export type ReceiveDecision =
  | { ok: true; message: SoundboardMessage }
  | { ok: false; reason: SoundboardRejection };

/**
 * Whether a received play may be played. The rate limit is charged only for
 * plays that pass every other check, so forged or misaddressed messages
 * cannot silence a sender.
 */
export function checkIncomingPlay(
  event: SoundboardTransportEvent,
  context: ReceiveContext,
  limiter: SoundboardRateLimiter,
  now: number,
): ReceiveDecision {
  const message = parseSoundboardMessage(event.message);
  if (!message) return { ok: false, reason: 'malformed' };
  if (!context.serverId) return { ok: false, reason: 'no-channel' };
  if (event.userId === context.selfId) return { ok: false, reason: 'self' };
  if (message.serverId !== context.serverId.toLowerCase()) return { ok: false, reason: 'wrong-server' };
  if (message.userId !== event.userId) return { ok: false, reason: 'sender-mismatch' };
  if (!context.participants.has(event.userId)) return { ok: false, reason: 'not-in-call' };
  if (event.granted === false) return { ok: false, reason: 'not-permitted' };
  if (!limiter.allow(event.userId, now)) return { ok: false, reason: 'rate-limited' };
  return { ok: true, message };
}
