/** matrixBridgeSetup.ts: state parsing, liveness, setup steps, room input and the self-run commands. */
import { describe, expect, it } from 'vitest'
import {
  MATRIX_PLACEHOLDERS,
  buildMatrixChecklist,
  buildMatrixCompose,
  buildMatrixDockerRun,
  buildMatrixEnvFile,
  collectMatrixProblems,
  deriveMatrixSetupStep,
  matrixPairLostRoom,
  matrixPairRoom,
  matrixRoomIssue,
  matrixRoomLabel,
  matrixServerName,
  matrixStatusKind,
  parseMatrixBridgeState,
  parseMatrixRoomInput,
  parseMatrixRooms,
  shellSafeUrl,
  type MatrixBridgeState,
} from '../matrixBridgeSetup'

const NOW = Date.parse('2026-11-25T12:00:00Z')
const ago = (seconds: number) => new Date(NOW - seconds * 1000).toISOString()

const ready = { ready: true, user_id: '@relay:hs.org', homeserver: 'https://hs.org', server_name: 'hs.org', pending: 2, failed: 1, problems: [] }
function state(overrides: Record<string, unknown> = {}): MatrixBridgeState {
  const parsed = parseMatrixBridgeState({
    id: 'b', server_id: 's', bot_id: 'bot', mode: 'self', connection: 'application_service',
    status: ready, snapshot: { rooms: [] }, bridge_version: '0.2.0', last_seen_at: ago(10), pairs: [], ...overrides,
  })
  if (!parsed) throw new Error('no state')
  return parsed
}
const pair = { channel_id: 'c', room_id: '!r:hs', room_alias: null, direction: 'both', sender_mode: 'ghost', state: 'ready', state_error: null }

describe('parseMatrixBridgeState', () => {
  it('reads null as no bridge and anything else malformed as undefined', () => {
    expect(parseMatrixBridgeState(null)).toBeNull()
    for (const bad of [[], 'x', {}, { id: 'b', server_id: 's', mode: 'cloud' }, { id: 'b', server_id: 's', mode: 'self', pairs: [{ ...pair, direction: 'to_discord' }] }]) {
      expect(parseMatrixBridgeState(bad)).toBeUndefined()
    }
  })

  it('reads a bridge that never reported', () => {
    const bridge = state({ connection: null, status: {}, snapshot: {}, bridge_version: null, last_seen_at: null })
    expect(bridge).toMatchObject({ connection: null, rooms: [], pairs: [], status: { ready: false, userId: null, pending: 0, failed: 0, problems: [] } })
  })

  it('reads the status, the rooms and the pairs', () => {
    const bridge = state({ pairs: [{ ...pair, state: 'sleeping', state_error: 'room_in_use' }] })
    expect(bridge.status).toEqual({ ready: true, userId: '@relay:hs.org', homeserver: 'https://hs.org', serverName: 'hs.org', pending: 2, failed: 1, problems: [] })
    expect(bridge.pairs).toEqual([{ ...pair, state: null, state_error: 'room_in_use' }])
  })

  it('keeps text of other networks on one line, bounded and without control or bidirectional characters', () => {
    const [room] = parseMatrixRooms({ rooms: [{ room_id: '!r', name: `  A\u0000\n‮room ${'x'.repeat(5000)}`, encrypted: false }] })
    expect(room.name!.startsWith('A room xxx')).toBe(true)
    expect(room.name!.endsWith('…')).toBe(true)
    expect([...room.name!]).toHaveLength(80)
    const bridge = state({ status: { ...ready, problems: [{ code: 'odd', detail: `line⁦\n${'y'.repeat(900)}` }, { detail: 'no code' }] } })
    expect(bridge.status.problems).toHaveLength(1)
    expect(bridge.status.problems[0].detail.startsWith('line yyy')).toBe(true)
    expect([...bridge.status.problems[0].detail]).toHaveLength(300)
  })
})

