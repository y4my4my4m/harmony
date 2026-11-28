/**
 * Managed Matrix bridges (matrix_bridges): state parsing, liveness, setup steps and the
 * copy-paste commands shown in Server Settings → Bridges → Matrix.
 */
import { isBridgeOnline, type BridgeMode, type CheckState } from '@/utils/discordBridgeSetup'

// ---------------------------------------------------------------------------
// State (matrix_bridge_state)
// ---------------------------------------------------------------------------

export const MATRIX_SENDER_MODES = ['ghost', 'relay'] as const
export type MatrixSenderMode = (typeof MATRIX_SENDER_MODES)[number]

export function isMatrixSenderMode(value: unknown): value is MatrixSenderMode {
  return typeof value === 'string' && (MATRIX_SENDER_MODES as readonly string[]).includes(value)
}

/** How the bridge signs in to Matrix, as it reports it. */
export type MatrixConnection = 'application_service' | 'account'

export const MATRIX_PAIR_DIRECTIONS = ['both', 'to_harmony', 'to_matrix'] as const
export type MatrixPairDirection = (typeof MATRIX_PAIR_DIRECTIONS)[number]

/** bridge_channels.state, reported by the bridge; null until it has seen the pair. */
export type MatrixPairState = 'joining' | 'ready' | 'error'

export interface MatrixManagedPair {
  channel_id: string
  /** Null until the bridge resolves room_alias. */
  room_id: string | null
  room_alias: string | null
  direction: MatrixPairDirection
  sender_mode: MatrixSenderMode
  state: MatrixPairState | null
  state_error: string | null
}

export interface MatrixBridgeProblem {
  code: string
  /** The bridge's own words, shown for a code unknown here. */
  detail: string
}

export interface MatrixBridgeStatus {
  ready: boolean
  /** The bridge's Matrix account. */
  userId: string | null
  homeserver: string | null
  serverName: string | null
  /** Messages the bridge holds for delivery, and those it gave up on. */
  pending: number
  failed: number
  problems: MatrixBridgeProblem[]
}

/** A room the bridge is in or invited to. The gateway takes a room as encrypted unless the bridge says it is not. */
export interface MatrixRoom {
  room_id: string
  name: string | null
  alias: string | null
  encrypted: boolean
  can_send: boolean
  /** The bridge joins when a pair names the room. */
  invited: boolean
}

export interface MatrixBridgeState {
  id: string
  server_id: string
  bot_id: string | null
  mode: BridgeMode
  connection: MatrixConnection | null
  status: MatrixBridgeStatus
  rooms: MatrixRoom[]
  bridge_version: string | null
  last_seen_at: string | null
  pairs: MatrixManagedPair[]
  /** Mode hosted: the account's homeserver, and whether its token is stored. */
  homeserver_url: string | null
  has_account: boolean
}

type Json = Record<string, unknown>
const asRecord = (value: unknown): Json => (value && typeof value === 'object' && !Array.isArray(value) ? (value as Json) : {})
const asList = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asText = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
const asCount = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0)

const NAME_MAX = 80
/** Matrix identifiers are at most 255 bytes. */
const ID_MAX = 255
const DETAIL_MAX = 300
/** C0, DEL and C1 controls, and the bidirectional formatting characters. */
// eslint-disable-next-line no-control-regex -- strips them from text of other networks.
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]+/g

/** Text written on Matrix or by the bridge, on one line and cut to `max` characters. */
function asForeignText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const text = [...value.slice(0, max * 4).replace(UNPRINTABLE, ' ').replace(/\s+/g, ' ').trim()]
  if (!text.length) return null
  return text.length > max ? `${text.slice(0, max - 1).join('')}…` : text.join('')
}

export function parseMatrixBridgeStatus(raw: unknown): MatrixBridgeStatus {
  const status = asRecord(raw)
  return {
    ready: status.ready === true,
    userId: asForeignText(status.user_id, ID_MAX),
    homeserver: asForeignText(status.homeserver, ID_MAX),
    serverName: asForeignText(status.server_name, ID_MAX),
    pending: asCount(status.pending),
    failed: asCount(status.failed),
    problems: asList(status.problems).flatMap((item) => {
      const problem = asRecord(item)
      const code = asForeignText(problem.code, NAME_MAX)
      return code ? [{ code, detail: asForeignText(problem.detail, DETAIL_MAX) ?? '' }] : []
    }),
  }
}

