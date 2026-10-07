/**
 * Clipboard form of custom emoji: tokens in text/plain, token-tagged images in
 * text/html, and pasted HTML reduced to text.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/services/emojiShortcodeResolver', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/emojiShortcodeResolver')>()
  return {
    ...actual,
    findEmojiByName: (name: string) =>
      name === 'har_wink' ? { id: 'e1', name: 'har_wink', url: 'https://cdn.example/har_wink.webp' } : actual.findEmojiByName(name),
  }
})

import {
  handleRenderedEmojiCopy,
  htmlToTokenText,
  installRenderedEmojiCopy,
  nodeToTokenText,
  pastedText,
  tokenTextToHtml,
} from '@/utils/emojiClipboard'

const ID = '1376980620600672316'

function clipboard(initial: Record<string, string> = {}) {
  const store: Record<string, string> = { ...initial }
  return {
    store,
    getData: (type: string) => store[type] ?? '',
    setData: (type: string, value: string) => { store[type] = value },
    items: [] as unknown[],
  }
}

function copyEvent(data = clipboard()) {
  const event = new Event('copy', { bubbles: true, cancelable: true }) as ClipboardEvent
  Object.defineProperty(event, 'clipboardData', { value: data })
  return { event, data }
}

function select(start: Node, startOffset: number, end: Node, endOffset: number) {
  const range = document.createRange()
  range.setStart(start, startOffset)
  range.setEnd(end, endOffset)
  const sel = window.getSelection()!
  sel.removeAllRanges()
  sel.addRange(range)
}

afterEach(() => {
  document.body.innerHTML = ''
  window.getSelection()?.removeAllRanges()
})

describe('nodeToTokenText', () => {
  it('writes emoji elements as tokens and keeps line breaks', () => {
    const div = document.createElement('div')
    div.innerHTML =
      `hi <img class="emoji-icon" alt=":heh:" data-emoji-token=":discord:heh:${ID}:" src="x">` +
      ` <span class="editor-emoji" data-emoji="har_wink"><img alt=":har_wink:"></span><br>next` +
      ` <img class="inline-emoji" alt="😀" src="t.svg"> <img class="content-image" src="photo.png">`
    expect(nodeToTokenText(div)).toEqual({
      text: `hi :discord:heh:${ID}: :har_wink:\nnext 😀 `,
      tokens: [`:discord:heh:${ID}:`, ':har_wink:'],
      emojiCount: 3,
    })
  })
})

describe('tokenTextToHtml', () => {
  it('turns resolvable tokens into token-tagged images and escapes the rest', () => {
    const html = tokenTextToHtml(`<b>a</b> :har_wink: :nope:\n:discord:heh:${ID}:`)
    expect(html).toContain('&lt;b&gt;a&lt;/b&gt;')
    expect(html).toContain('<img data-emoji-token=":har_wink:" alt=":har_wink:" src="https://cdn.example/har_wink.webp"')
    expect(html).toContain(' :nope:<br>')
    expect(html).toContain(`src="https://cdn.discordapp.com/emojis/${ID}.png"`)
    expect(htmlToTokenText(html).text).toBe(`<b>a</b> :har_wink: :nope:\n:discord:heh:${ID}:`)
  })
})

describe('pastedText', () => {
  it('keeps plain text when no HTML is present', () => {
    expect(pastedText(clipboard({ 'text/plain': 'just text :)' }) as unknown as DataTransfer)).toBe('just text :)')
  })

  it('keeps plain text when it already carries the tokens', () => {
    const data = clipboard({
      'text/plain': 'a :har_wink: b',
      'text/html': '<p>a <img alt=":har_wink:" src="x"> <b>b</b></p>',
    })
    expect(pastedText(data as unknown as DataTransfer)).toBe('a :har_wink: b')
  })

  it('takes the HTML text when the images carry tokens text/plain lacks', () => {
    const data = clipboard({
      'text/plain': 'a  b',
      'text/html': `<span>a <img class="emoji-icon" alt=":heh:" data-emoji-token=":discord:heh:${ID}:"> b</span>`,
    })
    expect(pastedText(data as unknown as DataTransfer)).toBe(`a :discord:heh:${ID}: b`)
  })

  it('reduces malicious HTML to text', () => {
    const onerror = vi.fn()
    ;(window as unknown as { __pwned: () => void }).__pwned = onerror
    const data = clipboard({
      'text/plain': 'x',
      'text/html':
        '<img alt=":har_wink:" src="nope" onerror="window.__pwned()"><script>window.__pwned()</script>' +
        '<style>body{}</style><a href="javascript:window.__pwned()">link</a><iframe src="javascript:1"></iframe>',
    })
    const text = pastedText(data as unknown as DataTransfer)
    expect(text).toBe(':har_wink:link')
    expect(onerror).not.toHaveBeenCalled()
  })
})

describe('handleRenderedEmojiCopy', () => {
  function renderedMessage() {
    const root = document.createElement('div')
    root.className = 'unified-content'
    root.innerHTML =
      `<span class="text-content">look </span><img class="emoji-icon" alt=":heh:" data-emoji-token=":discord:heh:${ID}:" src="d.png">` +
      `<span class="text-content"> and </span><img class="emoji-icon" alt=":har_wink:" data-emoji-token=":har_wink:" src="w.png">` +
      `<span class="text-content"> end</span>`
    document.body.appendChild(root)
    return root
  }

  it('writes tokens for a selection over rendered emoji images', () => {
    const root = renderedMessage()
    select(root.firstChild!.firstChild!, 0, root.lastChild!.firstChild!, 4)
    const { event, data } = copyEvent()
    handleRenderedEmojiCopy(event)
    expect(event.defaultPrevented).toBe(true)
    expect(data.store['text/plain']).toBe(`look :discord:heh:${ID}: and :har_wink: end`)
    expect(data.store['text/html']).toContain('data-emoji-token=":har_wink:"')
  })

  it('leaves a selection without emoji to the browser', () => {
    const root = renderedMessage()
    select(root.firstChild!.firstChild!, 0, root.firstChild!.firstChild!, 4)
    const { event, data } = copyEvent()
    handleRenderedEmojiCopy(event)
    expect(event.defaultPrevented).toBe(false)
    expect(data.store['text/plain']).toBeUndefined()
  })

  it('leaves selections inside an editor to the editor', () => {
    const editor = document.createElement('div')
    editor.setAttribute('contenteditable', 'true')
    editor.innerHTML = 'a <img alt=":har_wink:" src="w.png"> b'
    document.body.appendChild(editor)
    select(editor, 0, editor, editor.childNodes.length)
    const { event } = copyEvent()
    handleRenderedEmojiCopy(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('runs from the document listener', () => {
    const uninstall = installRenderedEmojiCopy()
    try {
      const root = renderedMessage()
      select(root, 0, root, root.childNodes.length)
      const { event, data } = copyEvent()
      root.dispatchEvent(event)
      expect(data.store['text/plain']).toBe(`look :discord:heh:${ID}: and :har_wink: end`)
    } finally {
      uninstall()
    }
  })
})
