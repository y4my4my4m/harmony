import { renderChatMessageText } from './chatMessageTextRenderer'
import { escapeHtml, sanitizeMessageHtml } from './sanitize'

const URL_PATTERN = /\bhttps?:\/\/[^\s<]+[^\s<.,;:!?)\]'"]/g

/** Wraps bare http(s) URLs in text segments; tags and existing links are left alone. */
function linkify(html: string): string {
  let insideLink = 0
  let insideCode = 0
  return html
    .split(/(<[^>]+>)/)
    .map((part) => {
      if (part.startsWith('<')) {
        if (/^<a[\s>]/i.test(part)) insideLink++
        else if (/^<\/a>/i.test(part)) insideLink = Math.max(0, insideLink - 1)
        else if (/^<code[\s>]/i.test(part)) insideCode++
        else if (/^<\/code>/i.test(part)) insideCode = Math.max(0, insideCode - 1)
        return part
      }
      if (insideLink || insideCode) return part
      return part.replace(URL_PATTERN, (url) => `<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`)
    })
    .join('')
}

/**
 * Renders a server welcome message with the chat's markdown subset: bold, italic,
 * underline, strikethrough, inline and fenced code, blockquotes, and bare links.
 * Fenced code renders as a block-level <code>; the message allowlist has no <pre>.
 */
export function renderWelcomeMessage(text: string): string {
  if (!text) return ''
  const { renderedText, codeBlocks } = renderChatMessageText(text, {
    isNativePack: true,
    emojiServiceLoaded: false,
    resolveEmoji: (input) => ({ display: { type: 'native', content: input } }),
    isSingleEmoji: false,
    greentextEnabled: false,
  })
  let html = linkify(renderedText)
  for (const block of codeBlocks) {
    html = html.split(block.id).join(`<code class="md-code-block">${escapeHtml(block.code)}</code>`)
  }
  return sanitizeMessageHtml(html)
}
