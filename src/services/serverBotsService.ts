import { supabase } from '@/supabase'
import type { CustomUserStatus } from '@/types'
import { botMemberStatus, type BotMemberStatus } from '@/utils/botUtils'
import { formatCustomStatusDisplay } from '@/utils/customStatusDisplay'

/** One row of public.get_server_bots. */
export interface ServerBotRow {
  id: string
  username: string
  display_name: string | null
  avatar_url: string | null
  bot_type: string | null
  status: string | null
  custom_status: string | null
  activity_type: string | null
  activity_name: string | null
  last_heartbeat_at: string | null
}

/** A bot installed in a server, as the member list renders it. Derived once per fetch. */
export interface ServerBot {
  id: string
  username: string
  displayName: string
  avatarUrl: string
  botType: string | null
  status: BotMemberStatus
  /** Activity type for ActivityIcon; null for a custom status or none. */
  activityType: Exclude<CustomUserStatus['type'], 'custom' | undefined> | null
  /** Custom status, else "Playing: name"; empty when neither is set. */
  statusText: string
  /** Lowercased display name, the collation key. */
  sortKey: string
}

/** Window event re-dispatching a server-structure `bot:*` broadcast; detail carries server_id and bot_id. */
export const SERVER_BOT_CHANGE_EVENT = 'server-structure:bot-change'

const DEFAULT_AVATAR = '/default_avatar.webp'

const ACTIVITY_TYPES = new Set(['playing', 'listening', 'watching', 'competing', 'streaming'])

type ActivityType = NonNullable<ServerBot['activityType']>

/** Custom status takes precedence over the activity. */
function botStatusLine(row: ServerBotRow): { type: ActivityType | null; text: string } {
  const custom = row.custom_status?.trim()
  if (custom) return { type: null, text: custom }
  const name = row.activity_name?.trim()
  if (!name) return { type: null, text: '' }
  if (row.activity_type && ACTIVITY_TYPES.has(row.activity_type)) {
    const type = row.activity_type as ActivityType
    return { type, text: formatCustomStatusDisplay({ type, text: name }) }
  }
  return { type: null, text: name }
}

export function toServerBot(row: ServerBotRow, now = Date.now()): ServerBot {
  const displayName = row.display_name?.trim() || row.username
  const line = botStatusLine(row)
  return {
    id: row.id,
    username: row.username,
    displayName,
    avatarUrl: row.avatar_url || DEFAULT_AVATAR,
    botType: row.bot_type,
    status: botMemberStatus(row, now),
    activityType: line.type,
    statusText: line.text,
    sortKey: displayName.toLowerCase(),
  }
}

/** Active bots installed in a server. Empty for a caller who is neither an accepted member nor an instance admin. */
export async function fetchServerBots(serverId: string): Promise<ServerBot[]> {
  const { data, error } = await supabase.rpc('get_server_bots', { p_server_id: serverId })
  if (error) throw error
  const now = Date.now()
  return ((data ?? []) as ServerBotRow[]).map(row => toServerBot(row, now))
}

export type ServerBotGroups = Record<BotMemberStatus, ServerBot[]>

/** Bots matching `query` by display name or username, by status, each group in collation order. */
export function groupServerBots(
  bots: readonly ServerBot[],
  query: string,
  collator: Intl.Collator,
): ServerBotGroups {
  const groups: ServerBotGroups = { online: [], away: [], busy: [], offline: [] }
  const q = query.trim().toLowerCase()
  for (const bot of bots) {
    if (q && !bot.sortKey.includes(q) && !bot.username.toLowerCase().includes(q)) continue
    groups[bot.status].push(bot)
  }
  for (const group of Object.values(groups)) {
    group.sort((a, b) => collator.compare(a.sortKey, b.sortKey))
  }
  return groups
}
