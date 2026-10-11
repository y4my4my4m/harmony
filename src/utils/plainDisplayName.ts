/**
 * A display name as plain text for accessible names and headings: custom emoji
 * shortcodes (":blobcat:", ":blob@remote.example:", zero-width-space wrapped as
 * Misskey sends them) are dropped and whitespace is collapsed. Falls back to
 * `fallback` (the username) when nothing is left.
 */
const SHORTCODE = /\u200b?:[A-Za-z0-9_]+(?:@[A-Za-z0-9._-]*)?:\u200b?/g

export function plainDisplayName(name: unknown, fallback = ''): string {
  let text = ''
  if (typeof name === 'string') text = name
  else if (Array.isArray(name)) {
    text = name.map((part: any) => (typeof part === 'string' ? part : part?.text || part?.content || '')).join('')
  }
  const plain = text.replace(SHORTCODE, ' ').replace(/\s+/g, ' ').trim()
  return plain || fallback
}
