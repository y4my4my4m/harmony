/**
 * Clipboard form of text holding custom emoji.
 *
 * text/plain carries the composer token: `:name:` for this instance's custom
 * emoji, `:discord:[a:]<name>:<id>:` for Discord emoji. text/html carries the
 * same text with each resolvable token as
 * `<img data-emoji-token=":name:" alt=":name:" src=…>`.
 *
 * Pasted HTML is parsed in an inert DOMParser document and reduced to text;
 * no pasted markup reaches an editor.
 */
import { DISCORD_EMOJI_TOKEN_INNER } from '@/utils/discordEmoji'
import { EMOJI_SHORTCODE_INNER, findEmojiByName } from '@/services/emojiShortcodeResolver'
import { escapeHtml } from '@/utils/sanitize'

const EMOJI_TOKEN_RE = new RegExp(`^:(?:${DISCORD_EMOJI_TOKEN_INNER}|${EMOJI_SHORTCODE_INNER}):$`)
const EMOJI_TOKEN_GLOBAL = () => new RegExp(`:(${DISCORD_EMOJI_TOKEN_INNER}|${EMOJI_SHORTCODE_INNER}):`, 'g')
/** Unicode emoji sequence: pictographs, regional indicators, ZWJ, VS16, skin tones, keycaps. */
const UNICODE_EMOJI_RE = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|\u200D|\uFE0F|\u20E3|[#*0-9])+$/u

const BLOCK_TAGS = new Set([
  'ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DIV', 'DL', 'DT', 'FIGCAPTION', 'FIGURE',
  'FOOTER', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P',
  'PRE', 'SECTION', 'TABLE', 'TR', 'UL',
])
const SKIPPED_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'TITLE', 'META', 'LINK', 'IFRAME', 'OBJECT'])

export function isEmojiToken(value: string): boolean {
  return EMOJI_TOKEN_RE.test(value)
}

/**
 * Clipboard text of an emoji element; null for any other element.
 * Sources in order: data-emoji-token, RichTextEditor's `.editor-emoji[data-emoji]`,
 * an img alt in token form, an emoji-classed img's unicode alt.
 */
export function emojiTextOfElement(el: Element): { text: string; token: boolean } | null {
  const attr = el.getAttribute('data-emoji-token')?.trim()
  if (attr) {
    if (isEmojiToken(attr)) return { text: attr, token: true }
    if (UNICODE_EMOJI_RE.test(attr)) return { text: attr, token: false }
  }
  if (el.classList.contains('editor-emoji')) {
    const name = el.getAttribute('data-emoji')
    if (name && isEmojiToken(`:${name}:`)) return { text: `:${name}:`, token: true }
  }
  if (el.tagName === 'IMG') {
    const alt = el.getAttribute('alt')?.trim() ?? ''
    if (isEmojiToken(alt)) return { text: alt, token: true }
    if (/emoji/i.test(el.getAttribute('class') ?? '') && UNICODE_EMOJI_RE.test(alt)) {
      return { text: alt, token: false }
    }
  }
  return null
}

export interface TokenText {
  text: string
  /** Custom emoji tokens met, in order. */
  tokens: string[]
  /** Emoji elements met, custom and unicode. */
  emojiCount: number
}

/** Text of a DOM subtree with emoji elements as their tokens. Non-emoji images contribute nothing. */
export function nodeToTokenText(root: Node): TokenText {
  let text = ''
  const tokens: string[] = []
  let emojiCount = 0
  const breakLine = () => {
    if (text && !text.endsWith('\n')) text += '\n'
  }

  const visit = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent ?? ''
      return
    }
    if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return
    if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as Element
      const tag = el.tagName.toUpperCase()
      if (SKIPPED_TAGS.has(tag)) return
      const emoji = emojiTextOfElement(el)
      if (emoji) {
        text += emoji.text
        emojiCount++
        if (emoji.token) tokens.push(emoji.text)
        return
      }
      if (tag === 'BR') {
        text += '\n'
        return
      }
      if (tag === 'IMG') return
      if (BLOCK_TAGS.has(tag)) {
        breakLine()
        node.childNodes.forEach(visit)
        breakLine()
        return
      }
    }
    node.childNodes.forEach(visit)
  }

  visit(root)
  return { text: text.replace(/\u00A0/g, ' ').replace(/^\n+|\n+$/g, ''), tokens, emojiCount }
}

