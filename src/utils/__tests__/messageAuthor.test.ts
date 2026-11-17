/**
 * Bridged-author detection. Relayed rows carry discord_user or matrix_user, or
 * bridge_source 'discord' / 'matrix'; bridge_source 'harmony' marks a Harmony
 * user's message the bridge relayed out.
 */
import { describe, it, expect } from 'vitest'
import { bridgedAuthorHandle, bridgedAuthorName, bridgePlatformLabel, getBridgedAuthor, getBridgeSource, getForeignAuthor, getHarmonyProfileUserId, getRemoteAuthor, getWebhookAuthor, isBotAuthorMessage, isBridgedAuthorMessage, messageAuthorKey } from '@/utils/messageAuthor'
import type { Message } from '@/types'

const message = (metadata: Record<string, unknown> | undefined, extra: Partial<Message> = {}) =>
  ({ id: 'm1', user_id: 'u1', content: [], metadata, ...extra }) as unknown as Message

describe('isBridgedAuthorMessage', () => {
  it('is true for Discord-origin rows', () => {
    expect(isBridgedAuthorMessage(message({ discord_user: { id: '1', username: 'd' } }, { bot_id: 'b1' }))).toBe(true)
    expect(isBridgedAuthorMessage(message({ bridge_source: 'discord' }, { bot_id: 'b1' }))).toBe(true)
    expect(getBridgeSource(message({ bridge_source: 'discord' }))).toBe('discord')
  })

  it('is false for a Harmony message the bridge relayed out', () => {
    const relayed = message({ bridge_source: 'harmony', discord_message_id: '123' })
    expect(isBridgedAuthorMessage(relayed)).toBe(false)
    expect(getBridgeSource(relayed)).toBeNull()
    expect(getHarmonyProfileUserId(relayed)).toBe('u1')
  })

  it('is false for a plain Harmony message', () => {
    expect(isBridgedAuthorMessage(message(undefined))).toBe(false)
  })
})

