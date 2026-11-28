import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config/supabase.js', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() }, config: { bridge: {} } }))

import { isMatrixRoomAlias, isMatrixUserId, sanitizeMatrixStatusReport } from '../matrixBridgeConfig.js'
import { normalizeSetupCode } from '../bridgeConfig.js'

const CHANNEL = '00000000-0000-0000-0000-0000000000c1'
// Four UTF-8 bytes, two UTF-16 units.
const WIDE = '\u{1F3B5}'
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value))

describe('sanitizeMatrixStatusReport', () => {
  it('refuses a body that is no object', () => {
    for (const body of [null, undefined, 'x', 7, [], [{}]]) expect(sanitizeMatrixStatusReport(body)).toBeNull()
  })

  it('reads an empty report as a bridge that is not ready and sees nothing', () => {
    expect(sanitizeMatrixStatusReport({})).toEqual({
      version: null,
      connection: null,
      status: { ready: false, user_id: null, homeserver: null, server_name: null, pending: null, failed: null, problems: [] },
      snapshot: { rooms: [] },
      pairs: [],
    })
  })

  it('drops what has the wrong type, and every unknown field', () => {
    const report = sanitizeMatrixStatusReport({
      version: 2, connection: 'bot', ready: 'yes', user_id: 'sam', homeserver: 'ftp://example.org', server_name: 'exa mple',
      pending: -1, failed: 1.5, rooms: 'all', pairs: {}, problems: [7, null, { detail: 'no code' }], access_token: 'secret',
    })!
    expect(JSON.stringify(report)).not.toContain('secret')
    expect(report).toEqual(sanitizeMatrixStatusReport({}))
  })

  it('keeps codes it does not know and errors as sent', () => {
    const report = sanitizeMatrixStatusReport({
      problems: [{ code: 'M_SOMETHING new', detail: 'as sent' }, { code: 'worker_stopped' }],
      pairs: [{ channel_id: CHANNEL, state: 'error', error: 'anything else' }],
    })!
    expect(report.status.problems).toEqual([{ code: 'M_SOMETHING new', detail: 'as sent' }, { code: 'worker_stopped', detail: null }])
    expect(report.pairs).toEqual([{ channel_id: CHANNEL, state: 'error', error: 'anything else' }])
  })

  it('takes a room as encrypted unless the bridge reports it plaintext', () => {
    const rooms = sanitizeMatrixStatusReport({
      rooms: [
        { room_id: '!plain:example.org', encrypted: false },
        { room_id: '!encrypted:example.org', encrypted: true },
        { room_id: '!unknown:example.org' },
        { room_id: '!odd:example.org', encrypted: 'false' },
      ],
    })!.snapshot.rooms as Array<{ room_id: string; encrypted: boolean }>
    expect(rooms.filter((room) => !room.encrypted).map((room) => room.room_id)).toEqual(['!plain:example.org'])
  })

  it('keeps an invite flag as a boolean, false when absent', () => {
    const rooms = sanitizeMatrixStatusReport({
      rooms: [{ room_id: '!a', invited: true }, { room_id: '!b', invited: 'yes' }, { room_id: '!c' }],
    })!.snapshot.rooms as Array<{ invited: boolean }>
    expect(rooms.map((room) => room.invited)).toEqual([true, false, false])
  })

  it('drops a room without a Matrix room id, one named twice, and an alias that is none', () => {
    const rooms = sanitizeMatrixStatusReport({
      rooms: [
        { room_id: 'general', name: 'x' }, { room_id: '!a/b:example.org' }, { room_id: '!\ud800:example.org' }, { name: 'no id' }, null,
        { room_id: '!a:example.org', name: 'first', alias: 'a' }, { room_id: '!a:example.org', name: 'second' },
      ],
    })!.snapshot.rooms
    expect(rooms).toEqual([{ room_id: '!a:example.org', name: 'first', alias: null, encrypted: true, can_send: false, invited: false, members: null }])
  })

  it('drops pairs without a channel id and repeats, and an unknown state', () => {
    expect(sanitizeMatrixStatusReport({
      pairs: [{ channel_id: 'general', state: 'ready' }, { channel_id: CHANNEL.toUpperCase(), state: 'sideways' }, { channel_id: CHANNEL, state: 'ready' }],
    })!.pairs).toEqual([{ channel_id: CHANNEL, state: null, error: null }])
  })

  // jsonb refuses U+0000 and a lone surrogate: either would refuse the whole report.
  it('cleans text of control characters, lone surrogates and bidirectional overrides', () => {
    const report = sanitizeMatrixStatusReport({
      version: '0.2\u0000.0',
      rooms: [{ room_id: '!a:example.org', name: ' Gen\u0000eral\n\u202eevil\ud83d ' }],
      problems: [{ code: 'x\u0007', detail: '\udc00\u2066 ' }],
    })!
    expect(report.version).toBe('0.2 .0')
    expect((report.snapshot.rooms[0] as { name: string }).name).toBe('Gen eral  evil')
    expect(report.status.problems).toEqual([{ code: 'x', detail: null }])
    expect(JSON.stringify(report)).not.toMatch(/\\u(0000|d[89a-f])/i)
  })

  it('cuts text at a character, never inside one', () => {
    const name = (value: string) =>
      (sanitizeMatrixStatusReport({ rooms: [{ room_id: '!a', name: value }] })!.snapshot.rooms[0] as { name: string }).name
    expect(name(WIDE.repeat(300))).toBe(WIDE.repeat(200))
    expect(name('a' + WIDE.repeat(300))).toBe('a' + WIDE.repeat(199))
  })

  it('keeps a homeserver URL without its credentials, query and fragment', () => {
    const homeserver = (value: unknown) => sanitizeMatrixStatusReport({ homeserver: value })!.status.homeserver
    expect(homeserver('https://user:secret@matrix.example.org/client/?token=1#x')).toBe('https://matrix.example.org/client')
    expect(homeserver('http://synapse:8008/')).toBe('http://synapse:8008')
    expect(homeserver('javascript:alert(1)')).toBeNull()
    expect(homeserver('not a url')).toBeNull()
  })

  // A backslash is two bytes of JSON text.
  it.each([['four-byte characters', WIDE], ['escaped characters', '\\']])('stays under the database\'s caps at its largest: %s', (_what, char) => {
    const report = sanitizeMatrixStatusReport({
      version: char.repeat(500), connection: 'account', ready: true,
      user_id: '@' + char.repeat(120) + ':b.org', homeserver: 'https://' + 'a'.repeat(400) + '.org', server_name: 'a'.repeat(255),
      pending: Number.MAX_SAFE_INTEGER, failed: Number.MAX_SAFE_INTEGER,
      rooms: Array.from({ length: 2000 }, (_, i) => ({
        room_id: `!${i}` + char.repeat(120), name: char.repeat(500), alias: '#' + char.repeat(120) + ':b.org', members: i,
      })),
      pairs: Array.from({ length: 3000 }, (_, i) => ({
        channel_id: `00000000-0000-0000-0000-${String(i).padStart(12, '0')}`, state: 'error', error: char.repeat(1000),
      })),
      problems: Array.from({ length: 200 }, () => ({ code: char.repeat(100), detail: char.repeat(1000) })),
    })!
    expect(report.snapshot.rooms).toHaveLength(500)
    expect(report.pairs).toHaveLength(1000)
    expect(report.status.problems).toHaveLength(50)
    // jsonb's text form adds a space after each ':' and ','.
    const caps = [[report.status, 65_536], [report.snapshot, 2_097_152], [report.pairs, 2_097_152]] as const
    for (const [part, cap] of caps) expect(bytes(part) + (JSON.stringify(part).match(/[:,]/g) ?? []).length).toBeLessThan(cap)
  })
})

