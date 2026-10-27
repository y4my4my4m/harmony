/**
 * Masked links over federation: url parts with a label go out as anchors with the label (and,
 * for receivers that drop anchors, the URL in an invisible span); inbound anchors whose text is
 * a label come back as labelled url parts. A label naming another host goes out as the URL.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../config/index.js', () => ({
  default: {
    INSTANCE_DOMAIN: 'harmony.test',
    SUPABASE_URL: 'http://localhost:54321',
    PUBLIC_SUPABASE_URL: 'http://localhost:54321',
  },
  config: { INSTANCE_DOMAIN: 'harmony.test' },
}))
vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn(() => ({})) }))
vi.mock('../utils/urlUtils.js', () => ({
  getFullAvatarUrl: vi.fn((url: string | null) => url || null),
  getFullBannerUrl: vi.fn((url: string | null) => url || null),
  getFullEmojiUrl: vi.fn((url: string | null) => url || null),
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

import { convertContentToHTML } from '../utils/contentUtils.js'
import { postToNote } from '../activitypub/converters/toActivityPub.js'
import { noteToContent } from '../activitypub/converters/fromActivityPub.js'
import { anchorLinkLabel, isDeceptiveLabel, shownLinkLabel, urlPartPlainText } from '../utils/maskedLinks.js'

const docs = { type: 'url', url: 'https://example.com/docs?a=1&b=2', preview: true, label: 'the <docs>' }

describe('outbound', () => {
  it('Group Notes and DMs carry the label, the URL in an invisible span', () => {
    expect(convertContentToHTML([{ type: 'text', text: 'read ' }, docs])).toBe(
      'read <a href="https://example.com/docs?a=1&amp;b=2">the &lt;docs&gt;</a>'
      + '<span class="invisible"> (https://example.com/docs?a=1&amp;b=2)</span>',
    )
  })

  it('posts carry the label', () => {
    const note = postToNote({ id: 'p1', content: [docs], visibility: 'public', created_at: '' }, { username: 'alice' })
    expect(note.content).toContain('target="_blank">the &lt;docs&gt;</a><span class="invisible"> (https://example.com/docs?a=1&amp;b=2)</span>')
  })

  it('a label naming another host goes out as the URL', () => {
    const html = convertContentToHTML([{ type: 'url', url: 'https://evil.example/x', label: 'https://paypal.com' }])
    expect(html).toBe('<a href="https://evil.example/x">https://evil.example/x</a>')
  })

  it('an unlabelled url part is unchanged', () => {
    expect(convertContentToHTML([{ type: 'url', url: 'https://example.com' }])).toBe('<a href="https://example.com">https://example.com</a>')
  })
})

describe('inbound', () => {
  it('reads an anchor with link text as a labelled url part', () => {
    expect(noteToContent({ content: '<p>see <a href="https://example.com/docs" rel="nofollow">the docs</a> now</p>' })).toEqual([
      { type: 'text', text: 'see ' },
      { type: 'url', url: 'https://example.com/docs', preview: true, label: 'the docs' },
      { type: 'text', text: ' now' },
    ])
  })

  it('round-trips what this version sends', () => {
    const html = convertContentToHTML([{ type: 'text', text: 'read ' }, docs, { type: 'text', text: ' ok' }])
    expect(noteToContent({ content: `<p>${html}</p>` })).toEqual([
      { type: 'text', text: 'read ' },
      { type: 'url', url: 'https://example.com/docs?a=1&b=2', preview: true, label: 'the <docs>' },
      { type: 'text', text: ' ok' },
    ])
  })

  it("leaves Mastodon's shortened URL display as a plain link", () => {
    const html = '<p><a href="https://example.com/a/long/path" rel="nofollow noopener" target="_blank">'
      + '<span class="invisible">https://</span><span class="ellipsis">example.com/a/lo</span>'
      + '<span class="invisible">ng/path</span></a></p>'
    expect(noteToContent({ content: html })).toEqual([{ type: 'url', url: 'https://example.com/a/long/path', preview: true }])
  })

  it('keeps mentions and hashtags', () => {
    const parts = noteToContent({
      content: '<p><span class="h-card"><a href="https://m.example/@bob" class="u-url mention">@<span>bob</span></a></span> '
        + '<a href="https://m.example/tags/cats" class="mention hashtag" rel="tag">#<span>cats</span></a></p>',
      tag: [
        { type: 'Mention', href: 'https://m.example/@bob', name: '@bob@m.example' },
        { type: 'Hashtag', name: '#cats', href: 'https://m.example/tags/cats' },
      ],
    })
    expect(parts.map((p: { type: string }) => p.type)).toEqual(['mention', 'hashtag'])
  })

  it('takes no label naming another host', () => {
    expect(noteToContent({ content: '<a href="https://evil.example/x">paypal.com</a>' })).toEqual([
      { type: 'text', text: 'paypal.com' },
    ])
  })
})

describe('plain text', () => {
  it('names the host after the label', () => {
    expect(urlPartPlainText(docs)).toBe('the <docs> (example.com)')
    expect(isDeceptiveLabel('www.paypal.com', 'https://evil.example')).toBe(true)
  })
})

// The same rules as src/utils/maskedLinks.ts; src/utils/__tests__/maskedLinks.test.ts holds
// the full table.
describe('label policy', () => {
  const evil = 'https://evil.example/x'

  it.each([
    ['a host after words', 'Sign in at accounts.google.com'],
    ['a host before words', 'paypal.com login'],
    ['a one-dot leader', 'paypal\u2024com'],
    ['an ideographic full stop', 'paypal\u3002com'],
    ['a Cyrillic TLD', 'paypal.c\u043Em'],
    ['a fullwidth TLD', 'paypal.\uFF43\uFF4F\uFF4D'],
    ['a trailing Hangul filler', 'paypal.com\u3164'],
    ['a host in parentheses', '(paypal.com)'],
    ['a Polish host', 'mbank.pl'],
  ])('shows the URL, and takes no inbound label, for %s', (_name, label) => {
    expect(shownLinkLabel({ type: 'url', url: evil, label })).toBeNull()
    expect(anchorLinkLabel(label, evil)).toBeUndefined()
    expect(isDeceptiveLabel(label, evil)).toBe(true)
  })

  it('takes no parent domain of the destination', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://attacker.github.io', label: 'github.io' })).toBeNull()
  })

  it('shows no label for a destination that is not http(s)', () => {
    expect(shownLinkLabel({ type: 'url', url: 'javascript://google.com/%0aalert(1)', label: 'google.com' })).toBeNull()
    expect(convertContentToHTML([{ type: 'url', url: 'javascript://google.com/%0aalert(1)', label: 'google.com' }])).not.toContain('>google.com<')
  })

  it('shows the label without bidi marks, the destination named after a host-shaped name', () => {
    expect(shownLinkLabel({ type: 'url', url: evil, label: '\u200Fcom\u200F.\u200Fpaypal' })).toBe('com.paypal (evil.example)')
    expect(shownLinkLabel({ type: 'url', url: 'https://nodejs.org', label: 'Node.js' })).toBe('Node.js (nodejs.org)')
    expect(urlPartPlainText({ type: 'url', url: 'https://nodejs.org', label: 'Node.js' })).toBe('Node.js (nodejs.org)')
  })

  it('shows a label naming the destination as typed', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://www.example.com/a', label: 'read it on example.com' })).toBe('read it on example.com')
  })
})
