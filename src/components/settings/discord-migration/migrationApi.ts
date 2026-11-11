/**
 * RPCs and the gateway call behind Server Settings → Migrate from Discord. Every write goes through a
 * discord_migration_* RPC (managers only); the role snapshot comes from the gateway's refresh route.
 */
import { supabase } from '@/supabase'
import { MIGRATION_CALLBACK_PATH, resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'

export type MigrationState = 'draft' | 'open' | 'finished'
export type CredentialSource = 'instance_bot' | 'bridge' | 'own'
export type LinkStatus = 'active' | 'left' | 'banned' | 'kicked_on_harmony'

export interface DiscordRoleRow {
  discord_role_id: string
  name: string
  /** Discord's 0xRRGGBB integer; 0 is "no colour". */
  color: number
  position: number
  /** Permission bitmask as a decimal string (bigint). */
  harmony_permissions: string
  fetched_at: string
}

export interface RoleMapRow {
  discord_role_id: string
  harmony_role_id: string
}

export interface Readiness {
  ready: boolean
  unmapped_roles: Array<{ discord_role_id: string; name: string }>
  has_credentials: boolean
  has_guild: boolean
  roles_fetched: boolean
}

export interface PermissionGap {
  discord_role_id: string
  harmony_role_id: string
  /** Permission names such as KICK_MEMBERS. */
  missing: string[]
}

export interface SyncResultSummary {
  checked?: number
  rolesChanged?: number
  removed?: number
  timeouts?: number
  paused?: string
  errors?: number
}

export interface MigrationConfig {
  server_id: string
  state: MigrationState | null
  discord_guild_id?: string | null
  credential_source?: CredentialSource | null
  link_token?: string
  opened_at?: string | null
  finished_at?: string | null
  last_sync_at?: string | null
  last_sync_result?: SyncResultSummary | null
  sync_requested_at?: string | null
  sync_paused_reason?: string | null
  /** Set by resuming a removal_brake pause: the next pass applies those removals once. */
  brake_override?: boolean
  bot_can_ban?: boolean | null
  readiness_warnings?: { unpaired_channels?: string[]; member_overrides?: number } | null
  has_own_credentials: boolean
  bridge_available: boolean
  instance_bot_available: boolean
  caller_is_owner: boolean
  discord_roles: DiscordRoleRow[]
  role_map: RoleMapRow[]
  link_counts: Record<LinkStatus, number>
  readiness: Readiness
  permission_gaps: PermissionGap[]
}

export interface MigrationMember {
  user_id: string
  username: string | null
  display_name: string | null
  discord_user_id: string
  status: LinkStatus
  last_synced_at: string | null
}

export interface AutoMatchRow {
  discord_role_id: string
  harmony_role_id: string | null
}

export interface AdminHolder {
  user_id: string
  username: string | null
  display_name: string | null
}

export type RefreshResult =
  | { ok: true; roles: number; canBan: boolean }
  /** error: credentials_missing, token_invalid, bot_not_in_guild, or a transport failure. */
  | { ok: false; error: string }

/** What the role rules raise, kept on the thrown Error. */
export type MigrationErrorCode =
  | 'ADMIN_ROLE_OWNER_ONLY'
  | 'ADMIN_ROLE_NEEDS_CONFIRM'
  | 'MISSING_MANAGE_ROLES'
  | 'CANNOT_GRANT'
  | 'OTHER'

export class MigrationError extends Error {
  code: MigrationErrorCode
  pg?: string
  /** For CANNOT_GRANT: the permission the caller does not hold. */
  permission?: string
  constructor(message: string, code: MigrationErrorCode, pg?: string, permission?: string) {
    super(message)
    this.name = 'MigrationError'
    this.code = code
    this.pg = pg
    this.permission = permission
  }
}

export function classifyError(error: { code?: string; message?: string }): MigrationError {
  const message = error.message || 'Request failed'
  if (message.includes('ADMIN_ROLE_OWNER_ONLY')) return new MigrationError(message, 'ADMIN_ROLE_OWNER_ONLY', error.code)
  if (message.includes('ADMIN_ROLE_NEEDS_CONFIRM')) return new MigrationError(message, 'ADMIN_ROLE_NEEDS_CONFIRM', error.code)
  if (message.includes('Missing permission: MANAGE_ROLES')) return new MigrationError(message, 'MISSING_MANAGE_ROLES', error.code)
  const grant = /Cannot grant (\w+) without holding it/.exec(message)
  if (grant) return new MigrationError(message, 'CANNOT_GRANT', error.code, grant[1])
  return new MigrationError(message, 'OTHER', error.code)
}

async function rpc<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw classifyError(error)
  return data as T
}

