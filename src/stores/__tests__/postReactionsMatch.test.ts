import { describe, it, expect } from 'vitest'
import { __test } from '../postReactions'

// The same shortcode exists twice on one post: (uuid, ':party:') written by the local
// picker, and (NULL, ':party:') written from a remote actor. The RPCs group on the pair, so
// the client has to match on the pair too.
const LOCAL = { emoji_id: 'e0010000-0000-4000-8000-000000000001', custom_emoji_content: ':party:' }
const REMOTE = { emoji_id: null, custom_emoji_content: ':party:' }

describe('post reaction chip matching', () => {
  it('picks the local chip by id, not the remote one sharing its shortcode', () => {
    const m = __test.matchesEmojiBy(LOCAL.emoji_id, ':party:')
    expect(m(LOCAL as never)).toBe(true)
    expect(m(REMOTE as never)).toBe(false)
  })

  it('picks the remote chip when no id is supplied', () => {
    const m = __test.matchesEmojiBy(null, ':party:')
    expect(m(REMOTE as never)).toBe(true)
    expect(m(LOCAL as never)).toBe(false)
  })

  it('leaves content unconstrained for a picker call that knows only the id', () => {
    const m = __test.matchesEmojiBy(LOCAL.emoji_id, null)
    expect(m(LOCAL as never)).toBe(true)
    expect(m(REMOTE as never)).toBe(false)
  })
})
