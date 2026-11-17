import bundledCatalog from 'virtual:activity-catalog'
import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import type { SessionContext } from '../../../activities/sdk/protocol'

/**
 * Activities this instance offers. The web build's /activities/index.json (vite-plugin-activities)
 * describes the built-ins and names their built scripts; activity_apps holds the admin's enabled
 * switch, and describes installed packages itself (20261117600001_activity_packages.sql), whose
 * files the backend serves at /api/federation/activities/pkg/<id>/<sha256>.<ext>. A native app reads
 * the instance's catalog, since its own bundle may be another version, and falls back to the
 * bundled one when the instance does not answer.
 */

export type CatalogApp = (typeof bundledCatalog)['apps'][number]

export interface ActivityApp extends CatalogApp {
  enabled: boolean
  /** Absolute URL of the icon on the instance. */
  iconUrl: string
  source: 'builtin' | 'package'
  /** Packages: where the zip came from (null for an upload) and when it was installed. */
  packageUrl: string | null
  installedAt: string | null
}

export interface ActivityAppRow {
  id: string
  name: string
  enabled: boolean
  builtin: boolean
  min_players: number
  max_players: number
  contexts: SessionContext[]
  version: string | null
  description: string | null
  i18n: CatalogApp['i18n'] | null
  accent: string | null
  entry_sha: string | null
  icon_sha: string | null
  icon_ext: string | null
  package_url: string | null
  installed_at: string | null
}

/** Origin the instance serves the web build and the federation API from; '' for this page's. */
export function instanceOrigin(): string {
  return apiUrl('').replace(/\/+$/, '')
}

function absolute(path: string): string {
  const origin = instanceOrigin()
  return origin ? `${origin}${path}` : new URL(path, window.location.href).toString()
}

export function activityIconUrl(app: Pick<CatalogApp, 'id' | 'icon'>, source: ActivityApp['source'] = 'builtin'): string {
  return absolute(source === 'package' ? `/api/federation/activities/pkg/${app.id}/${app.icon}` : `/activities/${app.id}/${app.icon}`)
}

/** The document an activity runs in (federation-backend src/activities/frame.ts). */
export function activityFrameUrl(app: Pick<ActivityApp, 'id' | 'entry' | 'source'>): string {
  const source = app.source === 'package' ? '&source=package' : ''
  return absolute(`/api/federation/activities/frame/${encodeURIComponent(app.id)}?entry=${encodeURIComponent(app.entry)}${source}`)
}

/** WebSocket URL of the instance relay. */
export function activityRelayUrl(): string {
  return absolute('/api/federation/activities/socket').replace(/^http/i, 'ws')
}

export async function fetchCatalog(): Promise<CatalogApp[]> {
  try {
    const response = await fetch(absolute('/activities/index.json'), { cache: 'no-cache' })
    if (response.ok) {
      const body = (await response.json()) as typeof bundledCatalog
      if (body?.v === 1 && Array.isArray(body.apps)) return body.apps
    }
  } catch {
    /* the bundled catalog below */
  }
  return bundledCatalog.apps
}

export async function fetchAppRows(): Promise<ActivityAppRow[]> {
  const { data, error } = await supabase
    .from('activity_apps')
    .select('id, name, enabled, builtin, min_players, max_players, contexts, version, description, i18n, accent, entry_sha, icon_sha, icon_ext, package_url, installed_at')
    .order('id')
  if (error) throw error
  return (data ?? []) as ActivityAppRow[]
}

