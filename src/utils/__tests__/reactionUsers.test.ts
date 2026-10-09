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
    expect(users[1]).toMatchObject({ kind: 'discord', id: '42', displayName: 'dd', handle: '@dd', userColor: BOT_NAME_COLOR, isBridged: true, bridgeSource: 'discord' })
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
