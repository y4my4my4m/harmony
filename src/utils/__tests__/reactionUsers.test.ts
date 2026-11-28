import { describe, expect, it } from 'vitest'
import { BOT_NAME_COLOR } from '@/utils/botUtils'
import {
  formatUserHandle,
  reactionGroupKey,
  reactionProfileIds,
  toReactionUsers,
  type ReactionUserResolvers,
} from '@/utils/reactionUsers'

const resolvers: ReactionUserResolvers = {
  displayName: (id) => (id ? `name:${id}` : 'Unknown User'),
  avatarUrl: (id) => `/a/${id}`,
  color: () => '#123456',
  handle: (id) => `@${id}`,
}

describe('reactionUsers', () => {
  it('maps users, bridged Discord users and bots', () => {
    const users = toReactionUsers([
      { reaction_id: 'r1', user_id: 'u1' },
      { reaction_id: 'r2', user_id: 'bridge', metadata: { discord_user: { id: '42', username: 'dd' } } },
      { reaction_id: 'r3', bot_id: 'b1', display_name: 'Live Bot' },
    ], resolvers)

    expect(users[0]).toMatchObject({ kind: 'user', id: 'u1', displayName: 'name:u1', handle: '@u1', userColor: '#123456', isBridged: false })
    expect(users[1]).toMatchObject({ kind: 'discord', id: '42', displayName: 'dd', handle: '@dd', userColor: 'var(--text-primary)', isBridged: true, bridgeSource: 'discord' })
    expect(users[2]).toMatchObject({ kind: 'bot', id: 'b1', displayName: 'Live Bot', userColor: BOT_NAME_COLOR })
    expect(new Set(users.map(u => u.key)).size).toBe(3)
  })

  it('preloads Harmony profiles only', () => {
    expect(reactionProfileIds([
      { reaction_id: 'r1', user_id: 'u1' },
      { reaction_id: 'r2', user_id: 'u1' },
      { reaction_id: 'r3', user_id: 'bridge', metadata: { discord_user: { id: '42' } } },
      { reaction_id: 'r4', bot_id: 'b1' },
    ])).toEqual(['u1'])
  })

  it('maps Discord and Matrix reactors alike, keyed apart per platform', () => {
    const actors = [
      { reaction_id: 'd', bot_id: 'relay', metadata: { discord_user: { id: '42', username: 'sam', display_name: 'Sam' } } },
      { reaction_id: 'm', bot_id: 'relay', metadata: { matrix_user: { id: '@sam:example.org', username: 'sam', display_name: 'Sam' } } },
    ]
    expect(reactionProfileIds(actors)).toEqual([])
    const bridgedColor = (platform: string, id: string) => `${platform}-${id}`
    const users = toReactionUsers(actors, { ...resolvers, bridgedColor })
    expect(users.map(user => user.key)).toEqual(['discord:42', 'matrix:@sam:example.org'])
    expect(users[0]).toMatchObject({ kind: 'discord', displayName: 'Sam', handle: '@sam', userColor: 'discord-42', bridgeSource: 'discord' })
    expect(users[1]).toMatchObject({ kind: 'matrix', displayName: 'Sam', handle: '@sam:example.org', userColor: 'matrix-@sam:example.org', bridgeSource: 'matrix' })
    expect(users[1].bridgedAuthor).toMatchObject({ platform: 'matrix', id: '@sam:example.org' })
  })

  it('keys a Discord reactor without an id by its reaction', () => {
    const users = toReactionUsers([
      { reaction_id: 'r1', bot_id: 'relay', metadata: { discord_user: { username: 'a' } as never } },
      { reaction_id: 'r2', bot_id: 'relay', metadata: { discord_user: { username: 'b' } as never } },
    ], resolvers)
    expect(users.map(user => user.key)).toEqual(['reaction:r1', 'reaction:r2'])
  })

  it('formats local and remote handles', () => {
    expect(formatUserHandle({ username: 'alice', domain: 'here.example', isLocal: true })).toBe('@alice')
    expect(formatUserHandle({ username: 'bob', domain: 'there.example', isLocal: false })).toBe('@bob@there.example')
    expect(formatUserHandle({ username: '  ' })).toBeNull()
    expect(formatUserHandle(null)).toBeNull()
  })

  it('keys a pill by emoji_id, else by emoji name', () => {
    expect(reactionGroupKey({ emoji_id: 'e1', emoji: { name: 'party' } as any })).toBe('e1')
    expect(reactionGroupKey({ emoji_id: null, emoji: { name: '👍' } as any })).toBe('👍')
  })
})