/** Built-ins of the catalog the instance knows, then its installed packages, with the admin's switch. */
export function mergeApps(catalog: CatalogApp[], rows: ActivityAppRow[]): ActivityApp[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  const builtins: ActivityApp[] = catalog
    .filter((app) => byId.get(app.id)?.builtin)
    .map((app) => {
      const row = byId.get(app.id)!
      return {
        ...app,
        minPlayers: row.min_players,
        maxPlayers: row.max_players,
        contexts: row.contexts,
        enabled: row.enabled,
        iconUrl: activityIconUrl(app),
        source: 'builtin',
        packageUrl: null,
        installedAt: null,
      }
    })
  const packages: ActivityApp[] = rows
    .filter((row) => !row.builtin && row.entry_sha && row.icon_sha && row.icon_ext)
    .map((row) => {
      const app = {
        id: row.id,
        name: row.name,
        version: row.version ?? '0.0.0',
        description: row.description ?? '',
        ...(row.i18n ? { i18n: row.i18n } : {}),
        minPlayers: row.min_players,
        maxPlayers: row.max_players,
        contexts: row.contexts,
        icon: `${row.icon_sha}.${row.icon_ext}`,
        accent: row.accent ?? '#0EA5E9',
        entry: `${row.entry_sha}.js`,
      }
      return {
        ...app,
        enabled: row.enabled,
        iconUrl: activityIconUrl(app, 'package'),
        source: 'package',
        packageUrl: row.package_url,
        installedAt: row.installed_at,
      }
    })
  return [...builtins, ...packages]
}

/** Name and description in `locale`, else the manifest's. */
export function localizedApp(app: CatalogApp, locale: string): { name: string; description: string } {
  const own = app.i18n?.[locale] ?? app.i18n?.[locale.split('-')[0]]
  return { name: own?.name || app.name, description: own?.description || app.description }
}

export async function setAppEnabled(appId: string, enabled: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_activity_app_enabled', { p_app: appId, p_enabled: enabled })
  if (error) throw error
}

/* -------------------------------------------------------------------------------------------- */
/* Packages (federation-backend src/activities/packageRoutes.ts)                                 */
/* -------------------------------------------------------------------------------------------- */

export interface PackagePreview {
  id: string
  name: string
  version: string
  description: string
  i18n: CatalogApp['i18n']
  minPlayers: number
  maxPlayers: number
  contexts: SessionContext[]
  accent: string
  sha256: string
  size: number
  entrySize: number
  /** data: URL of the icon. */
  icon: string
  url: string | null
  existing: { version: string | null; enabled: boolean; builtin: boolean } | null
}

export class PackageRequestError extends Error {
  constructor(readonly code: string, message?: string) {
    super(message ?? code)
    this.name = 'PackageRequestError'
  }
}

async function packageRequest<T>(path: string, init: RequestInit): Promise<T> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token
  if (!token) throw new PackageRequestError('not_authenticated')
  const response = await fetch(absolute(`/api/federation/admin/activities${path}`), {
    ...init,
    headers: { ...(init.headers ?? {}), Authorization: `Bearer ${token}` },
  })
  const body = await response.json().catch(() => ({})) as { error?: string; message?: string }
  if (!response.ok) throw new PackageRequestError(body.error ?? `HTTP_${response.status}`, body.message)
  return body as T
}

type PackageSource = { file: Blob } | { url: string }

/** The zip goes as an ArrayBuffer: WebKit's request interception (Playwright) drops Blob bodies. */
async function packageBody(source: PackageSource, extra: Record<string, string> = {}): Promise<RequestInit> {
  if ('file' in source) return { method: 'POST', headers: { 'Content-Type': 'application/zip' }, body: await source.file.arrayBuffer() }
  return { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: source.url, ...extra }) }
}

export async function previewPackage(source: PackageSource): Promise<PackagePreview> {
  return packageRequest('/preview', await packageBody(source))
}

/** Installs what preview described: `sha256` must be the preview's. */
export async function installPackage(source: PackageSource, sha256: string): Promise<{ id: string; enabled: boolean; updated: boolean }> {
  if ('file' in source) return packageRequest(`/install?sha=${sha256}`, await packageBody(source))
  return packageRequest('/install', await packageBody(source, { expectSha256: sha256 }))
}

export function removePackage(id: string): Promise<{ removed: boolean }> {
  return packageRequest(`/${encodeURIComponent(id)}`, { method: 'DELETE' })
}
