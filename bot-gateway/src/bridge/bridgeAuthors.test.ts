import { describe, expect, it } from 'vitest'
import { bridgeAuthor, bridgedMessageAuthor } from './bridgeAuthors.js'

const matrix = { platform: 'matrix', id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://example.org/sam.png' }

describe('bridge authors', () => {
  it('keeps only bounded author fields for the registered platform', () => {
    expect(bridgeAuthor({ ...matrix, token: 'not metadata', display_name: 'x'.repeat(101) }, 'matrix')).toEqual({ ...matrix, display_name: 'x'.repeat(100) })
  })
  it.each([null, [], {}, { ...matrix, id: 'native-uuid' }, { ...matrix, username: '' }, { ...matrix, username: 'x'.repeat(101) }, { ...matrix, platform: 'discord' }])('rejects invalid Matrix identity %j', value => {
    expect(bridgeAuthor(value, 'matrix')).toBeNull()
  })
  it('rejects a mismatched registration or invalid Discord snowflake', () => {
    expect(bridgeAuthor(matrix, 'discord')).toBeNull()
    expect(bridgeAuthor({ ...matrix, platform: 'discord' }, 'discord')).toBeNull()
    expect(bridgeAuthor({ ...matrix, platform: 'discord', id: '123' }, 'discord')?.id).toBe('123')
  })
  it.each(['javascript:alert(1)', 'data:image/svg+xml,x', 'https://secret:password@example.org/a', 'mxc://example.org/a', 'not a URL'])('drops unsafe optional avatar %s', avatar_url => {
    expect(bridgeAuthor({ ...matrix, avatar_url }, 'matrix')).not.toHaveProperty('avatar_url')
  })
  it('formats a generic author without looking up or posing as a Harmony profile', () => {
    expect(bridgedMessageAuthor({ bot_id: 'bridge', metadata: { bridge_author: matrix } })).toMatchObject({ id: matrix.id, display_name: 'Sam', bridge_source: 'matrix', bridge_author: true, bot: false })
    expect(bridgedMessageAuthor({ metadata: { bridge_author: matrix } })).toBeNull()
  })
  it('preserves legacy Discord flags and prefers the generic identity when both exist', () => {
    const discord = { id: '123', username: 'alice' }
    expect(bridgedMessageAuthor({ bot_id: 'bridge', metadata: { discord_user: discord } })).toMatchObject({ ...discord, discord_user: true, bot: false })
    expect(bridgedMessageAuthor({ bot_id: 'bridge', metadata: { discord_user: discord, bridge_author: matrix } })?.id).toBe(matrix.id)
  })
})
