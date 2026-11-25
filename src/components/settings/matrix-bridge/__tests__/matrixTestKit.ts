/** Fixtures for the managed Matrix bridge tests: matrix_bridge_state answers as the database sends them. */
import { parseMatrixBridgeState, type MatrixBridgeState } from '@/utils/matrixBridgeSetup'
import { SEEN, SERVER_ID } from '../../discord-bridge/__tests__/bridgeTestKit'

export const BRIDGE_ID = 'm1'
export const BOT_ID = 'mx-bot'
export const ACCOUNT = '@harmony_relay:example.org'

export const ROOMS = [
  { room_id: '!general:example.org', name: 'General', alias: '#general:example.org', encrypted: false, can_send: true, members: 4 },
  { room_id: '!secret:example.org', name: 'Secret', alias: null, encrypted: true, can_send: true, members: 2 },
  { room_id: '!news:example.org', name: 'News', alias: null, encrypted: false, can_send: false, members: 9 },
  { room_id: '!lobby:example.org', name: 'Lobby', alias: null, encrypted: false, can_send: true, members: 0, invited: true },
]

export const READY_STATUS = {
  ready: true,
  user_id: ACCOUNT,
  homeserver: 'https://matrix.example.org',
  server_name: 'example.org',
  pending: 0,
  failed: 0,
  problems: [] as { code: string; detail?: string }[],
}

/** A bridge that never reported: status and snapshot are {}. */
export function rawState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: BRIDGE_ID,
    server_id: SERVER_ID,
    bot_id: BOT_ID,
    mode: 'self',
    connection: null,
    status: {},
    snapshot: {},
    bridge_version: null,
    last_seen_at: null,
    created_at: SEEN,
    updated_at: SEEN,
    pairs: [],
    ...overrides,
  }
}

export function rawReady(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return rawState({
    connection: 'application_service',
    status: READY_STATUS,
    snapshot: { rooms: ROOMS },
    bridge_version: '0.2.0',
    last_seen_at: SEEN,
    ...overrides,
  })
}

export function rawPair(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    channel_id: 'h-general',
    room_id: '!general:example.org',
    room_alias: '#general:example.org',
    direction: 'both',
    sender_mode: 'ghost',
    state: 'ready',
    state_error: null,
    ...overrides,
  }
}

export function parsed(raw: Record<string, unknown>): MatrixBridgeState {
  const state = parseMatrixBridgeState(raw)
  if (!state) throw new Error('not a bridge state')
  return state
}
