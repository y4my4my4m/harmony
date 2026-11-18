/**
 * Activity package routes.
 *
 *   GET    /activities/pkg/:appId/:sha.:ext       a stored script or icon (public)
 *   POST   /admin/activities/preview              a package's manifest and sizes, nothing stored
 *   POST   /admin/activities/install              stores it (install_activity_package)
 *   DELETE /admin/activities/:id                  removes it (remove_activity_package)
 *
 * preview and install take the zip as the body (application/zip) or {url} (JSON; HTTPS, fetched
 * through safeFetch). install from a URL also takes {expectSha256}, the preview's sha256: content
 * that changed between preview and install is refused (409 PACKAGE_CHANGED).
 *
 * Stored files are served with `Content-Security-Policy: sandbox; default-src 'none'`: an SVG or a
 * script opened directly runs nothing at the instance's origin. Paths carry the content's SHA-256,
 * so responses are immutable.
 */

import express, { Router, type Request, type Response } from 'express'
import { getSupabaseClient } from '../config/supabase.js'
import { createStrictKeyedLimit } from '../middleware/rateLimit.js'
import { asyncHandler } from '../middleware/errorHandler.js'
import { requireInstanceAdmin } from '../utils/instanceAdmin.js'
import { safeFetch } from '../utils/ssrfProtection.js'
import { logger } from '../utils/logger.js'
import { PACKAGE_MAX_BYTES, PackageError, parsePackage, type ParsedPackage } from './packages.js'

const APP_ID = /^[a-z][a-z0-9-]{1,39}$/
const FILE = /^([0-9a-f]{64})\.(js|svg|png|webp)$/
const SHA = /^[0-9a-f]{64}$/
const CACHE_MAX_BYTES = 64 * 1024 * 1024

const installLimit = createStrictKeyedLimit({
  name: 'admin-activity-packages',
  windowMs: 60 * 60 * 1000,
  maxRequests: 60,
  message: 'Too many package requests; try again later.',
})

/* ---------------------------------------------------------------------------------------------- */
/* Files                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

const cache = new Map<string, { type: string; bytes: Buffer }>()
let cacheBytes = 0

function remember(key: string, value: { type: string; bytes: Buffer }): void {
  if (value.bytes.byteLength > CACHE_MAX_BYTES / 4) return
  cache.set(key, value)
  cacheBytes += value.bytes.byteLength
  while (cacheBytes > CACHE_MAX_BYTES) {
    const [oldest, entry] = cache.entries().next().value!
    cache.delete(oldest)
    cacheBytes -= entry.bytes.byteLength
  }
}

/** bytea as PostgREST returns it: `\x` and hex. */
function decodeBytea(value: unknown): Buffer | null {
  if (typeof value !== 'string' || !value.startsWith('\\x')) return null
  return Buffer.from(value.slice(2), 'hex')
}

export const packageFilesRouter = Router()

packageFilesRouter.get('/pkg/:appId/:file', asyncHandler(async (req: Request, res: Response) => {
  const appId = String(req.params.appId)
  const match = FILE.exec(String(req.params.file))
  if (!APP_ID.test(appId) || !match) {
    res.status(404).end()
    return
  }
  const [, sha] = match
  const key = `${appId}/${sha}`
  let file = cache.get(key)
  if (!file) {
    const { data, error } = await getSupabaseClient()
      .from('activity_app_files')
      .select('content_type, bytes')
      .eq('app_id', appId)
      .eq('sha256', sha)
      .maybeSingle()
    if (error) {
      logger.warn(`Activity package file ${key}: ${error.message}`)
      res.status(503).end()
      return
    }
    const bytes = decodeBytea(data?.bytes)
    if (!data || !bytes) {
      res.status(404).end()
      return
    }
    file = { type: data.content_type as string, bytes }
    remember(key, file)
  } else {
    // Most recently used last.
    cache.delete(key)
    cache.set(key, file)
  }
  res.removeHeader('X-Frame-Options')
  res.setHeader('Content-Type', file.type)
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'")
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin')
  res.setHeader('X-Content-Type-Options', 'nosniff')
  res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
  res.setHeader('ETag', `"${sha}"`)
  res.end(file.bytes)
}))

/* ---------------------------------------------------------------------------------------------- */
/* Admin                                                                                          */
/* ---------------------------------------------------------------------------------------------- */

class RouteError extends Error {
  constructor(readonly status: number, readonly code: string, message?: string) {
    super(message ?? code)
  }
}

