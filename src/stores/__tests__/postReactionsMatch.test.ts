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

// get_post_emoji_reactions orders by MIN(created_at), so an unconstrained content match
// returns the oldest chip whose emoji_id is null - somebody else's unicode reaction - and the
// engine then takes the wrong add/remove branch.
describe('unicode chips are distinguished from each other', () => {
  const FIRE = { emoji_id: null, custom_emoji_content: '🔥' }
  const GRIN = { emoji_id: null, custom_emoji_content: '😀' }

  it('matches the picked unicode emoji, not the first null-id chip', () => {
    expect(__test.matchesEmoji(FIRE as never, { native: '🔥' })).toBe(true)
    expect(__test.matchesEmoji(FIRE as never, { native: '😀' })).toBe(false)
    expect(__test.matchesEmoji(GRIN as never, { native: '😀' })).toBe(true)
  })

  it('treats a non-uuid id as the shortcode, as buildOptimisticGroups does', () => {
    expect(__test.matchesEmoji(FIRE as never, { id: '🔥' })).toBe(true)
    expect(__test.matchesEmoji(GRIN as never, { id: '🔥' })).toBe(false)
  })
})
