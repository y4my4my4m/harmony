/**
 * Activity packages: activities an instance admin installs, as opposed to the built-ins of the web
 * build. A package is a zip of exactly three files, optionally inside one top-level folder:
 *
 *   manifest.json   as activities/<id>/manifest.json of a built-in, `entry` naming the built script
 *   <entry>.js      one classic script, the SDK bundled in (activities/sdk)
 *   <icon>          SVG, PNG or WebP
 *
 * The instance stores the bytes (activity_app_files) and serves them itself at hash-named paths
 * (packageFiles.ts); nothing is fetched from the author's host after install.
 */

import { createHash } from 'node:crypto'
import { inflateRawSync } from 'node:zlib'

export const PACKAGE_MAX_BYTES = 6 * 1024 * 1024
export const ENTRY_MAX_BYTES = 5 * 1024 * 1024
export const ICON_MAX_BYTES = 256 * 1024
export const MANIFEST_MAX_BYTES = 64 * 1024
/** Central directory records a zip may list: three files, a folder record and archiver extras. */
export const ZIP_ENTRIES_MAX = 32
/** Packages one instance holds. */
export const PACKAGES_MAX = 50

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/
const CONTEXTS = ['direct', 'group', 'channel', 'voice'] as const
const LOCALES = ['en', 'es', 'fr', 'de', 'ja', 'ko', 'zh']

export type PackageErrorCode =
  | 'NOT_A_ZIP'
  | 'TOO_LARGE'
  | 'UNEXPECTED_FILE'
  | 'MISSING_FILE'
  | 'BAD_MANIFEST'
  | 'BAD_ENTRY'
  | 'BAD_ICON'

export class PackageError extends Error {
  constructor(readonly code: PackageErrorCode, message: string) {
    super(message)
    this.name = 'PackageError'
  }
}

export interface PackageManifest {
  id: string
  name: string
  version: string
  description: string
  i18n: Record<string, { name?: string; description?: string }>
  minPlayers: number
  maxPlayers: number
  contexts: Array<(typeof CONTEXTS)[number]>
  accent: string
}

export interface PackageFile {
  sha256: string
  contentType: string
  bytes: Uint8Array
}

export interface ParsedPackage {
  manifest: PackageManifest
  entry: PackageFile
  icon: PackageFile & { ext: 'svg' | 'png' | 'webp' }
  /** SHA-256 of the zip as received. */
  sha256: string
  size: number
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function fail(code: PackageErrorCode, message: string): never {
  throw new PackageError(code, message)
}

function text(value: unknown, max: number): string | null {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max ? value.trim() : null
}

/** The manifest's fields, checked as vite-plugin-activities checks a built-in's. */
export function parseManifest(raw: unknown): PackageManifest & { entry: string; icon: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('BAD_MANIFEST', 'manifest.json is not an object')
  const m = raw as Record<string, unknown>
  const problems: string[] = []
  const id = typeof m.id === 'string' && APP_ID.test(m.id) ? m.id : (problems.push('id'), '')
  const name = text(m.name, 60) ?? (problems.push('name'), '')
  const version = typeof m.version === 'string' && /^\d{1,4}\.\d{1,4}\.\d{1,6}$/.test(m.version) ? m.version : (problems.push('version'), '')
  const description = typeof m.description === 'string' && m.description.length <= 300 ? m.description.trim() : (problems.push('description'), '')
  const minPlayers = Number.isInteger(m.minPlayers) ? (m.minPlayers as number) : 0
  const maxPlayers = Number.isInteger(m.maxPlayers) ? (m.maxPlayers as number) : 0
  if (!(minPlayers >= 1 && maxPlayers <= 64 && minPlayers <= maxPlayers)) problems.push('players')
  const contexts = Array.isArray(m.contexts) && m.contexts.length > 0 && m.contexts.every((c) => (CONTEXTS as readonly unknown[]).includes(c))
    ? [...new Set(m.contexts as PackageManifest['contexts'])]
    : (problems.push('contexts'), [])
  const accent = typeof m.accent === 'string' && /^#[0-9a-fA-F]{6}$/.test(m.accent) ? m.accent : (problems.push('accent'), '')
  const entry = typeof m.entry === 'string' && FILE_NAME.test(m.entry) && m.entry.endsWith('.js') ? m.entry : (problems.push('entry'), '')
  const icon = typeof m.icon === 'string' && FILE_NAME.test(m.icon) && /\.(svg|png|webp)$/.test(m.icon) ? m.icon : (problems.push('icon'), '')
  const i18n: PackageManifest['i18n'] = {}
  if (m.i18n !== undefined) {
    if (!m.i18n || typeof m.i18n !== 'object' || Array.isArray(m.i18n)) problems.push('i18n')
    else {
      for (const [locale, value] of Object.entries(m.i18n as Record<string, unknown>)) {
        if (!LOCALES.includes(locale) || !value || typeof value !== 'object') {
          problems.push(`i18n.${locale}`)
          continue
        }
        const v = value as Record<string, unknown>
        const entryName = v.name === undefined ? undefined : text(v.name, 60)
        const entryDescription = v.description === undefined ? undefined : (typeof v.description === 'string' && v.description.length <= 300 ? v.description.trim() : null)
        if (entryName === null || entryDescription === null) problems.push(`i18n.${locale}`)
        else i18n[locale] = { ...(entryName ? { name: entryName } : {}), ...(entryDescription ? { description: entryDescription } : {}) }
      }
    }
  }
  if (problems.length) fail('BAD_MANIFEST', `manifest.json: invalid ${problems.join(', ')}`)
  return { id, name, version, description, i18n, minPlayers, maxPlayers, contexts, accent, entry, icon }
}

function iconType(name: string, bytes: Uint8Array): { ext: 'svg' | 'png' | 'webp'; contentType: string } {
  if (name.endsWith('.png')) {
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)) fail('BAD_ICON', 'the icon is not a PNG')
    return { ext: 'png', contentType: 'image/png' }
  }
  if (name.endsWith('.webp')) {
    const tag = String.fromCharCode(...bytes.slice(0, 4)) + String.fromCharCode(...bytes.slice(8, 12))
    if (tag !== 'RIFFWEBP') fail('BAD_ICON', 'the icon is not a WebP')
    return { ext: 'webp', contentType: 'image/webp' }
  }
  const head = new TextDecoder('utf-8', { fatal: false }).decode(bytes.slice(0, 512)).replace(/^﻿/, '').trimStart()
  if (!/^(<\?xml[^>]*>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(head)) fail('BAD_ICON', 'the icon is not an SVG')
  return { ext: 'svg', contentType: 'image/svg+xml' }
}

