import { supabase } from '../config/supabase.js'
import type { WebSocketGateway } from './WebSocketGateway.js'
import { TTLCache } from '../utils/TTLCache.js'
import { withSignedMessageMedia } from '../utils/messageMedia.js'
import { absoluteAvatarUrl } from '../utils/avatarUrl.js'
import { absoluteEmojiUrl, isAnimatedEmojiUrl, isDiscordCdnUrl } from '../utils/emojiUrl.js'
import {
  type EveryoneLayer,
  type InstallRow,
  botCanReadChannel,
  loadEveryoneLayer,
} from '../auth/botPermissions.js'

// Cached bot_server_permissions row, every column: see loadInstall().
type BotPermissionRow = InstallRow & { bot_id: string }

// A reactions row as MESSAGE_REACTION_ADD and MESSAGE_REACTION_REMOVE describe it.
interface ReactionRow {
  id: string
  message_id: string
  channel_id: string | null
  user_id?: string | null
  bot_id?: string | null
  emoji_id?: string | null
  custom_emoji_content?: string | null
  metadata?: Record<string, unknown> | null
}

const REACTION_COLUMNS = 'id, message_id, channel_id, user_id, bot_id, emoji_id, custom_emoji_content, metadata, created_at'
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
// role_mention roleId of @here (db_schema/migrations/20261011600001_here_mention.sql).
const HERE_ROLE_ID = 'here'

// A server's install rows as one comparable string; column and row order are not significant.
function installsFingerprint(rows: BotPermissionRow[]): string {
  return JSON.stringify(
    rows
      .map(row => JSON.stringify(Object.entries(row).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))))
      .sort(),
  )
}

function reactionRow(r: ReactionRow): ReactionRow {
  return {
    id: r.id,
    message_id: r.message_id,
    channel_id: r.channel_id,
    user_id: r.user_id ?? null,
    bot_id: r.bot_id ?? null,
    emoji_id: r.emoji_id ?? null,
    custom_emoji_content: r.custom_emoji_content ?? null,
    metadata: r.metadata ?? null,
  }
}

// BUGS.md PC1: without these caches each handled message costs two extra DB
// queries (channel → server, then server → bot permissions), across three
// handlers (create/update/delete), on top of the polling baseline.
//
// channel.server_id changes only through admin moves between servers, so the
// 1 hour TTL keeps the cache warm for the life of the gateway.
//
// bot_server_permissions changes when a server owner installs, edits or removes
// a bot. The web client writes it directly, so no change reaches this process:
// refreshBotPermissions re-reads every cached server each
// BOT_PERMISSIONS_REFRESH_MS and drops entries that differ, which bounds how
// long a removed or narrowed install keeps receiving events. The TTL bounds the
// refreshed set to servers with recent traffic.
const CHANNEL_TO_SERVER_TTL_MS = 60 * 60 * 1000
const CHANNEL_TO_SERVER_MAX = 10_000
const BOT_PERMISSIONS_TTL_MS = 5 * 60 * 1000
const BOT_PERMISSIONS_MAX = 1_000
const BOT_PERMISSIONS_REFRESH_MS = 10 * 1000
// server_id values per refresh query; 100 UUIDs keep the PostgREST URL near 4 KB.
const BOT_PERMISSIONS_REFRESH_BATCH = 100
// @everyone's channel layer decides whether a bot sees a channel. A channel hidden from
// @everyone stops reaching bots within this bound.
const CHANNEL_LAYER_TTL_MS = 10 * 1000
const CHANNEL_LAYER_MAX = 10_000
// user_servers.nickname per server and user. A nickname change reaches message events within
// this bound.
const NICKNAME_TTL_MS = 60 * 1000
const NICKNAME_MAX = 20_000
// channel_message_changes (migration 20261009000001): edited and soft-deleted channel messages
// ordered by (updated_at, id). updated_at moves only on a content change or a soft delete.
const CHANGE_PAGE = 500
const CHANGE_PAGES_PER_TICK = 10
// updated_at is stamped at transaction start and visible at commit, so a row can appear behind
// the cursor. Each tick re-reads this far behind it; changeSeen drops the repeats.
const CHANGE_OVERLAP_MS = 30_000
const CHANGE_SEEN_MAX = 50_000
// Ids already sent MESSAGE_DELETE, soft or hard.
const DELETED_MAX = 10_000
const DELETED_TTL_MS = 24 * 60 * 60 * 1000
const NIL_UUID = '00000000-0000-0000-0000-000000000000'

interface FeedPosition {
  at: string
  id: string
}

