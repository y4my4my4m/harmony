// Discord's attachment convention: a file named SPOILER_* is shown covered.
export const SPOILER_PREFIX = 'SPOILER_'

export function isSpoilerFileName(name: string | null | undefined): boolean {
  return !!name && name.toUpperCase().startsWith(SPOILER_PREFIX)
}

export function toggleSpoilerFileName(name: string): string {
  return isSpoilerFileName(name) ? name.slice(SPOILER_PREFIX.length) : SPOILER_PREFIX + name
}

const SPOILER_TEXT = /\|\|(?=\S)([\s\S]*?\S)\|\|/g

/** Plain-text previews (notifications, reply bars): a spoiler becomes a bar of its length, at most 12. */
export function maskSpoilers(text: string): string {
  return text.replace(SPOILER_TEXT, (_m, inner: string) => '▒'.repeat(Math.min(Math.max(inner.length, 3), 12)))
}
