import { supabase } from '@/supabase'
import { authContextService } from '@/services/AuthContextService'
import { toServerBot, type ServerBot } from '@/services/serverBotsService'
import { defaultBotPermissions } from '@/utils/botUtils'

export interface BotCommand {
  name: string
  description: string | null
}

export interface BotSupportServer {
  id: string
  name: string
  icon: string | null
}

/** public.get_bot_profile result. */
export interface BotProfileRow {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  banner_url: string | null
  bio: string | null
  bot_type: string | null
  is_verified: boolean
  is_public: boolean
  website_url: string | null
  created_at: string | null
  support_server: BotSupportServer | null
  presence: {
    status: string | null
    custom_status: string | null
    activity_type: string | null
    activity_name: string | null
    last_heartbeat_at: string | null
  } | null
  commands: BotCommand[] | null
}

export interface BotWebsite {
  href: string
  label: string
}

export interface BotProfile extends ServerBot {
  bannerUrl: string | null
  bio: string
  isVerified: boolean
  isPublic: boolean
  website: BotWebsite | null
  createdAt: string | null
  supportServer: BotSupportServer | null
  commands: BotCommand[]
}

/** An http(s) URL as a link; anything else, javascript: included, is dropped. */
export function botWebsite(url: string | null | undefined): BotWebsite | null {
  const raw = url?.trim()
  if (!raw) return null
  let parsed: URL
  try {
    parsed = new URL(raw)
  } catch {
    return null
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null
  const path = parsed.pathname === '/' ? '' : parsed.pathname
  return { href: parsed.href, label: `${parsed.host}${path}` }
}

export function toBotProfile(row: BotProfileRow, now = Date.now()): BotProfile {
  const presence = row.presence
  return {
    ...toServerBot({
      id: row.id,
      username: row.username,
      display_name: row.display_name,
      avatar_url: row.avatar_url,
      bot_type: row.bot_type,
      status: presence?.status ?? 'offline',
      custom_status: presence?.custom_status ?? null,
      activity_type: presence?.activity_type ?? null,
      activity_name: presence?.activity_name ?? null,
      last_heartbeat_at: presence?.last_heartbeat_at ?? null,
    }, now),
    bannerUrl: row.banner_url || null,
    bio: row.bio?.trim() ?? '',
    isVerified: row.is_verified === true,
    isPublic: row.is_public === true,
    website: botWebsite(row.website_url),
    createdAt: row.created_at,
    supportServer: row.support_server ?? null,
    commands: row.commands ?? [],
  }
}

/** One bot for its card. Null when it is inactive or the caller may not see it. */
export async function fetchBotProfile(botId: string): Promise<BotProfile | null> {
  const { data, error } = await supabase.rpc('get_bot_profile', { p_bot_id: botId })
  if (error) throw error
  return data ? toBotProfile(data as BotProfileRow) : null
}

export interface BotInstallTarget {
  id: string
  name: string
  icon: string | null
}

export interface BotInstallTargets {
  servers: BotInstallTarget[]
  installed: Set<string>
}

/** Servers the caller owns, which add_bot_to_server admits, and those already running the bot. */
export async function fetchBotInstallTargets(botId: string): Promise<BotInstallTargets> {
  const profileId = await authContextService.getCurrentProfileId()
  const { data: servers, error } = await supabase
    .from('servers')
    .select('id, name, icon')
    .eq('owner', profileId)
    .order('name')
  if (error) throw error
  const list = (servers ?? []) as BotInstallTarget[]

  let installed = new Set<string>()
  if (list.length > 0) {
    const { data: rows, error: permError } = await supabase
      .from('bot_server_permissions')
      .select('server_id')
      .eq('bot_id', botId)
      .eq('is_active', true)
      .in('server_id', list.map(s => s.id))
    if (permError) throw permError
    installed = new Set(((rows ?? []) as Array<{ server_id: string }>).map(r => r.server_id))
  }
  return { servers: list, installed }
}

/** Installs with the default permissions; flags outside them take the RPC's column defaults. */
export async function addBotToServer(botId: string, botType: string | null | undefined, serverId: string): Promise<void> {
  const profileId = await authContextService.getCurrentProfileId()
  const { error } = await supabase.rpc('add_bot_to_server', {
    p_bot_id: botId,
    p_server_id: serverId,
    p_installed_by: profileId,
    p_permissions: defaultBotPermissions(botType),
  })
  if (error) throw error
}

/** True when the bot has an active installation in the server, as its members read it. */
export async function isBotInstalled(botId: string, serverId: string): Promise<boolean> {
  const { data, error } = await supabase
    .from('bot_server_permissions')
    .select('id')
    .eq('bot_id', botId)
    .eq('server_id', serverId)
    .eq('is_active', true)
    .limit(1)
  if (error) throw error
  return (data ?? []).length > 0
}

/** Deactivates the installation. RLS admits the server owner and filters anyone else to zero rows. */
export async function removeBotFromServer(botId: string, serverId: string): Promise<void> {
  const { data, error } = await supabase
    .from('bot_server_permissions')
    .update({ is_active: false })
    .eq('bot_id', botId)
    .eq('server_id', serverId)
    .select('id')
  if (error) throw error
  if (!data?.length) throw new Error('bot_server_permissions row was not updated')
}