interface ZipEntry {
  name: string
  /** 0 stored, 8 deflated. */
  method: number
  /** Offset of the local header, and of the data after it. */
  offset: number
  start: number
  /** Bytes of data in the zip, and unpacked: as declared, or the data's own for a stored entry. */
  size: number
  unpacked: number
}

/**
 * The files of a zip's central directory (APPNOTE 4.3.12 and 4.3.16; zip64 4.3.14, 4.3.15 and
 * 4.5.3). Nothing is unpacked. Entries that share or overlap local data are refused: each byte of
 * the zip is then inflated at most once.
 */
function readDirectory(zip: Uint8Array): ZipEntry[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength)
  const u16 = (at: number) => view.getUint16(at, true)
  const u32 = (at: number) => view.getUint32(at, true)
  const u64 = (at: number) => Number(view.getBigUint64(at, true))

  // The end record is 22 bytes and a comment of at most 65535.
  let end = zip.byteLength - 22
  while (u32(end) !== 0x06054b50) if (zip.byteLength - --end > 22 + 0xffff) fail('NOT_A_ZIP', 'the zip has no end record')
  let count = u16(end + 10)
  let at = u32(end + 16)
  if (end >= 20 && u32(end - 20) === 0x07064b50) {
    const end64 = u64(end - 12)
    if (u32(end64) === 0x06064b50) {
      count = u64(end64 + 32)
      at = u64(end64 + 48)
    }
  }
  if (count > ZIP_ENTRIES_MAX) fail('UNEXPECTED_FILE', `a package holds at most ${ZIP_ENTRIES_MAX} zip entries`)

  const entries: ZipEntry[] = []
  let total = 0
  for (let i = 0; i < count; i++) {
    if (u32(at) !== 0x02014b50) fail('NOT_A_ZIP', 'the zip directory is damaged')
    const method = u16(at + 10)
    const nameLength = u16(at + 28)
    const extraLength = u16(at + 30)
    // Flag 0x800: the name is UTF-8.
    const name = Buffer.from(zip.buffer, zip.byteOffset + at + 46, nameLength).toString(u16(at + 8) & 0x800 ? 'utf8' : 'latin1')
    let size = u32(at + 20)
    let declared = u32(at + 24)
    let offset = u32(at + 42)
    const extra = at + 46 + nameLength
    for (let x = extra; x + 4 <= extra + extraLength; x += 4 + u16(x + 2)) {
      if (u16(x) !== 1) continue
      let field = x + 4
      if (declared === 0xffffffff) { declared = u64(field); field += 8 }
      if (size === 0xffffffff) { size = u64(field); field += 8 }
      if (offset === 0xffffffff) offset = u64(field)
      break
    }
    at = extra + extraLength + u16(at + 32)
    // Directory entries carry no data.
    if (name.endsWith('/')) continue
    if (method !== 0 && method !== 8) fail('NOT_A_ZIP', `${name} uses an unsupported compression method`)
    const unpacked = method === 0 ? size : declared
    total += unpacked
    if (unpacked > ENTRY_MAX_BYTES || total > PACKAGE_MAX_BYTES) fail('TOO_LARGE', `${name} is too large`)
    if (u32(offset) !== 0x04034b50) fail('NOT_A_ZIP', `${name} has no local header`)
    const start = offset + 30 + u16(offset + 26) + u16(offset + 28)
    if (start + size > zip.byteLength) fail('NOT_A_ZIP', `${name} is cut short`)
    entries.push({ name, method, offset, start, size, unpacked })
  }

  let previous = 0
  for (const entry of [...entries].sort((a, b) => a.offset - b.offset)) {
    if (entry.offset < previous) fail('NOT_A_ZIP', `${entry.name} overlaps another entry`)
    previous = entry.start + entry.size
  }
  return entries
}

