import type { Server } from '@/types'

// Columns update_server writes (db_schema/migrations/20261006400001_server_category.sql);
// it refuses any other key.
export const SERVER_SETTINGS_KEYS = [
  'name',
  'description',
  'icon',
  'banner',
  'public',
  'federation_enabled',
  'allow_cross_server_emojis',
  'rules',
  'category',
] as const

export type ServerSettingsKey = (typeof SERVER_SETTINGS_KEYS)[number]
export type ServerSettingsChanges = Partial<Pick<Server, ServerSettingsKey>>

/** The settings keys of `server` that hold a defined value. */
export function pickServerSettings(server: Partial<Server>): ServerSettingsChanges {
  const changes: Record<string, unknown> = {}
  for (const key of SERVER_SETTINGS_KEYS) {
    if (server[key] !== undefined) changes[key] = server[key]
  }
  return changes as ServerSettingsChanges
}

/** The settings keys whose value differs between `before` and `after`; null and undefined are equal. */
export function diffServerSettings(before: Partial<Server>, after: Partial<Server>): ServerSettingsChanges {
  const changes: Record<string, unknown> = {}
  for (const key of SERVER_SETTINGS_KEYS) {
    const next = after[key] ?? null
    if (JSON.stringify(before[key] ?? null) !== JSON.stringify(next)) changes[key] = next
  }
  return changes as ServerSettingsChanges
}