/**
 * Microseconds since the epoch of a timestamptz as Postgres renders it in JSON
 * ("2026-10-08T12:00:00.123456+00:00"); Date.parse keeps milliseconds only.
 */
export function timestampMicros(ts: string): number {
  const m = /^(.*T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(.*)$/.exec(ts)
  if (!m) return Date.parse(ts) * 1000
  const fraction = Number((m[2] ?? '').padEnd(6, '0').slice(0, 6))
  return Date.parse(m[1] + (m[3] || 'Z')) * 1000 + fraction
}

export class EventDispatcher {
  private subscriptions: any[] = []
  private pollingInterval: NodeJS.Timeout | null = null
  private editPollingInterval: NodeJS.Timeout | null = null
  private reactionPollingInterval: NodeJS.Timeout | null = null
  private permissionRefreshInterval: NodeJS.Timeout | null = null
  private pollsInFlight = new Set<string>()
  private lastProcessedTimestamp: Date = new Date()
  private lastReactionTimestamp: Date = new Date()
  private processedMessageIds: Set<string> = new Set()

  // Highest (updated_at, id) handled from channel_message_changes; null until the database
  // clock is read. Rows stamped at or before changeFloorMicros predate start and are not sent.
  private changeCursor: FeedPosition | null = null
  private changeFloorMicros = 0
  // Keyset position of a drain cut short by CHANGE_PAGES_PER_TICK or an error.
  private changeResume: FeedPosition | null = null
  // id -> updated_at last handled, for rows inside the overlap window.
  private changeSeen = new Map<string, string>()
  private deletedIds = new TTLCache<string, true>(DELETED_MAX, DELETED_TTL_MS)

  // Reactions are hard-deleted. Removals are detected by diffing a window of
  // known reaction IDs against what exists.
  // The row is kept so a removal describes the reaction as its add did.
  private knownReactionIds: Set<string> = new Set()
  private reactionContext: Map<string, ReactionRow> = new Map()
  // emoji_id -> custom emoji name and url. Read-mostly.
  private emojiCache = new TTLCache<string, { name: string | null; url: string | null }>(5_000, 30 * 60 * 1000)

  // Read-mostly lookup caches; see CHANNEL_TO_SERVER_TTL_MS above. Null is
  // cached as well, so deleted or inaccessible channels are not re-queried.
  private channelToServerCache = new TTLCache<string, string | null>(
    CHANNEL_TO_SERVER_MAX,
    CHANNEL_TO_SERVER_TTL_MS,
  )
  private botPermissionsCache = new TTLCache<string, BotPermissionRow[]>(
    BOT_PERMISSIONS_MAX,
    BOT_PERMISSIONS_TTL_MS,
  )
  private channelLayerCache = new TTLCache<string, EveryoneLayer>(
    CHANNEL_LAYER_MAX,
    CHANNEL_LAYER_TTL_MS,
  )
  // Author (user or bot) lookup cache. Username/display_name/avatar are
  // read-mostly; 10 minutes of staleness costs nothing for event dispatch and
  // saves one DB roundtrip per message.
  private authorCache = new TTLCache<string, {
    id: string
    username: string
    display_name: string
    avatar_url: string | null
    isBot: boolean
  } | null>(5_000, 10 * 60 * 1000)
  // Key `${server_id}:${user_id}`; null is cached for an author without a nickname.
  private nicknameCache = new TTLCache<string, string | null>(NICKNAME_MAX, NICKNAME_TTL_MS)
  
  constructor(private gateway: WebSocketGateway) {}
  
  async start() {
    console.log('Starting Event Dispatcher...')
    
    await this.initializeChangeFeed()
    await this.initializeKnownReactions()
    
    // Polling for all events; more reliable than Realtime.
    this.startPolling()
    
    console.log('Event Dispatcher started with polling mode (creates, edits, deletes, reactions)')
  }
  
  /** Starts the change feed at the database clock: nothing earlier is dispatched. */
  private async initializeChangeFeed(): Promise<boolean> {
    const { data, error } = await supabase.rpc('channel_message_changes', {
      p_after_at: null,
      p_after_id: null,
      p_limit: 1,
    })
    if (error || typeof data?.now !== 'string') {
      console.error('channel_message_changes: no database clock; edits and deletes wait:', error?.message)
      return false
    }
    this.changeCursor = { at: data.now, id: NIL_UUID }
    this.changeFloorMicros = timestampMicros(data.now)
    return true
  }

  private startPolling() {
    console.log('Starting polling mode for all message events...')
    
    this.pollingInterval = this.schedulePoll('messages', 1000, () => this.pollMessages())

    this.editPollingInterval = this.schedulePoll('edits', 2000, () => this.pollMessageChanges())

    // Reaction polling feeds MESSAGE_REACTION_ADD / MESSAGE_REACTION_REMOVE to
    // bots and the Discord bridge.
    this.reactionPollingInterval = this.schedulePoll('reactions', 2000, () => this.pollReactions())

    this.permissionRefreshInterval = this.schedulePoll(
      'permissions',
      BOT_PERMISSIONS_REFRESH_MS,
      () => this.refreshBotPermissions(),
    )
  }

  // A tick that finds its previous run unfinished is skipped. Overlapping runs
  // read the same cursor window and dispatch the same event twice.
  private schedulePoll(name: string, periodMs: number, poll: () => Promise<void>): NodeJS.Timeout {
    return setInterval(async () => {
      if (this.pollsInFlight.has(name)) return
      this.pollsInFlight.add(name)
      try {
        await poll()
      } finally {
        this.pollsInFlight.delete(name)
      }
    }, periodMs)
  }

  // Reactions

  private async initializeKnownReactions() {
    // Seeds the known-reaction window: historical reactions are not replayed
    // as adds on startup, and removals become detectable.
    const twentyFourHoursAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    const { data: reactions } = await supabase
      .from('reactions')
      .select(REACTION_COLUMNS)
      .gt('created_at', twentyFourHoursAgo)
      .order('created_at', { ascending: false })
      .limit(5000)

    if (reactions) {
      for (const r of reactions) {
        this.knownReactionIds.add(r.id)
        this.reactionContext.set(r.id, reactionRow(r))
      }
      console.log(`Initialized ${reactions.length} known reactions for add/remove tracking (last 24h)`)
    }
  }

  private async pollReactions() {
    try {
      // --- new reactions (adds) ---
      const { data: newReactions, error } = await supabase
        .from('reactions')
        .select(REACTION_COLUMNS)
        .gt('created_at', this.lastReactionTimestamp.toISOString())
        .order('created_at', { ascending: true })
        .limit(100)

      if (error) {
        console.error('Error polling reactions:', error)
      } else if (newReactions?.length) {
        for (const r of newReactions) {
          if (!this.knownReactionIds.has(r.id)) {
            await this.handleReactionEvent('MESSAGE_REACTION_ADD', r)
            this.knownReactionIds.add(r.id)
            this.reactionContext.set(r.id, reactionRow(r))
          }
          this.lastReactionTimestamp = new Date(r.created_at)
        }

        // Keep the tracking set bounded.
        if (this.knownReactionIds.size > 10000) {
          const ids = Array.from(this.knownReactionIds).slice(-10000)
          this.knownReactionIds = new Set(ids)
          const ctx = new Map<string, ReactionRow>()
          for (const id of ids) {
            const c = this.reactionContext.get(id)
            if (c) ctx.set(id, c)
          }
          this.reactionContext = ctx
        }
      }

      // --- removed reactions (hard deletes) ---
      // Any ID in the recent window that no longer exists was removed.
      const idsToCheck = Array.from(this.knownReactionIds).slice(-200)
      if (idsToCheck.length > 0) {
        const { data: stillThere, error: presentError } = await supabase
          .from('reactions')
          .select('id')
          .in('id', idsToCheck)

        // A failed lookup reads as every reaction gone; nothing is removed until one succeeds.
        if (presentError || !Array.isArray(stillThere)) {
          console.error('Error checking reaction removals:', presentError?.message)
          return
        }
        const present = new Set(stillThere.map(r => r.id))
        for (const id of idsToCheck) {
          if (!present.has(id)) {
            const ctx = this.reactionContext.get(id)
            this.knownReactionIds.delete(id)
            this.reactionContext.delete(id)
            if (ctx) {
              await this.handleReactionEvent('MESSAGE_REACTION_REMOVE', ctx)
            }
          }
        }
      }
    } catch (err) {
      console.error('pollReactions exception:', err)
    }
  }

  /**
   * Resolves a custom emoji's shortcode name and image url; cached. Native/unicode reactions
   * store the character in custom_emoji_content and have no emoji_id. A failed lookup is not
   * cached.
   */
  private async resolveEmoji(emojiId: string): Promise<{ name: string | null; url: string | null }> {
    const cached = this.emojiCache.get(emojiId)
    if (cached !== undefined) return cached
    const { data, error } = await supabase
      .from('emojis')
      .select('name, url')
      .eq('id', emojiId)
      .single()
    if (error && error.code !== 'PGRST116') return { name: null, url: null }
    const entry = { name: data?.name ?? null, url: data?.url ?? null }
    this.emojiCache.set(emojiId, entry)
    return entry
  }

  /** ADD and REMOVE carry the same description of the reaction; REMOVE uses the row seen at add. */
  private async handleReactionEvent(type: 'MESSAGE_REACTION_ADD' | 'MESSAGE_REACTION_REMOVE', reaction: ReactionRow) {
    const channelId = reaction.channel_id
    const serverId = await this.resolveServerId(channelId)
    if (!channelId || !serverId) return

    const botIds = await this.resolveReaders(serverId, channelId)
    if (botIds.length === 0) return

    // { id, name, url, animated }. A custom emoji has its emojis row's id, name and absolute url.
    // A reaction without an emoji_id has id null and name its custom_emoji_content, a unicode
    // character or a bridged identifier (discord:name:id); its url is metadata.remote_emoji_url
    // when that is on Discord's CDN, else null.
    let emoji: { id: string | null, name: string | null, url: string | null, animated: boolean }
    if (reaction.emoji_id) {
      const resolved = await this.resolveEmoji(reaction.emoji_id)
      const url = absoluteEmojiUrl(resolved.url)
      emoji = { id: reaction.emoji_id, name: resolved.name, url, animated: isAnimatedEmojiUrl(url) }
    } else {
      const remote = reaction.metadata?.remote_emoji_url
      const url = isDiscordCdnUrl(remote) ? remote : null
      emoji = { id: null, name: reaction.custom_emoji_content ?? null, url, animated: isAnimatedEmojiUrl(url) }
    }

    const event = {
      op: 0,
      t: type,
      d: {
        reaction_id: reaction.id,
        message_id: reaction.message_id,
        channel_id: reaction.channel_id,
        user_id: reaction.user_id ?? null,
        bot_id: reaction.bot_id ?? null,
        emoji,
        metadata: reaction.metadata ?? {},
      },
    }

    this.gateway.sendToMultipleBots(botIds, event)
    console.log(`Dispatched ${type} to ${botIds.length} bots`)
  }

  // Cached lookups (BUGS.md PC1)

  /**
   * Resolves a channel's server_id. Cached for 1 hour; channels rarely move
   * between servers.
   *
   * Caching semantics (BUGS.md H3):
   * - Channel found with server_id: cached.
   * - PGRST116 "no rows": `null` cached, so deleted/orphan channels stop
   *   re-querying.
   * - Any other error (network, RLS denial, schema reload, transient
   *   Postgres issue): not cached; returns null and retries next call.
   *   Caching a transient null locks out a working channel for the full TTL.
   */
  private async resolveServerId(channelId: string | null | undefined): Promise<string | null> {
    if (!channelId) return null
    const cached = this.channelToServerCache.get(channelId)
    if (cached !== undefined) return cached

    const { data: channel, error } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()

    // PGRST116 = no row returned by .single(); the channel does not exist.
    // Any other error is transient and must not be cached as a negative.
    if (error && error.code !== 'PGRST116') {
      console.warn(`channels lookup for ${channelId} returned a transient error; skipping cache:`, error)
      return null
    }

    const serverId = channel?.server_id ?? null
    this.channelToServerCache.set(channelId, serverId)
    return serverId
  }

  /**
   * Resolves the bots holding read_messages in a server. Cached for 5
   * minutes; refreshBotPermissions drops entries that change sooner.
   *
   * As in `resolveServerId`, only clean responses are cached. Caching `[]`
   * from a transient error silences every bot on that server for the TTL.
   */
  private async resolveBotPermissions(serverId: string): Promise<BotPermissionRow[]> {
    const cached = this.botPermissionsCache.get(serverId)
    if (cached !== undefined) return cached

    // '*': allowed_channel_ids exists in production only; naming it fails the query elsewhere.
    const { data: botPermissions, error } = await supabase
      .from('bot_server_permissions')
      .select('*')
      .eq('server_id', serverId)
      .eq('read_messages', true)
      .eq('is_active', true)

    if (error) {
      console.warn(`bot_server_permissions lookup for ${serverId} returned a transient error; skipping cache:`, error)
      return []
    }

    const list = (botPermissions ?? []) as BotPermissionRow[]
    this.botPermissionsCache.set(serverId, list)
    return list
  }

  /**
   * Re-reads the installs of every cached server, with resolveBotPermissions' filters, and
   * deletes each entry whose rows differ in any column; the next event for that server
   * queries again.
   *
   * A batch that errors keeps its entries. A batch truncated by PostgREST max-rows reads as
   * changed: it costs a re-query, never a stale grant.
   */
  async refreshBotPermissions(): Promise<void> {
    const cached = this.botPermissionsCache.entries()

    for (let i = 0; i < cached.length; i += BOT_PERMISSIONS_REFRESH_BATCH) {
      const batch = cached.slice(i, i + BOT_PERMISSIONS_REFRESH_BATCH)

      const { data, error } = await supabase
        .from('bot_server_permissions')
        .select('*')
        .in('server_id', batch.map(([serverId]) => serverId))
        .eq('read_messages', true)
        .eq('is_active', true)

      if (error) {
        console.warn('bot_server_permissions refresh returned a transient error; keeping cache:', error)
        continue
      }

      const current = new Map<string, BotPermissionRow[]>()
      for (const row of (data ?? []) as BotPermissionRow[]) {
        const serverId = row.server_id as string
        const rows = current.get(serverId)
        if (rows) rows.push(row)
        else current.set(serverId, [row])
      }

      for (const [serverId, rows] of batch) {
        if (installsFingerprint(rows) !== installsFingerprint(current.get(serverId) ?? [])) {
          this.botPermissionsCache.delete(serverId)
        }
      }
    }
  }

  /** @everyone's layer on a channel. Failed lookups are not cached. */
  private async resolveEveryoneLayer(serverId: string, channelId: string): Promise<EveryoneLayer | null> {
    const cached = this.channelLayerCache.get(channelId)
    if (cached !== undefined) return cached
    const layer = await loadEveryoneLayer(serverId, channelId)
    if (layer) this.channelLayerCache.set(channelId, layer)
    return layer
  }

  /**
   * Bots that may read a channel: read_messages, the install's allowed_channel_ids, and
   * VIEW_CHANNEL as a holder of @everyone (botCanReadChannel). None when visibility cannot be
   * established.
   */
  private async resolveReaders(serverId: string, channelId: string): Promise<string[]> {
    const botPermissions = await this.resolveBotPermissions(serverId)
    if (botPermissions.length === 0) return []

    const layer = await this.resolveEveryoneLayer(serverId, channelId)
    if (!layer) {
      console.warn(`Channel ${channelId}: visibility unknown, dispatching to no bot`)
      return []
    }

    return botPermissions
      .filter(row => botCanReadChannel(row, layer, channelId))
      .map(row => row.bot_id)
  }
  
  /**
   * Where a tick reads from: CHANGE_OVERLAP_MS behind the cursor, never before start, rounded
   * down to the millisecond the query is sent with. `micros` is that rounded value, so the
   * dedupe prune never drops a row the next read returns.
   */
  private changeWindowStart(cursor: FeedPosition): { position: FeedPosition; micros: number } {
    const ms = Math.floor(Math.max(timestampMicros(cursor.at) - CHANGE_OVERLAP_MS * 1000, this.changeFloorMicros) / 1000)
    return { position: { at: new Date(ms).toISOString(), id: NIL_UUID }, micros: ms * 1000 }
  }

  /**
   * Dispatches MESSAGE_UPDATE for each content edit and MESSAGE_DELETE for each soft delete since
   * the cursor, CHANGE_PAGE rows per query and at most CHANGE_PAGES_PER_TICK queries per tick.
   */
  private async pollMessageChanges() {
    try {
      if (!this.changeCursor && !(await this.initializeChangeFeed())) return
      const window = this.changeWindowStart(this.changeCursor!)
      let after = this.changeResume ?? window.position

      for (let page = 0; page < CHANGE_PAGES_PER_TICK; page++) {
        const { data, error } = await supabase.rpc('channel_message_changes', {
          p_after_at: after.at,
          p_after_id: after.id,
          p_limit: CHANGE_PAGE,
        })
        if (error || !Array.isArray(data?.messages)) {
          console.error('channel_message_changes error:', error?.message)
          if (page > 0) this.changeResume = after
          return
        }

        // The cursor never passes the database clock: a row a privileged writer stamped in the
        // future would otherwise move every later edit behind the overlap window.
        const nowMicros = typeof data.now === 'string' ? timestampMicros(data.now) : Infinity
        const rows: any[] = data.messages
        for (const row of rows) {
          await this.handleMessageChange(row)
          after = { at: row.updated_at, id: row.id }
          const at = timestampMicros(row.updated_at)
          if (at > timestampMicros(this.changeCursor!.at) && at <= nowMicros) {
            this.changeCursor = after
          }
        }

        if (rows.length < CHANGE_PAGE) {
          // Drained: every row visible at the database clock is read, so the cursor moves to it
          // and a quiet feed re-reads CHANGE_OVERLAP_MS of history, not the last burst forever.
          if (nowMicros !== Infinity && nowMicros > timestampMicros(this.changeCursor!.at)) {
            this.changeCursor = { at: data.now, id: NIL_UUID }
          }
          this.changeResume = null
          this.pruneChangeSeen(this.changeWindowStart(this.changeCursor!).micros)
          return
        }
      }
      this.changeResume = after
    } catch (error) {
      console.error('pollMessageChanges exception:', error)
    }
  }

  /** One feed row: MESSAGE_DELETE once per soft-deleted id, else MESSAGE_UPDATE once per updated_at. */
  private async handleMessageChange(row: any) {
    if (this.changeSeen.get(row.id) === row.updated_at) return
    this.changeSeen.delete(row.id)
    this.changeSeen.set(row.id, row.updated_at)
    if (timestampMicros(row.updated_at) <= this.changeFloorMicros) return

    try {
      if (row.is_deleted) {
        if (this.deletedIds.get(row.id)) return
        this.deletedIds.set(row.id, true)
        await this.handleMessageDelete({ old: { id: row.id, channel_id: row.channel_id, metadata: row.metadata } })
      } else {
        await this.handleMessageUpdate({ new: row, old: { id: row.id } })
      }
    } catch (err) {
      console.error(`Change dispatch failed for ${row.id}:`, err)
    }
  }

  /** Drops entries stamped before `windowMicros`, then the oldest beyond CHANGE_SEEN_MAX. */
  private pruneChangeSeen(windowMicros: number) {
    for (const [id, at] of this.changeSeen) {
      if (timestampMicros(at) < windowMicros) this.changeSeen.delete(id)
    }
    for (const id of this.changeSeen.keys()) {
      if (this.changeSeen.size <= CHANGE_SEEN_MAX) break
      this.changeSeen.delete(id)
    }
  }

  /**
   * MESSAGE_DELETE for a row removed through the bot REST API. A hard-deleted row leaves nothing
   * in the change feed, so the caller passes what it read before the delete.
   */
  async messageHardDeleted(message: { id: string; channel_id: string | null; metadata: unknown }) {
    if (this.deletedIds.get(message.id)) return
    this.deletedIds.set(message.id, true)
    await this.handleMessageDelete({ old: message })
  }

  private async pollMessages() {
    try {
      const { data: messages, error } = await supabase
        .from('messages')
        .select('*')
        .gt('created_at', this.lastProcessedTimestamp.toISOString())
        .order('created_at', { ascending: true })
        .limit(50)
      
      if (error) {
        console.error('Error polling messages:', error)
        return
      }
      
      if (messages && messages.length > 0) {
        const newMessages = messages.filter(m => !this.processedMessageIds.has(m.id))
        
        if (newMessages.length > 0) {
          console.log(`Polled ${newMessages.length} new messages`)
          
          for (const message of newMessages) {
            await this.handleMessageCreate({ new: message })
            this.processedMessageIds.add(message.id)
            this.lastProcessedTimestamp = new Date(message.created_at)
            
            // Bounded to the last 10000 IDs.
            if (this.processedMessageIds.size > 10000) {
              const idsArray = Array.from(this.processedMessageIds);
              this.processedMessageIds = new Set(idsArray.slice(-10000));
            }
          }
        }
      }
    } catch (error) {
      console.error('Polling error:', error)
    }
  }
  
  async handleMessageCreate(payload: any) {
    const message = payload.new
    
    console.log(`EventDispatcher: Message received`, {
      id: message.id,
      channel_id: message.channel_id,
      user_id: message.user_id,
      bot_id: message.bot_id,
      encrypted: message.encrypted
    });
    
    // Bots cannot read encrypted messages.
    if (message.encrypted) {
      console.log('Skipping encrypted message');
      return
    }
    
    // Bot messages are dispatched so other bots see them. Each bot filters its
    // own messages by author.id.
    
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) {
      console.log('No server ID found, skipping dispatch');
      return
    }
    
    const botIds = await this.resolveReaders(serverId, message.channel_id)
    
    console.log(`Found ${botIds.length} bots that can read channel ${message.channel_id} in server ${serverId}`);
    
    if (botIds.length === 0) {
      return
    }
    
    const event = {
      op: 0,
      t: 'MESSAGE_CREATE',
      d: await this.formatMessage(message, serverId)
    }
    
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`Dispatched MESSAGE_CREATE to ${botIds.length} bots:`, botIds)
  }
  
  private async handleMessageUpdate(payload: any) {
    const message = payload.new
    
    if (!message || !message.id) return
    if (message.encrypted) return
    
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) return
    
    const botIds = await this.resolveReaders(serverId, message.channel_id)
    if (botIds.length === 0) return
    
    const formattedMessage = await this.formatMessage(message, serverId)
    const event = {
      op: 0,
      t: 'MESSAGE_UPDATE',
      d: formattedMessage
    }
    
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`Dispatched MESSAGE_UPDATE to ${botIds.length} bots`)
  }
  
  private async handleMessageDelete(payload: any) {
    const message = payload.old
    
    console.log(`EventDispatcher: Message deleted`, {
      id: message.id,
      channel_id: message.channel_id
    });
    
    const serverId = await this.resolveServerId(message.channel_id)
    if (!serverId) {
      console.log('No server ID found, skipping dispatch');
      return
    }
    
    const botIds = await this.resolveReaders(serverId, message.channel_id)
    if (botIds.length === 0) {
      return
    }
    
    const event = {
      op: 0,
      t: 'MESSAGE_DELETE',
      d: {
        id: message.id,
        channel_id: message.channel_id,
        metadata: message.metadata
      }
    }
    
    this.gateway.sendToMultipleBots(botIds, event)
    
    console.log(`Dispatched MESSAGE_DELETE to ${botIds.length} bots`)
  }
  
  // FORMATTERS
  
  private formatAvatarUrl(avatarPath: string | null | undefined): string | undefined {
    return absoluteAvatarUrl(avatarPath)
  }
  
  private async resolveAuthor(userId: string | null, botId: string | null) {
    const cacheKey = userId ? `u:${userId}` : botId ? `b:${botId}` : null
    if (!cacheKey) return null
    const cached = this.authorCache.get(cacheKey)
    if (cached !== undefined) return cached

    // BUGS.md H3: cache only on clean responses or a definitive
    // "row not found" (PGRST116). A transient error must not poison the
    // cache for the full 10 min TTL.
    if (userId) {
      const { data, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url')
        .eq('id', userId)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.warn(`profiles lookup for ${userId} returned a transient error; skipping cache:`, error)
        return null
      }
      const entry = data ? { ...data, isBot: false } : null
      this.authorCache.set(cacheKey, entry)
      return entry
    } else {
      const { data, error } = await supabase
        .from('bots')
        .select('id, username, display_name, avatar_url')
        .eq('id', botId!)
        .single()
      if (error && error.code !== 'PGRST116') {
        console.warn(`bots lookup for ${botId} returned a transient error; skipping cache:`, error)
        return null
      }
      const entry = data ? { ...data, isBot: true } : null
      this.authorCache.set(cacheKey, entry)
      return entry
    }
  }

  /**
   * The author's user_servers.nickname in a server; null when unset, blank or not a member.
   * Failed lookups are not cached.
   */
  private async resolveNickname(serverId: string, userId: string): Promise<string | null> {
    const key = `${serverId}:${userId}`
    const cached = this.nicknameCache.get(key)
    if (cached !== undefined) return cached

    const { data, error } = await supabase
      .from('user_servers')
      .select('nickname')
      .eq('server_id', serverId)
      .eq('user_id', userId)
      .limit(1)
    if (error) {
      console.warn(`user_servers lookup for ${userId} in ${serverId} returned a transient error; skipping cache:`, error)
      return null
    }
    const raw = Array.isArray(data) ? data[0]?.nickname : null
    const nickname = typeof raw === 'string' && raw.trim() !== '' ? raw : null
    this.nicknameCache.set(key, nickname)
    return nickname
  }

  /** `serverId` is the channel's server; author.nickname is resolved in it. */
  private async formatMessage(message: any, serverId: string | null) {
    let author = null

    // Discord-bridged messages carry the original user's profile inline; no DB hit.
    if (message.bot_id && message.metadata?.discord_user) {
      const discordUser = message.metadata.discord_user
      author = {
        id: discordUser.id,
        username: discordUser.username,
        display_name: discordUser.display_name,
        avatar: discordUser.avatar_url, // Discord URLs are already complete
        nickname: null,
        bot: false, // Treat as regular user for display
        discord_user: true
      }
    } else if (message.bot_id && typeof message.metadata?.webhook?.name === 'string') {
      // A channel webhook's message names its shown author; execute_channel_webhook writes it.
      const webhook = message.metadata.webhook
      author = {
        id: message.bot_id,
        username: webhook.name,
        display_name: webhook.name,
        avatar: typeof webhook.avatar_url === 'string' ? webhook.avatar_url : null,
        nickname: null,
        bot: true,
        webhook: true,
      }
    } else if (message.user_id || message.bot_id) {
      const entry = await this.resolveAuthor(message.user_id ?? null, message.bot_id ?? null)
      if (entry) {
        author = {
          id: entry.id,
          username: entry.username,
          display_name: entry.display_name,
          avatar: this.formatAvatarUrl(entry.avatar_url),
          nickname: !entry.isBot && serverId ? await this.resolveNickname(serverId, entry.id) : null,
          bot: entry.isBot
        }
      }
    }
    
    return {
      id: message.id,
      channel_id: message.channel_id,
      author,
      content: this.contentToText(message.content),
      // Attachments of the message's room carry a signed url (utils/messageMedia.ts).
      content_raw: await withSignedMessageMedia(message.content, message),
      is_system: message.is_system === true,
      reply_to: message.reply_to ?? null,
      timestamp: message.created_at,
      edited_timestamp: message.updated_at,
      mentions: this.extractMentions(message.content),
      mention_everyone: await this.mentionsEveryone(message, serverId),
      metadata: message.metadata // Include metadata in event
    }
  }

  /**
   * Discord's Message.mention_everyone: the message carries @everyone (the server's default
   * role) or @here, and its author may ping them. The right is the one
   * handle_role_mention_notifications checks: MENTION_EVERYONE in the channel, or a bot's
   * mention_everyone. False on any failed lookup.
   */
  private async mentionsEveryone(message: any, serverId: string | null): Promise<boolean> {
    if (!serverId || !message.channel_id || !Array.isArray(message.content)) return false
    const roleIds: unknown[] = message.content
      .filter((part: any) => part?.type === 'role_mention')
      .map((part: any) => part.roleId)
    if (roleIds.length === 0) return false

    if (!roleIds.includes(HERE_ROLE_ID)) {
      const uuids = roleIds.filter((id): id is string => typeof id === 'string' && UUID_PATTERN.test(id))
      if (uuids.length === 0) return false
      const { data, error } = await supabase
        .from('server_roles')
        .select('id')
        .eq('server_id', serverId)
        .eq('is_default', true)
        .in('id', uuids)
      if (error || !data || data.length === 0) return false
    }

    const { data, error } = message.bot_id
      ? await supabase.rpc('check_bot_permission', {
          p_bot_id: message.bot_id, p_server_id: serverId, p_permission: 'mention_everyone',
        })
      : message.user_id
        ? await supabase.rpc('has_permission', {
            p_user_id: message.user_id, p_server_id: serverId,
            p_permission: 'MENTION_EVERYONE', p_channel_id: message.channel_id,
          })
        : { data: false, error: null }
    return !error && data === true
  }
  
  private contentToText(content: any): string {
    console.log('contentToText input:', JSON.stringify(content).substring(0, 200));
    
    if (typeof content === 'string') {
      console.log('Content is string:', content);
      return content
    }
    
    if (Array.isArray(content)) {
      const textParts = content
        .filter(part => part && part.type === 'text')
        .map(part => part.text || part.value || '')
        .join(' ')
        .trim()
      
      console.log(`Extracted text from ${content.length} parts: "${textParts}"`);
      return textParts
    }
    
    console.log('Content is neither string nor array, returning empty');
    return ''
  }
  
  private extractMentions(content: any): string[] {
    if (!Array.isArray(content)) return []
    
    return content
      .filter(part => part.type === 'mention')
      .map(part => part.user_id)
      .filter(Boolean)
  }
  
  // SHUTDOWN
  
  async shutdown() {
    if (this.pollingInterval) {
      clearInterval(this.pollingInterval)
      this.pollingInterval = null
    }
    if (this.editPollingInterval) {
      clearInterval(this.editPollingInterval)
      this.editPollingInterval = null
    }
    if (this.reactionPollingInterval) {
      clearInterval(this.reactionPollingInterval)
      this.reactionPollingInterval = null
    }
    if (this.permissionRefreshInterval) {
      clearInterval(this.permissionRefreshInterval)
      this.permissionRefreshInterval = null
    }

    for (const channel of this.subscriptions) {
      await channel.unsubscribe()
    }
    this.subscriptions = []
    this.channelToServerCache.clear()
    this.botPermissionsCache.clear()
    this.channelLayerCache.clear()
    this.authorCache.clear()
    this.emojiCache.clear()
    this.changeSeen.clear()
    this.deletedIds.clear()
    console.log('Event Dispatcher shut down')
  }
}