/** An entry's bytes. Inflating stops once the output passes the declared size. */
function unpack(zip: Uint8Array, entry: ZipEntry): Uint8Array {
  const data = zip.subarray(entry.start, entry.start + entry.size)
  if (entry.method === 0) return data.slice()
  let bytes: Uint8Array
  try {
    bytes = inflateRawSync(data, { maxOutputLength: Math.max(1, entry.unpacked) })
  } catch {
    fail('NOT_A_ZIP', `${entry.name} could not be unpacked`)
  }
  if (bytes.byteLength !== entry.unpacked) fail('NOT_A_ZIP', `${entry.name} is not its declared size`)
  return bytes
}

/** A package's files, checked; throws PackageError. */
export function parsePackage(zip: Uint8Array): ParsedPackage {
  if (zip.byteLength > PACKAGE_MAX_BYTES) fail('TOO_LARGE', `a package is at most ${PACKAGE_MAX_BYTES} bytes`)
  if (!(zip[0] === 0x50 && zip[1] === 0x4b)) fail('NOT_A_ZIP', 'not a zip file')

  let entries: ZipEntry[]
  try {
    entries = readDirectory(zip)
  } catch (error) {
    if (error instanceof PackageError) throw error
    // A RangeError: an offset or length past the end of the zip.
    fail('NOT_A_ZIP', 'the zip could not be read')
  }

  // One top-level folder, as zipping a folder produces, is dropped from every path.
  const folders = new Set(entries.map(({ name }) => (name.includes('/') ? name.split('/')[0] : '')))
  const prefix = folders.size === 1 && !folders.has('') ? `${[...folders][0]}/` : ''
  const byName = new Map<string, ZipEntry>()
  for (const entry of entries) {
    const local = entry.name.slice(prefix.length)
    if (local.includes('/') || local.includes('\\') || !FILE_NAME.test(local)) fail('UNEXPECTED_FILE', `${entry.name} is not allowed in a package`)
    if (byName.has(local)) fail('UNEXPECTED_FILE', `${entry.name} is in the package twice`)
    byName.set(local, entry)
  }

  // Nothing but the manifest is unpacked before every name is known to belong.
  const manifestEntry = byName.get('manifest.json') ?? fail('MISSING_FILE', 'manifest.json is missing')
  if (manifestEntry.unpacked > MANIFEST_MAX_BYTES) fail('TOO_LARGE', 'manifest.json is too large')
  const manifestBytes = unpack(zip, manifestEntry)
  let rawManifest: unknown
  try {
    rawManifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(manifestBytes))
  } catch {
    fail('BAD_MANIFEST', 'manifest.json is not JSON')
  }
  const manifest = parseManifest(rawManifest)

  for (const name of byName.keys()) {
    if (name !== 'manifest.json' && name !== manifest.entry && name !== manifest.icon) {
      fail('UNEXPECTED_FILE', `${name} is not the manifest, the entry or the icon`)
    }
  }
  const script = byName.get(manifest.entry) ?? fail('MISSING_FILE', `${manifest.entry} is missing`)
  const picture = byName.get(manifest.icon) ?? fail('MISSING_FILE', `${manifest.icon} is missing`)
  if (picture.unpacked > ICON_MAX_BYTES) fail('BAD_ICON', 'the icon is too large')
  const entryBytes = unpack(zip, script)
  const iconBytes = unpack(zip, picture)
  if (entryBytes.byteLength === 0 || entryBytes.byteLength > ENTRY_MAX_BYTES) fail('BAD_ENTRY', 'the entry is empty or too large')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(entryBytes)
  } catch {
    fail('BAD_ENTRY', 'the entry is not UTF-8 text')
  }
  if (iconBytes.byteLength === 0) fail('BAD_ICON', 'the icon is empty')
  const icon = iconType(manifest.icon, iconBytes)

  const { entry: _entry, icon: _icon, ...fields } = manifest
  return {
    manifest: fields,
    entry: { sha256: sha256Hex(entryBytes), contentType: 'text/javascript; charset=utf-8', bytes: entryBytes },
    icon: { sha256: sha256Hex(iconBytes), contentType: icon.contentType, bytes: iconBytes, ext: icon.ext },
    sha256: sha256Hex(zip),
    size: zip.byteLength,
  }
}
