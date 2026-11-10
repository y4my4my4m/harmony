import { describe, expect, it } from 'vitest'
import { botUserId, configSchema, ghostUserId, ghostOwner, loadSecrets, registration } from './config.js'

export const sampleConfig = () => ({
  harmony: { apiUrl: 'https://harmony.test/bot-gateway', gatewayUrl: 'wss://harmony.test/bot-gateway/gateway', allowedUserIds: ['11111111-1111-4111-8111-111111111111'] },
  matrix: { homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', applicationServiceUrl: 'http://127.0.0.1:9009', allowedUserIds: ['@alice:matrix.test'] },
  pairs: [{ harmonyChannelId: '22222222-2222-4222-8222-222222222222', matrixRoomId: '!test:matrix.test' }],
})

describe('configuration', () => {
  it('defaults to one-to-one both-way relay, loopback listen and explicit users', () => {
    const config = configSchema.parse(sampleConfig())
    expect(config.pairs[0].direction).toBe('both')
    expect(config.pairs[0].senderMode).toBe('relay')
    expect(config.listen.host).toBe('127.0.0.1')
    expect(botUserId(config)).toBe('@harmony_relay:matrix.test')
    expect(configSchema.safeParse({ ...sampleConfig(), harmony: { ...sampleConfig().harmony, allowedUserIds: [] } }).success).toBe(false)
  })
  it('accepts opaque modern room IDs without a homeserver suffix', () => {
    const input = sampleConfig()
    input.pairs[0].matrixRoomId = '!ModernOpaqueRoomId_0123456789_without_server'
    expect(configSchema.parse(input).pairs[0].matrixRoomId).toBe(input.pairs[0].matrixRoomId)
    input.pairs[0].matrixRoomId = '!invalid room'
    expect(configSchema.safeParse(input).success).toBe(false)
  })
  it('rejects ambiguous mappings and URLs containing secrets or unsupported schemes', () => {
    const input = sampleConfig()
    expect(configSchema.safeParse({ ...input, pairs: [...input.pairs, input.pairs[0]] }).success).toBe(false)
    for (const apiUrl of ['file:///etc/passwd', 'https://user:secret@test', 'https://test?token=secret']) {
      expect(configSchema.safeParse({ ...input, harmony: { ...input.harmony, apiUrl } }).success).toBe(false)
    }
    expect(configSchema.safeParse({ ...input, arbitrary: true }).success).toBe(false)
  })
  it.each(['@' + 'a'.repeat(255) + ':test', '@bad\u0000:test', '@bad:test\u007f'])('rejects invalid or oversized Matrix sender IDs', id => {
    const input = sampleConfig()
    input.matrix.allowedUserIds = [id]
    expect(configSchema.safeParse(input).success).toBe(false)
  })
  it('requires strong distinct tokens without echoing invalid secrets', () => {
    const env = { HARMONY_TOKEN: `harmony_bot_${'a'.repeat(64)}`, MATRIX_AS_TOKEN: 'b'.repeat(64), MATRIX_HS_TOKEN: 'c'.repeat(64) }
    expect(loadSecrets(env).asToken).toBe(env.MATRIX_AS_TOKEN)
    expect(() => loadSecrets({ ...env, MATRIX_HS_TOKEN: env.MATRIX_AS_TOKEN })).toThrow(/distinct/)
    expect(() => loadSecrets({ ...env, HARMONY_TOKEN: 'secret-password' })).toThrow('HARMONY_TOKEN must be a Harmony bot token')
  })
  it('registers the exact AS sender and dedicated ghosts without claiming unrelated users or rooms', () => {
    const config = configSchema.parse(sampleConfig())
    const result = registration(config, { asToken: 'as', hsToken: 'hs' })
    const namespaces = result.namespaces as { users: Array<{ regex: string }>; rooms: unknown[] }
    expect(new RegExp(namespaces.users[0].regex).test('@harmony_relay:matrix.test')).toBe(true)
    expect(new RegExp(namespaces.users[0].regex).test('@harmony_relay:matrixXtest')).toBe(false)
    expect(new RegExp(namespaces.users[0].regex).test('@alice:matrix.test')).toBe(false)
    expect(namespaces.rooms).toEqual([])
    const id = config.harmony.allowedUserIds[0]
    const ghost = ghostUserId(config, id)
    expect(ghostOwner(config, ghost)).toBe(id)
    expect(ghost).toBe('@harmony_relay_h_11111111111141118111111111111111:matrix.test')
    expect(new RegExp(namespaces.users[1].regex).test(ghost)).toBe(true)
    expect(new RegExp(namespaces.users[1].regex).test(ghost.replace('h_111', 'h_bad111'))).toBe(false)
    expect(ghostOwner(config, '@alice:matrix.test')).toBeNull()
  })
})