/** text/html of composer text: escaped text, `<br>` line breaks, resolvable emoji tokens as images. */
export function tokenTextToHtml(text: string): string {
  const re = EMOJI_TOKEN_GLOBAL()
  let html = ''
  let last = 0
  let match: RegExpExecArray | null
  while ((match = re.exec(text)) !== null) {
    html += escapeHtml(text.slice(last, match.index))
    const token = match[0]
    let url: string | undefined
    try {
      url = findEmojiByName(match[1])?.url || undefined
    } catch {
      url = undefined
    }
    html += url
      ? `<img data-emoji-token="${escapeHtml(token)}" alt="${escapeHtml(token)}" src="${escapeHtml(url)}" style="height:1.375em;width:auto;vertical-align:bottom">`
      : escapeHtml(token)
    last = match.index + token.length
  }
  html += escapeHtml(text.slice(last))
  return html.replace(/\r?\n/g, '<br>')
}

/** Text of clipboard HTML. The DOMParser document has no browsing context: no script runs, no resource loads. */
export function htmlToTokenText(html: string): TokenText {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return nodeToTokenText(doc.body)
}

/**
 * Text to insert for a paste. text/plain wins unless the HTML holds custom
 * emoji tokens that text/plain lacks (an image copied without its token).
 */
export function pastedText(data: DataTransfer | null | undefined): string {
  if (!data) return ''
  const plain = data.getData('text/plain') || ''
  const html = data.getData('text/html') || ''
  if (!html) return plain
  const fromHtml = htmlToTokenText(html)
  if (fromHtml.tokens.length === 0) return plain
  if (fromHtml.tokens.every((token) => plain.includes(token))) return plain
  return fromHtml.text
}

/** Writes both flavours and claims the event. False when the event has no clipboardData. */
export function writeTokenTextToClipboard(event: ClipboardEvent, text: string): boolean {
  const data = event.clipboardData
  if (!data) return false
  data.setData('text/plain', text)
  data.setData('text/html', tokenTextToHtml(text))
  event.preventDefault()
  return true
}

/**
 * Copy of a selection over rendered (non-editable) content. Takes over only
 * when the selection holds an emoji element; any other copy keeps the
 * browser's default. Selections inside editable elements are left to them.
 */
export function handleRenderedEmojiCopy(event: ClipboardEvent): void {
  if (event.defaultPrevented) return
  const selection = typeof window !== 'undefined' ? window.getSelection() : null
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return

  const pieces: string[] = []
  let hasEmoji = false
  for (let i = 0; i < selection.rangeCount; i++) {
    const range = selection.getRangeAt(i)
    const anchor = range.commonAncestorContainer
    const anchorEl = anchor.nodeType === Node.ELEMENT_NODE ? (anchor as Element) : anchor.parentElement
    if (anchorEl?.closest('[contenteditable="true"], [contenteditable=""], input, textarea')) return
    const fragment = range.cloneContents()
    if (fragment.querySelector('img, [data-emoji-token], .editor-emoji')) {
      const piece = nodeToTokenText(fragment)
      if (piece.emojiCount > 0) hasEmoji = true
      pieces.push(piece.text)
    } else {
      pieces.push(fragment.textContent ?? '')
    }
  }
  if (!hasEmoji) return
  writeTokenTextToClipboard(event, pieces.join('\n'))
}

let renderedCopyInstalled = false

/** Document-level copy listener for rendered emoji. Idempotent; returns the uninstaller. */
export function installRenderedEmojiCopy(target: Document = document): () => void {
  if (renderedCopyInstalled) return () => {}
  renderedCopyInstalled = true
  target.addEventListener('copy', handleRenderedEmojiCopy)
  return () => {
    target.removeEventListener('copy', handleRenderedEmojiCopy)
    renderedCopyInstalled = false
  }
}