/** Joined rooms before invitations, plaintext before encrypted, then by name. */
export function parseMatrixRooms(snapshot: unknown): MatrixRoom[] {
  return asList(asRecord(snapshot).rooms)
    .flatMap((item): MatrixRoom[] => {
      const room = asRecord(item)
      const id = asText(room.room_id)
      if (!id) return []
      return [{
        room_id: id,
        name: asForeignText(room.name, NAME_MAX),
        alias: asForeignText(room.alias, ID_MAX),
        encrypted: room.encrypted !== false,
        can_send: room.can_send === true,
        invited: room.invited === true,
      }]
    })
    .sort(
      (a, b) =>
        Number(a.invited) - Number(b.invited) ||
        Number(a.encrypted) - Number(b.encrypted) ||
        matrixRoomName(a).localeCompare(matrixRoomName(b)),
    )
}

export function matrixRoomName(room: Pick<MatrixRoom, 'room_id' | 'name' | 'alias'>): string {
  return room.name ?? room.alias ?? room.room_id
}

/** The name of the room an id or alias names; the id or alias itself for one the bridge does not list. */
export function matrixRoomLabel(rooms: readonly MatrixRoom[], idOrAlias: string): string {
  const room = rooms.find((r) => r.room_id === idOrAlias || r.alias === idOrAlias)
  return room ? matrixRoomName(room) : idOrAlias
}

function parsePair(raw: unknown): MatrixManagedPair | null {
  const pair = asRecord(raw)
  const channelId = asText(pair.channel_id)
  if (!channelId || !isMatrixSenderMode(pair.sender_mode)) return null
  if (!(MATRIX_PAIR_DIRECTIONS as readonly unknown[]).includes(pair.direction)) return null
  return {
    channel_id: channelId,
    room_id: asText(pair.room_id),
    room_alias: asText(pair.room_alias),
    direction: pair.direction as MatrixPairDirection,
    sender_mode: pair.sender_mode,
    state: pair.state === 'joining' || pair.state === 'ready' || pair.state === 'error' ? pair.state : null,
    state_error: asForeignText(pair.state_error, DETAIL_MAX),
  }
}

const MODES: readonly unknown[] = ['self', 'hosted', 'instance'] satisfies BridgeMode[]

/** matrix_bridge_state's answer; undefined when it is neither a bridge nor null. */
export function parseMatrixBridgeState(raw: unknown): MatrixBridgeState | null | undefined {
  if (raw === null || raw === undefined) return null
  const row = asRecord(raw)
  const id = asText(row.id)
  const serverId = asText(row.server_id)
  if (!id || !serverId || !MODES.includes(row.mode)) return undefined
  const pairs = asList(row.pairs).map(parsePair)
  if (pairs.some((pair) => pair === null)) return undefined
  return {
    id,
    server_id: serverId,
    bot_id: asText(row.bot_id),
    mode: row.mode as BridgeMode,
    connection: row.connection === 'application_service' || row.connection === 'account' ? row.connection : null,
    status: parseMatrixBridgeStatus(row.status),
    rooms: parseMatrixRooms(row.snapshot),
    bridge_version: asForeignText(row.bridge_version, NAME_MAX),
    last_seen_at: asText(row.last_seen_at),
    pairs: pairs as MatrixManagedPair[],
    homeserver_url: asForeignText(row.homeserver_url, ID_MAX),
    has_account: row.has_account === true,
  }
}

/** A pair of the instance's bridge exists once a code linked its room; without one, another code moved the room. */
export function matrixPairLostRoom(bridge: Pick<MatrixBridgeState, 'mode'>, pair: Pick<MatrixManagedPair, 'room_id' | 'state_error'>): boolean {
  return bridge.mode === 'instance' && (!pair.room_id || pair.state_error === 'room_in_use')
}

/** "#alias:server" or "!id" of a pair, as matrix_bridge_pair takes it. */
export function matrixPairRoom(pair: Pick<MatrixManagedPair, 'room_id' | 'room_alias'>): string {
  return pair.room_alias ?? pair.room_id ?? ''
}

// ---------------------------------------------------------------------------
// Liveness, checklist, problems
// ---------------------------------------------------------------------------

