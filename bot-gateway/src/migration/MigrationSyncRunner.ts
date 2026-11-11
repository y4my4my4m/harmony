/**
 * Scheduled sync for "Migrate from Discord": reads each open migration's linked members from Discord
 * and writes roles, profile fields and timeouts through the discord_migration_* RPCs. Members who left
 * or were banned on Discord are collected and removed in one brake-guarded batch at the end of a pass.
 * Nothing here ever logs or returns a Discord token.
 */

import { config, supabase } from '../config/supabase.js'
import { publicStorageUrl } from '../utils/messageMedia.js'
import { mirrorExternalMediaToStorage } from '../utils/mirrorExternalMedia.js'
import {
  type DiscordMember,
  type DiscordResult,
  fetchBan,
  fetchGuildMember,
  fetchGuildRoles,
  fetchUser,
} from './discordClient.js'
import { buildRolesSnapshot } from './discordPermissions.js'

export interface DueMigration {
  server_id: string
  discord_guild_id: string | null
  credential_source: string | null
  sync_requested_at: string | null
  last_sync_at: string | null
  sync_cursor: string | null
}

export interface SyncResult {
  checked: number
  rolesChanged: number
  removed: number
  timeouts: number
  paused?: string
  errors: number
}

interface MigrationLink {
  user_id: string
  discord_user_id: string
  sync_fields: string[]
}

interface MigrationInfo {
  discord_guild_id: string | null
  bot_can_ban: boolean
  state: string
  sync_paused_reason: string | null
}

interface MirrorTarget {
  bucket: string
  folder: string
  stem: string
}

type RpcResult = { data: any; error: { message?: string; code?: string } | null }

export interface MigrationSyncDeps {
  rpc?: (fn: string, args?: Record<string, unknown>) => PromiseLike<RpcResult>
  discord?: {
    fetchGuildRoles: typeof fetchGuildRoles
    fetchGuildMember: typeof fetchGuildMember
    fetchUser: typeof fetchUser
    fetchBan: typeof fetchBan
  }
  /** Copies a Discord CDN image into Harmony storage and returns the value to store; throws on failure. */
  mirror?: (url: string, target: MirrorTarget) => Promise<string>
  /** The migration row, null when there is none; throws on a database error. */
  loadMigration?: (serverId: string) => Promise<MigrationInfo | null>
  loadLink?: (serverId: string, userId: string) => Promise<MigrationLink | null>
  now?: () => number
  intervalMs?: number
  pollMs?: number
  budgetMs?: number
  batch?: number
}

/** Fewer members than this are too few to judge a failure rate by. */
const MIN_SAMPLE_FOR_ERROR_BRAKE = 3
const MIRROR_CACHE_MAX = 5000
const DUE_LIMIT = 20
/** Wait after a transient failure of one server: doubles per consecutive failure. */
const BACKOFF_START_MS = 60_000
const BACKOFF_MAX_MS = 30 * 60_000

class DiscordCallFailed extends Error {
  constructor(readonly status: number, readonly reason: string) {
    super(`discord call failed: ${reason}`)
  }
}

function failureOf(err: unknown): { status: number; reason: string } {
  return err instanceof DiscordCallFailed ? err : { status: 502, reason: 'malformed_response' }
}

function pauseReasonFor(f: { status: number; reason: string }): string | null {
  if (f.reason === 'bot_not_in_guild') return 'bot_not_in_guild'
  if (f.status === 401) return 'token_invalid'
  if (f.status === 403 || f.status === 404) return 'bot_not_in_guild'
  return null
}

export class MigrationSyncRunner {
  private readonly rpc: NonNullable<MigrationSyncDeps['rpc']>
  private readonly discord: NonNullable<MigrationSyncDeps['discord']>
  private readonly mirror: NonNullable<MigrationSyncDeps['mirror']>
  private readonly loadMigration: NonNullable<MigrationSyncDeps['loadMigration']>
  private readonly loadLink: NonNullable<MigrationSyncDeps['loadLink']>
  private readonly now: () => number
  private readonly intervalMs: number
  private readonly pollMs: number
  private readonly budgetMs: number
  private readonly batch: number
  private timer: NodeJS.Timeout | null = null
  private running = false
  /** Servers whose last attempt failed transiently: not tried again before `until`. */
  private readonly backoffs = new Map<string, { until: number; delayMs: number }>()
  /** Source URL -> stored path, so an unchanged Discord image is not copied again on every pass. */
  private readonly mirrored = new Map<string, string>()

