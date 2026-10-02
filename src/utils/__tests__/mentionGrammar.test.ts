import { describe, it, expect } from 'vitest'
import {
  findHandles,
  parseHandle,
  isValidHost,
  continuesHandle,
  mentionDisplayDomain,
} from '@/utils/mentionGrammar'

const handles = (t: string) => findHandles(t).map(h => (h.domain ? `${h.username}@${h.domain}` : h.username))

describe('mentionGrammar', () => {
  it('takes every label of a subdomain host', () => {
    expect(handles('deployed @doesnm@chat.understars.dev')).toEqual(['doesnm@chat.understars.dev'])
    expect(handles('@a@x.y.z.example.co.uk hi')).toEqual(['a@x.y.z.example.co.uk'])
    expect(handles('@bob@localhost')).toEqual(['bob@localhost'])
  })

  it('reports exact offsets', () => {
    const [h] = findHandles('hi @doesnm@chat.understars.dev!')
    expect(h).toMatchObject({ start: 3, end: 30, raw: '@doesnm@chat.understars.dev' })
  })

  it('lowercases the host and keeps the user', () => {
    expect(findHandles('@Bob@Chat.Example.COM')[0]).toMatchObject({ username: 'Bob', domain: 'chat.example.com' })
  })

  it.each(['.', ',', '!', '?', ')', ':'])('ends the host before trailing %s', (p) => {
    expect(handles(`ping @doesnm@chat.understars.dev${p}`)).toEqual(['doesnm@chat.understars.dev'])
    expect(handles(`ping @alice${p}`)).toEqual(['alice'])
  })

  it('accepts a handle inside parentheses', () => {
    expect(handles('(@doesnm@chat.understars.dev)')).toEqual(['doesnm@chat.understars.dev'])
  })

  it('treats user@host without a leading @ as text', () => {
    expect(handles('no, it should be doesnm@chat.understars.dev')).toEqual([])
    expect(handles('mail bob@example.com')).toEqual([])
    expect(handles('a_b@c')).toEqual([])
  })

  it('treats @@user as text', () => {
    expect(handles('@@bob')).toEqual([])
    expect(handles('x @@bob@example.com')).toEqual([])
  })

  it('treats a dotted continuation as text instead of splitting it', () => {
    expect(handles('hi @doesnm.chat.understars.dev')).toEqual([])
    expect(handles('@doesnm@understars.dev.chat')).toEqual(['doesnm@understars.dev.chat'])
  })

  it('rejects a third @ segment', () => {
    expect(handles('@a@b.example@c.example')).toEqual([])
  })

  it('rejects hosts with empty or hyphen-edged labels', () => {
    // ".." is trailing punctuation after host "b".
    expect(handles('@a@b..c')).toEqual(['a@b'])
    expect(handles('@a@-b.c')).toEqual([])
    expect(handles('@a@b-.c')).toEqual([])
  })

  it('does not start a handle after a slash', () => {
    expect(handles('mastodon.social/@user/123')).toEqual([])
  })

  it('finds several handles', () => {
    expect(handles('@alice, @bob@remote.example and @carol@a.b.c!')).toEqual([
      'alice',
      'bob@remote.example',
      'carol@a.b.c',
    ])
  })

  it('parseHandle accepts exactly one handle', () => {
    expect(parseHandle('@doesnm@chat.understars.dev')).toEqual({ username: 'doesnm', domain: 'chat.understars.dev' })
    expect(parseHandle('@alice')).toEqual({ username: 'alice', domain: undefined })
    expect(parseHandle('@alice and more')).toBeNull()
    expect(parseHandle('alice@example.com')).toBeNull()
  })

  it('isValidHost', () => {
    expect(isValidHost('chat.understars.dev')).toBe(true)
    expect(isValidHost('chat.understars.dev.')).toBe(false)
    expect(isValidHost('a,b')).toBe(false)
  })

  it('continuesHandle', () => {
    expect(continuesHandle('chat')).toBe(true)
    expect(continuesHandle('@x')).toBe(true)
    expect(continuesHandle('.chat')).toBe(true)
    expect(continuesHandle('. next')).toBe(false)
    expect(continuesHandle('.')).toBe(false)
    expect(continuesHandle(' x')).toBe(false)
    expect(continuesHandle(',')).toBe(false)
  })
})

describe('mentionDisplayDomain', () => {
  const local = 'har.mony.lol'

  it('shows the remote host', () => {
    expect(mentionDisplayDomain({ domain: 'chat.understars.dev', isLocal: false }, null, local)).toBe('chat.understars.dev')
  })

  it('never shows the local host', () => {
    expect(mentionDisplayDomain({ domain: 'har.mony.lol', isLocal: false }, null, local)).toBeNull()
    expect(mentionDisplayDomain({ domain: 'har.mony.lol', isLocal: true }, null, local)).toBeNull()
  })

  it('prefers the cached profile over a stored part with the local host on a remote user', () => {
    expect(
      mentionDisplayDomain(
        { domain: 'har.mony.lol', isLocal: false },
        { domain: 'chat.understars.dev', isLocal: false },
        local,
      ),
    ).toBe('chat.understars.dev')
  })

  it('hides the host of bridged users', () => {
    expect(mentionDisplayDomain({ domain: 'discord.com', isLocal: false }, null, local)).toBeNull()
  })
})
