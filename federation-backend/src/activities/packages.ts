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
import { unzipSync } from 'fflate'

export const PACKAGE_MAX_BYTES = 6 * 1024 * 1024
export const ENTRY_MAX_BYTES = 5 * 1024 * 1024
export const ICON_MAX_BYTES = 256 * 1024
export const MANIFEST_MAX_BYTES = 64 * 1024
/** Central directory records read: three files, a folder record and archiver extras. */
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

/** A package's files, checked; throws PackageError. */
export function parsePackage(zip: Uint8Array): ParsedPackage {
  if (zip.byteLength > PACKAGE_MAX_BYTES) fail('TOO_LARGE', `a package is at most ${PACKAGE_MAX_BYTES} bytes`)
  if (!(zip[0] === 0x50 && zip[1] === 0x4b)) fail('NOT_A_ZIP', 'not a zip file')

  let declared = 0
  let entries = 0
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(zip, {
      filter: (file) => {
        // fflate visits as many records as the end record claims; zip64 allows 2^32 - 1.
        if (++entries > ZIP_ENTRIES_MAX) fail('UNEXPECTED_FILE', `a package holds at most ${ZIP_ENTRIES_MAX} zip entries`)
        // Directory entries carry no data.
        if (file.name.endsWith('/')) return false
        if (file.compression !== 0 && file.compression !== 8) fail('NOT_A_ZIP', `${file.name} uses an unsupported compression method`)
        // fflate copies a stored entry's compressed size and inflates a deflated one into its
        // declared size; records may share one local entry, so each copy counts.
        const bytes = file.compression === 0 ? file.size : file.originalSize
        if (!Number.isSafeInteger(bytes) || bytes < 0) fail('NOT_A_ZIP', `${file.name} has an invalid size`)
        declared += bytes
        if (bytes > ENTRY_MAX_BYTES || declared > PACKAGE_MAX_BYTES) fail('TOO_LARGE', `${file.name} is too large`)
        return true
      },
    })
  } catch (error) {
    if (error instanceof PackageError) throw error
    fail('NOT_A_ZIP', 'the zip could not be read')
  }
  const total = Object.values(files).reduce((n, bytes) => n + bytes.byteLength, 0)
  if (total > PACKAGE_MAX_BYTES) fail('TOO_LARGE', 'the unpacked package is too large')

  // One top-level folder, as zipping a folder produces, is dropped from every path.
  const names = Object.keys(files)
  const folders = new Set(names.map((name) => (name.includes('/') ? name.split('/')[0] : '')))
  const prefix = folders.size === 1 && !folders.has('') ? `${[...folders][0]}/` : ''
  const byName = new Map<string, Uint8Array>()
  for (const name of names) {
    const local = name.slice(prefix.length)
    if (local.includes('/') || local.includes('\\') || !FILE_NAME.test(local)) fail('UNEXPECTED_FILE', `${name} is not allowed in a package`)
    byName.set(local, files[name])
  }

  const manifestBytes = byName.get('manifest.json') ?? fail('MISSING_FILE', 'manifest.json is missing')
  if (manifestBytes.byteLength > MANIFEST_MAX_BYTES) fail('TOO_LARGE', 'manifest.json is too large')
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
  const entryBytes = byName.get(manifest.entry) ?? fail('MISSING_FILE', `${manifest.entry} is missing`)
  const iconBytes = byName.get(manifest.icon) ?? fail('MISSING_FILE', `${manifest.icon} is missing`)
  if (entryBytes.byteLength === 0 || entryBytes.byteLength > ENTRY_MAX_BYTES) fail('BAD_ENTRY', 'the entry is empty or too large')
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(entryBytes)
  } catch {
    fail('BAD_ENTRY', 'the entry is not UTF-8 text')
  }
  if (iconBytes.byteLength === 0 || iconBytes.byteLength > ICON_MAX_BYTES) fail('BAD_ICON', 'the icon is empty or too large')
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
