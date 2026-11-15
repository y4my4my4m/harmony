import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { supabase, supabaseServiceKey, supabaseUrl } from '../config/supabase.js'
import { MESSAGE_MEDIA_BUCKET, signMessageMediaPaths } from './messageMedia.js'
import { extensionFrom, isAllowedSourceUrl, isAnimatedPng, mirrorAllows, referenceUrl } from './mirrorExternalMedia.js'
import { sniffContainer, stripMediaFileInPlace, type SniffedContainer } from './stripMediaFile.js'
import { IMAGE_MAX_BYTES, stripMediaBytes } from './stripMetadata.js'

/** A link with less than this left is treated as expired: the download could not finish on it. */
const MIN_LINK_LIFE_MS = 10 * 60 * 1000

/** Leading bytes sniffContainer decides on. */
const SNIFF_BYTES = 16

/** Enough of a PNG to find acTL ahead of the first IDAT. */
const APNG_PROBE_BYTES = 64 * 1024

/** Redirects followed from the source URL. */
const MAX_REDIRECTS = 3

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])

/** Thrown for every over-ceiling case: a known size, Content-Length, or a stream that ran past it. */
export class TooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Attachment too large (${bytes} bytes)`)
    this.name = 'TooLargeError'
  }
}

/** The server's cap on mirrored files (bridge_mirror_allows) has no room for `bytes` more. */
export class OverQuotaError extends Error {
  constructor(readonly bytes: number) {
    super(`Server mirror limit reached (${bytes} bytes refused)`)
    this.name = 'OverQuotaError'
  }
}

/** Discord answered 403, 404 or 410: the attachment is deleted or its link no longer works. */
export class GoneError extends Error {
  constructor(status: number) {
    super(`Attachment gone (${status})`)
    this.name = 'GoneError'
  }
}

/** When a Discord CDN link stops working: its `ex` parameter, hex Unix seconds. */
export function discordLinkExpiresAt(url: string): Date | null {
  let ex: string | null
  try {
    ex = new URL(url).searchParams.get('ex')
  } catch {
    return null
  }
  if (!ex || !/^[0-9a-f]{1,12}$/i.test(ex)) return null
  return new Date(parseInt(ex, 16) * 1000)
}

/**
 * Already past, or under 10 minutes left. A link without `ex` (unsigned CDN links) is not
 * expired here; see needsDiscordResign for unsigned attachment links.
 */
export function isDiscordLinkExpired(url: string, now = Date.now()): boolean {
  const expires = discordLinkExpiresAt(url)
  return expires !== null && expires.getTime() - now < MIN_LINK_LIFE_MS
}

/**
 * A link the bridge must re-sign before it can be downloaded: expired, or an attachment link
 * with no signature at all. Discord answers 404 ("This content is no longer available") to
 * unsigned attachment links even when the file still exists, so downloading one as is would
 * report a live file as gone. Proxied links (images-ext-*, external/) can't be re-signed.
 */
export function needsDiscordResign(url: string, now = Date.now()): boolean {
  if (isDiscordLinkExpired(url, now)) return true
  if (discordLinkExpiresAt(url) !== null) return false
  try {
    const u = new URL(url)
    return (
      /(^|\.)discordapp\.(com|net)$/i.test(u.hostname) &&
      /^\/(ephemeral-)?attachments\//.test(u.pathname)
    )
  } catch {
    return false
  }
}

/** Storage refused the object's content type (the bucket's allowed_mime_types). */
export class UnsupportedTypeError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnsupportedTypeError'
  }
}

/** The type message_media accepts for any file: served as a download, never rendered. */
const FALLBACK_CONTENT_TYPE = 'application/octet-stream'

/** The rasters sniffContainer names: the type each is stored as and the extensions that type goes by. */
const RASTERS: Record<Exclude<SniffedContainer, 'isobmff'>, { contentType: string; extensions: string[] }> = {
  jpeg: { contentType: 'image/jpeg', extensions: ['jpg', 'jpeg', 'jpe', 'jfif'] },
  png: { contentType: 'image/png', extensions: ['png'] },
  webp: { contentType: 'image/webp', extensions: ['webp'] },
  gif: { contentType: 'image/gif', extensions: ['gif'] },
}
const RASTER_CONTENT_TYPES = new Set(['image/jpeg', 'image/jpg', 'image/pjpeg', 'image/png', 'image/apng', 'image/gif', 'image/webp'])
const RASTER_EXTENSIONS = new Set(['jpg', 'jpeg', 'jpe', 'jfif', 'png', 'apng', 'gif', 'webp'])

/**
 * The content type and extension a file is stored under, from its sniffed container. A raster
 * takes its own type, and its own extension unless the declared one already names that type. A
 * declared raster type or extension on any other bytes becomes application/octet-stream and
 * `bin`. Everything else keeps what was declared: sniffContainer tells no video, audio or
 * document types apart.
 */
export function storedTypeOf(
  sniffed: SniffedContainer | null,
  declaredType: string,
  declaredExtension: string,
): { contentType: string; extension: string } {
  if (sniffed && sniffed !== 'isobmff') {
    const { contentType, extensions } = RASTERS[sniffed]
    return { contentType, extension: extensions.includes(declaredExtension) ? declaredExtension : extensions[0] }
  }
  return {
    contentType: RASTER_CONTENT_TYPES.has(declaredType.split(';')[0].trim().toLowerCase()) ? FALLBACK_CONTENT_TYPE : declaredType,
    extension: RASTER_EXTENSIONS.has(declaredExtension) ? 'bin' : declaredExtension,
  }
}

/**
 * Storage (or the proxy in front of it) refusing a body for its size: 413, or a JSON error
 * saying so. An HTML page only counts on a 413; a 502 or 504 page is a plain failure.
 */
function isStorageSizeRefusal(status: number, text: string): boolean {
  if (status === 413) return true
  if (/^\s*</.test(text)) return false
  return /too large|exceed|payload/i.test(text)
}

/** No request or response data for this long aborts a storage upload. */
const UPLOAD_IDLE_MS = 120_000

/**
 * POSTs a file to Storage's object endpoint over node:http(s), streaming it from disk with a
 * Content-Length. fetch (undici) reads a stream body ahead of the socket and keeps it in memory,
 * so a large file would raise RSS by about its size; this keeps memory flat.
 */
export async function uploadFileToStorage(
  filePath: string,
  objectPath: string,
  opts: { contentType: string; cacheControl: string; size: number },
): Promise<void> {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${MESSAGE_MEDIA_BUCKET}/${objectPath}`)
  const send = url.protocol === 'https:' ? httpsRequest : httpRequest
  const source = createReadStream(filePath)
  let req: ReturnType<typeof send> | undefined
  let status = 0
  try {
    const text = await new Promise<string>((resolve, reject) => {
      req = send(url, {
        method: 'POST',
        timeout: UPLOAD_IDLE_MS,
        headers: {
          authorization: `Bearer ${supabaseServiceKey}`,
          apikey: supabaseServiceKey,
          'x-upsert': 'false',
          'content-type': opts.contentType,
          'cache-control': `max-age=${opts.cacheControl}`,
          'content-length': String(opts.size),
        },
      })
      req.on('timeout', () => req!.destroy(new Error('upload timed out')))
      req.on('response', (res) => {
        status = res.statusCode ?? 0
        const chunks: Buffer[] = []
        let length = 0
        res.on('data', (chunk: Buffer) => {
          if (length < 4096) chunks.push(chunk)
          length += chunk.length
        })
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8').slice(0, 4096)))
        res.on('error', reject)
      })
      req.on('error', reject)
      pipeline(source, req).catch(reject)
    })
    if (status >= 200 && status < 300) return
    if (isStorageSizeRefusal(status, text)) throw new TooLargeError(opts.size)
    const message = `Storage upload failed: ${status} ${text.slice(0, 200)}`
    if (/invalid_mime_type|InvalidMimeType/.test(text)) throw new UnsupportedTypeError(message)
    throw new Error(message)
  } catch (error) {
    if (error instanceof TooLargeError || error instanceof UnsupportedTypeError) throw error
    if (status === 413) throw new TooLargeError(opts.size)
    if (status) throw error
    throw new Error(`Storage upload failed: ${(error as Error).message}`)
  } finally {
    source.destroy()
    req?.destroy()
  }
}

