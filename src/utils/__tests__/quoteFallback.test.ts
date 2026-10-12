import { describe, expect, it } from 'vitest'
import type { TimelinePost } from '@/types'
import { quoteTargetUrl, withoutQuoteFallback, withoutStrayMentionAt } from '../postReblog'

const Q = 'https://holos.social/users/doesnm/statuses/1784442538721-6iijw0'

describe('withoutQuoteFallback', () => {
  it('drops the leading "RE: <quoted url>" line and the space after it', () => {
    const parts = [
      { type: 'text', text: 'RE: ' },
      { type: 'url', url: Q },
      { type: 'text', text: ' \n> Could we' },
    ]
    expect(withoutQuoteFallback(parts, Q)).toEqual([{ type: 'text', text: '> Could we' }])
  })

  it('keeps content whose first link is not the quoted post, or with no quote', () => {
    const parts = [{ type: 'text', text: 'RE: ' }, { type: 'url', url: 'https://other.example/1' }]
    expect(withoutQuoteFallback(parts, Q)).toEqual(parts)
    expect(withoutQuoteFallback(parts, null)).toEqual(parts)
    const plain = [{ type: 'text', text: 'hello ' }, { type: 'url', url: Q }]
    expect(withoutQuoteFallback(plain, Q)).toEqual(plain)
  })
})

describe('quoteTargetUrl', () => {
  it('reads inbound and locally composed quotes', () => {
    expect(quoteTargetUrl({ metadata: { quote_ap_url: Q } } as unknown as TimelinePost)).toBe(Q)
    expect(quoteTargetUrl({ metadata: { quote_url: Q } } as unknown as TimelinePost)).toBe(Q)
    expect(quoteTargetUrl({ metadata: {} } as unknown as TimelinePost)).toBeNull()
  })
})

describe('withoutStrayMentionAt', () => {
  const mention = { type: 'mention', username: 'y4my4m', domain: 'har.mony.lol', isLocal: true }

  it('drops the "@" a text part ends with before a mention', () => {
    expect(withoutStrayMentionAt([{ type: 'text', text: '@' }, mention, { type: 'text', text: ' hi' }]))
      .toEqual([mention, { type: 'text', text: ' hi' }])
    expect(withoutStrayMentionAt([{ type: 'text', text: 'cc @' }, mention]))
      .toEqual([{ type: 'text', text: 'cc ' }, mention])
  })

  it('returns other content as given', () => {
    const parts = [{ type: 'text', text: 'mail me@' }, { type: 'url', url: 'https://a.example' }]
    expect(withoutStrayMentionAt(parts)).toBe(parts)
    expect(withoutStrayMentionAt('plain')).toBe('plain')
  })
})
