import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { toInternalPath } from '@/utils/internalLinks'

/**
 * Addresses of Drive files on this instance:
 *   /drive/file/<file id>   in the app; opens for whoever may read the file (drive_file_card)
 *   /d/<token>              a link share; opens for anyone holding the token
 */

export type DriveLinkRef = { kind: 'file'; id: string } | { kind: 'token'; token: string }

const FILE_PATH = /^\/drive\/file\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i
/** drive_link_create tokens: base64url of 18 random bytes; the backend route accepts 16 to 64. */
const TOKEN_PATH = /^\/d\/([A-Za-z0-9_-]{16,64})\/?$/

/** The Drive link a path names, or null. Query and fragment are ignored. */
export function driveLinkFromPath(path: string): DriveLinkRef | null {
  const pathname = path.split(/[?#]/)[0]
  const file = FILE_PATH.exec(pathname)
  if (file) return { kind: 'file', id: file[1].toLowerCase() }
  const token = TOKEN_PATH.exec(pathname)
  if (token) return { kind: 'token', token: token[1] }
  return null
}

/** The Drive link of a URL on this instance, or null for any other host or path. */
export function driveLinkFromUrl(href: string): DriveLinkRef | null {
  const path = toInternalPath(href)
  return path ? driveLinkFromPath(path) : null
}

/** In-app path of a link. */
export function driveLinkPath(ref: DriveLinkRef): string {
  return ref.kind === 'file' ? `/drive/file/${ref.id}` : `/d/${ref.token}`
}

/** Shareable address of a file, on the instance's public origin. */
export function driveFileUrl(fileId: string, base: string = resolveHarmonyBaseUrl()): string {
  return `${base.replace(/\/+$/, '')}/drive/file/${fileId}`
}

/** Ids of this instance's /drive/file/ links in pasted text, in order, without repeats. */
export function driveFileIdsIn(text: string): string[] {
  const ids: string[] = []
  for (const match of text.matchAll(/https?:\/\/[^\s<>"'`]+/gi)) {
    const ref = driveLinkFromUrl(match[0].replace(/[).,;:!?\]]+$/, ''))
    if (ref?.kind === 'file' && !ids.includes(ref.id)) ids.push(ref.id)
  }
  return ids
}