export interface MirrorFileOptions {
  botId: string
  channelId: string
  fileName?: string
  contentType?: string
  /** Size Discord reported for the attachment, checked before any download. */
  knownSize?: number
  ceiling: number
  /** The server's cap has room for `bytes` more. Default: mirrorAllows for the channel. */
  allows?: (bytes: number) => Promise<boolean>
  tmpDir?: string
  fetchImpl?: typeof fetch
}

/**
 * GETs `sourceUrl` with redirects followed by hand, up to MAX_REDIRECTS: each Location is
 * resolved and checked against the source allowlist before it is requested, so no request
 * leaves the allowed hosts. Returns the first response that is not a redirect.
 */
async function fetchFromAllowedHosts(fetchImpl: typeof fetch, sourceUrl: string): Promise<Response> {
  let url = sourceUrl
  for (let hop = 0; ; hop++) {
    const response = await fetchImpl(url, { redirect: 'manual' })
    // undici answers redirect: 'manual' with the 3xx itself; an opaqueredirect carries no Location.
    if (!REDIRECT_STATUSES.has(response.status) && response.type !== 'opaqueredirect') return response
    await response.body?.cancel().catch(() => {})
    const location = response.headers.get('location')
    if (!location) throw new Error(`Download redirected without a Location (${response.status})`)
    let next: string
    try {
      next = new URL(location, url).href
    } catch {
      throw new Error('Download redirected to an invalid URL')
    }
    if (!isAllowedSourceUrl(next)) throw new Error('Download redirected off Discord')
    if (hop >= MAX_REDIRECTS) throw new Error('Download redirected too many times')
    url = next
  }
}