describe('bridged authors', () => {
  const people = {
    discord: { key: 'discord_user', id: '1234567890', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/s.png' },
    matrix: { key: 'matrix_user', id: '@sam:example.org', username: 'sam', display_name: 'Sam', avatar_url: 'https://cdn.test/s.png' },
  } as const

  it.each(['discord', 'matrix'] as const)('reads a %s person the same way', platform => {
    const { key, ...person } = people[platform]
    const posted = message({ [key]: person }, { user_id: undefined, bot_id: 'bridge' })
    expect(getBridgedAuthor(posted)).toEqual({ platform, ...person })
    expect(getBridgeSource(posted)).toBe(platform)
    expect(isBridgedAuthorMessage(posted)).toBe(true)
    expect(getHarmonyProfileUserId(posted)).toBe('')
    expect(getForeignAuthor(posted)).toEqual({ name: 'Sam', avatar_url: person.avatar_url })
    expect(messageAuthorKey(posted)).toBe(`${platform}:${person.id}`)
    expect(messageAuthorKey(posted)).not.toBe(messageAuthorKey(message({ [key]: { ...person, id: `${person.id}0` } }, { bot_id: 'bridge' })))
  })

  it('names a person by display name, else username, else the MXID localpart', () => {
    expect(bridgedAuthorName({ platform: 'discord', id: '1', username: 'sam', display_name: 'Sam' })).toBe('Sam')
    expect(bridgedAuthorName({ platform: 'discord', id: '1', username: 'sam' })).toBe('sam')
    expect(bridgedAuthorName({ platform: 'matrix', id: '@sam:example.org', username: '', display_name: '  ' })).toBe('sam')
  })

  it('gives Discord an @username handle and Matrix the MXID', () => {
    expect(bridgedAuthorHandle({ platform: 'discord', id: '1', username: 'sam' })).toBe('@sam')
    expect(bridgedAuthorHandle({ platform: 'discord', id: '1', username: '@sam' })).toBe('@sam')
    expect(bridgedAuthorHandle({ platform: 'matrix', id: '@sam:example.org', username: 'sam' })).toBe('@sam:example.org')
  })

  it('reads no person from bridge_author, a Matrix row without an id, or a non-object', () => {
    expect(getBridgedAuthor(message({ bridge_author: { platform: 'matrix', id: '@a:b', username: 'a' } }))).toBeNull()
    expect(getBridgedAuthor(message({ matrix_user: { id: '', username: 'a' } }))).toBeNull()
    expect(getBridgedAuthor(message({ matrix_user: 'sam' }))).toBeNull()
    expect(getBridgedAuthor(message({ discord_user: { username: 'legacy' } }))).toMatchObject({ platform: 'discord', id: '', username: 'legacy' })
  })

  it('reads a replaced metadata object afresh', () => {
    const posted = message({ discord_user: { id: '1', username: 'a' } }, { bot_id: 'bridge' })
    expect(getBridgedAuthor(posted)?.username).toBe('a')
    posted.metadata = { matrix_user: { id: '@b:hs', username: 'b' } }
    expect(getBridgedAuthor(posted)).toMatchObject({ platform: 'matrix', username: 'b' })
  })

  it('labels platforms by their own names', () => {
    expect(bridgePlatformLabel('discord')).toBe('Discord')
    expect(bridgePlatformLabel('matrix')).toBe('Matrix')
  })
})

describe('getWebhookAuthor', () => {
  it('reads the shown name and avatar of a webhook message', () => {
    const posted = message({ webhook: { id: 'w1', name: 'Deployer', avatar_url: 'https://cdn.test/d.png' } }, { user_id: null, bot_id: 'b1' })
    expect(getWebhookAuthor(posted)).toEqual({ id: 'w1', name: 'Deployer', avatar_url: 'https://cdn.test/d.png' })
    expect(getWebhookAuthor(message({ webhook: { id: 'w1', name: 'CI', avatar_url: null } }, { bot_id: 'b1' }))?.avatar_url).toBeNull()
  })

  it('is null without a bot author or a name', () => {
    expect(getWebhookAuthor(message({ webhook: { id: 'w1', name: 'CI' } }))).toBeNull()
    expect(getWebhookAuthor(message({ webhook: { id: 'w1' } }, { bot_id: 'b1' }))).toBeNull()
    expect(getWebhookAuthor(message(undefined, { bot_id: 'b1' }))).toBeNull()
  })
})

describe('getForeignAuthor', () => {
  it('names a Discord person, a webhook or a bot, in that order', () => {
    const dana = { id: '1', username: 'dana', display_name: 'Dana', avatar_url: 'https://cdn.test/d.png' }
    expect(getForeignAuthor(message({ discord_user: dana }, { user_id: null, bot_id: 'b1' })))
      .toEqual({ name: 'Dana', avatar_url: 'https://cdn.test/d.png' })
    expect(getForeignAuthor(message({ discord_user: { id: '1', username: 'dana' } }, { user_id: null, bot_id: 'b1' }))?.name).toBe('dana')
    expect(getForeignAuthor(message({ webhook: { id: 'w1', name: 'CI' } }, { user_id: null, bot_id: 'b1' })))
      .toEqual({ name: 'CI', avatar_url: null })
    const bot = { id: 'b1', username: 'bridge', display_name: 'Discord Bridge', avatar_url: null }
    expect(getForeignAuthor(message(undefined, { user_id: null, bot_id: 'b1', bot } as Partial<Message>))?.name).toBe('Discord Bridge')
    expect(getForeignAuthor(message(undefined, { user_id: null, bot_id: 'b1' }))?.name).toBe('Bot')
  })

  it('is null for a message a profile wrote', () => {
    expect(getForeignAuthor(message(undefined))).toBeNull()
    expect(getForeignAuthor(null)).toBeNull()
  })
})

// A copy of a federated server: its host's Group speaks for bots, webhooks and bridged people;
// the row has no profile and no bot (federation-backend groupAuthor.ts).
describe('remote authors', () => {
  const remote = (author: Record<string, unknown>) =>
    message({ remote_author: author }, { user_id: null, bot_id: null } as Partial<Message>)

  it('reads a remote bot and a remote webhook', () => {
    const bot = remote({ kind: 'bot', id: 'b1', name: 'Deploy Bot', avatar_url: 'https://cdn.test/b.png' })
    expect(getRemoteAuthor(bot)).toEqual({ kind: 'bot', id: 'b1', name: 'Deploy Bot', avatar_url: 'https://cdn.test/b.png' })
    expect(getWebhookAuthor(bot)).toBeNull()
    expect(isBotAuthorMessage(bot)).toBe(true)
    expect(getForeignAuthor(bot)).toEqual({ name: 'Deploy Bot', avatar_url: 'https://cdn.test/b.png' })

    const hook = remote({ kind: 'webhook', id: 'w1', name: 'CI', avatar_url: null })
    expect(getWebhookAuthor(hook)).toEqual({ id: 'w1', name: 'CI', avatar_url: null })
    expect(getHarmonyProfileUserId(hook)).toBe('')
  })

  it('is ignored on a row with an author of its own, or without a name', () => {
    expect(getRemoteAuthor(message({ remote_author: { kind: 'bot', id: 'b1', name: 'B' } }))).toBeNull()
    expect(getRemoteAuthor(remote({ kind: 'bot', id: 'b1' }))).toBeNull()
    expect(getRemoteAuthor(remote({ kind: 'person', id: 'p', name: 'P' }))).toBeNull()
  })
})

describe('messageAuthorKey', () => {
  it('tells apart the people one bot or one Group speaks for', () => {
    const viaBridge = (id: string) => message({ discord_user: { id, username: id } }, { user_id: null, bot_id: 'b1' })
    expect(messageAuthorKey(viaBridge('1'))).not.toBe(messageAuthorKey(viaBridge('2')))
    expect(messageAuthorKey(viaBridge('1'))).toBe(messageAuthorKey(viaBridge('1')))

    const hook = (name: string) => message({ webhook: { id: 'w1', name } }, { user_id: null, bot_id: 'b1' })
    expect(messageAuthorKey(hook('CI'))).not.toBe(messageAuthorKey(hook('Deploy')))

    const remote = (id: string) => message({ remote_author: { kind: 'bot', id, name: id } }, { user_id: null, bot_id: null } as Partial<Message>)
    expect(messageAuthorKey(remote('b1'))).not.toBe(messageAuthorKey(remote('b2')))
    expect(messageAuthorKey(remote('b1'))).not.toBe(messageAuthorKey(message(undefined, { user_id: null, bot_id: null } as Partial<Message>)))
  })

  it('treats a missing bot_id as none, and a bot apart from a person', () => {
    expect(messageAuthorKey(message(undefined, { bot_id: undefined }))).toBe(messageAuthorKey(message(undefined, { bot_id: null } as Partial<Message>)))
    expect(messageAuthorKey(message(undefined, { user_id: null, bot_id: 'b1' }))).not.toBe(messageAuthorKey(message(undefined)))
  })
})
