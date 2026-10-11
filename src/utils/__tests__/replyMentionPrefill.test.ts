import { describe, expect, it } from 'vitest'
import type { TimelinePost } from '@/types'
import { replyMentionPrefill } from '../postReblog'

const author = (id: string, username: string, domain: string, is_local: boolean) => ({ id, username, domain, is_local })
const mention = (userId: string, username: string, domain: string, isLocal: boolean) => ({ type: 'mention', userId, username, domain, isLocal })

function post(over: Record<string, unknown>): TimelinePost {
  return { id: 'p1', content: [], author: author('a', 'alice', 'remote.example', false), ...over } as unknown as TimelinePost
}

describe('replyMentionPrefill', () => {
  it('mentions the author, then the post\'s mentions in order, each once, with one trailing space', () => {
    const p = post({
      content: [
        mention('b', 'bob', 'har.mony.lol', true),
        { type: 'text', text: ' hi ' },
        mention('c', 'carol', 'other.example', false),
        mention('a', 'alice', 'remote.example', false),
        mention('c', 'carol', 'other.example', false),
      ],
    })
    expect(replyMentionPrefill(p, 'me')).toBe('@alice@remote.example @bob @carol@other.example ')
  })

  it('never mentions the viewer', () => {
    const p = post({ content: [mention('me', 'me', 'har.mony.lol', true), mention('b', 'bob', 'har.mony.lol', true)] })
    expect(replyMentionPrefill(p, 'me')).toBe('@alice@remote.example @bob ')
  })

  it('is empty for a reply to one\'s own post that mentions no one else', () => {
    const p = post({ author: author('me', 'me', 'har.mony.lol', true), content: [mention('me', 'me', 'har.mony.lol', true)] })
    expect(replyMentionPrefill(p, 'me')).toBe('')
  })

  it('uses the boosted post for a hydrated reblog, never the booster', () => {
    const original = post({ id: 'o', author: author('c', 'carol', 'other.example', false), content: [mention('b', 'bob', 'har.mony.lol', true)] })
    const reblog = post({ id: 'r', author: author('d', 'dave', 'har.mony.lol', true), reblog: original, reblog_author: original.author })
    expect(replyMentionPrefill(reblog, 'me')).toBe('@carol@other.example @bob ')
  })
})
