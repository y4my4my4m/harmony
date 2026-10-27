/**
 * Pure helpers of the chat composer: IME keys, editor spaces, pasted line ends, the masked-link
 * paste over a selection, the editor's link token, and url parts back to composer text and to
 * preview text.
 */
import { describe, it, expect } from 'vitest'
import { isImeKeyEvent } from '@/utils/editorShortcuts'
import { editorSpaces } from '@/utils/editorText'
import { pastedText } from '@/utils/emojiClipboard'
import { linkPasteText, urlPartSource } from '@/utils/maskedLinks'
import { parseMarkdownWithMarkers } from '@/utils/markdownParser'
import { messagePartsToMarkdown, messagePartsToPlainText, messagePartsToRawText } from '@/utils/messageContentUtils'
import type { MessagePart } from '@/types'

describe('isImeKeyEvent', () => {
  it('owns keys of an open composition', () => {
    expect(isImeKeyEvent({ isComposing: true, keyCode: 13 } as KeyboardEvent)).toBe(true)
  })
  // WebKit's committing Enter (keyCode 229 after compositionend) is the editor's to mark:
  // editorShortcuts.test.ts. A 229 no editor marked is an ordinary key (IBus, fcitx).
  it('leaves keyCode 229 no editor marked', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 229 } as KeyboardEvent)).toBe(false)
  })
  it('leaves an ordinary Enter', () => {
    expect(isImeKeyEvent({ isComposing: false, keyCode: 13 } as KeyboardEvent)).toBe(false)
  })
})

describe('editorSpaces', () => {
  it.each([
    ['one two', 'one two'],
    [' lead', '\u00a0lead'],
    ['trail ', 'trail\u00a0'],
    ['a  b', 'a\u00a0 b'],
    ['a   b', 'a\u00a0\u00a0 b'],
    ['  ', '\u00a0\u00a0'],
  ])('%j -> %j', (input, output) => {
    expect(editorSpaces(input)).toBe(output)
  })
})

describe('pastedText', () => {
  const data = (plain: string) => ({ getData: (t: string) => (t === 'text/plain' ? plain : '') }) as unknown as DataTransfer
  it('ends lines with \\n whatever the clipboard used', () => {
    expect(pastedText(data('one\r\ntwo\rthree\nfour'))).toBe('one\ntwo\nthree\nfour')
  })
})

describe('linkPasteText', () => {
  it('links the selection, whitespace kept outside', () => {
    expect(linkPasteText(' the docs ', 'https://example.com/docs')).toBe(' [the docs](https://example.com/docs) ')
  })
  it.each([
    ['a paste of text', 'docs', 'see https://example.com'],
    ['a paste of a non-http link', 'docs', 'ftp://example.com'],
    ['a blank selection', '  ', 'https://example.com'],
    ['a selection across lines', 'a\nb', 'https://example.com'],
    ['a selection holding brackets', 'a]b', 'https://example.com'],
    ['a selected link', 'https://old.example', 'https://example.com'],
    ['a URL the grammar cannot hold', 'docs', 'https://example.com/a)b'],
  ])('declines %s', (_name, selected, pasted) => {
    expect(linkPasteText(selected, pasted)).toBeNull()
  })
})

describe('parseMarkdownWithMarkers link tokens', () => {
  it('splits a masked link into label and destination', () => {
    expect(parseMarkdownWithMarkers('a [b c](<https://x.example>) d')).toEqual([
      { type: 'text', content: 'a ' },
      { type: 'link', content: 'b c', destination: '<https://x.example>', raw: '[b c](<https://x.example>)', language: undefined },
      { type: 'text', content: ' d' },
    ])
  })
  it('finds a masked link inside bold', () => {
    const [bold] = parseMarkdownWithMarkers('**[b](https://x.example)**')
    expect(bold.type).toBe('bold')
    expect(bold.children?.[0]).toMatchObject({ type: 'link', content: 'b', destination: 'https://x.example' })
  })
  it('leaves links in code alone', () => {
    expect(parseMarkdownWithMarkers('```\n[b](https://x.example)\n```').map((t) => t.type)).toEqual(['codeblock'])
  })
})

describe('url parts as text', () => {
  const parts: MessagePart[] = [
    { type: 'text', text: 'read ' },
    { type: 'url', url: 'https://docs.example.com/a', preview: true, label: 'the docs' },
    { type: 'text', text: ' or ' },
    { type: 'url', url: 'https://q.example', preview: false, label: 'quiet' },
    { type: 'text', text: ' or ' },
    { type: 'url', url: 'https://evil.example', preview: true, label: 'https://paypal.com' },
  ]

  it('edits as typed', () => {
    const typed = 'read [the docs](https://docs.example.com/a) or [quiet](<https://q.example>) or [https://paypal.com](https://evil.example)'
    expect(messagePartsToMarkdown(parts)).toBe(typed)
    expect(messagePartsToRawText(parts)).toBe(typed)
  })

  it('previews the label and host, a deceptive label as its URL', () => {
    expect(messagePartsToPlainText(parts)).toBe('read the docs (docs.example.com) or quiet (q.example) or https://evil.example')
  })

  it('keeps a label the grammar cannot hold out of the typed form', () => {
    expect(urlPartSource({ url: 'https://a.example', preview: true, label: 'a]b' })).toBe('https://a.example')
  })
})
