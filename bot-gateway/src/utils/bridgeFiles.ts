import { createHash } from 'node:crypto'
import { supabase } from '../config/supabase.js'
import { BOT_MEDIA_URL_TTL_SECONDS, MESSAGE_MEDIA_BUCKET, isRoomMediaPath, publicStorageUrl } from './messageMedia.js'
import { stripMediaBytes } from './stripMetadata.js'
import { isAnimatedPng } from './mirrorExternalMedia.js'

export const MAX_BRIDGE_FILE_BYTES = 50 * 1024 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const IMAGE_EXT: Record<string, string> = { 'image/png': 'png', 'image/apng': 'apng', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp', 'image/avif': 'avif', 'image/bmp': 'bmp', 'image/heic': 'heic', 'image/heif': 'heif', 'image/tiff': 'tiff' }
const FILE_MIMES = new Set(['application/octet-stream', 'text/plain', 'application/json', 'application/x-ndjson', 'text/csv', 'application/csv', 'text/tab-separated-values', 'text/markdown', 'application/rtf', 'text/rtf', 'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'application/vnd.oasis.opendocument.spreadsheet', 'application/vnd.ms-powerpoint', 'application/vnd.openxmlformats-officedocument.presentationml.presentation', 'application/vnd.oasis.opendocument.presentation', 'application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text', 'application/zip', 'application/x-zip-compressed', 'application/vnd.rar', 'application/x-rar-compressed', 'application/x-7z-compressed', 'application/gzip', 'application/x-tar'])
const ACTIVE_EXT = /\.(?:svgz?|html?|xhtml|js|mjs|cjs|hta|swf|wasm|exe|com|scr|msi|bat|cmd|ps1|vbs|wsf|sh|php|jar|lnk|desktop)$/i
const ENCRYPTION_KEYS = ['encrypted', 'encryption', 'encryption_metadata', 'key', 'iv', 'hashes', 'ciphertext', 'algorithm', 'encryptedFile', 'encrypted_file']

export class BridgeFileError extends Error {
  constructor(public readonly status: number, message: string) { super(message) }
}
export interface BridgeFilePart {
  type: 'file'; path: string; url: string; fileType: 'image' | 'file'; fileName: string; fileSize: number; mimeType: string
}
type Limits = { max: number; allowed: string[] | null }

export function fileName(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 255 || value === '.' || value === '..'
    || /[\x00-\x1f\x7f/\\]/.test(value) || ACTIVE_EXT.test(value.trim())) {
    throw new BridgeFileError(415, 'Unsupported attachment name')
  }
  return value
}
export function decodedFileName(header: unknown): string {
  if (typeof header !== 'string' || header.length > 2048) throw new BridgeFileError(400, 'Expected an encoded X-File-Name')
  try { return fileName(decodeURIComponent(header)) } catch (error) {
    if (error instanceof BridgeFileError) throw error
    throw new BridgeFileError(400, 'Invalid encoded X-File-Name')
  }
}
function mime(value: unknown): string {
  if (typeof value !== 'string' || value.length > 255) throw new BridgeFileError(415, 'Unsupported attachment MIME type')
  const type = value.split(';')[0].trim().toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
  if (!(type in IMAGE_EXT) && !FILE_MIMES.has(type) && !/^(?:audio|video)\/[a-z0-9.+-]+$/.test(type)) throw new BridgeFileError(415, 'Unsupported attachment MIME type')
  return type
}
async function limits(): Promise<Limits> {
  try {
    const { data, error } = await supabase.storage.getBucket(MESSAGE_MEDIA_BUCKET)
    if (error || !data || data.public !== false || (data.file_size_limit != null && (!Number.isSafeInteger(data.file_size_limit) || data.file_size_limit < 0))
      || (data.allowed_mime_types != null && (!Array.isArray(data.allowed_mime_types) || data.allowed_mime_types.some((type: unknown) => typeof type !== 'string')))) throw new Error()
    return { max: typeof data.file_size_limit === 'number' ? Math.min(MAX_BRIDGE_FILE_BYTES, data.file_size_limit) : MAX_BRIDGE_FILE_BYTES, allowed: data.allowed_mime_types ?? null }
  } catch { throw new BridgeFileError(503, 'Private attachment storage policy unavailable') }
}
function allowed(policy: Limits, type: string, size: number): void {
  if (size > policy.max) throw new BridgeFileError(413, 'Attachment exceeds the storage size limit')
  if (policy.allowed && !policy.allowed.some(value => {
    const rule = value.toLowerCase().replace(/^image\/jpg$/, 'image/jpeg')
    return rule === type || rule === '*/*' || (rule.endsWith('/*') && type.startsWith(rule.slice(0, -1)))
  })) throw new BridgeFileError(415, 'Attachment MIME type is not allowed by storage policy')
}
function rasterMatches(bytes: Buffer, type: string): boolean {
  const png = bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
  if (type === 'image/png') return png
  if (type === 'image/apng') return png && isAnimatedPng(bytes)
  if (type === 'image/jpeg') return bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255
  if (type === 'image/gif') return ['GIF87a', 'GIF89a'].includes(bytes.subarray(0, 6).toString('ascii'))
  if (type === 'image/webp') return bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'
  if (type === 'image/bmp') return bytes.length >= 14 && bytes.toString('ascii', 0, 2) === 'BM'
  if (type === 'image/tiff') return bytes.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) || bytes.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42]))
  if (bytes.length < 16 || bytes.toString('ascii', 4, 8) !== 'ftyp') return false
  const brands: string[] = []
  const end = Math.min(bytes.readUInt32BE(0), bytes.length, 4096)
  for (let i = 8; i + 4 <= end; i += 4) if (i !== 12) brands.push(bytes.toString('ascii', i, i + 4))
  const accepted = type === 'image/avif' ? ['avif', 'avis'] : type === 'image/heic' ? ['heic', 'heix', 'hevc', 'hevx'] : ['mif1', 'msf1', 'heic', 'heix', 'hevc', 'hevx']
  return accepted.some(brand => brands.includes(brand))
}
function validateBytes(bytes: Buffer, type: string): void {
  if (type.startsWith('image/')) {
    if (!rasterMatches(bytes, type)) throw new BridgeFileError(415, 'Image bytes do not match the attachment MIME type')
    return
  }
  const prefix = bytes.subarray(0, 8192).toString('utf8')
  if (/<(?:!doctype\s+html|html\b|head\b|body\b|script\b|svg\b|iframe\b|object\b|embed\b)/i.test(prefix)
    || bytes.subarray(0, 2).toString('ascii') === 'MZ' || bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) || /^\s*#!/.test(prefix)) {
    throw new BridgeFileError(415, 'Active attachment content is not supported')
  }
  if (type === 'application/pdf' && bytes.toString('ascii', 0, 5) !== '%PDF-') throw new BridgeFileError(415, 'File bytes do not match the attachment MIME type')
}
function safePath(path: unknown, channelId: string): path is string {
  return UUID.test(channelId) && isRoomMediaPath(path, `c/${channelId.toLowerCase()}`)
    && path.length <= 1024 && /^[a-zA-Z0-9_./-]+$/.test(path)
}
export function isDriveFilePath(path: unknown): path is string {
  if (typeof path !== 'string') return false
  const pieces = path.split('/')
  return pieces.length === 3 && pieces[0] === 'u' && UUID.test(pieces[1]) && /^[A-Za-z0-9_.-]{1,255}$/.test(pieces[2]) && pieces[2] !== '.' && pieces[2] !== '..'
}
export function isEncryptedDescriptor(part: any): boolean {
  return !!part && typeof part === 'object' && ENCRYPTION_KEYS.some(key => Object.prototype.hasOwnProperty.call(part, key))
}
function ownUploadPath(path: unknown, botId: string, channelId: string): path is string {
  return UUID.test(botId) && safePath(path, channelId) && path.startsWith(`c/${channelId.toLowerCase()}/bridge/${botId}/`)
    && /^[a-f0-9]{64}\.[a-z0-9]{1,8}$/.test(path.split('/').at(-1)!) && path.split('/').length === 5
}
function address(bytes: Buffer, meta: Omit<BridgeFilePart, 'path' | 'url'>): string {
  return createHash('sha256').update(JSON.stringify([meta.fileName, meta.mimeType, meta.fileType, meta.fileSize])).update('\0').update(bytes).digest('hex')
}
async function signed(path: string, ttl: number): Promise<string> {
  try {
    const { data, error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).createSignedUrl(path, ttl)
    if (error || typeof data?.signedUrl !== 'string') throw new Error()
    const url = new URL(data.signedUrl)
    const bases = [process.env.SUPABASE_URL, process.env.PUBLIC_URL].filter((base): base is string => !!base)
    const own = bases.some(base => {
      const parsed = new URL(base)
      const prefix = `${parsed.pathname.replace(/\/$/, '')}/storage/v1/object/sign/${MESSAGE_MEDIA_BUCKET}/`
      return url.origin === parsed.origin && url.pathname.startsWith(prefix) && decodeURIComponent(url.pathname.slice(prefix.length)) === path
    })
    if (!own || url.username || url.password || url.hash || !['http:', 'https:'].includes(url.protocol)) throw new Error()
    return data.signedUrl
  } catch { throw new BridgeFileError(503, 'Private attachment URL unavailable') }
}
/** Never fetch a message's url. Sign its validated room-local object ourselves. */
async function storedBytes(path: string, max: number): Promise<{ bytes: Buffer; mimeType: string }> {
  try {
    const url = await signed(path, 60)
    const response = await fetch(url, { redirect: 'error', signal: AbortSignal.timeout(15_000) })
    if (!response.ok || !response.body) {
      await response.body?.cancel().catch(() => {})
      throw new BridgeFileError(503, 'Private attachment bytes unavailable')
    }
    const length = response.headers.get('content-length')
    if (length != null && (!/^\d+$/.test(length) || Number(length) > max)) {
      await response.body.cancel()
      throw new BridgeFileError(413, 'Attachment exceeds the storage size limit')
    }
    const reader = response.body.getReader(), chunks: Buffer[] = []
    let size = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > max) throw new BridgeFileError(413, 'Attachment exceeds the storage size limit')
        chunks.push(Buffer.from(value))
      }
    } finally { await reader.cancel().catch(() => {}) }
    return { bytes: Buffer.concat(chunks), mimeType: mime(response.headers.get('content-type')) }
  } catch (error) {
    if (error instanceof BridgeFileError) throw error
    throw new BridgeFileError(503, 'Private attachment bytes unavailable')
  }
}
export async function storeBridgeFile(bytes: Buffer, name: string, declaredType: unknown, botId: string, channelId: string): Promise<BridgeFilePart> {
  if (!UUID.test(botId) || !UUID.test(channelId)) throw new BridgeFileError(400, 'Invalid attachment scope')
  let mimeType = mime(declaredType)
  const file = fileName(name), policy = await limits()
  allowed(policy, mimeType, bytes.length)
  validateBytes(bytes, mimeType)
  if (mimeType === 'image/png' && isAnimatedPng(bytes)) mimeType = 'image/apng'
  const clean = Buffer.from(await stripMediaBytes(bytes))
  allowed(policy, mimeType, clean.length)
  validateBytes(clean, mimeType)
  const meta = { type: 'file' as const, fileName: file, mimeType, fileType: mimeType.startsWith('image/') ? 'image' as const : 'file' as const, fileSize: clean.length }
  const extension = IMAGE_EXT[mimeType] ?? (/\.([a-z0-9]{1,8})$/i.exec(file)?.[1].toLowerCase() || 'bin')
  const path = `c/${channelId.toLowerCase()}/bridge/${botId}/${address(clean, meta)}.${extension}`
  try {
    const { error } = await supabase.storage.from(MESSAGE_MEDIA_BUCKET).upload(path, clean, { contentType: mimeType, upsert: true, cacheControl: '31536000', metadata: { bridgeFile: meta } })
    if (error) throw new Error()
  } catch { throw new BridgeFileError(503, 'Private attachment storage unavailable') }
  return { ...meta, path, url: publicStorageUrl(await signed(path, BOT_MEDIA_URL_TTL_SECONDS)) }
}
/** Only Matrix create accepts paths, and only exact canonical uploads in this bot/channel. */
export async function canonicalBridgeFileParts(parts: any[], botId: string, channelId: string): Promise<any[]> {
  const uploads = parts.filter(part => part && typeof part === 'object' && 'path' in part)
  if (uploads.length > 20) throw new BridgeFileError(413, 'At most twenty uploaded attachments are allowed per message')
  let declared = 0
  for (const part of uploads) {
    if (!Number.isSafeInteger(part.fileSize) || part.fileSize < 0) throw new BridgeFileError(400, 'Invalid attachment size')
    declared += part.fileSize
    if (declared > MAX_BRIDGE_FILE_BYTES) throw new BridgeFileError(413, 'Attachments exceed the combined message size limit')
  }
  let total = 0
  const out: any[] = []
  for (const part of parts) {
    if (!part || typeof part !== 'object' || !Object.prototype.hasOwnProperty.call(part, 'path')) { out.push(part); continue }
    if (part.type !== 'file' || isEncryptedDescriptor(part) || !ownUploadPath(part.path, botId, channelId)) throw new BridgeFileError(400, 'Invalid Matrix attachment path or descriptor')
    const policy = await limits(), stored = await storedBytes(part.path, Math.min(policy.max, MAX_BRIDGE_FILE_BYTES - total))
    total += stored.bytes.length
    const mimeType = mime(part.mimeType), name = fileName(part.fileName)
    allowed(await limits(), mimeType, stored.bytes.length)
    validateBytes(stored.bytes, mimeType)
    const meta = { type: 'file' as const, fileName: name, mimeType, fileType: mimeType.startsWith('image/') ? 'image' as const : 'file' as const, fileSize: stored.bytes.length }
    if (part.fileSize !== meta.fileSize || part.fileType !== meta.fileType || stored.mimeType !== mimeType
      || !part.path.split('/').at(-1)!.startsWith(address(stored.bytes, meta) + '.')) throw new BridgeFileError(400, 'Attachment metadata does not match its uploaded object')
    out.push({ ...meta, path: part.path, url: publicStorageUrl(await signed(part.path, BOT_MEDIA_URL_TTL_SECONDS)) })
  }
  return out
}
/** Drive paths require the caller's fresh drive_file_owned_by check; never fetch part.url. */
export async function downloadBridgeFile(part: any, channelId: string, driveOwned = false): Promise<{ bytes: Buffer; fileName: string; mimeType: string }> {
  if (part?.type !== 'file' || isEncryptedDescriptor(part)) throw new BridgeFileError(422, 'Encrypted or unsupported attachment descriptor')
  if (!safePath(part.path, channelId) && !(driveOwned && isDriveFilePath(part.path))) throw new BridgeFileError(422, 'Attachment is not stored in this channel private media namespace')
  const policy = await limits(), stored = await storedBytes(part.path, policy.max)
  const name = fileName(part.fileName || 'attachment')
  const currentPolicy = await limits()
  allowed(currentPolicy, stored.mimeType, stored.bytes.length)
  validateBytes(stored.bytes, stored.mimeType)
  const clean = Buffer.from(await stripMediaBytes(stored.bytes))
  allowed(currentPolicy, stored.mimeType, clean.length)
  return { bytes: clean, fileName: name, mimeType: stored.mimeType }
}
