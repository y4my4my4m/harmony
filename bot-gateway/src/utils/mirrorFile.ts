import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { request as httpRequest } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { supabaseServiceKey, supabaseUrl } from '../config/supabase.js'
import { MESSAGE_MEDIA_BUCKET, signMessageMediaPaths } from './messageMedia.js'
import { extensionFrom, isAllowedSourceUrl, isAnimatedPng, referenceUrl } from './mirrorExternalMedia.js'
import { stripMediaFileInPlace } from './stripMediaFile.js'
import { IMAGE_MAX_BYTES, stripMediaBytes } from './stripMetadata.js'

/** A link with less than this left is treated as expired: the download could not finish on it. */
const MIN_LINK_LIFE_MS = 10 * 60 * 1000

/** Enough of a PNG to find acTL ahead of the first IDAT. */
const APNG_PROBE_BYTES = 64 * 1024

const ISOBMFF_TYPES = new Set(['video/mp4', 'video/quicktime'])
const ISOBMFF_EXTENSIONS = new Set(['mp4', 'mov', 'm4v', '3gp'])

/** Thrown for every over-ceiling case: a known size, Content-Length, or a stream that ran past it. */
export class TooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`Attachment too large (${bytes} bytes)`)
    this.name = 'TooLargeError'
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
  opts: { contentType: string; cacheControl: string; size: number; bucket?: string },
): Promise<void> {
  const url = new URL(`${supabaseUrl.replace(/\/+$/, '')}/storage/v1/object/${opts.bucket ?? MESSAGE_MEDIA_BUCKET}/${objectPath}`)
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
  /** Required unless `target` is set. */
  botId?: string
  channelId?: string
  /**
   * Store in another bucket as `<folder>/<stem>-<ms>.<ext>` (the web app's naming for avatars and
   * banners) instead of the channel's room of message_media. `url` is then empty: the caller
   * builds the bucket's public URL from `path`.
   */
  target?: { bucket: string; folder: string; stem: string }
  fileName?: string
  contentType?: string
  /** Size Discord reported for the attachment, checked before any download. */
  knownSize?: number
  ceiling: number
  tmpDir?: string
  fetchImpl?: typeof fetch
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
 * (stripMetadata.ts). Never holds a video in memory. TooLargeError for anything over `ceiling`.
 */
export async function mirrorFileToStorage(
  sourceUrl: string,
  opts: MirrorFileOptions,
): Promise<{ path: string; url: string; contentType: string; bytes: number }> {
  if (!isAllowedSourceUrl(sourceUrl)) throw new Error('Refusing to mirror disallowed URL host')
  if (opts.knownSize !== undefined && opts.knownSize > opts.ceiling) throw new TooLargeError(opts.knownSize)

  const fetchImpl = opts.fetchImpl ?? ((...args: Parameters<typeof fetch>) => fetch(...args))
  const response = await fetchImpl(sourceUrl)
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
  // A redirect may only lead to another Discord host.
  if (response.url && !isAllowedSourceUrl(response.url)) {
    await response.body.cancel().catch(() => {})
    throw new Error('Download redirected off Discord')
  }

  let dir: string
  try {
    dir = await mkdtemp(join(opts.tmpDir ?? (process.env.BRIDGE_MIRROR_TMPDIR || tmpdir()), 'mirror-'))
  } catch (error) {
    await response.body.cancel().catch(() => {})
    throw error
  }
  try {
    const file = join(dir, 'download')
    await pipeline(Readable.fromWeb(response.body as any), byteLimit(opts.ceiling), createWriteStream(file))

    let contentType = opts.contentType || response.headers.get('content-type') || 'application/octet-stream'
    const declaredExtension = extensionFrom(opts.fileName, contentType, sourceUrl)
    let size = (await stat(file)).size

    if (contentType.startsWith('image/') && size <= IMAGE_MAX_BYTES) {
      // Location and camera metadata never reach storage from a bot (utils/stripMetadata.ts).
      const original = new Uint8Array(await readFile(file))
      const stripped = await stripMediaBytes(original)
      if (stripped !== original) {
        await writeFile(file, stripped)
        size = stripped.length
      }
    } else if (ISOBMFF_TYPES.has(contentType.split(';')[0].trim()) || ISOBMFF_EXTENSIONS.has(declaredExtension)) {
      await stripMediaFileInPlace(file)
    }

    // An APNG stored as .png is served as a static thumbnail: clients downscale .png only.
    const animatedPng = isAnimatedPng(await readHead(file, APNG_PROBE_BYTES))
    if (animatedPng) contentType = 'image/apng'
    const extension = animatedPng ? 'apng' : declaredExtension

    if (opts.target) {
      const { bucket, folder, stem } = opts.target
      const targetPath = `${folder}/${stem}-${Date.now()}.${extension}`
      await uploadFileToStorage(file, targetPath, { contentType, cacheControl: '31536000', size, bucket })
      return { path: targetPath, url: '', contentType, bytes: size }
    }

    if (!opts.botId || !opts.channelId) throw new Error('botId and channelId are required without a target')
    const storagePath = `c/${opts.channelId.toLowerCase()}/bridge/${opts.botId}/${randomUUID()}.${extension}`
    try {
      await uploadFileToStorage(file, storagePath, { contentType, cacheControl: '31536000', size })
    } catch (error) {
      // The bucket allows only some types (markdown, HTML, fonts, RAW photos… are refused).
      // Store the file as a plain download instead; the part keeps its name and original type.
      if (!(error instanceof UnsupportedTypeError) || contentType === FALLBACK_CONTENT_TYPE) throw error
      contentType = FALLBACK_CONTENT_TYPE
      await uploadFileToStorage(file, storagePath, { contentType, cacheControl: '31536000', size })
    }

    const signed = await signMessageMediaPaths([storagePath])
    return { path: storagePath, url: signed.get(storagePath) ?? referenceUrl(storagePath), contentType, bytes: size }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
