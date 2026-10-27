/**
 * Masked links: the grammar, the label shown in place of the URL, the deception check, plain
 * text, inbound anchors, and the parser's url parts.
 */
import { describe, it, expect, afterEach } from 'vitest'
import {
  anchorLinkLabel,
  findMaskedLinks,
  isDeceptiveLabel,
  maskedLinkSource,
  shownLinkLabel,
  urlPartPlainText,
} from '@/utils/maskedLinks'
import {
  convertActivityPubHTMLToMessageParts,
  convertMessagePartsToActivityPubHTML,
  convertMessagePartsToText,
  parseContentToMessageParts,
} from '@/utils/unifiedContentProcessing'
import { setMirrorLinkPreferences } from '@/utils/mirrorLinks'

describe('findMaskedLinks', () => {
  it('finds [label](url) with its offsets', () => {
    const text = 'read [the docs](https://example.com/docs) now'
    expect(findMaskedLinks(text)).toEqual([
      { start: 5, end: 41, label: 'the docs', url: 'https://example.com/docs', preview: true, rawLabel: 'the docs', rawDestination: 'https://example.com/docs' },
    ])
  })

  it('takes the <url> form as linked without preview', () => {
    expect(findMaskedLinks('[a](<https://example.com/x>)')).toMatchObject([{ url: 'https://example.com/x', preview: false }])
  })

  it('keeps one level of balanced parentheses in the URL', () => {
    expect(findMaskedLinks('[Foo](https://en.wikipedia.org/wiki/Foo_(bar)).')[0].url).toBe('https://en.wikipedia.org/wiki/Foo_(bar)')
  })

  it.each([
    ['javascript:', '[x](javascript:alert(1))'],
    ['data:', '[x](data:text/html,hi)'],
    ['mailto:', '[x](mailto:a@b.c)'],
    ['a relative path', '[x](/chat/1)'],
    ['a blank label', '[  ](https://example.com)'],
    ['a label across lines', '[a\nb](https://example.com)'],
    ['an escaped bracket', '\\[x](https://example.com)'],
    ['image syntax', '![x](https://example.com/a.png)'],
    ['a space in the URL', '[x](https://example.com/a b)'],
  ])('ignores %s', (_name, text) => {
    expect(findMaskedLinks(text)).toEqual([])
  })

  it('trims the label', () => {
    expect(findMaskedLinks('[ docs ](https://example.com)')[0].label).toBe('docs')
  })

  it('round-trips through maskedLinkSource', () => {
    const source = maskedLinkSource('docs', 'https://example.com/a', false)
    expect(source).toBe('[docs](<https://example.com/a>)')
    expect(findMaskedLinks(source)[0]).toMatchObject({ label: 'docs', url: 'https://example.com/a', preview: false })
  })
})

describe('isDeceptiveLabel', () => {
  it.each([
    ['a URL of another host', 'https://paypal.com/login', 'https://evil.example'],
    ['a URL inside the text', 'Log in at https://paypal.com now', 'https://evil.example'],
    ['www. of another host', 'www.paypal.com', 'https://evil.example'],
    ['a bare host', 'paypal.com', 'https://evil.example/paypal.com'],
    ['a bare host with a path', 'paypal.com/login', 'https://evil.example'],
    ['a host hidden by a zero-width space', 'paypal\u200B.com', 'https://evil.example'],
    ['a country-code host', 'bank.co.uk', 'https://evil.example'],
  ])('flags %s', (_name, label, url) => {
    expect(isDeceptiveLabel(label, url)).toBe(true)
  })

  it.each([
    ['plain words', 'the docs', 'https://example.com'],
    ['the same host', 'example.com', 'https://example.com/a'],
    ['www. of the same host', 'www.example.com', 'https://example.com'],
    ['a subdomain of the destination', 'docs.example.com', 'https://example.com/docs'],
    ['the destination as a subdomain', 'example.com', 'https://blog.example.com'],
    ['a library name', 'Node.js', 'https://nodejs.org'],
    ['a file name', 'README.md', 'https://github.com/a/b'],
    ['a version', 'v1.2.3', 'https://example.com'],
    ['a domain mid-sentence', 'log in at paypal.com', 'https://evil.example'],
  ])('passes %s', (_name, label, url) => {
    expect(isDeceptiveLabel(label, url)).toBe(false)
  })
})

