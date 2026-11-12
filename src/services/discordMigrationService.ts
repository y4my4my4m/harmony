/**
 * "Migrate from Discord", the member side: the public /migrate/<token> page, claiming a ticket,
 * the profile fields a link may copy, and the join date shown on profile cards.
 *
 * Gateway routes live under <instance>/bot-gateway/bridge/v2/migrate/; the claim and the link
 * itself are RPCs.
 */
import { supabase } from '@/supabase'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'

export const SYNC_FIELDS = [
  'avatar',
  'display_name',
  'banner',
  'accent_color',
  'server_nickname',
  'server_avatar',
  'server_banner',
] as const
export type SyncField = (typeof SYNC_FIELDS)[number]

/** An error code of the flow in lower case: harmony_banned, ticket_expired, username_taken, ... */
export class DiscordMigrationError extends Error {
  code: string
  constructor(code: string) {
    super(code)
    this.name = 'DiscordMigrationError'
    this.code = code
  }
}

export interface MigrationPreview {
  serverId: string
  serverName: string
  iconUrl: string | null
}

export interface ClaimResult {
  serverId: string
  rolesGranted: string[]
  /** The claimer owns the server: roles are only ever added to them. */
  isOwner: boolean
}

export interface MigrationLink {
  status: string
  syncFields: SyncField[]
  discordJoinedAt: string | null
}

const GATEWAY_PREFIX = '/bot-gateway/bridge/v2/migrate'

function gatewayUrl(path: string): string {
  return `${resolveHarmonyBaseUrl().replace(/\/$/, '')}${GATEWAY_PREFIX}${path}`
}

/** The error code an RPC raised: its message is the upper-case code (HARMONY_BANNED, ...). */
function rpcCode(error: { message?: string; code?: string }): string {
  const match = /[A-Z][A-Z_]{3,}/.exec(error.message ?? '')
  return match ? match[0].toLowerCase() : 'unknown'
}

export async function preview(token: string): Promise<MigrationPreview | null> {
  const { data, error } = await supabase.rpc('discord_migration_preview', { p_token: token })
  if (error) throw new DiscordMigrationError('unavailable')
  const row = data as { server_id?: string; server_name?: string; icon_url?: string | null } | null
  if (!row?.server_name) return null
  return { serverId: row.server_id ?? '', serverName: row.server_name, iconUrl: row.icon_url ?? null }
}

/** Full-page navigation: the gateway sends the browser on to Discord and back to /migrate/<token>. */
export function startDiscordSignIn(token: string): void {
  window.location.assign(gatewayUrl(`/authorize?token=${encodeURIComponent(token)}`))
}