describe('rooms', () => {
  const rooms = parseMatrixRooms({
    rooms: [
      { room_id: '!i:hs', name: 'An invitation', invited: true, encrypted: false, can_send: true },
      { room_id: '!e:hs', name: 'Encrypted', encrypted: true, can_send: true },
      { room_id: '!z:hs', alias: '#zed:hs', encrypted: false, can_send: true },
      { room_id: '!a:hs', name: 'Alpha', encrypted: false, can_send: false },
      { room_id: '!u:hs', name: 'Unchecked', can_send: true },
      { name: 'no id' },
    ],
  })

  it('lists joined rooms before invitations and encrypted ones after the rest; unchecked counts as encrypted', () => {
    expect(rooms.map((r) => [r.room_id, r.encrypted, r.invited])).toEqual([
      ['!z:hs', false, false],
      ['!a:hs', false, false],
      ['!e:hs', true, false],
      ['!u:hs', true, false],
      ['!i:hs', false, true],
    ])
    expect(parseMatrixRooms({})).toEqual([])
  })

  it('refuses an encrypted room always and an unwritable one unless nothing is sent to it', () => {
    const [, readOnly, encrypted] = rooms
    expect(matrixRoomIssue(encrypted, 'to_harmony')).toBe('encrypted')
    expect(matrixRoomIssue(readOnly, 'both')).toBe('cannot_send')
    expect(matrixRoomIssue(readOnly, 'to_matrix')).toBe('cannot_send')
    expect(matrixRoomIssue(readOnly, 'to_harmony')).toBeNull()
    expect(matrixRoomIssue(rooms[0], 'both')).toBeNull()
  })

  it('names a room by its id or alias', () => {
    expect(matrixRoomLabel(rooms, '!a:hs')).toBe('Alpha')
    expect(matrixRoomLabel(rooms, '#zed:hs')).toBe('#zed:hs')
    expect(matrixRoomLabel(rooms, '!gone:hs')).toBe('!gone:hs')
  })

  it('lost its room where a code of the instance moved it, not before a bridge joined it', () => {
    const gone = { room_id: null, state_error: null }
    expect(matrixPairLostRoom({ mode: 'instance' }, gone)).toBe(true)
    expect(matrixPairLostRoom({ mode: 'instance' }, { room_id: '!r:hs', state_error: 'room_in_use' })).toBe(true)
    expect(matrixPairLostRoom({ mode: 'instance' }, { room_id: '!r:hs', state_error: null })).toBe(false)
    expect(matrixPairLostRoom({ mode: 'self' }, gone)).toBe(false)
    expect(matrixPairLostRoom({ mode: 'hosted' }, { room_id: '!r:hs', state_error: 'room_in_use' })).toBe(false)
  })

  it('re-pairs a pair under the alias it was named by', () => {
    expect(matrixPairRoom({ room_id: '!r:hs', room_alias: '#r:hs' })).toBe('#r:hs')
    expect(matrixPairRoom({ room_id: '!r:hs', room_alias: null })).toBe('!r:hs')
  })

  it.each([
    ['#general:example.org', '#general:example.org'],
    ['  !abc:example.org ', '!abc:example.org'],
    ['!v12roomid', '!v12roomid'],
    ['#general:example.org:8448', '#general:example.org:8448'],
    ['https://matrix.to/#/%23general:example.org', '#general:example.org'],
    ['https://matrix.to/#/#general:example.org?via=example.org', '#general:example.org'],
    ['https://matrix.to/#/!abc:example.org/$event?via=a.b', '!abc:example.org'],
    ['matrix:r/general:example.org', '#general:example.org'],
    ['matrix:roomid/abc:example.org?action=join', '!abc:example.org'],
    ['general', null],
    ['#general', null],
    ['@sam:example.org', null],
    ['#two words:example.org', null],
    ['!with/slash', null],
    [`!${'a'.repeat(255)}`, null],
    ['', null],
  ])('reads %j as the room %j', (input, room) => {
    expect(parseMatrixRoomInput(input)).toBe(room)
  })
})

describe('liveness', () => {
  it('reads a bridge silent for more than 90 s as offline', () => {
    expect(matrixStatusKind(state({ last_seen_at: null }), NOW)).toBe('never')
    expect(matrixStatusKind(state({ last_seen_at: ago(90) }), NOW)).toBe('online')
    expect(matrixStatusKind(state({ last_seen_at: ago(91) }), NOW)).toBe('offline')
  })

  it('is degraded by a problem or a pair in error, starting until ready, and online with a notice', () => {
    expect(matrixStatusKind(state({ status: { ...ready, ready: false } }), NOW)).toBe('starting')
    expect(matrixStatusKind(state({ status: { ...ready, problems: [{ code: 'matrix_unreachable' }] } }), NOW)).toBe('degraded')
    expect(matrixStatusKind(state({ pairs: [{ ...pair, state: 'error' }] }), NOW)).toBe('degraded')
    expect(matrixStatusKind(state({ status: { ...ready, problems: [{ code: 'messages_skipped' }] } }), NOW)).toBe('online')
  })

  it('leads the problems of a silent bridge with offline and collapses duplicates', () => {
    const problems = [{ code: 'a', detail: 'x' }, { code: 'a', detail: 'x' }, { code: 'a', detail: 'y' }]
    expect(collectMatrixProblems(state({ last_seen_at: ago(200), status: { ...ready, problems } }), NOW)).toEqual([
      { code: 'bridge_offline', detail: '' }, { code: 'a', detail: 'x' }, { code: 'a', detail: 'y' },
    ])
    expect(collectMatrixProblems(state({ last_seen_at: null, status: { ...ready, problems } }), NOW)).toEqual([])
  })

  const checks = (bridge: MatrixBridgeState) => Object.fromEntries(buildMatrixChecklist(bridge, NOW).map((c) => [c.key, c.state]))

  it('checks the bridge, the homeserver and Harmony', () => {
    expect(checks(state({ last_seen_at: null }))).toEqual({ bridge: 'waiting', matrix: 'waiting', harmony: 'waiting' })
    expect(checks(state({ last_seen_at: ago(100) }))).toEqual({ bridge: 'fail', matrix: 'waiting', harmony: 'waiting' })
    expect(checks(state())).toEqual({ bridge: 'ok', matrix: 'ok', harmony: 'ok' })
    const starting = { ...ready, ready: false }
    expect(checks(state({ status: starting }))).toEqual({ bridge: 'ok', matrix: 'waiting', harmony: 'waiting' })
    expect(checks(state({ status: { ...starting, problems: [{ code: 'matrix_registration_missing' }] } }))).toEqual({ bridge: 'ok', matrix: 'fail', harmony: 'waiting' })
    expect(checks(state({ status: { ...starting, problems: [{ code: 'harmony_unreachable' }] } }))).toEqual({ bridge: 'ok', matrix: 'waiting', harmony: 'fail' })
  })

  it('derives the setup step', () => {
    expect(deriveMatrixSetupStep(state({ last_seen_at: null }), NOW)).toBe('connect')
    expect(deriveMatrixSetupStep(state({ last_seen_at: null }), NOW, 'check')).toBe('check')
    expect(deriveMatrixSetupStep(state({ status: { ...ready, ready: false } }), NOW)).toBe('check')
    expect(deriveMatrixSetupStep(state(), NOW)).toBe('channels')
  })
})