  constructor(deps: MigrationSyncDeps = {}) {
    this.rpc = deps.rpc ?? ((fn, args) => supabase.rpc(fn, args) as unknown as PromiseLike<RpcResult>)
    this.discord = deps.discord ?? { fetchGuildRoles, fetchGuildMember, fetchUser, fetchBan }
    this.mirror = deps.mirror ?? defaultMirror
    this.loadMigration = deps.loadMigration ?? defaultLoadMigration
    this.loadLink = deps.loadLink ?? defaultLoadLink
    this.now = deps.now ?? Date.now
    this.intervalMs = deps.intervalMs ?? config.migration.syncMs
    this.pollMs = deps.pollMs ?? config.migration.pollMs
    this.budgetMs = deps.budgetMs ?? config.migration.budgetMs
    this.batch = deps.batch ?? config.migration.batch
    this.syncOne = this.syncOne.bind(this)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => {
      void this.runOnce()
    }, this.pollMs)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Syncs every due migration, one after the other. A call while one is running returns at once. */
  async runOnce(): Promise<void> {
    if (this.running) return
    this.running = true
    try {
      const { data, error } = await this.rpc('discord_migration_due', {
        p_limit: DUE_LIMIT,
        p_interval: `${Math.max(1, Math.floor(this.intervalMs))} milliseconds`,
      })
      if (error) {
        console.error('discord_migration_due failed:', error.code, error.message)
        return
      }
      for (const row of Array.isArray(data) ? (data as DueMigration[]) : []) {
        const wait = this.backoffs.get(row.server_id)
        if (wait && this.now() < wait.until) continue
        try {
          await this.syncServer(row)
        } catch (err) {
          console.error('migration sync failed:', err instanceof Error ? err.message : 'unknown error')
          this.backOff(row.server_id)
        }
      }
    } finally {
      this.running = false
    }
  }

  private backOff(serverId: string): void {
    const prev = this.backoffs.get(serverId)
    const delayMs = prev ? Math.min(prev.delayMs * 2, BACKOFF_MAX_MS) : BACKOFF_START_MS
    this.backoffs.set(serverId, { until: this.now() + delayMs, delayMs })
  }

