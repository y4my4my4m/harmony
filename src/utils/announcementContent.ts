import DOMPurify from 'dompurify'
import { createShortcodeRegex } from '@/services/emojiShortcodeResolver'
import { isLocalStorageUrl } from '@/utils/storageImageUtils'

const ALLOWED_TAGS = [
  'p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'del', 'pre', 'code',
  'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'img',
]
const ALLOWED_ATTR = ['href', 'rel', 'target', 'class', 'title', 'src', 'alt']

/** This instance's custom emoji: name to image URL. */
export type EmojiUrls = ReadonlyMap<string, string>

function isHttpsUrl(value: string | null): boolean {
  if (!value) return false
  try {
    return new URL(value).protocol === 'https:'
  } catch {
    return false
  }
}

/** An emoji image from this instance's storage, or any https address. */
function isEmojiImageUrl(url: string): boolean {
  return isHttpsUrl(url) || isLocalStorageUrl(url)
}

/** Replaces :name: in text outside code and pre with the emoji of that name. */
function addEmoji(root: DocumentFragment, emojis: EmojiUrls): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT)
  const texts: Text[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) texts.push(node as Text)

  for (const text of texts) {
    if (text.parentElement?.closest('code, pre')) continue
    const value = text.data
    const pattern = createShortcodeRegex()
    const parts: Node[] = []
    let last = 0
    for (let match = pattern.exec(value); match; match = pattern.exec(value)) {
      const url = emojis.get(match[1])
      if (!url || !isEmojiImageUrl(url)) {
        // The closing colon may open the next shortcode (":not:smile:").
        pattern.lastIndex = match.index + match[0].length - 1
        continue
      }
      parts.push(document.createTextNode(value.slice(last, match.index)))
      const img = document.createElement('img')
      img.className = 'inline-emoji'
      img.setAttribute('src', url)
      img.setAttribute('alt', match[0])
      img.setAttribute('title', match[0])
      parts.push(img)
      last = match.index + match[0].length
    }
    if (!parts.length) continue
    parts.push(document.createTextNode(value.slice(last)))
    text.replaceWith(...parts)
  }
}

/**
 * Announcement HTML for v-html: sanitized, an img kept only with an https src, and :name:
 * shortcodes shown as the instance's custom emoji of that name.
 */
export function renderAnnouncementHtml(content: string, emojis?: EmojiUrls): string {
  const raw = content || ''
  const looksLikeHtml = /<[a-z][^>]*>/i.test(raw)
  const prepared = looksLikeHtml ? raw : raw.replace(/\r?\n/g, '<br>')
  const fragment = DOMPurify.sanitize(prepared, { ALLOWED_TAGS, ALLOWED_ATTR, RETURN_DOM_FRAGMENT: true })
  for (const img of [...fragment.querySelectorAll('img')]) {
    if (!isHttpsUrl(img.getAttribute('src'))) img.remove()
  }
  if (emojis?.size) addEmoji(fragment, emojis)
  const out = document.createElement('div')
  out.append(fragment)
  return out.innerHTML
}
