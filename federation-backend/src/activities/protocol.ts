/**
 * Relay half of the Harmony activity protocol, version 1. The client half and the frame protocol
 * live in activities/sdk/protocol.ts at the repository root; protocolParity.test.ts holds the
 * limits of both equal.
 */

export const PROTOCOL_VERSION = 1

export const MESSAGE_MAX_BYTES = 256 * 1024
export const STATE_MAX_BYTES = 64 * 1024
export const STORE_VALUE_MAX_BYTES = 256 * 1024
export const STORE_MAX_BYTES = 8 * 1024 * 1024
export const STORE_MAX_KEYS = 1024
export const STORE_KEY_MAX_LENGTH = 128
export const MEMBER_STATE_MAX_BYTES = 2 * 1024
export const RATE_MESSAGES_PER_SECOND = 40
export const RATE_MESSAGES_BURST = 80
export const RATE_BYTES_PER_SECOND = 1024 * 1024
export const RATE_BYTES_BURST = 4 * 1024 * 1024
export const RELAY_FRAME_MAX_BYTES = 300 * 1024

export type SessionContext = 'direct' | 'group' | 'channel' | 'voice'

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

export interface MemberInfo {
  id: string
  name: string
  username: string
  avatarUrl: string | null
  joinedAt: number
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

export type SendTarget = 'host' | string[]

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

export type ClientFrame =
  | { op: 'hello'; v: number; token: string; session: string }
  | { op: 'auth'; token: string }
  | { op: 'send'; data: Json; to?: SendTarget }
  | { op: 'state'; state: Json }
  | { op: 'store'; key: string; value?: Json }
  | { op: 'me'; state: Json }
  | { op: 'end' }
  | { op: 'ping'; t: number }

export type RelayFrame =
  | {
      op: 'welcome'
      you: MemberInfo
      session: SessionInfo
      members: MemberInfo[]
      host: string
      state: Json
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

/** WebSocket close codes. 4000-4999 are application codes (RFC 6455 7.4.2). */
export const CLOSE = {
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TOO_BIG: 1009,
  NO_HELLO: 4000,
  UNAUTHORIZED: 4001,
  BAD_FRAME: 4002,
  REFUSED: 4003,
  RATE_LIMITED: 4004,
  ENDED: 4005,
  REPLACED: 4009,
  UNAVAILABLE: 4013,
} as const
