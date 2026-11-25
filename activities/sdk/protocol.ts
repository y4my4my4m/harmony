/**
 * Harmony activity protocol, version 1.
 *
 * Two hops. The activity runs in a sandboxed frame (opaque origin) and speaks to the Harmony client
 * that embeds it through postMessage (FrameToHost / HostToFrame, every message tagged `hp: 1`). The
 * client holds the account's session and speaks to the instance relay over a WebSocket
 * (ClientFrame / RelayFrame, JSON text frames). The frame never sees a token or a network.
 *
 * The relay is game-agnostic and host-authoritative: one member is the host; only the host writes
 * the shared state and the host store. When the host leaves, the relay promotes the member that
 * joined earliest and hands it the store. Byte sizes count the UTF-8 JSON encoding.
 */

export const PROTOCOL_VERSION = 1

/** One `send` payload. */
export const MESSAGE_MAX_BYTES = 256 * 1024
/** The shared state, written whole by the host. */
export const STATE_MAX_BYTES = 64 * 1024
/** One host store value; the store holds at most STORE_MAX_KEYS keys and STORE_MAX_BYTES in all. */
export const STORE_VALUE_MAX_BYTES = 256 * 1024
export const STORE_MAX_BYTES = 8 * 1024 * 1024
export const STORE_MAX_KEYS = 1024
export const STORE_KEY_MAX_LENGTH = 128
/** A member's own public state. */
export const MEMBER_STATE_MAX_BYTES = 2 * 1024
/** Files an activity hands the client to save, PNG/JPEG/WebP/GIF only. */
export const SAVE_MAX_BYTES = 10 * 1024 * 1024
export const SAVE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
/** Relay frames per connection: sustained rate per second and burst. */
export const RATE_MESSAGES_PER_SECOND = 40
export const RATE_MESSAGES_BURST = 80
export const RATE_BYTES_PER_SECOND = 1024 * 1024
export const RATE_BYTES_BURST = 4 * 1024 * 1024
/** Largest relay frame accepted; a store write of STORE_VALUE_MAX_BYTES plus its envelope fits. */
export const RELAY_FRAME_MAX_BYTES = 300 * 1024

export type SessionContext = 'direct' | 'group' | 'channel' | 'voice'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** A custom emoji of a display name: `:name:` in it, drawn from `url`. */
export interface NameEmoji {
  name: string
  url: string
}

/** Most name emojis a member carries. */
export const NAME_EMOJIS_MAX = 16

export interface MemberInfo {
  id: string
  /** Display name as stored, custom emojis as :shortcodes:. */
  name: string
  username: string
  avatarUrl: string | null
  nameEmojis: NameEmoji[]
  /** Relay clock, ms. */
  joinedAt: number
  /** Joined while the session already held max_players players. */
  spectator: boolean
  state: Json
}

export interface SessionInfo {
  id: string
  appId: string
  context: SessionContext
  startedBy: string | null
  maxPlayers: number
  minPlayers: number
}

export type EndReason = 'host_ended' | 'empty' | 'disabled' | 'removed' | 'idle' | 'ended'

/* ---------------------------------------------------------------------------------------------- */
/* Client <-> relay                                                                               */
/* ---------------------------------------------------------------------------------------------- */

export type SendTarget = 'host' | string[]

export type ClientFrame =
  | { op: 'hello'; v: typeof PROTOCOL_VERSION; token: string; session: string }
  | { op: 'auth'; token: string }
  | { op: 'send'; data: Json; to?: SendTarget }
  | { op: 'state'; state: Json }
  | { op: 'store'; key: string; value?: Json }
  | { op: 'me'; state: Json }
  | { op: 'end' }
  | { op: 'ping'; t: number }

export type RelayErrorCode =
  | 'BAD_FRAME'
  | 'UNAUTHORIZED'
  | 'REFUSED'
  | 'NOT_HOST'
  | 'TOO_LARGE'
  | 'STORE_FULL'
  | 'RATE_LIMITED'
  | 'REPLACED'
  | 'UNAVAILABLE'