export type MatrixCheckKey = 'bridge' | 'matrix' | 'harmony'
export interface MatrixCheckItem {
  key: MatrixCheckKey
  state: CheckState
}

const MATRIX_SIDE = ['matrix_registration_missing', 'matrix_token_invalid', 'matrix_unreachable', 'account_in_use']
const HARMONY_SIDE = ['harmony_auth_failed', 'harmony_unreachable']

export function buildMatrixChecklist(bridge: MatrixBridgeState, now = Date.now()): MatrixCheckItem[] {
  const waiting: MatrixCheckItem[] = [
    { key: 'matrix', state: 'waiting' },
    { key: 'harmony', state: 'waiting' },
  ]
  if (!bridge.last_seen_at) return [{ key: 'bridge', state: 'waiting' }, ...waiting]
  if (!isBridgeOnline(bridge.last_seen_at, now)) return [{ key: 'bridge', state: 'fail' }, ...waiting]
  const { ready, problems } = bridge.status
  const side = (codes: string[]): CheckState => {
    if (problems.some((p) => codes.includes(p.code))) return 'fail'
    return ready ? 'ok' : 'waiting'
  }
  return [
    { key: 'bridge', state: 'ok' },
    { key: 'matrix', state: side(MATRIX_SIDE) },
    { key: 'harmony', state: side(HARMONY_SIDE) },
  ]
}

/** Codes that report something that happened: shown, but nothing to fix. */
const MATRIX_NOTICE_CODES: ReadonlySet<string> = new Set(['messages_skipped'])

export function isMatrixNotice(problem: MatrixBridgeProblem): boolean {
  return MATRIX_NOTICE_CODES.has(problem.code)
}

