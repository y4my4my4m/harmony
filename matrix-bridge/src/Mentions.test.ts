import { describe, expect, it } from 'vitest'
import { configSchema, ghostUserId } from './config.js'
import { harmonyToMatrix, matrixToHarmony } from './Mentions.js'

const config = configSchema.parse({
  harmony: { apiUrl: 'https://harmony.test', gatewayUrl: 'wss://harmony.test', allowedUserIds: ['11111111-1111-4111-8111-111111111111'] },
  matrix: { homeserverUrl: 'https://matrix.test', serverName: 'matrix.test', applicationServiceUrl: 'http://localhost', allowedUserIds: ['@sam:matrix.test'] },
  pairs: [{ harmonyChannelId: '22222222-2222-4222-8222-222222222222', matrixRoomId: '!room:test' }],
})
const id = config.harmony.allowedUserIds[0]
const ghost = ghostUserId(config, id)
const member = { id, username: 'alice', display_name: 'Room Alice', domain: 'harmony.test', avatar_url: null }

describe('mentions', () => {
  it('translates explicit owned ghost pills into native mention parts in place', () => {
    const parts = matrixToHarmony('Hi Room Alice!', `Hi <a href="https://matrix.to/#/${encodeURIComponent(ghost)}">Room Alice</a>!`, [ghost], [member], config)
    expect(parts).toEqual([{ type: 'text', text: 'Hi ' }, { type: 'mention', userId: id, username: 'alice', domain: 'harmony.test', isLocal: true, isBridged: false }, { type: 'text', text: '!' }])
  })
  it('does not guess display names, trust unannotated pills, or ping unknown/ineligible targets', () => {
    const html = `<a href="https://matrix.to/#/${ghost}">Room Alice</a>`
    for (const [ids, members] of [[[], [member]], [[ghost], []], [['@evil:test'], [member]]] as const) {
      expect(matrixToHarmony('Room Alice', html, [...ids], [...members], config)).toEqual([{ type: 'text', text: 'Room Alice' }])
    }
  })
  it('does not replace misleading plaintext using a different HTML body', () => {
    const parts = matrixToHarmony('Actual text', `<a href="https://matrix.to/#/${ghost}">Forged</a>`, [ghost], [member], config)
    expect(parts[0]).toEqual({ type: 'text', text: 'Actual text' })
    expect(parts.filter(part => part.type === 'mention')).toHaveLength(1)
  })
  it('supports the exact-username relay command, never display-name or ambiguous guesses', () => {
    expect(matrixToHarmony('!mention alice hello', undefined, [], [member], config)[0]).toMatchObject({ type: 'mention', userId: id })
    for (const members of [[member], [member, { ...member, id: 'other' }]]) {
      expect(matrixToHarmony('!mention Room_Alice hello', undefined, [], members, config)).toEqual([{ type: 'text', text: '!mention Room_Alice hello' }])
    }
    expect(matrixToHarmony('!mention alice hello', undefined, [], [member, { ...member, id: 'other' }], config)[0].type).toBe('text')
  })
  it('creates real Matrix user annotations and escaped pills from structured Matrix mentions', () => {
    const result = harmonyToMatrix([{ type: 'text', text: '<img>& hello ' }, { type: 'mention', userId: '@sam:matrix.test', username: '<Sam>', isBridged: true, bridgeSource: 'matrix' }], 'unused', new Map([['@sam:matrix.test', '@sam:matrix.test']]))
    expect(result.body).toBe('<img>& hello @<Sam>')
    expect(result.userIds).toEqual(['@sam:matrix.test'])
    expect(result.formattedBody).toBe('&lt;img&gt;&amp; hello <a href="https://matrix.to/#/%40sam%3Amatrix.test">@&lt;Sam&gt;</a>')
  })
  it('never parses frontend marker strings or enables mass mentions', () => {
    expect(harmonyToMatrix([{ type: 'text', text: '<@matrix:%40sam%3Atest> @room' }], '', new Map())).toEqual({ body: '<@matrix:%40sam%3Atest> @room', userIds: [] })
    const result = harmonyToMatrix([{ type: 'mention', userId: '@sam:test', username: 'sam' }], '', new Map([['@sam:test', '@sam:test']]))
    expect(result.userIds).toEqual([])
    expect(result.formattedBody).toBeUndefined()
  })
})
