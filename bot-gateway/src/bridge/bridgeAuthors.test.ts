import { describe, expect, it } from 'vitest'
import { bridgedMessageAuthor, matrixAuthor } from './bridgeAuthors.js'

const matrix = { platform: 'matrix', id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/s.png' }

describe('matrixAuthor', () => {
  it('keeps the author fields and nothing else', () => {
    expect(matrixAuthor({ ...matrix, token: 'not metadata', display_name: 'x'.repeat(101) }))
      .toEqual({ id: '@sam:example.org', username: 'sam', display_name: 'x'.repeat(100), avatar_url: 'https://cdn.test/s.png' })
  })

  it.each([
    ['another platform', { ...matrix, platform: 'discord', id: '42' }],
    ['no platform', { id: '@sam:example.org', username: 'sam' }],
    ['an id that is not an MXID', { ...matrix, id: 'sam' }],
    ['an MXID over 255 characters', { ...matrix, id: `@${'a'.repeat(250)}:example.org` }],
    ['an empty username', { ...matrix, username: '  ' }],
    ['a username over 100 characters', { ...matrix, username: 'u'.repeat(101) }],
  ])('refuses %s', (_name, value) => {
    expect(matrixAuthor(value)).toBeNull()
  })

  it('drops an avatar that is not https', () => {
    expect(matrixAuthor({ ...matrix, avatar_url: 'http://cdn.test/s.png' })).not.toHaveProperty('avatar_url')
    expect(matrixAuthor({ ...matrix, avatar_url: 'https://user:pw@cdn.test/s.png' })).not.toHaveProperty('avatar_url')
    expect(matrixAuthor({ ...matrix, avatar_url: 'not a url' })).not.toHaveProperty('avatar_url')
  })
})

describe('bridgedMessageAuthor', () => {
  it('names a Matrix-relayed message by its matrix_user', () => {
    const message = { bot_id: 'b', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/s.png' } } }
    expect(bridgedMessageAuthor(message)).toEqual({
      id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar: 'https://cdn.test/s.png',
      nickname: null, bot: false, bridge_source: 'matrix', bridge_author: true,
    })
  })

  it('names a Discord-relayed message by its discord_user', () => {
    const message = { bot_id: 'b', metadata: { discord_user: { id: '42', username: 'gus', display_name: 'Gus', avatar_url: 'https://cdn.discordapp.com/a.png' } } }
    expect(bridgedMessageAuthor(message)).toMatchObject({ id: '42', username: 'gus', discord_user: true, bot: false })
  })

  it('answers null for a member message and for a bot message without a relayed author', () => {
    expect(bridgedMessageAuthor({ user_id: 'u', metadata: { matrix_user: { id: '@sam:example.org' } } })).toBeNull()
    expect(bridgedMessageAuthor({ bot_id: 'b', metadata: {} })).toBeNull()
    expect(bridgedMessageAuthor({ bot_id: 'b', metadata: { bridge_author: matrix } })).toBeNull()
  })
})