export async function createAccount(input: {
  ticket: string
  username: string
  email: string
  password: string
}): Promise<{ needsConfirmation: boolean }> {
  let response: Response
  try {
    response = await fetch(gatewayUrl('/account'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
  } catch {
    throw new DiscordMigrationError('network')
  }
  const body = (await response.json().catch(() => ({}))) as { error?: string; needsConfirmation?: boolean }
  if (!response.ok) throw new DiscordMigrationError(body.error ?? 'unknown')
  return { needsConfirmation: body.needsConfirmation === true }
}

export async function claim(ticket: string): Promise<ClaimResult> {
  const { data, error } = await supabase.rpc('discord_migration_claim', { p_ticket: ticket })
  if (error) throw new DiscordMigrationError(rpcCode(error))
  const row = (data ?? {}) as { server_id?: string; roles_granted?: string[]; is_owner?: boolean }
  return { serverId: String(row.server_id ?? ''), rolesGranted: row.roles_granted ?? [], isOwner: row.is_owner === true }
}

// -------------------------------------------------------------------------------------------
// Toggles chosen before the claim exists (the new-account form) wait in localStorage per ticket.
// -------------------------------------------------------------------------------------------

const SYNC_CHOICE_PREFIX = 'discord-migration-sync:'
/** A ticket lives seven days; a choice saved for it is dropped after the same time. */
const SYNC_CHOICE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000

export function saveSyncChoice(ticket: string, fields: SyncField[]): void {
  try {
    localStorage.setItem(SYNC_CHOICE_PREFIX + ticket, JSON.stringify({ fields, savedAt: Date.now() }))
  } catch {
    /* storage unavailable: the member can set the toggles in Settings */
  }
}

function takeSyncChoice(ticket: string): SyncField[] | null {
  try {
    const raw = localStorage.getItem(SYNC_CHOICE_PREFIX + ticket)
    if (raw === null) return null
    localStorage.removeItem(SYNC_CHOICE_PREFIX + ticket)
    const parsed = JSON.parse(raw) as { fields?: unknown; savedAt?: unknown } | null
    if (!parsed || typeof parsed.savedAt !== 'number' || Date.now() - parsed.savedAt > SYNC_CHOICE_MAX_AGE_MS) return null
    return Array.isArray(parsed.fields)
      ? parsed.fields.filter((f): f is SyncField => (SYNC_FIELDS as readonly string[]).includes(f))
      : null
  } catch {
    return null
  }
}

/**
 * Claims every ticket bound to the signed-in account (an account made on /migrate/<token> claims
 * once its email is confirmed and its profile exists), then applies the toggles saved for it. An
 * expired ticket is dropped silently; other failures leave the ticket for the next sign-in.
 */
export async function completePendingClaims(): Promise<ClaimResult[]> {
  const { data, error } = await supabase.rpc('discord_migration_my_pending_claims')
  if (error || !Array.isArray(data)) return []
  const results: ClaimResult[] = []
  for (const pending of data as Array<{ ticket: string }>) {
    try {
      const result = await claim(pending.ticket)
      results.push(result)
      const chosen = takeSyncChoice(pending.ticket)
      if (chosen && chosen.length > 0) {
        // Saving the fields also asks for the sync.
        await setMySync(result.serverId, chosen).catch(() => {})
      } else {
        // The roles on the ticket may be days old: have the gateway read Discord now.
        void requestMySync(result.serverId)
      }
    } catch (err) {
      // A refusal of the claim (expired, banned, closed, ...) is final for this ticket: its saved
      // choice goes too. An unrecognised failure may be transient and keeps the ticket's choice.
      if (err instanceof DiscordMigrationError && err.code !== 'unknown') takeSyncChoice(pending.ticket)
    }
  }
  return results
}

let pendingClaimsFor: string | null = null

/** completePendingClaims at most once per signed-in user per page load; never throws. */
export function completePendingClaimsOnce(userId: string): void {
  if (pendingClaimsFor === userId) return
  pendingClaimsFor = userId
  void completePendingClaims().catch(() => {})
}

// -------------------------------------------------------------------------------------------
// The signed-in member's link
// -------------------------------------------------------------------------------------------

export async function myLink(serverId: string): Promise<MigrationLink | null> {
  const { data, error } = await supabase.rpc('discord_migration_my_link', { p_server_id: serverId })
  if (error || !data) return null
  const row = data as { status?: string; sync_fields?: string[]; discord_joined_at?: string | null }
  return {
    status: row.status ?? 'active',
    syncFields: (row.sync_fields ?? []).filter((f): f is SyncField => (SYNC_FIELDS as readonly string[]).includes(f)),
    discordJoinedAt: row.discord_joined_at ?? null,
  }
}

/**
 * Saves which profile fields the link copies, then asks the gateway to copy them now. The save is
 * what counts; a failed immediate sync is picked up by the next scheduled pass.
 */
export async function setMySync(serverId: string, fields: SyncField[]): Promise<void> {
  const { error } = await supabase.rpc('discord_migration_set_my_sync', { p_server_id: serverId, p_fields: fields })
  if (error) throw new DiscordMigrationError(rpcCode(error))
  if (fields.length === 0) return
  await requestMySync(serverId)
}

/**
 * Asks the gateway to sync the signed-in member's link now (roles and the chosen fields). Best
 * effort: a failure is ignored, the next scheduled pass does the same work.
 */
export async function requestMySync(serverId: string): Promise<void> {
  try {
    const { data } = await supabase.auth.getSession()
    const jwt = data.session?.access_token
    if (!jwt) return
    await fetch(gatewayUrl(`/me/${encodeURIComponent(serverId)}/sync`), {
      method: 'POST',
      headers: { Authorization: `Bearer ${jwt}` },
    })
  } catch {
    /* the scheduled sync does it later */
  }
}

// -------------------------------------------------------------------------------------------
// Profile cards
// -------------------------------------------------------------------------------------------

const joinedAtCache = new Map<string, Promise<string | null>>()

/** "Joined on Discord" date of a member, fetched once per server and user. */
export function memberJoinedAt(serverId: string, userId: string): Promise<string | null> {
  const key = `${serverId}:${userId}`
  let cached = joinedAtCache.get(key)
  if (!cached) {
    cached = Promise.resolve(supabase.rpc('discord_migration_member_joined_at', { p_server_id: serverId, p_user_id: userId }))
      .then(({ data, error }) => {
        if (error) {
          joinedAtCache.delete(key)
          return null
        }
        return typeof data === 'string' ? data : null
      })
      .catch(() => {
        joinedAtCache.delete(key)
        return null
      })
    joinedAtCache.set(key, cached)
  }
  return cached
}
