import { describe, it, expect } from 'vitest'
import { withUnmatchedMentionsAsText } from '@/utils/unmatchedMentions'
import type { MessagePart } from '@/types'

const ALICE = '00000000-0000-4000-8000-00000000a11c'
const local = (username: string, userId = `unresolved-${username}`) =>
  ({ type: 'mention', userId, username, domain: 'harmony.test', isLocal: true }) as MessagePart

describe('withUnmatchedMentionsAsText', () => {
  it('reads a stored mention of no account as the text around it', () => {
    const parts = [{ type: 'text', text: 'see you ' }, local('5'), { type: 'text', text: ':32 ok' }] as MessagePart[]
    expect(withUnmatchedMentionsAsText(parts)).toEqual([{ type: 'text', text: 'see you @5:32 ok' }])
  })

  it('keeps markdown across the text whole', () => {
    const parts = [{ type: 'text', text: '**' }, local('nobody'), { type: 'text', text: '**' }] as MessagePart[]
    expect(withUnmatchedMentionsAsText(parts)).toEqual([{ type: 'text', text: '**@nobody**' }])
  })

  it('reads a lone stored mention of no account as text', () => {
    expect(withUnmatchedMentionsAsText([local('gasdghasidghasdg')])).toEqual([{ type: 'text', text: '@gasdghasidghasdg' }])
  })

  it('joins adjacent ones and leaves other parts in place', () => {
    const url = { type: 'url', url: 'https://x.example/' } as MessagePart
    const parts = [local('a'), { type: 'text', text: ' ' }, local('b'), url, { type: 'text', text: ' after' }] as MessagePart[]
    expect(withUnmatchedMentionsAsText(parts)).toEqual([{ type: 'text', text: '@a @b' }, url, { type: 'text', text: ' after' }])
  })

  it('keeps mentions of accounts, unknown remote handles and bridged users', () => {
    const parts = [
      local('alice', ALICE),
      { type: 'text', text: ' ' },
      { type: 'mention', userId: 'unresolved-kai@spacify.cloud', username: 'kai', domain: 'spacify.cloud', isLocal: false },
      { type: 'text', text: ' ' },
      { type: 'mention', userId: '123456789', username: 'unresolved-x', domain: 'discord.com', isLocal: false, isBridged: true },
    ] as MessagePart[]
    expect(withUnmatchedMentionsAsText(parts)).toBe(parts)
  })

  it('reads one received from another Harmony instance as the text typed there', () => {
    const remote = { type: 'mention', userId: 'unresolved-ghost', username: 'ghost', domain: 'other.example', isLocal: false } as MessagePart
    expect(withUnmatchedMentionsAsText([{ type: 'text', text: 'hi ' } as MessagePart, remote]))
      .toEqual([{ type: 'text', text: 'hi @ghost' }])
  })

  it('returns the parts as given when none is present', () => {
    const parts = [{ type: 'text', text: 'plain' }] as MessagePart[]
    expect(withUnmatchedMentionsAsText(parts)).toBe(parts)
  })
})