export const getMigration = (serverId: string) =>
  rpc<MigrationConfig>('discord_migration_get', { p_server_id: serverId })

export const saveMigration = (serverId: string, discordGuildId: string | null, credentialSource: CredentialSource | null) =>
  rpc<MigrationConfig>('discord_migration_save', {
    p_server_id: serverId,
    p_discord_guild_id: discordGuildId,
    p_credential_source: credentialSource,
  })

/** Blank or null fields keep the stored value. */
export const setOwnCredentials = (
  serverId: string,
  creds: { clientId?: string | null; clientSecret?: string | null; botToken?: string | null },
) =>
  rpc<void>('discord_migration_set_own_credentials', {
    p_server_id: serverId,
    p_client_id: creds.clientId || null,
    p_client_secret: creds.clientSecret || null,
    p_bot_token: creds.botToken || null,
  })

export const autoMatch = (serverId: string) =>
  rpc<AutoMatchRow[]>('discord_migration_auto_match', { p_server_id: serverId })

/** Replaces the whole map. */
export const saveRoleMap = (serverId: string, map: RoleMapRow[], confirmAdmin = false) =>
  rpc<Readiness>('discord_migration_save_role_map', {
    p_server_id: serverId,
    p_map: map,
    p_confirm_admin: confirmAdmin,
  })

export const adminImpact = (serverId: string, discordRoleId: string) =>
  rpc<{ holders: AdminHolder[] }>('discord_migration_admin_impact', {
    p_server_id: serverId,
    p_discord_role_id: discordRoleId,
  })

export const applyPermissions = (serverId: string, discordRoleIds: string[] | null, confirmAdmin = false) =>
  rpc<{ updated: Array<{ harmony_role_id: string; added: string[] }> }>('discord_migration_apply_permissions', {
    p_server_id: serverId,
    p_discord_role_ids: discordRoleIds,
    p_confirm_admin: confirmAdmin,
  })

export const setState = (serverId: string, state: MigrationState) =>
  rpc<MigrationConfig>('discord_migration_set_state', { p_server_id: serverId, p_state: state })

export const requestSync = (serverId: string) =>
  rpc<void>('discord_migration_request_sync', { p_server_id: serverId })

export const regenerateToken = (serverId: string) =>
  rpc<string>('discord_migration_regenerate_token', { p_server_id: serverId })

export const allowBack = (serverId: string, userId: string) =>
  rpc<void>('discord_migration_allow_back', { p_server_id: serverId, p_user_id: userId })

export const listMembers = (serverId: string) =>
  rpc<MigrationMember[]>('discord_migration_members', { p_server_id: serverId })

/** The gateway sits behind the instance's reverse proxy at /bot-gateway (see discordBridgeSetup). */
export function gatewayBaseUrl(): string {
  return `${resolveHarmonyBaseUrl()}/bot-gateway`
}

/** Discord redirects here after a member signs in; the admin registers it for the own application. */
export function migrationRedirectUri(): string {
  return `${resolveHarmonyBaseUrl()}${MIGRATION_CALLBACK_PATH}`
}

/** The invitation link members open. */
export function migrationInviteUrl(linkToken: string): string {
  return `${resolveHarmonyBaseUrl()}/migrate/${encodeURIComponent(linkToken)}`
}

/** Re-reads the guild's roles, the bot's ban permission and the readiness warnings through the gateway. */
export async function refreshFromDiscord(serverId: string): Promise<RefreshResult> {
  const { data } = await supabase.auth.getSession()
  const jwt = data.session?.access_token
  if (!jwt) return { ok: false, error: 'unauthenticated' }
  let res: Response
  try {
    res = await fetch(`${gatewayBaseUrl()}/bridge/v2/migrate/${encodeURIComponent(serverId)}/refresh`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    })
  } catch {
    return { ok: false, error: 'network' }
  }
  const body = (await res.json().catch(() => null)) as { ok?: boolean; roles?: number; canBan?: boolean; error?: string } | null
  if (body?.ok === true) return { ok: true, roles: body.roles ?? 0, canBan: body.canBan === true }
  return { ok: false, error: body?.error ?? `http_${res.status}` }
}