  async syncServer(m: DueMigration): Promise<SyncResult> {
    const result: SyncResult = { checked: 0, rolesChanged: 0, removed: 0, timeouts: 0, errors: 0 }
    const serverId = m.server_id
    const startedAt = new Date(this.now()).toISOString()

    const pauseWith = async (reason: string) => {
      await this.rpc('discord_migration_pause', { p_server_id: serverId, p_reason: reason })
      result.paused = reason
      this.backoffs.delete(serverId)
      return result
    }
    // A transient failure ends the attempt early; the server is skipped for a growing delay.
    const transient = () => {
      result.errors++
      this.backOff(serverId)
      return result
    }

    const creds = await this.credentials(serverId)
    if (creds === null) return pauseWith('credentials_missing')
    if (creds === 'error') return transient()
    let info: MigrationInfo | null
    try {
      info = await this.loadMigration(serverId)
    } catch {
      // A DB error says nothing about the credentials: try again later instead of pausing.
      return transient()
    }
    const guildId = info?.discord_guild_id ?? m.discord_guild_id
    if (!info || !guildId) return pauseWith('credentials_missing')

    const refreshed = await this.refreshRoles(serverId, guildId, creds.bot_token)
    if (refreshed !== 'ok') {
      if (refreshed === 'unavailable') return transient()
      return pauseWith(refreshed)
    }

    const candidates: Array<{ user_id: string; kind: 'left' | 'banned' }> = []
    const seen = new Set<string>()
    let failedMembers = 0
    let checkedMembers = 0
    let stop = false
    // False when the pass ended with members left (time budget, a failed batch read): the next run continues.
    let complete = true

    while (!stop && this.now() - Date.parse(startedAt) < this.budgetMs) {
      // Members that stayed unsynced (absent, failed) sort first on every read, so ask for the seen ones too and skip them.
      const { data, error } = await this.rpc('discord_migration_links_batch', {
        p_server_id: serverId,
        p_limit: seen.size + this.batch,
      })
      if (error) {
        console.error('discord_migration_links_batch failed:', error.code, error.message)
        result.errors++
        complete = false
        break
      }
      const fresh = (Array.isArray(data) ? (data as MigrationLink[]) : []).filter((l) => !seen.has(l.user_id))
      if (fresh.length === 0) break

      for (const l of fresh) {
        if (this.now() - Date.parse(startedAt) >= this.budgetMs) {
          stop = true
          complete = false
          break
        }
        seen.add(l.user_id)
        const outcome = await this.syncLink(serverId, guildId, creds.bot_token, l, result, {
          checkBans: true,
          botCanBan: info.bot_can_ban === true,
        })
        result.checked++
        if (outcome.kind === 'candidate') candidates.push({ user_id: l.user_id, kind: outcome.candidate })
        if (outcome.memberFetch) {
          checkedMembers++
          if (outcome.failed) failedMembers++
        }
        if (
          checkedMembers >= MIN_SAMPLE_FOR_ERROR_BRAKE &&
          failedMembers * 2 > checkedMembers
        ) {
          stop = true
          break
        }
      }
    }

    // The loop condition ended it on the budget: members may be left.
    if (!stop && this.now() - Date.parse(startedAt) >= this.budgetMs) complete = false

    if (checkedMembers > 0 && failedMembers * 2 > checkedMembers) return pauseWith('discord_errors')

    if (candidates.length > 0) {
      const { data, error } = await this.rpc('discord_migration_apply_removals', {
        p_server_id: serverId,
        p_candidates: candidates,
      })
      if (error) {
        console.error('discord_migration_apply_removals failed:', error.code, error.message)
        result.errors++
      } else if (data?.paused) {
        // The brake paused the server inside the RPC.
        result.paused = 'removal_brake'
        return result
      } else {
        result.removed = Number(data?.applied ?? 0)
      }
    }

    const recorded = await this.rpc('discord_migration_record_sync', {
      p_server_id: serverId,
      p_result: result,
      p_cursor: null,
      p_started_at: startedAt,
      p_complete: complete,
    })
    this.backoffs.delete(serverId)
    if (recorded.error) console.error('discord_migration_record_sync failed:', recorded.error.code, recorded.error.message)
    return result
  }

  /** Syncs one linked member now. A member gone from Discord is left for the next full pass. */
  async syncOne(serverId: string, userId: string): Promise<void> {
    const info = await this.loadMigration(serverId)
    if (!info || !info.discord_guild_id || info.state !== 'open' || info.sync_paused_reason) return
    const l = await this.loadLink(serverId, userId)
    if (!l) return
    const creds = await this.credentials(serverId)
    if (!creds || creds === 'error') throw new Error('credentials_unavailable')

    const result: SyncResult = { checked: 0, rolesChanged: 0, removed: 0, timeouts: 0, errors: 0 }
    const outcome = await this.syncLink(serverId, info.discord_guild_id, creds.bot_token, l, result, {
      checkBans: false,
      botCanBan: false,
    })
    if (outcome.kind === 'error') throw new Error('sync_failed')
  }

  // ------------------------------------------------------------- internals

  private async credentials(serverId: string): Promise<{ bot_token: string } | null | 'error'> {
    const { data, error } = await this.rpc('discord_migration_credentials', { p_server_id: serverId })
    if (error) {
      if ((error.message ?? '').includes('MIGRATION_CREDENTIALS_MISSING')) return null
      console.error('discord_migration_credentials failed:', error.code, error.message)
      return 'error'
    }
    const row = (Array.isArray(data) ? data[0] : data) as { bot_token?: unknown } | null
    return row && typeof row.bot_token === 'string' ? { bot_token: row.bot_token } : null
  }

