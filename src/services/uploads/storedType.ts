import { mimeAllowed } from '@/utils/mimeMatch'

export const OCTET_STREAM = 'application/octet-stream'

/** message_media's and user_media's list as the migrations install it (20261025100004_storage_converge.sql). */
export const SERVED_TYPES: readonly string[] = [
  'image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp', 'image/avif',
  'image/apng', 'image/bmp', 'image/heic', 'image/heif', 'image/tiff',
  'video/*', 'audio/*',
  'application/pdf', 'text/plain',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.oasis.opendocument.text',
  'application/zip', 'application/x-zip-compressed',
  'application/vnd.rar', 'application/x-rar-compressed',
  'application/x-7z-compressed', 'application/gzip', 'application/x-tar',
  OCTET_STREAM,
]

/** Types a browser runs as a page or a script when they are served inline. */
const ACTIVE_TYPE = /^(text\/html|application\/xhtml\+xml|image\/svg\+xml|text\/xml|application\/xml|text\/xsl|text\/javascript|application\/(x-)?javascript|text\/ecmascript|application\/ecmascript)$/
const ACTIVE_NAME = /\.(svgz?|x?html?|xht|xml|xsl|m?js)$/i

/**
 * The Content-Type an attachment or Drive file is stored and served with: its own type when the
 * bucket's list (`allowed`, else SERVED_TYPES) holds it, otherwise application/octet-stream, which
 * storage serves as a download. Types and names a browser would run (HTML, SVG, XML, scripts) are
 * octet-stream whatever the list holds. Any file is accepted; only how it is served differs.
 */
export function storedTypeFor(type: string, name: string, allowed: readonly string[] | null): string {
  const base = type.split(';')[0].trim().toLowerCase()
  if (!base || ACTIVE_TYPE.test(base) || ACTIVE_NAME.test(name)) return OCTET_STREAM
  return mimeAllowed(allowed && allowed.length ? allowed : SERVED_TYPES, base) ? type : OCTET_STREAM
}