/**
 * Removes an object this process uploaded and nothing references yet. Best effort: the
 * federation backend's message_media sweep removes an unreferenced object after a day.
 */
async function removeStored(storagePath: string): Promise<void> {
  try {
    const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).remove([storagePath])
    if (error) console.warn(`Removing ${storagePath} failed: ${error.message}`)
  } catch (error: any) {
    console.warn(`Removing ${storagePath} failed: ${error?.message || error}`)
  }
}

/** Passes bytes through, failing with TooLargeError once more than `ceiling` have gone by. */
function byteLimit(ceiling: number): Transform {
  let seen = 0
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      seen += chunk.length
      if (seen > ceiling) callback(new TooLargeError(seen))
      else callback(null, chunk)
    },
  })
}

async function readHead(file: string, length: number): Promise<Buffer> {
  const handle = await open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, 0)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

/**
 * Streams a Discord CDN attachment through a temp file into the channel's room of message_media
 * as c/<channel id>/bridge/<bot id>/<uuid>.<ext>, without its location and camera metadata
 * (stripMetadata.ts). The strip and the stored type follow the file's leading bytes
 * (sniffContainer), not the declared type or name. Never holds a video in memory. TooLargeError
 * for anything over `ceiling`; OverQuotaError when the server's cap refuses the file, asked with
 * the known size before the download, with Content-Length before the body, and with the stored
 * size before the upload whenever that is the largest so far.
 */
