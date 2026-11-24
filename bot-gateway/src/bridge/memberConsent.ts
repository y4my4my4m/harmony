/**
 * Harmony members' bridge opt-outs (bridge_member_optouts), applied to what the gateway sends a
 * bridge. A bridge reader is a bot whose platform for the channel is set (bridge_channel_platform);
 * only bots with bot_type 'bridge' or a bridge_platform can be one. Creates, edits and reaction
 * adds of a member who opted out of a reader's platform are withheld from that reader; deletes and
 * reaction removals always go through.
 *
 * Caches: bridge candidacy per bot 60 s, platform per (bot, channel) 10 s, a server's opt-outs per
 * platform 5 s. An opt-out reaches dispatch within 5 s; a pairing change within 10 s.
 */
import { supabase } from '../config/supabase.js'

export type BridgePlatform = 'discord' | 'matrix'

const CANDIDATE_TTL_MS = 60_000
const PLATFORM_TTL_MS = 10_000
const OPTOUT_TTL_MS = 5_000
// channels.server_id changes only through admin moves between servers.
const SERVER_TTL_MS = 3_600_000

interface Timed<T> { at: number; value: T }

const candidates = new Map<string, Timed<boolean>>()
const platforms = new Map<string, Timed<Promise<BridgePlatform | null>>>()
const optouts = new Map<string, Timed<Promise<ReadonlySet<string>>>>()
const servers = new Map<string, Timed<string>>()

const fresh = <T>(entry: Timed<T> | undefined, ttl: number): entry is Timed<T> =>
  !!entry && Date.now() - entry.at < ttl

/** Which of `botIds` can be a bridge. Throws when the lookup fails and a bot is not cached. */
async function bridgeCandidates(botIds: string[]): Promise<Set<string>> {
  const unknown = botIds.filter(id => !fresh(candidates.get(id), CANDIDATE_TTL_MS))
  if (unknown.length > 0) {
    const { data, error } = await supabase.from('bots').select('id, bot_type, bridge_platform').in('id', unknown)
    if (error || !Array.isArray(data)) throw new Error('Bridge candidacy unavailable')
    const at = Date.now()
    const found = new Map(data.map((row: any) => [row.id, row.bot_type === 'bridge' || row.bridge_platform != null]))
    for (const id of unknown) candidates.set(id, { at, value: found.get(id) === true })
  }
  return new Set(botIds.filter(id => candidates.get(id)?.value === true))
}

/** The bridge platform `botId` relays `channelId` to, or null. Throws when unavailable. */
export function bridgeChannelPlatform(botId: string, channelId: string): Promise<BridgePlatform | null> {
  const key = `${botId}:${channelId}`
  const cached = platforms.get(key)
  if (fresh(cached, PLATFORM_TTL_MS)) return cached.value
  const value = (async () => {
    const { data, error } = await supabase.rpc('bridge_channel_platform', { p_bot_id: botId, p_channel_id: channelId })
    if (error || (data !== null && data !== 'matrix' && data !== 'discord')) throw new Error('Bridge registration unavailable')
    return data as BridgePlatform | null
  })()
  platforms.set(key, { at: Date.now(), value })
  value.catch(() => { if (platforms.get(key)?.value === value) platforms.delete(key) })
  return value
}

/** Members of `serverId` who opted out of `platform`. Throws when unavailable. */
export function memberOptOuts(serverId: string, platform: BridgePlatform): Promise<ReadonlySet<string>> {
  const key = `${serverId}:${platform}`
  const cached = optouts.get(key)
  if (fresh(cached, OPTOUT_TTL_MS)) return cached.value
  const value = (async () => {
    const { data, error } = await supabase.rpc('bridge_member_optout_ids', { p_server_id: serverId, p_platform: platform })
    const ids = (data as { user_ids?: unknown } | null)?.user_ids
    if (error || !Array.isArray(ids) || ids.some(id => typeof id !== 'string')) throw new Error('Bridge privacy status unavailable')
    return new Set(ids as string[]) as ReadonlySet<string>
  })()
  optouts.set(key, { at: Date.now(), value })
  value.catch(() => { if (optouts.get(key)?.value === value) optouts.delete(key) })
  return value
}

/** The server of `channelId`; null when unknown. Only found servers are cached. */
export async function serverOfChannel(channelId: string): Promise<string | null> {
  const cached = servers.get(channelId)
  if (fresh(cached, SERVER_TTL_MS)) return cached.value
  const { data, error } = await supabase.from('channels').select('server_id').eq('id', channelId).maybeSingle()
  const serverId = !error && typeof data?.server_id === 'string' ? data.server_id : null
  if (serverId) servers.set(channelId, { at: Date.now(), value: serverId })
  return serverId
}

/** Drops cached platforms and opt-outs; a pairing or opt-out change takes effect on the next event. */
export function forgetBridgeConsent(): void {
  candidates.clear()
  platforms.clear()
  optouts.clear()
}

export interface ConsentSource {
  user_id?: string | null
  bot_id?: string | null
  is_system?: boolean | null
  metadata?: unknown
}

/**
 * The Harmony member a row speaks for: its author, or the invoker of a bot's interaction reply. A
 * system row has no author (messages_system_authorless): the member who acted is metadata.actor_id,
 * or metadata.subject_id where a member's own join or leave names no actor.
 */
export function consentSubject(source: ConsentSource | null | undefined): string | null {
  if (!source) return null
  if (typeof source.user_id === 'string' && source.user_id) return source.user_id
  const metadata = source.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const fields = metadata as { interaction?: { user_id?: unknown }; actor_id?: unknown; subject_id?: unknown }
  const member = source.is_system === true
    ? fields.actor_id ?? fields.subject_id
    : source.bot_id ? fields.interaction?.user_id : null
  return typeof member === 'string' && member ? member : null
}

/**
 * `readers` without the bridge readers whose platform `subject` opted out of in `serverId`. A
 * failed lookup withholds from every reader not known to be an ordinary bot.
 */
export async function consentingReaders(
  readers: string[],
  serverId: string,
  channelId: string,
  subject: string | null,
): Promise<string[]> {
  if (!subject || readers.length === 0) return readers
  let bridges: Set<string>
  try {
    bridges = await bridgeCandidates(readers)
  } catch {
    return readers.filter(id => candidates.get(id)?.value === false)
  }
  if (bridges.size === 0) return readers
  const kept: string[] = []
  for (const botId of readers) {
    if (!bridges.has(botId)) {
      kept.push(botId)
      continue
    }
    try {
      const platform = await bridgeChannelPlatform(botId, channelId)
      if (!platform || !(await memberOptOuts(serverId, platform)).has(subject)) kept.push(botId)
    } catch {
      // Withheld: the reader is a bridge and its subject's choice is unknown.
    }
  }
  return kept
}

/** Whether `subject`'s rows may reach `botId` in `channelId` (the bridge-consent endpoint, history reads). */
export async function relayAllowed(botId: string, serverId: string, channelId: string, subject: string | null): Promise<boolean> {
  return (await consentingReaders([botId], serverId, channelId, subject)).length === 1
}