  /** Stores the guild's roles snapshot. 'ok', a pause reason, or 'unavailable' for a transient failure. */
  private async refreshRoles(serverId: string, guildId: string, botToken: string): Promise<string> {
    let roles
    try {
      roles = await this.discord.fetchGuildRoles(botToken, guildId)
    } catch {
      return 'unavailable'
    }
    if (!roles.ok) return pauseReasonFor(roles) ?? 'unavailable'
    const names = await this.rpc('permission_bit_names')
    if (names.error || !Array.isArray(names.data)) {
      console.error('permission_bit_names failed:', names.error?.code, names.error?.message)
      return 'unavailable'
    }
    const stored = await this.rpc('discord_migration_store_discord_roles', {
      p_server_id: serverId,
      p_roles: buildRolesSnapshot(roles.value, names.data as string[]),
    })
    if (stored.error) {
      console.error('discord_migration_store_discord_roles failed:', stored.error.code, stored.error.message)
      return 'unavailable'
    }
    return 'ok'
  }

  private async call<T>(fn: () => Promise<DiscordResult<T>>): Promise<T> {
    let r: DiscordResult<T>
    try {
      r = await fn()
    } catch {
      throw new DiscordCallFailed(502, 'malformed_response')
    }
    if (!r.ok) throw new DiscordCallFailed(r.status, r.reason)
    return r.value
  }

  private async syncLink(
    serverId: string,
    guildId: string,
    botToken: string,
    l: MigrationLink,
    result: SyncResult,
    opts: { checkBans: boolean; botCanBan: boolean },
  ): Promise<
    | { kind: 'synced' | 'error'; memberFetch: boolean; failed: boolean }
    | { kind: 'candidate'; candidate: 'left' | 'banned'; memberFetch: true; failed: false }
  > {
    let found
    try {
      found = await this.call(() => this.discord.fetchGuildMember(botToken, guildId, l.discord_user_id))
    } catch (err) {
      result.errors++
      console.warn(`migration member fetch failed: ${failureOf(err).reason}`)
      return { kind: 'error', memberFetch: true, failed: true }
    }

    if (!found.present) {
      if (!opts.checkBans) return { kind: 'synced', memberFetch: true, failed: false }
      let candidate: 'left' | 'banned' = 'left'
      if (opts.botCanBan) {
        try {
          candidate = (await this.call(() => this.discord.fetchBan(botToken, guildId, l.discord_user_id))) ? 'banned' : 'left'
        } catch (err) {
          // Cannot tell a ban from leaving: leave the member alone this pass.
          result.errors++
          console.warn(`migration ban check failed: ${failureOf(err).reason}`)
          return { kind: 'error', memberFetch: true, failed: false }
        }
      }
      return { kind: 'candidate', candidate, memberFetch: true, failed: false }
    }

    const member = found.member
    const p_member: Record<string, unknown> = {
      present: true,
      role_ids: member.role_ids,
      joined_at: member.joined_at,
      timed_out_until: member.timed_out_until,
      profile: await this.buildProfile(serverId, guildId, botToken, l, member, result),
    }

    const { data, error } = await this.rpc('discord_migration_sync_member', {
      p_server_id: serverId,
      p_user_id: l.user_id,
      p_member,
    })
    if (error) {
      console.error('discord_migration_sync_member failed:', error.code, error.message)
      result.errors++
      return { kind: 'error', memberFetch: true, failed: false }
    }
    if (data?.skipped || data?.candidate) return { kind: 'synced', memberFetch: true, failed: false }
    if (data?.timeout_changed === true) result.timeouts++
    const roles = data?.roles
    if (roles) result.rolesChanged += (roles.added?.length ?? 0) + (roles.removed?.length ?? 0)
    return { kind: 'synced', memberFetch: true, failed: false }
  }

