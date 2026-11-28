import { supabase } from '../config/supabase.js'
import { UUID } from './bridgeConfig.js'
import { MATRIX_ROOM_ID } from './matrixRooms.js'

export const MATRIX_PLATFORM = 'matrix'

// Cc: control characters. Cs: lone surrogates, which jsonb refuses, as it does U+0000.
const MXID = /^@[^\s:\p{Cc}\p{Cs}]+:[^\s\p{Cc}\p{Cs}]+$/u
const ROOM_ALIAS = /^#[^\s:\p{Cc}\p{Cs}]+:[^\s\p{Cc}\p{Cs}]+$/u

/** A Matrix user id as bridge_privacy_check_subject() takes it: '@user:server', at most 255 characters. */
export function isMatrixUserId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && MXID.test(value)
}

/** A Matrix room alias, '#name:server', at most 255 characters (bridge_channels_room_alias_check). */
export function isMatrixRoomAlias(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255 && ROOM_ALIAS.test(value)
}

export interface MatrixBridgeRow {
  id: string
  server_id: string
  bot_id: string | null
  updated_at: string
}

export const MATRIX_BRIDGE_COLUMNS = 'id, server_id, bot_id, updated_at'

/** matrix_bridge_config() plus base_url: GET /bridge/v2/matrix/config and BRIDGE_CONFIG_UPDATE. */
export interface MatrixBridgeConfig {
  bridge_id: string
  server_id: string
  mode: 'self' | 'hosted' | 'instance'
  updated_at: string
  // Instance public base URL, as POST /redeem returns it; null when unknown (see configuredBaseUrl).
  base_url: string | null
  // Changes with every opt-out and opt-in of the server (bridge_privacy_optout_ids().version).
  privacy_version: string | null
  pairs: Array<{
    channel_id: string
    channel_name: string
    room_id: string | null
    room_alias: string | null
    direction: 'both' | 'to_harmony' | 'to_matrix'
    sender_mode: 'ghost' | 'relay'
    // Messages are end-to-end encrypted (channel_messages_encrypted); the bridge cannot relay them.
    encrypted: boolean
  }>
}

/** The managed Matrix bridge the bot drives; null when it drives none; 'error' when the lookup failed. */
export async function loadMatrixBridgeForBot(botId: string): Promise<MatrixBridgeRow | null | 'error'> {
  const { data, error } = await supabase
    .from('matrix_bridges')
    .select(MATRIX_BRIDGE_COLUMNS)
    .eq('bot_id', botId)
    .maybeSingle()
  if (error) {
    console.error(`matrix_bridges lookup for bot ${botId} failed:`, error.message)
    return 'error'
  }
  return (data as MatrixBridgeRow | null) ?? null
}

/** Null when the lookup fails or the bot drives no bridge any more. */
export async function buildMatrixBridgeConfig(botId: string, baseUrl: string | null): Promise<MatrixBridgeConfig | null> {
  const { data, error } = await supabase.rpc('matrix_bridge_config', { p_bot_id: botId })
  if (error) {
    console.error(`matrix_bridge_config for bot ${botId} failed:`, error.code, error.message)
    return null
  }
  if (!data || typeof data !== 'object' || !Array.isArray((data as MatrixBridgeConfig).pairs)) return null
  return { ...(data as Omit<MatrixBridgeConfig, 'base_url'>), base_url: baseUrl }
}

// Report caps. The database refuses a status over 64 KiB and a snapshot or pairs over 2 MiB: at 4
// bytes a character these keep them under 58 KiB, 1.4 MiB and 1.4 MiB.
const MAX_ROOMS = 500
const MAX_PAIRS = 1000
const MAX_PROBLEMS = 50
const MAX_NAME = 200
const MAX_CODE = 64
const MAX_DETAIL = 200
// bridge_channels_state_error_check.
const MAX_PAIR_ERROR = 300
const MAX_HOMESERVER = 512

export const PAIR_STATES = ['joining', 'ready', 'error'] as const

// Server name: host[:port], IPv6 in brackets.
const SERVER_NAME = /^[A-Za-z0-9.\-:[\]]{1,255}$/
// Control characters, lone surrogates and bidirectional overrides (U+202A-U+202E, U+2066-U+2069).
const UNSAFE_TEXT = /[\p{Cc}\p{Cs}\u202a-\u202e\u2066-\u2069]/gu

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {}
}

function list(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.map(obj) : []
}