describe('shownLinkLabel and urlPartPlainText', () => {
  it('shows a safe label', () => {
    const part = { type: 'url', url: 'https://docs.example.com/a', preview: true, label: 'the docs' }
    expect(shownLinkLabel(part)).toBe('the docs')
    expect(urlPartPlainText(part)).toBe('the docs (docs.example.com)')
    expect(urlPartPlainText(part, { withHost: false })).toBe('the docs')
  })

  it('shows the URL for no label, a blank one, or a deceptive one', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example' })).toBeNull()
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: '  ' })).toBeNull()
    const deceptive = { type: 'url', url: 'https://evil.example/x', label: 'https://paypal.com' }
    expect(shownLinkLabel(deceptive)).toBeNull()
    expect(urlPartPlainText(deceptive)).toBe('https://evil.example/x')
  })

  it('drops bidi overrides from the shown label', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: '\u202Eabc' })).toBe('abc')
  })

  it('names the host once when the label is the host', () => {
    expect(urlPartPlainText({ type: 'url', url: 'https://www.example.com/a', label: 'example.com' })).toBe('example.com')
  })
})

describe('anchorLinkLabel', () => {
  it('keeps link text that differs from the URL', () => {
    expect(anchorLinkLabel('the docs', 'https://example.com/docs')).toBe('the docs')
  })

  it.each([
    ['the URL itself', 'https://example.com/docs'],
    ["Mastodon's shortened display", 'example.com/do…'],
    ['the URL without scheme', 'example.com/docs'],
    ['another host', 'paypal.com'],
    ['blank text', ' '],
  ])('drops %s', (_name, text) => {
    expect(anchorLinkLabel(text, 'https://example.com/docs')).toBeUndefined()
  })
})

describe('parseContentToMessageParts with masked links', () => {
  afterEach(() => setMirrorLinkPreferences(undefined))

  it('stores a url part with the label', async () => {
    const parts = await parseContentToMessageParts('read [the docs](https://example.com/docs) now')
    expect(parts).toEqual([
      { type: 'text', text: 'read ' },
      { type: 'url', url: 'https://example.com/docs', preview: true, label: 'the docs' },
      { type: 'text', text: ' now' },
    ])
  })

  it('keeps a handle in the label as label text', async () => {
    const parts = await parseContentToMessageParts("[@bob's page](https://mastodon.social/@bob)")
    expect(parts).toEqual([{ type: 'url', url: 'https://mastodon.social/@bob', preview: true, label: "@bob's page" }])
  })

  it('leaves masked links in code alone', async () => {
    const parts = await parseContentToMessageParts('`[a](https://example.com)`')
    expect(parts.filter((p) => p.type === 'url')).toEqual([])
  })

  it('strips trackers from the URL and keeps the label as typed', async () => {
    const parts = await parseContentToMessageParts('[utm_source=x](https://example.com/a?utm_source=x&id=1)')
    expect(parts).toEqual([{ type: 'url', url: 'https://example.com/a?id=1', preview: true, label: 'utm_source=x' }])
  })

  it('rewrites the URL to the chosen mirror', async () => {
    const parts = await parseContentToMessageParts('[a post](https://x.com/NASA/status/1)')
    expect(parts).toEqual([{ type: 'url', url: 'https://fixupx.com/NASA/status/1', preview: true, label: 'a post' }])
  })

  it('parses bare URLs beside masked ones', async () => {
    const parts = await parseContentToMessageParts('[a](https://a.example) and https://b.example')
    expect(parts.filter((p) => p.type === 'url')).toEqual([
      { type: 'url', url: 'https://a.example', preview: true, label: 'a' },
      { type: 'url', url: 'https://b.example', preview: true },
    ])
  })

  it('turns back into the typed text for editing', async () => {
    const typed = 'see [the docs](https://example.com/docs) and [quiet](<https://example.com/q>)'
    expect(convertMessagePartsToText(await parseContentToMessageParts(typed))).toBe(typed)
  })

  it('goes out to ActivityPub as an anchor with the label, escaped', async () => {
    const html = convertMessagePartsToActivityPubHTML([
      { type: 'url', url: 'https://example.com/?a=1&b=2', preview: true, label: '<b>docs</b>' },
    ])
    expect(html).toBe('<a href="https://example.com/?a=1&amp;b=2" target="_blank" rel="noopener">&lt;b&gt;docs&lt;/b&gt;</a>')
  })

  it('reads an inbound anchor with text as a labelled url part', () => {
    expect(convertActivityPubHTMLToMessageParts('<p><a href="https://example.com/docs">the docs</a></p>')).toEqual([
      { type: 'url', url: 'https://example.com/docs', preview: true, label: 'the docs' },
    ])
  })
})