  /** Only the profile fields the member opted into; a field that cannot be fetched or mirrored is left out. */
  private async buildProfile(
    serverId: string,
    guildId: string,
    botToken: string,
    l: MigrationLink,
    member: DiscordMember,
    result: SyncResult,
  ): Promise<Record<string, unknown>> {
    const fields = new Set(l.sync_fields)
    const profile: Record<string, unknown> = {}
    const forServer = { folder: `${l.user_id}/servers/${serverId}` }

    const mirrorOf = async (url: string, bucket: string, folder: string, stem: string): Promise<string | undefined> => {
      const key = `${bucket}/${folder}/${stem}|${url}`
      const cached = this.mirrored.get(key)
      if (cached) return cached
      try {
        const path = await this.mirror(url, { bucket, folder, stem })
        if (this.mirrored.size >= MIRROR_CACHE_MAX) this.mirrored.clear()
        this.mirrored.set(key, path)
        return path
      } catch (err) {
        result.errors++
        console.warn(`migration media mirror failed: ${err instanceof Error ? err.message : 'unknown error'}`)
        return undefined
      }
    }

    if (fields.has('avatar') && member.user.avatar_url) {
      const path = await mirrorOf(member.user.avatar_url, 'avatars', l.user_id, 'avatar')
      if (path) profile.avatar_url = path
    }
    if (fields.has('display_name') && typeof member.user.global_name === 'string') {
      profile.display_name = member.user.global_name
    }
    if (fields.has('banner') || fields.has('accent_color')) {
      let user = null
      try {
        user = await this.call(() => this.discord.fetchUser(botToken, l.discord_user_id))
      } catch (err) {
        result.errors++
        console.warn(`migration user fetch failed: ${failureOf(err).reason}`)
      }
      if (user) {
        if (fields.has('banner') && user.banner_url) {
          const path = await mirrorOf(user.banner_url, 'banners', l.user_id, 'banner')
          if (path) profile.banner_url = path
        }
        if (fields.has('accent_color') && typeof user.accent_color === 'number') profile.accent_color = user.accent_color
      }
    }
    if (fields.has('server_nickname')) profile.server_nickname = member.nick
    if (fields.has('server_avatar')) {
      if (member.guild_avatar_url) {
        const path = await mirrorOf(member.guild_avatar_url, 'avatars', forServer.folder, 'avatar')
        if (path) profile.server_avatar_url = path
      } else {
        profile.server_avatar_url = null
      }
    }
    if (fields.has('server_banner')) {
      if (member.guild_banner_url) {
        const path = await mirrorOf(member.guild_banner_url, 'banners', forServer.folder, 'banner')
        if (path) profile.server_banner_url = path
      } else {
        profile.server_banner_url = null
      }
    }
    return profile
  }
}

/**
 * The value the web app stores: avatars hold the bucket's public URL (uploadAvatar, uploadServerAvatar),
 * banners hold the object path (uploadBanner, uploadServerBanner).
 */
async function defaultMirror(url: string, target: MirrorTarget): Promise<string> {
  const mirrored = await mirrorExternalMediaToStorage(url, { target })
  return target.bucket === 'avatars' ? publicStorageUrl(mirrored.url) : mirrored.path
}

async function defaultLoadMigration(serverId: string): Promise<MigrationInfo | null> {
  const { data, error } = await supabase
    .from('discord_migrations')
    .select('discord_guild_id, bot_can_ban, state, sync_paused_reason')
    .eq('server_id', serverId)
    .maybeSingle()
  if (error) {
    console.error('discord_migrations lookup failed:', error.code, error.message)
    throw new Error('migration_lookup_failed')
  }
  return (data as MigrationInfo | null) ?? null
}

async function defaultLoadLink(serverId: string, userId: string): Promise<MigrationLink | null> {
  const { data, error } = await supabase
    .from('discord_migration_links')
    .select('user_id, discord_user_id, sync_fields')
    .eq('server_id', serverId)
    .eq('user_id', userId)
    .eq('status', 'active')
    .maybeSingle()
  if (error) {
    console.error('discord_migration_links lookup failed:', error.code, error.message)
    return null
  }
  return (data as MigrationLink | null) ?? null
}
