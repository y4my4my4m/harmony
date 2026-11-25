/**
 * Harmony members' bridge opt-outs (bridge_member_optouts), applied to what the gateway sends a
 * bridge. A bridge reader is a bot whose platform for the channel is set (bridge_channel_platform);
 * only bots with bot_type 'bridge' or a bridge_platform can be one. Creates, edits and reaction
 * adds of a member who opted out of a reader's platform are withheld from that reader; deletes
 * (with the bridge's own mapping as their metadata) and reaction removals always go through. The
 * name of a thread speaks for its creator and for the author of its starter message.
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
 * The Harmony members a row speaks for: its author, or the invoker of a bot's interaction reply. A
 * system row has no author (messages_system_authorless); it speaks for every member its metadata
 * names: actor_id, who acted; subject_id, whom it is about (a join, a leave, a kick, a ban);
 * automod.user_id, whose message an AutoMod alert quotes.
 */
export function consentSubjects(source: ConsentSource | null | undefined): string[] {
  if (!source) return []
  if (typeof source.user_id === 'string' && source.user_id) return [source.user_id]
  const metadata = source.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return []
  const fields = metadata as {
    interaction?: { user_id?: unknown } | null
    actor_id?: unknown
    subject_id?: unknown
    automod?: { user_id?: unknown } | null
  }
  const members = source.is_system === true
    ? [fields.actor_id, fields.subject_id, fields.automod?.user_id]
    : source.bot_id ? [fields.interaction?.user_id] : []
  return [...new Set(members.filter((id): id is string => typeof id === 'string' && id !== ''))]
}

/**
 * `readers` without the bridge readers whose platform one of `subjects` opted out of in `serverId`.
 * A failed lookup withholds from every reader not known to be an ordinary bot.
 */
export async function consentingReaders(
  readers: string[],
  serverId: string,
  channelId: string,
  subjects: readonly string[],
): Promise<string[]> {
  if (subjects.length === 0 || readers.length === 0) return readers
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
      const optedOut = platform ? await memberOptOuts(serverId, platform) : null
      if (!optedOut || !subjects.some(id => optedOut.has(id))) kept.push(botId)
    } catch {
      // Withheld: the reader is a bridge and its subjects' choice is unknown.
    }
  }
  return kept
}

/** Whether a row speaking for `subjects` may reach `botId` in `channelId`. */
export async function relayAllowed(botId: string, serverId: string, channelId: string, subjects: readonly string[]): Promise<boolean> {
  return (await consentingReaders([botId], serverId, channelId, subjects)).length === 1
}

// Thread names

/** The title bot_create_thread gives an opted-out Discord author's thread. */
export const WITHHELD_THREAD_NAME = 'Thread'

export interface ThreadNameSource {
  id: string
  created_by?: string | null
  parent_message_id: string | null
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_READERS: ReadonlySet<string> = new Set()

/** The bridges of `channelId` among `readers`, and the bots whose part in it is unknown. */
export async function bridgeReaders(readers: string[], channelId: string): Promise<string[]> {
  let bridges: Set<string>
  try {
    bridges = await bridgeCandidates(readers)
  } catch {
    return readers.filter(id => candidates.get(id)?.value !== false)
  }
  const found: string[] = []
  for (const botId of readers) {
    if (!bridges.has(botId)) continue
    try {
      if ((await bridgeChannelPlatform(botId, channelId)) !== null) found.push(botId)
    } catch {
      found.push(botId)
    }
  }
  return found
}

/**
 * The members a thread's name speaks for, by thread id: its creator, and those of its starter
 * message, whose first 50 characters are the app's default name. A thread whose starter message is
 * gone is left out. Throws when the starter messages cannot be read.
 */
export async function threadNameSubjects(threads: readonly ThreadNameSource[]): Promise<Map<string, string[]>> {
  const starterIds = [...new Set(threads.flatMap(thread => thread.parent_message_id ?? []))]
  if (starterIds.length === 0) return new Map()
  const { data, error } = await supabase
    .from('messages')
    .select('id, user_id, bot_id, is_system, metadata')
    .in('id', starterIds)
  if (error || !Array.isArray(data)) throw new Error(error?.message ?? 'Thread starter messages unavailable')
  const starters = new Map((data as Array<ConsentSource & { id: string }>).map(row => [row.id, row]))
  const subjects = new Map<string, string[]>()
  for (const thread of threads) {
    const starter = thread.parent_message_id ? starters.get(thread.parent_message_id) : undefined
    if (!starter) continue
    subjects.set(thread.id, [...new Set([...(thread.created_by ? [thread.created_by] : []), ...consentSubjects(starter)])])
  }
  return subjects
}

/** metadata.thread_id of a thread_created notice that names its thread ('' without one); null for any other row. */
export function namedThreadId(source: ConsentSource): string | null {
  const metadata = source.metadata
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return null
  const fields = metadata as { type?: unknown; thread_id?: unknown; thread_name?: unknown }
  if (fields.type !== 'thread_created' || typeof fields.thread_name !== 'string') return null
  return typeof fields.thread_id === 'string' ? fields.thread_id : ''
}

/**
 * The readers a thread_created notice of each thread reaches without the thread's name: the bridge
 * readers whose platform a member it speaks for opted out of, and every bridge reader when the
 * thread or its starter message cannot be read.
 */
export async function threadNameWithheldFrom(
  readers: string[],
  serverId: string,
  channelId: string,
  threadIds: readonly string[],
): Promise<Map<string, ReadonlySet<string>>> {
  const withheld = new Map<string, ReadonlySet<string>>(threadIds.map(id => [id, NO_READERS]))
  if (threadIds.length === 0) return withheld
  const bridges = await bridgeReaders(readers, channelId)
  if (bridges.length === 0) return withheld
  let subjects = new Map<string, string[]>()
  try {
    const { data, error } = await supabase
      .from('threads')
      .select('id, created_by, parent_message_id')
      .in('id', threadIds.filter(id => UUID.test(id)))
    if (!error && Array.isArray(data)) subjects = await threadNameSubjects(data as ThreadNameSource[])
  } catch {
    // Withheld from every bridge reader: no thread has subjects.
  }
  for (const id of withheld.keys()) {
    const members = subjects.get(id)
    const reading = new Set(members ? await consentingReaders(bridges, serverId, channelId, members) : [])
    withheld.set(id, new Set(bridges.filter(botId => !reading.has(botId))))
  }
  return withheld
}

/** A thread_created notice as a reader its thread's name is withheld from gets it. */
export function withoutThreadName<T extends ConsentSource>(notice: T): T {
  return { ...notice, metadata: { ...(notice.metadata as Record<string, unknown>), thread_name: WITHHELD_THREAD_NAME } }
}