export async function mirrorFileToStorage(
  sourceUrl: string,
  opts: MirrorFileOptions,
): Promise<{ path: string; url: string; contentType: string; bytes: number }> {
  if (!isAllowedSourceUrl(sourceUrl)) throw new Error('Refusing to mirror disallowed URL host')
  if (opts.knownSize !== undefined && opts.knownSize > opts.ceiling) throw new TooLargeError(opts.knownSize)

  const allows = opts.allows ?? ((bytes: number) => mirrorAllows(opts.channelId, bytes))
  let admitted = -1
  // bridge_mirror_allows takes a bigint: whole bytes, never negative.
  const admit = async (size: number) => {
    const bytes = Math.max(0, Math.ceil(size))
    if (bytes <= admitted) return
    if (!(await allows(bytes))) throw new OverQuotaError(bytes)
    admitted = bytes
  }
  if (opts.knownSize !== undefined && Number.isFinite(opts.knownSize)) await admit(opts.knownSize)

  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const response = await fetchFromAllowedHosts(fetchImpl, sourceUrl)
  if (!response.ok) {
    await response.body?.cancel().catch(() => {})
    if ([403, 404, 410].includes(response.status)) throw new GoneError(response.status)
    throw new Error(`Download failed (${response.status})`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > opts.ceiling) {
    await response.body?.cancel().catch(() => {})
    throw new TooLargeError(declared)
  }
  if (!response.body) throw new Error('Download had no body')
  // Redirects are followed by hand; a response naming any other host as its own is refused too.
  if (response.url && !isAllowedSourceUrl(response.url)) {
    await response.body.cancel().catch(() => {})
    throw new Error('Download redirected off Discord')
  }

  let dir: string
  try {
    if (Number.isFinite(declared) && declared > 0) await admit(declared)
    dir = await mkdtemp(join(opts.tmpDir ?? (process.env.BRIDGE_MIRROR_TMPDIR || tmpdir()), 'mirror-'))
  } catch (error) {
    await response.body.cancel().catch(() => {})
    throw error
  }
  try {
    const file = join(dir, 'download')
    await pipeline(Readable.fromWeb(response.body as any), byteLimit(opts.ceiling), createWriteStream(file))

    let size = (await stat(file)).size
    const sniffed = sniffContainer(await readHead(file, SNIFF_BYTES))

    // Location and camera metadata never reach storage from a bot (utils/stripMetadata.ts).
    if (sniffed === 'isobmff') {
      // MP4, MOV, 3GP, HEIF, AVIF: patched on disk, the file is never read whole.
      await stripMediaFileInPlace(file)
    } else if (sniffed && size <= IMAGE_MAX_BYTES) {
      const original = new Uint8Array(await readFile(file))
      const stripped = await stripMediaBytes(original)
      if (stripped !== original) {
        await writeFile(file, stripped)
        size = stripped.length
      }
    }

    const declaredType = opts.contentType || response.headers.get('content-type') || FALLBACK_CONTENT_TYPE
    const stored = storedTypeOf(sniffed, declaredType, extensionFrom(opts.fileName, declaredType, sourceUrl))
    // An APNG stored as .png is served as a static thumbnail: clients downscale .png only.
    const animatedPng = sniffed === 'png' && isAnimatedPng(await readHead(file, APNG_PROBE_BYTES))
    let contentType = animatedPng ? 'image/apng' : stored.contentType
    const extension = animatedPng ? 'apng' : stored.extension

    await admit(size)

    const storagePath = `c/${opts.channelId.toLowerCase()}/bridge/${opts.botId}/${randomUUID()}.${extension}`
    try {
      try {
        await uploadFileToStorage(file, storagePath, { contentType, cacheControl: '31536000', size })
      } catch (error) {
        // The bucket allows only some types (markdown, HTML, fonts, RAW photos… are refused).
        // Store the file as a plain download instead; the part keeps its name and original type.
        if (!(error instanceof UnsupportedTypeError) || contentType === FALLBACK_CONTENT_TYPE) throw error
        contentType = FALLBACK_CONTENT_TYPE
        await uploadFileToStorage(file, storagePath, { contentType, cacheControl: '31536000', size })
      }
    } catch (error) {
      // A size or type refusal stored nothing. Any other failure (timeout, reset, 5xx) may
      // follow a stored object.
      if (!(error instanceof TooLargeError || error instanceof UnsupportedTypeError)) await removeStored(storagePath)
      throw error
    }

    // The signed url serves clients before 1.6.6; without one the part carries the reference.
    let url: string | undefined
    try {
      url = (await signMessageMediaPaths([storagePath])).get(storagePath)
    } catch (error: any) {
      console.warn(`Signing ${storagePath} failed: ${error?.message || error}`)
    }
    return { path: storagePath, url: url ?? referenceUrl(storagePath), contentType, bytes: size }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