/** Text a manager reads, at most `max` code points; null when nothing is left. */
function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // A code point is at most two UTF-16 units; the surrogate a slice may split off is unsafe text.
  const clean = value.slice(0, max * 2 + 1).replace(UNSAFE_TEXT, ' ').trim()
  return Array.from(clean).slice(0, max).join('') || null
}

function count(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null
}

function homeserverUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > MAX_HOMESERVER) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
    return `${url.origin}${url.pathname}`.replace(/\/+$/, '').slice(0, MAX_HOMESERVER)
  } catch {
    return null
  }
}

/** [{code, detail}], codes as sent; entries without a code are dropped. */
function problemList(value: unknown): Array<{ code: string | null; detail: string | null }> {
  return list(value)
    .slice(0, MAX_PROBLEMS)
    .map((problem) => ({ code: text(problem.code, MAX_CODE), detail: text(problem.detail, MAX_DETAIL) }))
    .filter((problem) => problem.code !== null)
}

function serverName(value: unknown): string | null {
  return typeof value === 'string' && SERVER_NAME.test(value) ? value : null
}

export interface MatrixStatusReport {
  version: string | null
  connection: 'application_service' | 'account' | null
  status: Record<string, unknown>
  snapshot: { rooms: unknown[] }
  pairs: Array<{ channel_id: string; state: string | null; error: string | null }>
}

/**
 * POST /bridge/v2/matrix/status body, reduced to the documented fields with bounded sizes. Unknown
 * fields, rooms without a Matrix room id, a room or pair named twice and pairs without a channel id
 * are dropped. A room's encryption is on unless the bridge reports it off. Codes and errors are kept
 * as sent. Null when the body is not an object.
 */
export function sanitizeMatrixStatusReport(body: unknown): MatrixStatusReport | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>

  const rooms = new Map<string, unknown>()
  for (const room of list(input.rooms)) {
    if (rooms.size >= MAX_ROOMS) break
    const id = room.room_id
    if (typeof id !== 'string' || !MATRIX_ROOM_ID.test(id) || /\p{Cs}/u.test(id) || rooms.has(id)) continue
    rooms.set(id, {
      room_id: id,
      name: text(room.name, MAX_NAME),
      alias: isMatrixRoomAlias(room.alias) ? room.alias : null,
      encrypted: room.encrypted !== false,
      can_send: room.can_send === true,
      invited: room.invited === true,
      members: count(room.members),
    })
  }

  const pairs = new Map<string, MatrixStatusReport['pairs'][number]>()
  for (const pair of list(input.pairs)) {
    if (pairs.size >= MAX_PAIRS) break
    if (typeof pair.channel_id !== 'string' || !UUID.test(pair.channel_id)) continue
    const id = pair.channel_id.toLowerCase()
    if (pairs.has(id)) continue
    pairs.set(id, {
      channel_id: id,
      state: (PAIR_STATES as readonly unknown[]).includes(pair.state) ? (pair.state as string) : null,
      error: text(pair.error, MAX_PAIR_ERROR),
    })
  }

  return {
    version: text(input.version, 64),
    connection: input.connection === 'application_service' || input.connection === 'account' ? input.connection : null,
    status: {
      ready: input.ready === true,
      user_id: isMatrixUserId(input.user_id) ? input.user_id : null,
      homeserver: homeserverUrl(input.homeserver),
      server_name: serverName(input.server_name),
      pending: count(input.pending),
      failed: count(input.failed),
      problems: problemList(input.problems),
    },
    snapshot: { rooms: [...rooms.values()] },
    pairs: [...pairs.values()],
  }
}

/**
 * POST /bridge/v2/matrix/host/status body, reduced and bounded as the status of a bridge. `instance` is
 * null while the host runs no instance connection. Null when the body is not an object.
 */
export function sanitizeMatrixHostStatus(body: unknown): { version: string | null; status: Record<string, unknown> } | null {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null
  const input = body as Record<string, unknown>
  const instance = input.instance && typeof input.instance === 'object' ? obj(input.instance) : null
  return {
    version: text(input.version, 64),
    status: {
      instance: instance && {
        ready: instance.ready === true,
        user_id: isMatrixUserId(instance.user_id) ? instance.user_id : null,
        server_name: serverName(instance.server_name),
        problems: problemList(instance.problems),
      },
      hosted: count(input.hosted) ?? 0,
    },
  }
}
