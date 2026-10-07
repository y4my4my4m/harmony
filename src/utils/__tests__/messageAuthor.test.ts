/**
 * Bridged-author detection. Discord-origin rows carry discord_user or
 * bridge_source 'discord'; bridge_source 'harmony' marks a Harmony user's
 * message the bridge relayed out.
 */
import { describe, it, expect } from 'vitest'
import { getBridgeSource, getHarmonyProfileUserId, isBridgedAuthorMessage } from '@/utils/messageAuthor'
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
