import { describe, it, expect } from 'vitest'
import * as client from '@/utils/mentionGrammar'
import * as server from '../../../federation-backend/src/utils/mentionGrammar'

const SAMPLES = [
  'interesting does fix already deployed @doesnm@chat.understars.dev',
  'no, it should be doesnm@chat.understars.dev',
  'hi @doesnm.chat.understars.dev',
  'ping @doesnm@chat.understars.dev. and @alice, @bob! (@carol@a.b.c) @d?: @e:',
  '@@bob x@y @a@b@c @a@-b.c @a@b..c @Bob@Chat.Example.COM',
  'https://mastodon.social/@user/123 mastodon.social/@user',
  'é@x @ü @x_y-z@host-1.example',
  '',
]

describe('mention grammar parity (frontend vs federation-backend)', () => {
  it('shares the pattern source', () => {
    expect(server.HANDLE_PATTERN).toBe(client.HANDLE_PATTERN)
  })

  it.each(SAMPLES)('finds the same handles in %j', (text) => {
    expect(server.findHandles(text)).toEqual(client.findHandles(text))
  })

  it('parses single handles identically', () => {
    for (const t of ['@a', '@a@b.c', '@a@b.c.', 'a@b.c', '@a@B.C']) {
      expect(server.parseHandle(t)).toEqual(client.parseHandle(t))
    }
  })
})