async function packageBytes(req: Request): Promise<{ zip: Uint8Array; url: string | null }> {
  if (Buffer.isBuffer(req.body) && req.body.byteLength > 0) return { zip: new Uint8Array(req.body), url: null }
  const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
  if (!url) throw new RouteError(400, 'NO_PACKAGE')
  if (!/^https:\/\//i.test(url) || url.length > 2000) throw new RouteError(400, 'BAD_URL')
  let response: globalThis.Response
  try {
    response = await safeFetch(url, { maxBodyBytes: PACKAGE_MAX_BYTES, timeoutMs: 20_000, headers: { Accept: 'application/zip, application/octet-stream' } })
  } catch (error) {
    throw new RouteError(502, 'FETCH_FAILED', (error as Error).message)
  }
  if (!response.ok) throw new RouteError(502, 'FETCH_FAILED', `HTTP ${response.status}`)
  let body: ArrayBuffer
  try {
    body = await response.arrayBuffer()
  } catch (error) {
    throw new RouteError(413, 'TOO_LARGE', (error as Error).message)
  }
  return { zip: new Uint8Array(body), url }
}

function parse(zip: Uint8Array): ParsedPackage {
  try {
    return parsePackage(zip)
  } catch (error) {
    if (error instanceof PackageError) throw new RouteError(422, error.code, error.message)
    throw error
  }
}

async function existing(id: string): Promise<{ version: string | null; enabled: boolean; builtin: boolean } | null> {
  const { data, error } = await getSupabaseClient().from('activity_apps').select('version, enabled, builtin').eq('id', id).maybeSingle()
  if (error) throw new RouteError(500, 'internal_error', error.message)
  return data as { version: string | null; enabled: boolean; builtin: boolean } | null
}

function describe(pkg: ParsedPackage, url: string | null, current: Awaited<ReturnType<typeof existing>>) {
  return {
    ...pkg.manifest,
    sha256: pkg.sha256,
    size: pkg.size,
    entrySize: pkg.entry.bytes.byteLength,
    icon: `data:${pkg.icon.contentType};base64,${Buffer.from(pkg.icon.bytes).toString('base64')}`,
    url,
    existing: current,
  }
}

function send(res: Response, error: unknown): void {
  if (error instanceof RouteError) {
    res.status(error.status).json({ error: error.code, message: error.message })
    return
  }
  logger.error('Activity packages:', error)
  res.status(500).json({ error: 'internal_error' })
}

const zipBody = express.raw({ type: ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'], limit: PACKAGE_MAX_BYTES })

export const adminActivitiesRouter = Router()

adminActivitiesRouter.post('/preview', zipBody, asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireInstanceAdmin(req, res)
  if (!admin || !(await installLimit.take(res, admin.profileId))) return
  try {
    const { zip, url } = await packageBytes(req)
    const pkg = parse(zip)
    const current = await existing(pkg.manifest.id)
    if (current?.builtin) throw new RouteError(409, 'BUILTIN_ID')
    res.json(describe(pkg, url, current))
  } catch (error) {
    send(res, error)
  }
}))

adminActivitiesRouter.post('/install', zipBody, asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireInstanceAdmin(req, res)
  if (!admin || !(await installLimit.take(res, admin.profileId))) return
  try {
    const { zip, url } = await packageBytes(req)
    const pkg = parse(zip)
    const expected = Buffer.isBuffer(req.body) ? String(req.query.sha ?? '') : String(req.body?.expectSha256 ?? '')
    if (url && !SHA.test(expected)) throw new RouteError(400, 'NO_EXPECTED_SHA')
    if (expected && expected !== pkg.sha256) throw new RouteError(409, 'PACKAGE_CHANGED')

    const app = {
      id: pkg.manifest.id,
      name: pkg.manifest.name,
      version: pkg.manifest.version,
      description: pkg.manifest.description,
      i18n: pkg.manifest.i18n,
      accent: pkg.manifest.accent,
      min_players: pkg.manifest.minPlayers,
      max_players: pkg.manifest.maxPlayers,
      contexts: pkg.manifest.contexts,
      entry_sha: pkg.entry.sha256,
      icon_sha: pkg.icon.sha256,
      icon_ext: pkg.icon.ext,
      package_url: url,
      package_sha: pkg.sha256,
    }
    const files = [pkg.entry, pkg.icon].map((file) => ({
      sha256: file.sha256,
      content_type: file.contentType,
      base64: Buffer.from(file.bytes).toString('base64'),
    }))
    const { data, error } = await getSupabaseClient().rpc('install_activity_package', { p_admin: admin.profileId, p_app: app, p_files: files })
    if (error) {
      if (error.message === 'BUILTIN_ID' || error.message === 'TOO_MANY_PACKAGES') throw new RouteError(409, error.message)
      throw new RouteError(500, 'internal_error', error.message)
    }
    res.json({ ...(data as object), version: pkg.manifest.version, sha256: pkg.sha256 })
  } catch (error) {
    send(res, error)
  }
}))

adminActivitiesRouter.delete('/:id', asyncHandler(async (req: Request, res: Response) => {
  const admin = await requireInstanceAdmin(req, res)
  if (!admin || !(await installLimit.take(res, admin.profileId))) return
  const id = String(req.params.id)
  if (!APP_ID.test(id)) {
    res.status(404).json({ error: 'NOT_FOUND' })
    return
  }
  const { data, error } = await getSupabaseClient().rpc('remove_activity_package', { p_admin: admin.profileId, p_app: id })
  if (error) {
    if (error.message === 'BUILTIN_ID') {
      res.status(409).json({ error: 'BUILTIN_ID' })
      return
    }
    send(res, new RouteError(500, 'internal_error', error.message))
    return
  }
  for (const key of [...cache.keys()]) if (key.startsWith(`${id}/`)) {
    cacheBytes -= cache.get(key)!.bytes.byteLength
    cache.delete(key)
  }
  if (!data) {
    res.status(404).json({ error: 'NOT_FOUND' })
    return
  }
  res.json({ removed: true })
}))
