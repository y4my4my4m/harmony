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
    ['a domain mid-sentence', 'log in at paypal.com', 'https://evil.example'],
    ['a host before words', 'paypal.com login', 'https://evil.example/x'],
    ['a host after words', 'Sign in at accounts.google.com', 'https://evil.example/x'],
    ['a Cyrillic TLD', 'paypal.c\u043Em', 'https://evil.example'],
    ['a fullwidth TLD', 'paypal.\uFF43\uFF4F\uFF4D', 'https://evil.example'],
    ['a one-dot leader', 'paypal\u2024com', 'https://evil.example/x'],
    ['a fullwidth full stop', 'paypal\uFF0Ecom', 'https://evil.example'],
    ['an ideographic full stop', 'paypal\u3002com', 'https://evil.example'],
    ['a halfwidth ideographic full stop', 'paypal\uFF61com', 'https://evil.example'],
    ['a Lisu tone letter for a dot', 'paypal\uA4F8com', 'https://evil.example'],
    ['a division slash in the path', 'paypal.com\u2215login', 'https://evil.example'],
    ['fraction slashes after the scheme', 'https:\u2044\u2044paypal.com', 'https://evil.example'],
    ['a trailing Hangul filler', 'paypal.com\u3164', 'https://evil.example'],
    ['a trailing Hangul choseong filler', 'paypal.com\u115F', 'https://evil.example'],
    ['a trailing halfwidth Hangul filler', 'paypal.com\uFFA0', 'https://evil.example'],
    ['a combining grapheme joiner', 'paypal\u034F.com', 'https://evil.example'],
    ['a Khmer inherent vowel', 'paypal.co\u17B4m', 'https://evil.example'],
    ['a variation selector', 'paypal.co\uFE0Fm', 'https://evil.example'],
    ['a combining mark', 'paypal.co\u0332m', 'https://evil.example'],
    ['a Polish host', 'mbank.pl', 'https://evil.example'],
    ['another Polish host', 'allegro.pl', 'https://evil.example'],
    ['a host and a bang', 'paypal.com!', 'https://evil.example'],
    ['a host in parentheses', '(paypal.com)', 'https://evil.example'],
    ['a host after an emoji', '\u{1F512} paypal.com', 'https://evil.example'],
    ['a parent domain of the destination', 'github.io', 'https://attacker.github.io'],
    ['a subdomain of the destination', 'docs.example.com', 'https://example.com/docs'],
    ['the destination as a subdomain', 'example.com', 'https://blog.example.com'],
    ['an IPv4 address', '192.168.1.1', 'https://evil.example'],
    ['a punycode host', 'xn--pypal-4ve.com', 'https://paypal.com'],
    ['a homoglyph of the destination', 'p\u0430ypal.com', 'https://paypal.com'],
    ['a destination that is not http(s)', 'google.com', 'javascript://google.com/%0aalert(1)'],
    ['a host beside the destination', 'example.com or paypal.com', 'https://example.com'],
  ])('flags %s', (_name, label, url) => {
    expect(isDeceptiveLabel(label, url)).toBe(true)
  })

  it.each([
    ['plain words', 'the docs', 'https://example.com'],
    ['the same host', 'example.com', 'https://example.com/a'],
    ['www. of the same host', 'www.example.com', 'https://example.com'],
    ['the same host, www. on the destination', 'example.com', 'https://www.example.com'],
    ['the same host in a sentence', 'read it on example.com!', 'https://example.com'],
    ['the same host with look-alike dots', 'example\u3002com', 'https://example.com'],
    ['a library name', 'Node.js', 'https://nodejs.org'],
    ['a file name', 'README.md', 'https://github.com/a/b'],
    ['a crate host ending like a file', 'docs.rs', 'https://evil.example'],
    ['a version', 'v1.2.3', 'https://example.com'],
    ['an abbreviation', 'e.g. this', 'https://example.com'],
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
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: '\u200B\u3164' })).toBeNull()
    const deceptive = { type: 'url', url: 'https://evil.example/x', label: 'https://paypal.com' }
    expect(shownLinkLabel(deceptive)).toBeNull()
    expect(urlPartPlainText(deceptive)).toBe('https://evil.example/x')
  })

  it('shows no label for a destination that is not http(s)', () => {
    expect(shownLinkLabel({ type: 'url', url: 'javascript://google.com/%0aalert(1)', label: 'google.com' })).toBeNull()
    expect(shownLinkLabel({ type: 'url', url: 'ftp://example.com/a', label: 'the file' })).toBeNull()
  })

  it('drops bidi overrides from the shown label', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: '\u202Eabc' })).toBe('abc')
  })

  it('shows exactly the text it checked: bidi marks are gone and the host is named', () => {
    // RLM and ALM, under unicode-bidi: plaintext, turn "com.paypal" into "paypal.com" on screen.
    for (const mark of ['\u200F', '\u061C']) {
      const label = `${mark}com${mark}.${mark}paypal`
      expect(shownLinkLabel({ type: 'url', url: 'https://evil.example/x', label })).toBe('com.paypal (evil.example)')
    }
  })

  it('removes zero-width and filler characters from the shown label', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: 'pay\u200Bment\u3164' })).toBe('payment')
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: 'a\u034Fb\u115F\u1160\uFFA0\u17B4\u17B5c' })).toBe('abc')
  })

  it('keeps the joiners and selectors of emoji and scripts', () => {
    const family = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467} photos'
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: family })).toBe(family)
    const heart = '\u2764\uFE0F\u200D\u{1F525} fan club'
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: heart })).toBe(heart)
    const scotland = '\u{1F3F4}\u{E0067}\u{E0062}\u{E0073}\u{E0063}\u{E0074}\u{E007F} team'
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: scotland })).toBe(scotland)
    const persian = '\u0645\u06CC\u200C\u062E\u0648\u0627\u0647\u0645'
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: persian })).toBe(persian)
    expect(shownLinkLabel({ type: 'url', url: 'https://a.example', label: 'a\u200Db\uFE0F' })).toBe('ab')
  })

  it('names the destination after a host-shaped name that is no known host', () => {
    const node = { type: 'url', url: 'https://nodejs.org/en', label: 'Node.js' }
    expect(shownLinkLabel(node)).toBe('Node.js (nodejs.org)')
    expect(urlPartPlainText(node)).toBe('Node.js (nodejs.org)')
    expect(shownLinkLabel({ type: 'url', url: 'https://evil.example/x', label: 'notion.so' })).toBe('notion.so (evil.example)')
    expect(shownLinkLabel({ type: 'url', url: 'https://www.github.com/a/b', label: 'README.md' })).toBe('README.md (github.com)')
  })

  it('a label already naming the destination gains no host, so a round trip keeps it', () => {
    expect(shownLinkLabel({ type: 'url', url: 'https://nodejs.org/en', label: 'Node.js (nodejs.org)' })).toBe('Node.js (nodejs.org)')
    expect(shownLinkLabel({ type: 'url', url: 'https://nodejs.org/en', label: 'Node.js on nodejs.org' })).toBe('Node.js on nodejs.org')
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
