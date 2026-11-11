import { randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, open, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { supabase } from '../config/supabase.js'
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
 * expired: it is downloaded as is, and a 403, 404 or 410 there means it is gone.
 */
export function isDiscordLinkExpired(url: string, now = Date.now()): boolean {
  const expires = discordLinkExpiresAt(url)
  return expires !== null && expires.getTime() - now < MIN_LINK_LIFE_MS
}

/** Storage (or the proxy in front of it) refusing a body for its size: 413, or an HTML/JSON error saying so. */
function isStorageSizeRefusal(error: any): boolean {
  const status = Number(error?.status ?? error?.statusCode ?? error?.originalError?.status)
  if (status === 413) return true
  return /too large|exceed|payload|Unexpected token '</i.test(String(error?.message ?? ''))
}

export interface MirrorFileOptions {
  botId: string
  channelId: string
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

    const storagePath = `c/${opts.channelId.toLowerCase()}/bridge/${opts.botId}/${randomUUID()}.${extension}`
    const body = createReadStream(file)
    let uploadError: any = null
    try {
      const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).upload(storagePath, body, {
        contentType,
        upsert: false,
        cacheControl: '31536000',
        duplex: 'half',
      })
      uploadError = error
    } catch (error) {
      uploadError = error
    } finally {
      body.destroy()
    }
    if (uploadError) {
      if (isStorageSizeRefusal(uploadError)) throw new TooLargeError(size)
      throw new Error(`Storage upload failed: ${uploadError.message}`)
    }

    const signed = await signMessageMediaPaths([storagePath])
    return { path: storagePath, url: signed.get(storagePath) ?? referenceUrl(storagePath), contentType, bytes: size }
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}
