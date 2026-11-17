import bundledCatalog from 'virtual:activity-catalog'
import { supabase } from '@/supabase'
import { apiUrl } from '@/services/instanceConfig'
import type { SessionContext } from '../../../activities/sdk/protocol'

/**
 * Activities this instance offers. The web build's /activities/index.json (vite-plugin-activities)
 * describes the apps and names their built scripts; activity_apps holds the admin's enabled
 * switch. A native app reads the instance's catalog, since its own bundle may be another version,
 * and falls back to the bundled one when the instance does not answer.
 */

export type CatalogApp = (typeof bundledCatalog)['apps'][number]

export interface ActivityApp extends CatalogApp {
  enabled: boolean
  /** Absolute URL of the icon on the instance. */
  iconUrl: string
}

export interface ActivityAppRow {
  id: string
  name: string
  enabled: boolean
  builtin: boolean
  min_players: number
  max_players: number
  contexts: SessionContext[]
}

/** Origin the instance serves the web build and the federation API from; '' for this page's. */
export function instanceOrigin(): string {
  return apiUrl('').replace(/\/+$/, '')
}

function absolute(path: string): string {
  const origin = instanceOrigin()
  return origin ? `${origin}${path}` : new URL(path, window.location.href).toString()
}

export function activityIconUrl(app: Pick<CatalogApp, 'id' | 'icon'>): string {
  return absolute(`/activities/${app.id}/${app.icon}`)
}

/** The document an activity runs in (federation-backend src/activities/frame.ts). */
export function activityFrameUrl(app: Pick<CatalogApp, 'id' | 'entry'>): string {
  return absolute(`/api/federation/activities/frame/${encodeURIComponent(app.id)}?entry=${encodeURIComponent(app.entry)}`)
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
    .select('id, name, enabled, builtin, min_players, max_players, contexts')
    .order('id')
  if (error) throw error
  return (data ?? []) as ActivityAppRow[]
}

/** Catalog apps the instance knows, with its enabled switch and player limits. */
export function mergeApps(catalog: CatalogApp[], rows: ActivityAppRow[]): ActivityApp[] {
  const byId = new Map(rows.map((row) => [row.id, row]))
  return catalog
    .filter((app) => byId.has(app.id))
    .map((app) => {
      const row = byId.get(app.id)!
      return {
        ...app,
        minPlayers: row.min_players,
        maxPlayers: row.max_players,
        contexts: row.contexts,
        enabled: row.enabled,
        iconUrl: activityIconUrl(app),
      }
    })
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