describe('Matrix ids', () => {
  it('takes MXIDs and aliases as the database does', () => {
    for (const id of ['@sam:example.org', '@sam:example.org:8448', '@s/am=1:example.org']) expect(isMatrixUserId(id)).toBe(true)
    for (const id of ['sam', '@sam', '@:example.org', '@sam:', '@s am:x', '@sam:x\u0000', 7, '@' + 'a'.repeat(260) + ':x']) expect(isMatrixUserId(id)).toBe(false)
    for (const alias of ['#general:example.org', '#a/b:example.org:8448']) expect(isMatrixRoomAlias(alias)).toBe(true)
    for (const alias of ['general', '#general', '#:example.org', '#a b:x', '!a:example.org', null]) expect(isMatrixRoomAlias(alias)).toBe(false)
  })
})

describe('normalizeSetupCode', () => {
  it('reads each platform\'s prefix and no other', () => {
    expect(normalizeSetupCode('mx abcd efgh jk23', 'MX')).toBe('MX-ABCD-EFGH-JK23')
    expect(normalizeSetupCode('abcdefghjk23', 'MX')).toBe('MX-ABCD-EFGH-JK23')
    expect(normalizeSetupCode('MXCDEFGHJKLM', 'MX')).toBe('MX-MXCD-EFGH-JKLM')
    expect(normalizeSetupCode('HB-ABCD-EFGH-JK23', 'MX')).toBeNull()
    expect(normalizeSetupCode('MX-ABCD-EFGH-JK23')).toBeNull()
    expect(normalizeSetupCode('HB-ABCD-EFGH-JK23')).toBe('HB-ABCD-EFGH-JK23')
  })
})