/** Problems to show, in the bridge's order. An offline bridge leads with `bridge_offline`. Duplicates collapse. */
export function collectMatrixProblems(bridge: MatrixBridgeState, now = Date.now()): MatrixBridgeProblem[] {
  if (!bridge.last_seen_at) return []
  const out: MatrixBridgeProblem[] = isBridgeOnline(bridge.last_seen_at, now) ? [] : [{ code: 'bridge_offline', detail: '' }]
  out.push(...bridge.status.problems)
  const seen = new Set<string>()
  return out.filter((problem) => {
    const key = `${problem.code}:${problem.detail}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export type MatrixStatusKind = 'never' | 'offline' | 'starting' | 'degraded' | 'online'

export function matrixStatusKind(bridge: MatrixBridgeState, now = Date.now()): MatrixStatusKind {
  if (!bridge.last_seen_at) return 'never'
  if (!isBridgeOnline(bridge.last_seen_at, now)) return 'offline'
  if (bridge.status.problems.some((problem) => !isMatrixNotice(problem))) return 'degraded'
  if (bridge.pairs.some((pair) => pair.state === 'error' || matrixPairLostRoom(bridge, pair))) return 'degraded'
  return bridge.status.ready ? 'online' : 'starting'
}

// ---------------------------------------------------------------------------
// Setup steps
// ---------------------------------------------------------------------------

export const MATRIX_SETUP_STEPS = ['connect', 'check', 'channels'] as const
/** The instance signs in to Matrix: rooms are linked once its service runs the bridge. */
export const MATRIX_INSTANCE_SETUP_STEPS = ['check', 'channels'] as const
export type MatrixSetupStep = (typeof MATRIX_SETUP_STEPS)[number]

export function matrixSetupStepsFor(mode: BridgeMode): readonly MatrixSetupStep[] {
  return mode === 'instance' ? MATRIX_INSTANCE_SETUP_STEPS : MATRIX_SETUP_STEPS
}

/**
 * The first step that still needs the manager. A self-run bridge that never reported in is at
 * 'connect' unless the manager moved on to 'check'; a hosted one until it has an account. Then the
 * checklist gates, and the pairs come last.
 */
export function deriveMatrixSetupStep(
  bridge: MatrixBridgeState,
  now = Date.now(),
  reached: MatrixSetupStep | null = null,
): MatrixSetupStep {
  if (bridge.mode === 'hosted' && !bridge.has_account) return 'connect'
  if (!bridge.last_seen_at && bridge.mode === 'self') return reached === 'check' ? 'check' : 'connect'
  return buildMatrixChecklist(bridge, now).every((item) => item.state === 'ok') ? 'channels' : 'check'
}

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/** Matrix room ids are opaque and at most 255 characters: room version 12 drops the ':server' suffix. */
const ROOM_ID = /^![^\s/]{1,254}$/
const ROOM_ALIAS = /^#[^\s:]+:[^\s/]+$/
/** MSC2312 entity paths: matrix:r/alias:server and matrix:roomid/id:server. */
const MATRIX_URI = /^matrix:(r|roomid)\/([^?#]+)/i
const MATRIX_TO = /^https?:\/\/matrix\.to\/#\/([^?]+)/i

function decode(text: string): string {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/**
 * The room id or alias in what was typed or pasted: either of them, a matrix.to link or a
 * matrix: URI. Null when it names no room.
 */
export function parseMatrixRoomInput(input: string): string | null {
  let text = input.trim()
  const link = MATRIX_TO.exec(text)
  const uri = MATRIX_URI.exec(text)
  // A link to a message carries the event id after the room.
  if (link) text = decode(link[1].split('/')[0])
  else if (uri) text = `${uri[1].toLowerCase() === 'r' ? '#' : '!'}${decode(uri[2].split('/')[0])}`
  // eslint-disable-next-line no-control-regex -- Matrix ids cannot contain C0/DEL controls.
  if (text.length > 255 || /[\u0000-\u001f\u007f]/.test(text)) return null
  return ROOM_ID.test(text) || ROOM_ALIAS.test(text) ? text : null
}

export type MatrixRoomIssue = 'encrypted' | 'cannot_send'

/** What keeps a room from being paired in the given direction; null when nothing does. */
export function matrixRoomIssue(room: MatrixRoom, direction: MatrixPairDirection): MatrixRoomIssue | null {
  if (room.encrypted) return 'encrypted'
  return direction !== 'to_harmony' && !room.can_send ? 'cannot_send' : null
}

// ---------------------------------------------------------------------------
// Self-run commands
// ---------------------------------------------------------------------------

export const MATRIX_BRIDGE_IMAGE = 'ghcr.io/y4my4my4m/harmony-matrix-bridge:latest'
export const MATRIX_BRIDGE_CONTAINER = 'harmony-matrix-bridge'
export const MATRIX_BRIDGE_VOLUME = 'harmony-matrix-bridge-data'
export const MATRIX_BRIDGE_REPO = 'https://github.com/y4my4my4m/harmony-matrix-bridge.git'
/** The bridge listens here for the homeserver. */
export const MATRIX_BRIDGE_PORT = 9009
/** In the container, and in the bridge's folder when it runs from source. */
export const MATRIX_REGISTRATION_FILE = 'registration.json'

/** Contain no shell metacharacters, so a pasted command that still holds one fails in the bridge, not in the shell. */
export const MATRIX_PLACEHOLDERS = {
  homeserverUrl: 'https://YOUR_HOMESERVER',
  serverName: 'YOUR_SERVER_NAME',
  appserviceUrl: `http://ADDRESS_OF_THE_BRIDGE:${MATRIX_BRIDGE_PORT}`,
  accessToken: 'PASTE_YOUR_MATRIX_ACCESS_TOKEN_HERE',
} as const

/** The ways a self-run bridge signs in to Matrix that the setup offers. */
export const MATRIX_SELF_CONNECTIONS: readonly MatrixConnection[] = ['application_service', 'account']

/** A URL that needs no quoting in sh, PowerShell or cmd.exe, without credentials, query or fragment; null otherwise. */
export function shellSafeUrl(input: string): string | null {
  const text = input.trim()
  if (!/^https?:\/\/[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?(\/[A-Za-z0-9._~/-]*)?$/.test(text)) return null
  return text.replace(/\/+$/, '')
}

/** The part after ':' in the homeserver's user ids, pasted alone or in a whole id; null when it is none. */
export function matrixServerName(input: string): string | null {
  const text = input.trim().replace(/^[@#][^:\s]+:/, '')
  return /^[A-Za-z0-9][A-Za-z0-9.-]*(:[0-9]{1,5})?$/.test(text) ? text : null
}

export interface MatrixCommandInput {
  harmonyUrl: string
  setupCode: string
  connection: MatrixConnection
  /** Valid values only; a missing one leaves its placeholder. */
  homeserverUrl?: string | null
  serverName?: string | null
  appserviceUrl?: string | null
}

export function matrixBridgeEnv(input: MatrixCommandInput): [name: string, value: string][] {
  const env: [string, string][] = [
    ['HARMONY_URL', input.harmonyUrl],
    ['HARMONY_SETUP_CODE', input.setupCode],
    ['MATRIX_HOMESERVER_URL', input.homeserverUrl || MATRIX_PLACEHOLDERS.homeserverUrl],
  ]
  if (input.connection === 'account') return [...env, ['MATRIX_ACCESS_TOKEN', MATRIX_PLACEHOLDERS.accessToken]]
  return [
    ...env,
    ['MATRIX_SERVER_NAME', input.serverName || MATRIX_PLACEHOLDERS.serverName],
    ['MATRIX_APPSERVICE_URL', input.appserviceUrl || MATRIX_PLACEHOLDERS.appserviceUrl],
  ]
}

/** An application service is called by the homeserver; an account calls out only. */
const listens = (connection: MatrixConnection) => connection === 'application_service'

/** One line: cmd.exe and PowerShell have no backslash continuation. */
export function buildMatrixDockerRun(input: MatrixCommandInput): string {
  return [
    'docker run -d',
    `--name ${MATRIX_BRIDGE_CONTAINER}`,
    '--restart unless-stopped',
    ...(listens(input.connection) ? [`-p ${MATRIX_BRIDGE_PORT}:${MATRIX_BRIDGE_PORT}`] : []),
    ...matrixBridgeEnv(input).map(([name, value]) => `-e ${name}=${value}`),
    `-v ${MATRIX_BRIDGE_VOLUME}:/data`,
    MATRIX_BRIDGE_IMAGE,
  ].join(' ')
}

export function buildMatrixCompose(input: MatrixCommandInput): string {
  const ports = listens(input.connection) ? `    ports:\n      - "${MATRIX_BRIDGE_PORT}:${MATRIX_BRIDGE_PORT}"\n` : ''
  const env = matrixBridgeEnv(input).map(([name, value]) => `      ${name}: "${value}"`).join('\n')
  return `services:
  ${MATRIX_BRIDGE_CONTAINER}:
    image: ${MATRIX_BRIDGE_IMAGE}
    container_name: ${MATRIX_BRIDGE_CONTAINER}
    restart: unless-stopped
${ports}    environment:
${env}
    volumes:
      - ${MATRIX_BRIDGE_VOLUME}:/data

volumes:
  ${MATRIX_BRIDGE_VOLUME}:
`
}

/** One command per line: PowerShell before 7 has no '&&'. */
export const MATRIX_SOURCE_INSTALL = `git clone ${MATRIX_BRIDGE_REPO}
cd harmony-matrix-bridge
npm ci
npm run build`

export function buildMatrixEnvFile(input: MatrixCommandInput): string {
  return `${matrixBridgeEnv(input).map(([name, value]) => `${name}=${value}`).join('\n')}\n`
}

export const MATRIX_SOURCE_RUN = 'node --env-file=.env dist/index.js'

/** Signs in with a password read from the terminal and prints the access token. */
export function buildMatrixLoginDocker(homeserverUrl: string | null | undefined): string {
  return `docker run --rm -it -e MATRIX_HOMESERVER_URL=${homeserverUrl || MATRIX_PLACEHOLDERS.homeserverUrl} ${MATRIX_BRIDGE_IMAGE} node dist/index.js --login`
}

export const MATRIX_LOGIN_SOURCE = 'node --env-file=.env dist/index.js --login'

export const MATRIX_REGISTRATION_COPY = `docker cp ${MATRIX_BRIDGE_CONTAINER}:/data/${MATRIX_REGISTRATION_FILE} .`
export const MATRIX_REGISTRATION_SOURCE = `data/${MATRIX_REGISTRATION_FILE}`

export const MATRIX_LOGS_COMMAND = `docker logs --tail 50 ${MATRIX_BRIDGE_CONTAINER}`
export const MATRIX_START_COMMAND = `docker start ${MATRIX_BRIDGE_CONTAINER}`
export const MATRIX_RESTART_COMMAND = `docker restart ${MATRIX_BRIDGE_CONTAINER}`
export const MATRIX_REMOVE_COMMAND = `docker rm -f ${MATRIX_BRIDGE_CONTAINER}`
