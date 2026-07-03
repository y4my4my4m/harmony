import DOMPurify from 'dompurify'

const ALLOWED_TAGS = [
  'p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'del', 'pre', 'code',
  'blockquote', 'ul', 'ol', 'li', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
]
const ALLOWED_ATTR = ['href', 'rel', 'target', 'class', 'title']

export function renderAnnouncementHtml(content: string): string {
  const raw = content || ''
  const looksLikeHtml = /<[a-z][^>]*>/i.test(raw)
  const prepared = looksLikeHtml ? raw : raw.replace(/\r?\n/g, '<br>')
  return DOMPurify.sanitize(prepared, { ALLOWED_TAGS, ALLOWED_ATTR })
}
