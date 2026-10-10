/**
 * A member's notification settings for a server, its categories and channels (RPCs from
 * 20261011200001_server_notification_settings.sql).
 *
 * Resolution mirrors notification_policy():
 *   level  channel override > category override > server setting > server default > 'mentions'
 *   muted  an active mute of the channel, its category or the server
 */
import { supabase } from '@/supabase'

export type NotificationLevel = 'all' | 'mentions' | 'none'

export const NOTIFICATION_LEVELS: readonly NotificationLevel[] = ['all', 'mentions', 'none']

export interface NotificationOverride {
  channel_id: string | null
  category_id: string | null
  /** null inherits. */
  level: NotificationLevel | null
  muted: boolean
  muted_until: string | null
}

export interface NotificationSettingsChannel {
  id: string
  name: string
  type: number
  category_id: string | null
  position: number | null
}

export interface NotificationSettingsCategory {
  id: string
  name: string
  position: number | null
}

export interface ServerNotificationSettings {
  server_id: string
  muted: boolean
  muted_until: string | null
  /** null follows server_default. */
  level: NotificationLevel | null
  server_default: NotificationLevel
  suppress_everyone: boolean
  suppress_roles: boolean
  push_notifications: boolean
  overrides: NotificationOverride[]
  channels: NotificationSettingsChannel[]
  categories: NotificationSettingsCategory[]
}

export interface ServerSettingsChanges {
  muted?: boolean
  muted_until?: string | null
  level?: NotificationLevel | null
  suppress_everyone?: boolean
  suppress_roles?: boolean
  push_notifications?: boolean
}

export interface OverrideChanges {
  level?: NotificationLevel | null
  muted?: boolean
  muted_until?: string | null
}

export type OverrideTarget = { channelId: string } | { categoryId: string }

/** Discord's mute presets; null minutes mutes until unmuted. */
export const MUTE_DURATIONS = [
  { key: 'm15', minutes: 15 },
  { key: 'h1', minutes: 60 },
  { key: 'h3', minutes: 180 },
  { key: 'h8', minutes: 480 },
  { key: 'h24', minutes: 1440 },
  { key: 'forever', minutes: null },
] as const

export type MuteDurationKey = (typeof MUTE_DURATIONS)[number]['key']

/** Mute end for a preset, as an ISO timestamp; null for an open-ended mute. */
export function muteUntil(key: MuteDurationKey, now: number = Date.now()): string | null {
  const preset = MUTE_DURATIONS.find((d) => d.key === key)
  return preset?.minutes ? new Date(now + preset.minutes * 60_000).toISOString() : null
}

export function isMuteActive(
  mute: { muted?: boolean | null; muted_until?: string | null } | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!mute?.muted) return false
  return !mute.muted_until || Date.parse(mute.muted_until) > now
}

const asLevel = (value: unknown): NotificationLevel | null =>
  value === 'all' || value === 'mentions' || value === 'none' ? value : null

function normalizeOverride(raw: any): NotificationOverride {
  return {
    channel_id: raw?.channel_id ?? null,
    category_id: raw?.category_id ?? null,
    level: asLevel(raw?.level),
    muted: raw?.muted === true,
    muted_until: raw?.muted_until ?? null,
  }
}

export function normalizeSettings(raw: any): ServerNotificationSettings {
  return {
    server_id: String(raw?.server_id ?? ''),
    muted: raw?.muted === true,
    muted_until: raw?.muted_until ?? null,
    level: asLevel(raw?.level),
    server_default: asLevel(raw?.server_default) ?? 'mentions',
    suppress_everyone: raw?.suppress_everyone === true,
    suppress_roles: raw?.suppress_roles === true,
    push_notifications: raw?.push_notifications !== false,
    overrides: Array.isArray(raw?.overrides) ? raw.overrides.map(normalizeOverride) : [],
    channels: Array.isArray(raw?.channels)
      ? raw.channels.map((c: any) => ({
          id: String(c.id),
          name: String(c.name ?? ''),
          type: Number(c.type ?? 0),
          category_id: c.category_id ?? null,
          position: c.position ?? null,
        }))
      : [],
    categories: Array.isArray(raw?.categories)
      ? raw.categories.map((k: any) => ({
          id: String(k.id),
          name: String(k.name ?? ''),
          position: k.position ?? null,
        }))
      : [],
  }
}

export function findOverride(
  settings: ServerNotificationSettings | null | undefined,
  target: OverrideTarget,
): NotificationOverride | null {
  if (!settings) return null
  return (
    settings.overrides.find((o) =>
      'channelId' in target ? o.channel_id === target.channelId : o.category_id === target.categoryId,
    ) ?? null
  )
}

/** Level a channel inherits when it has no override of its own: category, server, default. */
export function inheritedLevel(
  settings: ServerNotificationSettings,
  categoryId: string | null | undefined,
): NotificationLevel {
  const category = categoryId ? findOverride(settings, { categoryId }) : null
  return category?.level ?? settings.level ?? settings.server_default
}

export function effectiveLevel(
  settings: ServerNotificationSettings,
  channelId: string,
  categoryId: string | null | undefined,
): NotificationLevel {
  return findOverride(settings, { channelId })?.level ?? inheritedLevel(settings, categoryId)
}

/** A channel or category mute; a server mute does not mark channels muted. */
export function channelMuted(
  settings: ServerNotificationSettings | null | undefined,
  channelId: string,
  categoryId: string | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!settings) return false
  if (isMuteActive(findOverride(settings, { channelId }), now)) return true
  return !!categoryId && isMuteActive(findOverride(settings, { categoryId }), now)
}

function unwrap(result: { data: any; error: any }): ServerNotificationSettings {
  if (result.error) throw new Error(result.error.message || 'Request failed')
  return normalizeSettings(result.data)
}

export async function getServerNotificationSettings(serverId: string): Promise<ServerNotificationSettings> {
  return unwrap(await supabase.rpc('get_server_notification_settings', { p_server_id: serverId }))
}

export async function updateServerNotificationSettings(
  serverId: string,
  changes: ServerSettingsChanges,
): Promise<ServerNotificationSettings> {
  return unwrap(
    await supabase.rpc('update_server_notification_settings', { p_server_id: serverId, p_changes: changes }),
  )
}

export async function updateNotificationOverride(
  target: OverrideTarget,
  changes: OverrideChanges,
): Promise<ServerNotificationSettings> {
  if ('channelId' in target) {
    return unwrap(
      await supabase.rpc('update_channel_notification_override', {
        p_channel_id: target.channelId,
        p_changes: changes,
      }),
    )
  }
  return unwrap(
    await supabase.rpc('update_category_notification_override', {
      p_category_id: target.categoryId,
      p_changes: changes,
    }),
  )
}