export type RelayFrame =
  | {
      op: 'welcome'
      you: MemberInfo
      session: SessionInfo
      members: MemberInfo[]
      host: string
      state: Json
      /** Present for the host only. */
      store?: Record<string, Json>
      canEnd: boolean
      serverTime: number
    }
  | { op: 'join'; member: MemberInfo }
  | { op: 'leave'; id: string; reason: 'left' | 'timeout' | 'removed' }
  | { op: 'host'; id: string; store?: Record<string, Json> }
  | { op: 'message'; from: string; data: Json }
  | { op: 'state'; state: Json; from: string }
  | { op: 'member'; id: string; state: Json }
  | { op: 'ended'; reason: EndReason }
  | { op: 'error'; code: RelayErrorCode; message?: string; refusal?: string; fatal?: boolean }
  | { op: 'pong'; t: number; serverTime: number }

/* ---------------------------------------------------------------------------------------------- */
/* Frame <-> client                                                                               */
/* ---------------------------------------------------------------------------------------------- */

/**
 * A display name in order: text, and custom emojis with an object URL inside the frame. `src` is
 * null while the image is on its way or when it failed; show `:emoji:` then.
 */
export type NamePart = { text: string } | { emoji: string; src: string | null }

export interface FrameMember extends Omit<MemberInfo, 'nameEmojis'> {
  /** Display name as plain text: custom emojis left out, Unicode emoji kept. */
  name: string
  /** The display name with its custom emojis, for activities that draw them. */
  nameParts: NamePart[]
  /** An object URL inside the frame, made from the client's avatar image; null without one. */
  avatar: string | null
}

export interface ThemeInfo {
  scheme: 'dark' | 'light'
  /** CSS colour. */
  accent: string
  reducedMotion: boolean
}

export type ConnectionStatus = 'connected' | 'reconnecting' | 'offline'

interface Tagged { hp: typeof PROTOCOL_VERSION }

export type FrameToHost = Tagged & (
  | { t: 'ready'; sdk: string }
  | { t: 'send'; data: Json; to?: SendTarget }
  | { t: 'state'; state: Json }
  | { t: 'store'; key: string; value?: Json }
  | { t: 'me'; state: Json }
  | { t: 'end' }
  | { t: 'leave' }
  | { t: 'notify'; text: string }
  | { t: 'save'; id: number; blob: Blob; name: string }
  /** From Harmony's loader, never the SDK: the frame's document is being left. */
  | { t: 'gone' }
)

export type WireNamePart = { text: string } | { emoji: string; image: Blob | null }

/**
 * Members carry `avatarBlob` and the images of `nameParts`; the SDK turns them into object URLs.
 * `name` is plain text, as FrameMember.name.
 */
export type WireMember = Omit<MemberInfo, 'nameEmojis'> & { avatarBlob: Blob | null; nameParts: WireNamePart[] }

export type HostToFrame = Tagged & (
  | {
      t: 'init'
      session: SessionInfo
      you: string
      members: WireMember[]
      host: string
      state: Json
      store?: Record<string, Json>
      canEnd: boolean
      /** Relay clock minus the client clock, ms. */
      clockOffset: number
      locale: string
      theme: ThemeInfo
      visible: boolean
    }
  | { t: 'join'; member: WireMember }
  | { t: 'leave'; id: string; reason: 'left' | 'timeout' | 'removed' }
  | { t: 'host'; id: string; store?: Record<string, Json> }
  | { t: 'message'; from: string; data: Json }
  | { t: 'state'; state: Json; from: string }
  | { t: 'member'; id: string; state: Json }
  /** A member's avatar or name emojis that arrived after the member was delivered. */
  | { t: 'profile'; id: string; name: string; nameParts: WireNamePart[]; avatarBlob: Blob | null }
  | { t: 'ended'; reason: EndReason }
  | { t: 'error'; code: RelayErrorCode; message?: string }
  | { t: 'clock'; clockOffset: number }
  | { t: 'theme'; theme: ThemeInfo }
  | { t: 'visibility'; visible: boolean }
  | { t: 'connection'; status: ConnectionStatus }
  | { t: 'saved'; id: number; ok: boolean }
  /** A resync after a reconnect: the full picture, as init. */
  | {
      t: 'resync'
      members: WireMember[]
      host: string
      state: Json
      store?: Record<string, Json>
      clockOffset: number
    }
)

const encoder = new TextEncoder()

/** UTF-8 bytes of the JSON encoding; Infinity for a value JSON cannot encode. */
export function jsonBytes(value: unknown): number {
  try {
    const text = JSON.stringify(value)
    return text === undefined ? Infinity : encoder.encode(text).length
  } catch {
    return Infinity
  }
}