describe('commands', () => {
  const input = {
    harmonyUrl: 'https://harmony.example',
    setupCode: 'MX-AAAA-BBBB-CCCC',
    connection: 'application_service' as const,
    homeserverUrl: 'https://matrix.example.org',
    serverName: 'example.org',
    appserviceUrl: 'http://10.0.0.2:9009',
  }

  it('starts the application service with its port published', () => {
    expect(buildMatrixDockerRun(input)).toBe(
      'docker run -d --name harmony-matrix-bridge --restart unless-stopped -p 9009:9009 ' +
        '-e HARMONY_URL=https://harmony.example -e HARMONY_SETUP_CODE=MX-AAAA-BBBB-CCCC ' +
        '-e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_SERVER_NAME=example.org ' +
        '-e MATRIX_APPSERVICE_URL=http://10.0.0.2:9009 ' +
        '-v harmony-matrix-bridge-data:/data ghcr.io/y4my4my4m/harmony-matrix-bridge:latest',
    )
    expect(buildMatrixCompose(input)).toContain('    ports:\n      - "9009:9009"\n    environment:\n      HARMONY_URL: "https://harmony.example"\n')
    expect(buildMatrixEnvFile(input)).toBe(
      'HARMONY_URL=https://harmony.example\nHARMONY_SETUP_CODE=MX-AAAA-BBBB-CCCC\nMATRIX_HOMESERVER_URL=https://matrix.example.org\n' +
        'MATRIX_SERVER_NAME=example.org\nMATRIX_APPSERVICE_URL=http://10.0.0.2:9009\n',
    )
  })

  it('starts the account with a token placeholder and publishes no port', () => {
    const account = { ...input, connection: 'account' as const }
    expect(buildMatrixDockerRun(account)).toBe(
      'docker run -d --name harmony-matrix-bridge --restart unless-stopped ' +
        '-e HARMONY_URL=https://harmony.example -e HARMONY_SETUP_CODE=MX-AAAA-BBBB-CCCC ' +
        `-e MATRIX_HOMESERVER_URL=https://matrix.example.org -e MATRIX_ACCESS_TOKEN=${MATRIX_PLACEHOLDERS.accessToken} ` +
        '-v harmony-matrix-bridge-data:/data ghcr.io/y4my4my4m/harmony-matrix-bridge:latest',
    )
    expect(buildMatrixCompose(account)).not.toContain('ports')
    expect(buildMatrixEnvFile(account)).not.toContain('MATRIX_APPSERVICE_URL')
  })

  it('leaves placeholders without shell metacharacters where nothing valid was entered', () => {
    const command = buildMatrixDockerRun({ ...input, homeserverUrl: null, serverName: null, appserviceUrl: null })
    for (const placeholder of [MATRIX_PLACEHOLDERS.homeserverUrl, MATRIX_PLACEHOLDERS.serverName, MATRIX_PLACEHOLDERS.appserviceUrl]) {
      expect(command).toContain(`=${placeholder} `)
    }
    expect(Object.values(MATRIX_PLACEHOLDERS).join(' ')).toMatch(/^[A-Za-z0-9 :/_.-]+$/)
  })

  it.each([
    ['https://matrix.example.org', 'https://matrix.example.org'],
    [' http://10.0.0.2:9009/ ', 'http://10.0.0.2:9009'],
    ['https://example.org/bridge/', 'https://example.org/bridge'],
    ['matrix.example.org', null],
    ['ftp://example.org', null],
    ['https://user:pw@example.org', null],
    ['https://example.org/?a=b', null],
    ['https://example.org; rm -rf ~', null],
    ['https://$(id).example.org', null],
    ['', null],
  ])('reads %j as the address %j', (text, url) => {
    expect(shellSafeUrl(text)).toBe(url)
  })

  it.each([
    ['example.org', 'example.org'],
    ['example.org:8448', 'example.org:8448'],
    ['@sam:example.org', 'example.org'],
    ['https://example.org', null],
    ['example.org && true', null],
    ['', null],
  ])('reads %j as the server name %j', (text, name) => {
    expect(matrixServerName(text)).toBe(name)
  })
})
