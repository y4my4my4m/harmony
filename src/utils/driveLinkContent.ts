import { driveLinkFromUrl, type DriveLinkRef } from '@/services/drive/driveLinks'

/** Message or post content part, as far as these helpers read it. */
type PartLike = { type?: unknown; url?: unknown; text?: unknown; preview?: unknown } | null | undefined

const URL_IN_TEXT = /https?:\/\/[^\s<>"'`]+/gi
const TRAILING_PUNCTUATION = /[).,;:!?\]]+$/

function linkKey(ref: DriveLinkRef): string {
  return ref.kind === 'file' ? `file:${ref.id}` : `token:${ref.token}`
}

/** Drive links of this instance in pasted text, /drive/file/<id> and /d/<token>, in order, without repeats. */
export function driveLinksIn(text: string): DriveLinkRef[] {
  const refs: DriveLinkRef[] = []
  const seen = new Set<string>()
  for (const match of text.matchAll(URL_IN_TEXT)) {
    const ref = driveLinkFromUrl(match[0].replace(TRAILING_PUNCTUATION, ''))
    if (!ref || seen.has(linkKey(ref))) continue
    seen.add(linkKey(ref))
    refs.push(ref)
  }
  return refs
}

function previewed(part: PartLike): boolean {
  return part?.preview !== false && part?.preview !== 'false'
}

/** A url part of a Drive link of this instance whose preview is on. */
export function isDriveLinkPart(part: PartLike): part is { type: 'url'; url: string } {
  return part?.type === 'url' && typeof part.url === 'string' && previewed(part) && !!driveLinkFromUrl(part.url)
}

/**
 * The Drive link part that is the whole of `parts`: one previewed url part, with nothing beside
 * it but whitespace. Its text is not shown; the file renders in its place, as Discord drops an
 * image URL that is the whole message.
 */
export function soleDriveLinkPart<T>(parts: readonly T[] | null | undefined): T | null {
  if (!Array.isArray(parts)) return null
  let link: T | null = null
  for (const part of parts) {
    const p = part as PartLike
    if (p?.type === 'text' && !String(p.text ?? '').trim()) continue
    if (link !== null || !isDriveLinkPart(p)) return null
    link = part
  }
  return link
}

/** `parts` without the Drive link that is all of them. */
export function withoutSoleDriveLink<T>(parts: T): T {
  if (!Array.isArray(parts)) return parts
  const sole = soleDriveLinkPart(parts)
  return (sole ? parts.filter((part) => part !== sole) : parts) as T
}

/** URLs of the previewed Drive links among `parts`, in order, without repeats. */
export function driveLinkUrlsIn(parts: unknown): string[] {
  if (!Array.isArray(parts)) return []
  const urls: string[] = []
  for (const part of parts as PartLike[]) {
    if (isDriveLinkPart(part) && !urls.includes(part.url)) urls.push(part.url)
  }
  return urls
}
