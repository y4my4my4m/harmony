import { discardMirroredParts, enqueueMirror } from '../bridge/mirrorEnqueue.js'
import { Router, Request, Response } from 'express'
import { supabase } from '../config/supabase.js'
import { botAuthMiddleware, botRateLimit } from '../auth/BotAuthMiddleware.js'
import {
  ADMINISTRATOR,
  ALL_BITS,
  type ChannelWriteFlag,
  type InstallRow,
  type RoleRow,
  botCanReadChannel,
  botCanSeeChannel,
  botCanWriteChannel,
  botChannelMask,
  botReadsHistory,
  grantableRoleBits,
  isAdminRole,
  loadEveryoneLayer,
  loadInstall,
  overrideGrants,
  parseMask,
  rolePositionCap,
  u64,
} from '../auth/botPermissions.js'
import {
  BRIDGE_AUTHOR_KEYS,
  UUID_PATTERN,
  botContentParts,
  channelServerId as lookupChannelServerId,
  checkServerPermission,
  claimsBridgeAuthor,
  formatContent,
  prepareBotMessageContent,
  resolveMentionParts,
  visibleChannels,
} from './messageContent.js'
import { absoluteAvatarUrl, absoluteServerIconUrl } from '../utils/avatarUrl.js'
import { isDiscordCdnUrl } from '../utils/emojiUrl.js'
import { DISCORD_STICKER_ID, STICKER_BUCKET, StickerFileError, removeStoredSticker, storeDiscordSticker } from '../utils/discordStickerImport.js'
import { DISCORD_EMOJI_ID, EMOJI_BUCKET, EMOJI_NAME, discordEmojiStoragePath, isBridgeImportedEmoji, storeDiscordEmojiImage } from '../utils/discordEmojiImport.js'
import { DISCORD_SOUND_ID, MAX_SERVER_SOUNDS, storeDiscordSound, removeStoredSound } from '../utils/discordSoundImport.js'
import { LIST_MAX_ROWS, LIST_PAGE, selectAllById } from '../utils/pagedSelect.js'
import { GATEWAY_CAPABILITIES } from '../capabilities.js'
import { TTLCache } from '../utils/TTLCache.js'
import { MAX_COMMANDS, validateCommand, validateCommands } from '../commands/validate.js'

const AUTOMOD_BLOCKED_BODY = {
  error: "Blocked by the server's AutoMod",
  code: 'AUTOMOD_BLOCKED',
} as const

// Rejections raised by the messages trigger (20261005100001_server_automod.sql).
function moderationErrorResponse(error: { message?: string; details?: string; hint?: string }):
  { status: number; body: { error: string; code: string } } | null {
  const text = [error.message, error.details].filter(Boolean).join(' ')
  if (text.includes('AUTOMOD_BLOCKED')) return { status: 403, body: { ...AUTOMOD_BLOCKED_BODY } }
  if (text.includes('MEMBER_TIMED_OUT')) {
    return { status: 403, body: { error: error.hint || 'Timed out in this server', code: 'MEMBER_TIMED_OUT' } }
  }
  return null
}

type ChannelAccess = { ok: true } | { ok: false; error: string }

/** A refused message write, with its bot_interaction_record p_error. */
type WriteFailure = 'bot_cannot_post' | 'thread_locked' | 'automod_blocked' | 'failed'

type WriteResult =
  | { ok: true; message: any; duplicate?: true }
  | { ok: false; status: number; body: Record<string, unknown>; failure: WriteFailure }

interface BotMessageInput {
  content?: any
  embeds?: any
  reply_to?: any
  metadata?: any
  thread_id?: any
}

// enforce_message_length (baseline) raises check_violation with this text.
const MESSAGE_TOO_LONG = /^Message text exceeds the instance limit of \d+ characters/
// check_message_sticker_parts: a sticker part naming no live sticker, or a sticker pair whose file part differs.
const STICKER_REFUSED = /^STICKER_(UNKNOWN|FALLBACK)/
// guard_bridge_author_optout (20261112600001): the relayed author opted out of the server's bridge.
const BRIDGE_AUTHOR_OPTED_OUT = 'BRIDGE_AUTHOR_OPTED_OUT'
const OPTED_OUT_BODY = { error: 'The author opted out of this bridge', code: BRIDGE_AUTHOR_OPTED_OUT } as const

/** An interaction as the reply routes need it; bot_interaction_ack answers the same fields. */
interface InteractionContext {
  id: string
  channel_id: string
  thread_id: string | null
  user_id: string
  command_name: string
  ephemeral?: boolean | null
}

// Discord's InteractionCallbackType: CHANNEL_MESSAGE_WITH_SOURCE, DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE.
const CALLBACK_REPLY = 4
const CALLBACK_DEFER = 5
// Discord's MessageFlags.EPHEMERAL.
const EPHEMERAL = 64

/** A reply's flags: 0 when absent; null for anything but 0 and EPHEMERAL. */
export function replyFlags(value: unknown): 0 | typeof EPHEMERAL | null {
  if (value === undefined || value === null || value === 0) return 0
  return value === EPHEMERAL ? EPHEMERAL : null
}

const INTERACTION_ERRORS: Readonly<Record<string, [number, string]>> = {
  INTERACTION_UNKNOWN: [404, 'Unknown interaction'],
  INTERACTION_ACKNOWLEDGED: [400, 'Interaction already acknowledged'],
  INTERACTION_EXPIRED: [400, 'Interaction expired'],
  INTERACTION_NOT_ACKNOWLEDGED: [400, 'Interaction not acknowledged'],
  INTERACTION_RESPONSE_IN_PROGRESS: [409, 'Response in progress'],
  INTERACTION_FOLLOWUP_LIMIT: [400, 'Follow-up limit reached'],
}

const UNKNOWN_INTERACTION = { error: 'Unknown interaction' } as const
const UNKNOWN_COMMAND = { error: 'Unknown command' } as const

/** Code and detail of `RAISE EXCEPTION '<CODE>'` or `'<CODE>:<detail>'`. */
function raisedCode(error: { message?: string }): { code: string; detail: string } {
  const message = error.message ?? ''
  const colon = message.indexOf(':')
  if (colon < 0) return { code: message.trim(), detail: '' }
  return { code: message.slice(0, colon).trim(), detail: message.slice(colon + 1).trim() }
}

/** HTTP answer to an error of an interaction RPC. */
export function interactionErrorResponse(error: { message?: string }): { status: number; body: { error: string } } {
  const { code, detail } = raisedCode(error)
  const known = INTERACTION_ERRORS[code]
  if (known) return { status: known[0], body: { error: known[1] } }
  if (code === 'INTERACTION_REPLY_TOO_LONG') {
    return { status: 400, body: { error: `Message text exceeds the instance limit of ${detail} characters` } }
  }
  return { status: 500, body: { error: error.message || 'Interaction update failed' } }
}

/** HTTP answer to an error of a command RPC; 22023 is the RPC's own shape check. */
export function commandErrorResponse(error: { message?: string; code?: string }): { status: number; body: { error: string } } {
  if (error.code === '22023') return { status: 400, body: { error: error.message || 'Invalid command' } }
  const { code, detail } = raisedCode(error)
  switch (code) {
    case 'BOT_COMMAND_LIMIT':
      return { status: 400, body: { error: `A bot has at most ${MAX_COMMANDS} commands` } }
    case 'BOT_COMMAND_DUPLICATE':
      return { status: 400, body: { error: `Duplicate command name: ${detail}` } }
    case 'BOT_COMMAND_UNKNOWN_PERMISSION':
      return { status: 400, body: { error: `Unknown permission name: ${detail}` } }
  }
  if (code.startsWith('BOT_COMMAND_')) {
    return { status: 400, body: { error: `The command was refused: ${detail || code}` } }
  }
  return { status: 500, body: { error: error.message || 'Command update failed' } }
}

function isPlainObject(value: unknown): value is Record<string, any> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

interface ThreadRow {
  id: string
  channel_id: string
  parent_message_id: string
  name: string
  archived: boolean | null
  locked: boolean | null
  created_at: string
}

export { botContentParts, claimsBridgeAuthor, embedPart, typedMassMentionParts } from './messageContent.js'

/** A Discord snowflake: 1 to 20 digits. */
const SNOWFLAKE_RE = /^[0-9]{1,20}$/

// channels.type (0 text, 1 voice, 2 category) as Discord's GUILD_TEXT, GUILD_VOICE, GUILD_CATEGORY.
const DISCORD_CHANNEL_TYPE: Record<number, number> = { 0: 0, 1: 2, 2: 4 }

export interface BotRequest extends Request {
  bot?: {
    id: string
    username: string
    scopes: string[]
  }
}

// Message metadata keys written by federation, definer functions and this API; the
// client UI treats them as server statements. A bot's metadata never sets them. embeds holds
// link-preview payloads (update_message_embeds), suppress_embeds is set through
// set_message_embeds_suppressed, webhook by execute_channel_webhook, history_import by the
// history import function alone (it marks rows the dispatcher and realtime must stay quiet for),
// discord_reply_to likewise (import_link_replies acts on it). interaction names the slash
// command invocation a reply answers, and AutoMod judges the message as its invoker's.
const SERVER_METADATA_KEYS = new Set([
  'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published', 'conversation',
  'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at', 'federated_to', 'automod',
  'bot', 'created_via', 'embeds', 'suppress_embeds', 'webhook', 'remote_author', 'host_ap_id',
  'interaction',
  'history_import', 'discord_reply_to',
])

// Metadata a bridge bot records on a message it did not write (bridge 2.2): the Discord
// message ids of its copy, whether a webhook posted it, and the files uploaded with it.
// bridge_source is accepted only as 'harmony', which marks the message as Harmony-origin;
// the bridge reads the persisted ids back only when it is set.
const BRIDGE_MAPPING_KEYS = new Set([
  'discord_message_id', 'discord_message_ids', 'discord_via_webhook', 'discord_uploaded_files',
])

function isBridgeMappingEntry([key, value]: [string, unknown]): boolean {
  return BRIDGE_MAPPING_KEYS.has(key) || (key === 'bridge_source' && value === 'harmony')
}

export function botSuppliedMetadata(
  input: unknown,
  options: { bridgeAuthor?: boolean } = {},
): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  return Object.fromEntries(
    Object.entries(input as Record<string, unknown>).filter(([key]) =>
      !SERVER_METADATA_KEYS.has(key) && (options.bridgeAuthor === true || !BRIDGE_AUTHOR_KEYS.has(key))),
  )
}

/** The string fields of a bridged thread's Discord starter, or null (bot_create_thread p_discord_user). */
export function threadStarter(input: unknown): Record<string, string> | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const user = input as Record<string, unknown>
  if (typeof user.id !== 'string' || !SNOWFLAKE_RE.test(user.id)) return null
  const out: Record<string, string> = { id: user.id }
  for (const key of ['username', 'display_name', 'avatar_url']) {
    if (typeof user[key] === 'string' && user[key]) out[key] = user[key] as string
  }
  return out
}

/** A reaction's bot-supplied metadata; remote_emoji_url is kept only when it is an https Discord CDN URL. */
export function reactionMetadata(input: unknown): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input || null
  const metadata = { ...(input as Record<string, unknown>) }
  if ('remote_emoji_url' in metadata && !isDiscordCdnUrl(metadata.remote_emoji_url)) {
    delete metadata.remote_emoji_url
  }
  return metadata
}

/** Receives each row this API hard-deletes, for MESSAGE_DELETE dispatch. */
export interface MessageDeleteSink {
  messageHardDeleted(message: { id: string; channel_id: string | null; thread_id: string | null; metadata: unknown }): Promise<void>
}

/** Most messages one history read returns, Discord's maximum. */
export const MAX_MESSAGES_PER_READ = 100
/** Most members one member list read returns, Discord's maximum. */
export const MAX_MEMBERS_PER_READ = 1000

/**
 * A list route's `limit` query: `fallback` when absent or not a whole number, else clamped to
 * 1..max. Unclamped, one request reads up to PostgREST's row limit (1000 by default).
 */
export function queryLimit(raw: unknown, fallback: number, max: number): number {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw)) return fallback
  return Math.min(Math.max(Number(raw), 1), max)
}

/** A bridge pairing removed keeps answering true for at most this long. */
const BRIDGE_PAIR_TTL_MS = 60_000

export class BotRestAPI {
  public router: Router
  private readonly bridgePairs = new TTLCache<string, true>(5_000, BRIDGE_PAIR_TTL_MS)
  // A channel never moves to another server.
  private readonly auditChannelServers = new TTLCache<string, string>(10_000, 10 * 60_000)

  constructor(private readonly deletes?: MessageDeleteSink) {
    this.router = Router()
    this.setupMiddleware()
    this.setupRoutes()
  }
  
  private setupMiddleware() {
    this.router.use(botAuthMiddleware)
  }
  
  private setupRoutes() {
    // CHANNEL ENDPOINTS

    this.route('post', '/channels/:channelId/messages', this.sendMessage)

    this.route('get', '/channels/:channelId/messages', this.getMessages)

    // Lookup by bridged Discord message ID, stored in metadata.discord_message_id.
    this.route('get', '/channels/:channelId/messages/lookup', this.lookupMessageByDiscordId)

    this.route('get', '/messages/:messageId', this.getMessage)

    // Public invite preview; feeds Discord bridge embed cards.
    this.route('get', '/invites/:code/preview', this.getInvitePreview)

    this.route('patch', '/messages/:messageId', this.editMessage)

    this.route('delete', '/messages/:messageId', this.deleteMessage)

    this.route('put', '/messages/:messageId/reactions/:emoji', this.addReaction)

    this.route('delete', '/messages/:messageId/reactions/:emoji', this.removeReaction)

    this.route('post', '/channels/:channelId/typing', this.triggerTyping)

    // THREAD ENDPOINTS
    // A thread's messages carry its parent channel's channel_id plus thread_id; writes follow
    // the parent channel's send_messages access (bot installs carry no thread flags).

    this.route('post', '/channels/:channelId/threads', this.createThread)

    // A Discord bridge's thread pair, by Discord thread id.
    this.route('get', '/channels/:channelId/threads/lookup', this.lookupThreadByDiscordId)

    this.route('get', '/threads/:threadId', this.getThread)

    // Pairs a Harmony thread with the Discord thread a bridge created for it.
    this.route('put', '/threads/:threadId/discord', this.pairThread)

    // SERVER ENDPOINTS (Harmony terminology)

    this.route('get', '/servers/:serverId', this.getGuild)

    this.route('get', '/servers/:serverId/members', this.getGuildMembers)

    this.route('get', '/servers/:serverId/channels', this.getGuildChannels)

    // Requires manage_channels.
    this.route('post', '/servers/:serverId/channels', this.createChannel)
    this.route('post', '/servers/:serverId/categories', this.createCategory)
    this.route('patch', '/servers/:serverId/categories/:categoryId', this.updateCategory)

    // Category list; consumed by clone/diff.
    this.route('get', '/servers/:serverId/categories', this.getCategories)

    this.route('patch', '/channels/:channelId', this.updateChannel)

    // Writes require manage_roles and stay inside the bot's own permissions and position range.
    this.route('get', '/servers/:serverId/roles', this.getRoles)
    this.route('post', '/servers/:serverId/roles', this.createRole)
    this.route('patch', '/servers/:serverId/roles/:roleId', this.updateRole)
    this.route('delete', '/servers/:serverId/roles/:roleId', this.deleteRole)

    // Channel permission overrides; used by Discord bridge permission sync.
    this.route('get', '/channels/:channelId/permission-overrides', this.getChannelPermissionOverrides)
    this.route('put', '/channels/:channelId/permission-overrides', this.upsertChannelPermissionOverride)
    this.route('delete', '/channels/:channelId/permission-overrides/role/:roleId', this.deleteChannelPermissionOverrideForRole)

    // Deprecated aliases using Discord terminology.
    this.route('get', '/guilds/:guildId', this.getGuild)
    this.route('get', '/guilds/:guildId/members', this.getGuildMembers)
    this.route('get', '/guilds/:guildId/channels', this.getGuildChannels)

    // EMOJI ENDPOINTS

    this.route('get', '/emojis', this.getEmojis)

    this.route('post', '/emojis', this.createEmoji)

    // Server emoji with their Discord links; the Discord bridge maps reactions through them.
    this.route('get', '/servers/:serverId/emojis', this.getServerEmojis)
    // Discord bridge bot of the server only: Discord emoji → server emoji, once per Discord emoji.
    this.route('get', '/servers/:serverId/emojis/discord', this.listDiscordEmojis)
    this.route('post', '/servers/:serverId/emojis/discord', this.importDiscordEmoji)
    this.route('delete', '/servers/:serverId/emojis/:emojiId', this.removeServerEmoji)
    // Discord bridge bot of the server only: Discord sticker → server sticker, once per Discord sticker.
    this.route('get', '/servers/:serverId/stickers/discord', this.listDiscordStickers)
    this.route('post', '/servers/:serverId/stickers/discord', this.importDiscordSticker)
    this.route('delete', '/servers/:serverId/stickers/:stickerId', this.removeServerSticker)

    // Discord bridge bot of the server only: soundboard sync.
    this.route('get', '/servers/:serverId/sounds', this.listServerSounds)
    this.route('post', '/servers/:serverId/sounds/discord', this.importDiscordSound)
    this.route('delete', '/servers/:serverId/sounds/:soundId', this.deleteServerSound)

    // Content patch that leaves updated_at alone; no "(edited)" marker.
    this.route('patch', '/messages/:messageId/content-silent', this.silentUpdateMessageContent)

    // Merges bridge metadata (e.g. discord_message_id) without bumping updated_at.
    this.route('patch', '/messages/:messageId/metadata', this.mergeMessageMetadata)

    // USER ENDPOINTS

    // Express matches in registration order; /users/:userId would otherwise
    // capture "@me" and hand it to a uuid column.
    this.route('get', '/users/@me', this.getCurrentBot)

    this.route('get', '/users/:userId', this.getUser)

    // APPLICATION COMMANDS
    // The calling bot's slash commands; PUT replaces the whole set.

    this.route('get', '/commands', this.getCommands)
    this.route('put', '/commands', this.replaceCommands)
    this.route('post', '/commands', this.upsertCommand)
    this.route('delete', '/commands/:commandId', this.deleteCommand)

    // INTERACTIONS
    // Answers to the bot's own INTERACTION_CREATE events; rate-limited in INTERACTION_BUCKET.

    this.route('post', '/interactions/:interactionId/callback', this.interactionCallback)
    this.route('patch', '/interactions/:interactionId/response', this.interactionResponse)
    this.route('post', '/interactions/:interactionId/followups', this.interactionFollowup)

    // Requests no route matched are counted in a shared bucket, then fall through to the 404.
    this.router.use(botRateLimit)
  }

  private route(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    path: string,
    handler: (req: BotRequest, res: Response) => unknown,
  ) {
    this.router[method](path, botRateLimit, handler.bind(this))
  }
  
  // MEDIA

  private async silentUpdateMessageContent(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const { content } = req.body || {}
      const botId = req.bot!.id
      if (!Array.isArray(content)) {
        return res.status(400).json({ error: 'content must be a MessagePart array' })
      }

      const { data: message } = await supabase
        .from('messages')
        .select('bot_id, channel_id, content')
        .eq('id', messageId)
        .single()

      if (!message || message.bot_id !== botId) {
        return res.status(403).json({ error: 'Cannot update messages from other bots or users' })
      }

      const access = await this.channelWriteAccess(botId, message.channel_id, 'send_messages')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }

      // Silent rewrites refresh links; they never replace a part already copied into storage.
      // A bridge bot that sets its own `path` on a part bypasses this guard and the mirror
      // worker's candidate check (parts with a path are skipped). That is the same trust level
      // as the existing `path` pass-through for bot content; the guard targets honest refreshes.
      const nextParts = await resolveMentionParts(botContentParts(content), message.channel_id, botId)
      const currentParts: any[] = Array.isArray(message.content) ? message.content : []
      const losesMirroredPart = currentParts.some((part, i) =>
        typeof part?.path === 'string' && part.path !== '' && !((nextParts as any[])[i]?.path))
      if (losesMirroredPart) {
        return res.status(409).json({ error: 'mirrored_part' })
      }

      const { data: updated, error } = await supabase.rpc('update_message_content_silent', {
        p_message_id: messageId,
        p_old_content: message.content,
        p_content: nextParts,
      })
      if (error) {
        return res.status(400).json({ error: error.message })
      }
      if (!updated) {
        return res.status(409).json({ error: 'Message content changed; re-fetch and retry' })
      }
      return res.json({ ok: true })
    } catch (error: any) {
      console.error('silentUpdateMessageContent error:', error)
      return res.status(500).json({ error: error?.message || 'Failed to update message' })
    }
  }

  // THREAD ENDPOINTS

  private async loadThread(threadId: string): Promise<ThreadRow | null> {
    if (!UUID_PATTERN.test(threadId)) return null
    const { data, error } = await supabase
      .from('threads')
      .select('id, channel_id, parent_message_id, name, archived, locked, created_at')
      .eq('id', threadId)
      .maybeSingle()
    return error || !data ? null : (data as ThreadRow)
  }

  /** The bot's Discord bridge on the channel's server, when the bot runs one. */
  private async bridgeIdFor(botId: string, channelId: string): Promise<string | null> {
    const serverId = await lookupChannelServerId(channelId)
    if (!serverId) return null
    const { data } = await supabase
      .from('discord_bridges')
      .select('id')
      .eq('server_id', serverId)
      .eq('bot_id', botId)
      .maybeSingle()
    return (data as { id: string } | null)?.id ?? null
  }

  private async formatThread(thread: ThreadRow, botId: string) {
    const bridgeId = await this.bridgeIdFor(botId, thread.channel_id)
    let discordThreadId: string | null = null
    if (bridgeId) {
      const { data } = await supabase
        .from('discord_bridge_threads')
        .select('discord_thread_id')
        .eq('thread_id', thread.id)
        .eq('bridge_id', bridgeId)
        .maybeSingle()
      discordThreadId = (data as { discord_thread_id: string } | null)?.discord_thread_id ?? null
    }
    return {
      id: thread.id,
      channel_id: thread.channel_id,
      parent_message_id: thread.parent_message_id,
      name: thread.name,
      archived: !!thread.archived,
      locked: !!thread.locked,
      created_at: thread.created_at,
      discord_thread_id: discordThreadId,
    }
  }

  /**
   * Body { name, message_id?, discord_thread_id?, discord_user? }. On message_id the thread
   * hangs off that message (an existing thread of it is returned); otherwise it is standalone.
   * A Discord thread id pairs the thread with the bot's bridge and makes the call idempotent;
   * with it, discord_user (the member who started the Discord thread) names the notice.
   */
  private async createThread(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { name, message_id, discord_thread_id, discord_user } = req.body ?? {}
      const botId = req.bot!.id
      if (typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' })
      }
      if (message_id != null && (typeof message_id !== 'string' || !UUID_PATTERN.test(message_id))) {
        return res.status(400).json({ error: 'message_id must be a message id' })
      }
      if (discord_thread_id != null && (typeof discord_thread_id !== 'string' || !SNOWFLAKE_RE.test(discord_thread_id))) {
        return res.status(400).json({ error: 'discord_thread_id must be a Discord snowflake' })
      }
      const access = await this.channelWriteAccess(botId, channelId, 'send_messages')
      if (!access.ok) return res.status(403).json({ error: access.error })
      if (discord_thread_id != null && !(await this.bridgePairsChannel(botId, channelId))) {
        return res.status(403).json({ error: 'The channel is not bridged by this bot' })
      }

      const { data: threadId, error } = await supabase.rpc('bot_create_thread', {
        p_bot_id: botId,
        p_channel_id: channelId,
        p_name: name,
        p_parent_message_id: message_id ?? null,
        p_discord_thread_id: discord_thread_id ?? null,
        p_discord_user: discord_thread_id != null ? threadStarter(discord_user) : null,
      })
      if (error) {
        const status = error.code === 'P0002' ? 404 : error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500
        return res.status(status).json({ error: error.message })
      }
      const thread = await this.loadThread(threadId as string)
      if (!thread) return res.status(500).json({ error: 'Thread not found after creation' })
      await this.logBotAction(botId, 'thread_created', { channel_id: channelId, thread_id: thread.id }, { channelId })
      res.status(201).json(await this.formatThread(thread, botId))
    } catch (error: any) {
      console.error('Create thread error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async lookupThreadByDiscordId(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const discordThreadId = typeof req.query.discord_thread_id === 'string' ? req.query.discord_thread_id : ''
      const botId = req.bot!.id
      if (!SNOWFLAKE_RE.test(discordThreadId)) {
        return res.status(400).json({ error: 'discord_thread_id must be a Discord snowflake' })
      }
      if (!(await this.canReadChannel(botId, channelId))) {
        return res.status(403).json({ error: 'Channel not visible to this bot' })
      }
      const bridgeId = await this.bridgeIdFor(botId, channelId)
      if (!bridgeId) return res.status(404).json({ error: 'Thread not found' })
      const { data } = await supabase
        .from('discord_bridge_threads')
        .select('thread_id')
        .eq('bridge_id', bridgeId)
        .eq('discord_thread_id', discordThreadId)
        .maybeSingle()
      const thread = data ? await this.loadThread((data as { thread_id: string }).thread_id) : null
      if (!thread || thread.channel_id !== channelId) return res.status(404).json({ error: 'Thread not found' })
      res.json(await this.formatThread(thread, botId))
    } catch (error: any) {
      console.error('Lookup thread error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async getThread(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const thread = await this.loadThread(req.params.threadId)
      if (!thread || !(await this.canReadChannel(botId, thread.channel_id))) {
        return res.status(404).json({ error: 'Thread not found' })
      }
      res.json(await this.formatThread(thread, botId))
    } catch (error: any) {
      console.error('Get thread error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /**
   * Body { discord_thread_id }. Only the bridge bot of a paired channel. The first pair stands:
   * the same id again answers the thread, another id 409 with the standing pair.
   */
  private async pairThread(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const discordThreadId = req.body?.discord_thread_id
      if (typeof discordThreadId !== 'string' || !SNOWFLAKE_RE.test(discordThreadId)) {
        return res.status(400).json({ error: 'discord_thread_id must be a Discord snowflake' })
      }
      const thread = await this.loadThread(req.params.threadId)
      if (!thread || !(await this.canReadChannel(botId, thread.channel_id))) {
        return res.status(404).json({ error: 'Thread not found' })
      }
      const bridgeId = await this.bridgeIdFor(botId, thread.channel_id)
      if (!bridgeId || !(await this.bridgePairsChannel(botId, thread.channel_id))) {
        return res.status(403).json({ error: 'The channel is not bridged by this bot' })
      }
      const { data: existing } = await supabase
        .from('discord_bridge_threads')
        .select('discord_thread_id')
        .eq('thread_id', thread.id)
        .maybeSingle()
      const current = (existing as { discord_thread_id: string } | null)?.discord_thread_id
      if (current && current !== discordThreadId) {
        return res.status(409).json({ error: 'Thread is already paired', discord_thread_id: current })
      }
      if (!current) {
        const { error } = await supabase
          .from('discord_bridge_threads')
          .insert({ thread_id: thread.id, bridge_id: bridgeId, discord_thread_id: discordThreadId })
        if (error) {
          const status = error.code === '23505' ? 409 : 500
          return res.status(status).json({ error: error.message })
        }
      }
      res.json(await this.formatThread(thread, botId))
    } catch (error: any) {
      console.error('Pair thread error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  // MESSAGE ENDPOINTS
  
  private async sendMessage(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { content, embeds, reply_to, metadata, thread_id } = req.body
      const botId = req.bot!.id
      
      console.log(`Bot ${req.bot!.username} (${botId}) attempting to send message to channel ${channelId}`)
      console.log(`Received metadata:`, JSON.stringify(metadata, null, 2))

      const result = await this.createBotMessage(botId, channelId, { content, embeds, reply_to, metadata, thread_id })
      if (!result.ok) return res.status(result.status).json(result.body)
      res.status(result.duplicate ? 200 : 201).json(this.formatMessage(result.message))
    } catch (error: any) {
      console.error('Send message error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /**
   * A bot message in a channel, or in a thread of it: send_messages access, thread checks,
   * typed mass mentions, mention resolution, attachment policy, AutoMod, audit log and link
   * previews. `interaction` is stored as metadata.interaction.
   */
  private async createBotMessage(
    botId: string,
    channelId: string,
    input: BotMessageInput,
    interaction?: Record<string, unknown>,
  ): Promise<WriteResult> {
    const { content, embeds, reply_to, metadata, thread_id } = input
    const access = await this.channelWriteAccess(botId, channelId, 'send_messages')
    if (!access.ok) {
      console.log(`Permission denied for bot ${botId} in channel ${channelId}: ${access.error}`)
      return { ok: false, status: 403, body: { error: access.error }, failure: 'bot_cannot_post' }
    }

    let threadId: string | null = null
    if (thread_id !== undefined && thread_id !== null) {
      const thread = typeof thread_id === 'string' ? await this.loadThread(thread_id) : null
      if (!thread || thread.channel_id !== channelId) {
        return { ok: false, status: 400, body: { error: 'thread_id is not a thread of this channel' }, failure: 'failed' }
      }
      if (thread.locked) {
        return { ok: false, status: 403, body: { error: 'Thread is locked' }, failure: 'thread_locked' }
      }
      threadId = thread.id
    }

    // Instance attachment policy (e.g. mirroring Discord CDN URLs into
    // user_media) is applied here, keeping bots policy-agnostic.
    const { parts: messageContent, mirrorDeferred } = await prepareBotMessageContent({ content, embeds, metadata, channelId, botId })
    if (!Array.isArray(messageContent) || messageContent.length === 0) {
      return { ok: false, status: 400, body: { error: 'Cannot send an empty message' }, failure: 'failed' }
    }

    const bridgeAuthor = claimsBridgeAuthor(metadata) && await this.bridgePairsChannel(botId, channelId)
    const messageMetadata = {
      ...botSuppliedMetadata(metadata, { bridgeAuthor }),
      bot: true,
      created_via: 'bot_api',
      ...(interaction ? { interaction } : {}),
    }

    const messageSelect = `
        *,
        bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
      `
    // Array response, not .single(): the server's AutoMod drops a blocked row and
    // the insert returns zero rows. PostgREST rolls a zero-row singular request
    // back, which would discard the AutoMod event.
    const { data: rows, error } = await supabase
      .from('messages')
      .insert({
        channel_id: channelId,
        thread_id: threadId,
        bot_id: botId,  // Use bot_id instead of user_id
        content: messageContent,
        reply_to: reply_to || null,
        metadata: messageMetadata
      })
      .select(messageSelect)

    // No row: the files this request mirrored into its parts have nothing to reference them.
    if (error || !rows?.[0]) await discardMirroredParts(messageContent, error)

    // The unique index allows one live row per Discord message per channel. A live relay
    // racing a history import (or a retry) loses here; answer with the row that won.
    const discordMessageId = (messageMetadata as Record<string, unknown>).discord_message_id
    if (error?.code === '23505'
      && error.message?.includes('messages_channel_discord_message_id_unique')
      && typeof discordMessageId === 'string') {
      const held = await this.messageIdByDiscordId(channelId, discordMessageId)
      if (held.error) return { ok: false, status: 500, body: { error: held.error }, failure: 'failed' }
      const { data: existing, error: lookupError } = held.id === null
        ? { data: null, error: null }
        : await supabase.from('messages').select(messageSelect).eq('id', held.id).eq('bot_id', botId).maybeSingle()
      if (lookupError) return { ok: false, status: 500, body: { error: lookupError.message }, failure: 'failed' }
      if (existing && existing.is_deleted !== true) return { ok: true, message: existing, duplicate: true }
      // The row that holds the id is another bot's: not this bot's to read back.
      return { ok: false, status: 409, body: { error: 'That Discord message id is taken in this channel', code: 'DISCORD_MESSAGE_ID_TAKEN' }, failure: 'failed' }
    }

    if (error) {
      console.error('Error sending message:', error)
      const blocked = moderationErrorResponse(error)
      if (blocked) {
        const failure = blocked.body.code === 'AUTOMOD_BLOCKED' ? 'automod_blocked' : 'failed'
        return { ok: false, ...blocked, failure }
      }
      if (error.message === BRIDGE_AUTHOR_OPTED_OUT) {
        return { ok: false, status: 403, body: { ...OPTED_OUT_BODY }, failure: 'failed' }
      }
      if (STICKER_REFUSED.test(error.message ?? '')) {
        return { ok: false, status: 422, body: { error: error.message, code: 'STICKER_REFUSED' }, failure: 'failed' }
      }
      if (MESSAGE_TOO_LONG.test(error.message ?? '')) {
        return { ok: false, status: 400, body: { error: error.message }, failure: 'failed' }
      }
      return { ok: false, status: 500, body: { error: error.message }, failure: 'failed' }
    }

    const message = rows?.[0]
    if (!message) {
      return { ok: false, status: 403, body: { ...AUTOMOD_BLOCKED_BODY }, failure: 'automod_blocked' }
    }

    await this.logBotAction(botId, 'message_sent', { channel_id: channelId, message_id: message.id }, { channelId })

    this.triggerLinkPreviewEnrichment(message.id)
    if (mirrorDeferred) await enqueueMirror([message.id])

    return { ok: true, message }
  }

  /**
   * Asks the federation backend to enrich a message's link previews.
   * Best-effort. Auth uses INTERNAL_API_SECRET when set (scoped), otherwise
   * the service-role key. Either secret travels only over localhost or HTTPS.
   */
  private triggerLinkPreviewEnrichment(messageId: string): void {
    const federationUrl = process.env.FEDERATION_BACKEND_URL || 'http://localhost:3001'
    const secret = process.env.INTERNAL_API_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
    if (!secret) return

    try {
      const parsed = new URL(federationUrl)
      const isLocal = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1'
      if (parsed.protocol !== 'https:' && !isLocal) {
        console.warn('Refusing to send internal secret over plain http to a remote FEDERATION_BACKEND_URL')
        return
      }
    } catch {
      return
    }

    fetch(`${federationUrl}/link-preview/enrich-message`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${secret}`,
      },
      body: JSON.stringify({ messageId }),
    }).catch((err) => {
      console.warn(`Link preview enrichment trigger failed for ${messageId}:`, err?.message || err)
    })
  }
  
  /**
   * The id of the live message of a channel that holds a Discord message id; null when none does.
   * bridge_message_by_discord_id reads messages_channel_discord_message_id_unique. A select
   * filtered on metadata->>discord_message_id cannot: it reads every message of the channel.
   */
  private async messageIdByDiscordId(channelId: string, discordMessageId: string): Promise<{ id: string | null; error?: string }> {
    const { data, error } = await supabase.rpc('bridge_message_by_discord_id', {
      p_channel_id: channelId,
      p_discord_message_id: discordMessageId,
    })
    if (error) return { id: null, error: error.message }
    return { id: typeof data === 'string' ? data : null }
  }

  private async lookupMessageByDiscordId(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const discordMessageId = req.query.discord_message_id as string | undefined
      const botId = req.bot!.id

      if (!discordMessageId) {
        return res.status(400).json({ error: 'discord_message_id query parameter is required' })
      }

      const canRead = await this.canReadChannel(botId, channelId)
      if (!canRead) {
        return res.status(403).json({ error: 'Missing permission: read_messages' })
      }

      const held = await this.messageIdByDiscordId(channelId, discordMessageId)
      if (held.error) {
        return res.status(500).json({ error: held.error })
      }
      if (held.id === null) {
        return res.status(404).json({ error: 'Message not found' })
      }

      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          *,
          user:profiles!messages_user_id_fkey(id, username, display_name, avatar_url),
          bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
        .eq('id', held.id)
        .maybeSingle()

      if (error) {
        return res.status(500).json({ error: error.message })
      }
      if (!message || message.is_deleted === true || !(await this.withinHistory(botId, channelId, message.created_at))) {
        return res.status(404).json({ error: 'Message not found' })
      }

      res.json(this.formatMessage(message))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async mergeMessageMetadata(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const { metadata } = req.body || {}
      const botId = req.bot!.id

      if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
        return res.status(400).json({ error: 'metadata must be a JSON object' })
      }

      const { data: message, error: fetchError } = await supabase
        .from('messages')
        .select('channel_id, metadata, bot_id')
        .eq('id', messageId)
        .single()

      if (fetchError || !message) {
        return res.status(404).json({ error: 'Message not found' })
      }

      // Service-role write: without this check a bot could rewrite any
      // message's metadata, including the discord_user field that sets the
      // displayed author. On another author's message a bridge bot records its Discord
      // mapping alone, in a channel its bridge pairs.
      const own = message.bot_id === botId
      if (!own) {
        const entries = Object.entries(metadata)
        const mappingOnly = entries.length > 0 && entries.every(isBridgeMappingEntry)
        if (!mappingOnly || !(await this.bridgePairsChannel(botId, message.channel_id))) {
          return res.status(403).json({ error: 'Bots can only update metadata on their own messages' })
        }
      }

      const access = await this.channelWriteAccess(botId, message.channel_id, 'send_messages')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }

      const bridgeAuthor = own && claimsBridgeAuthor(metadata)
        && await this.bridgePairsChannel(botId, message.channel_id)
      const mergedMetadata = {
        ...(message.metadata || {}),
        ...(own ? botSuppliedMetadata(metadata, { bridgeAuthor }) : metadata),
      }

      const { error: updateError } = await supabase
        .from('messages')
        .update({ metadata: mergedMetadata })
        .eq('id', messageId)

      // An import may already hold this Discord message id in the channel (the unique index of
      // 20261110900002); the live copy lost the race, so the mapping is a no-op like sendMessage's.
      if (updateError?.code === '23505'
        && updateError.message?.includes('messages_channel_discord_message_id_unique')) {
        return res.json({ ok: true, metadata: message.metadata ?? {} })
      }

      if (updateError) {
        return res.status(500).json({ error: updateError.message })
      }

      res.json({ ok: true, metadata: mergedMetadata })
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async getMessages(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { before, after } = req.query
      const limit = queryLimit(req.query.limit, 50, MAX_MESSAGES_PER_READ)
      const botId = req.bot!.id

      const canRead = await this.canReadChannel(botId, channelId)
      if (!canRead) {
        return res.status(403).json({ error: 'Missing permission: read_messages' })
      }
      const since = await this.historySince(botId, channelId)
      if (since === undefined) {
        return res.status(403).json({ error: 'Missing permission: read_messages' })
      }
      
      let query = supabase
        .from('messages')
        .select(`
          *,
          user:profiles!messages_user_id_fkey(id, username, display_name, avatar_url),
          bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
        .eq('channel_id', channelId)
        .order('created_at', { ascending: false })
        .limit(limit)
      
      if (before) {
        query = query.lt('created_at', before as string)
      }
      if (after) {
        query = query.gt('created_at', after as string)
      }
      if (since !== null) {
        query = query.gte('created_at', since)
      }
      
      const { data: messages, error } = await query
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(messages?.map(m => this.formatMessage(m)) || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async getMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const botId = req.bot!.id
      
      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          *,
          bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
        .eq('id', messageId)
        .single()
      
      if (error || !message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      const { data: channel } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', message.channel_id)
        .single()
      
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' })
      }
      
      const canRead = await this.canReadChannel(botId, message.channel_id, channel.server_id)
      if (!canRead) {
        return res.status(403).json({ error: 'Missing permission: read_messages' })
      }
      if (!(await this.withinHistory(botId, message.channel_id, message.created_at, channel.server_id))) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      res.json(this.formatMessage(message))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async editMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const { content } = req.body
      const result = await this.editBotMessage(req.bot!.id, messageId, content)
      if (!result.ok) return res.status(result.status).json(result.body)
      res.json(this.formatMessage(result.message))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  /** New content for the bot's own message: send_messages access, mention resolution, attachment policy, AutoMod. */
  private async editBotMessage(botId: string, messageId: string, content: any, embeds?: any): Promise<WriteResult> {
    const { data: message } = await supabase
      .from('messages')
      .select('user_id, bot_id, channel_id, metadata')
      .eq('id', messageId)
      .single()

    if (!message || message.bot_id !== botId) {
      return { ok: false, status: 403, body: { error: 'Cannot edit messages from other bots or users' }, failure: 'failed' }
    }

    // BUGS.md H38: editing one's own message requires only `send_messages`.
    // Bridge bots hold `send_messages` alone, so gating on `manage_messages`
    // breaks Discord edit-sync. The ownership check above guarantees the bot
    // is the author. `deleteMessage` mirrors this: `manage_messages` is
    // required only for other bots' messages.
    const access = await this.channelWriteAccess(botId, message.channel_id, 'send_messages')
    if (!access.ok) {
      return { ok: false, status: 403, body: { error: access.error }, failure: 'bot_cannot_post' }
    }

    const { parts: messageContent, mirrorDeferred } = await prepareBotMessageContent({
      content,
      embeds,
      metadata: message.metadata,
      channelId: message.channel_id,
      botId,
    })
    if (!Array.isArray(messageContent) || messageContent.length === 0) {
      return { ok: false, status: 400, body: { error: 'Cannot send an empty message' }, failure: 'failed' }
    }

    const { data: updatedRows, error } = await supabase
      .from('messages')
      .update({
        content: messageContent
      })
      .eq('id', messageId)
      .select(`
        *,
        user:profiles!messages_user_id_fkey(id, username, display_name, avatar_url),
        bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
      `)

    if (error || !updatedRows?.[0]) await discardMirroredParts(messageContent, error)

    if (error) {
      const blocked = moderationErrorResponse(error)
      if (blocked) {
        const failure = blocked.body.code === 'AUTOMOD_BLOCKED' ? 'automod_blocked' : 'failed'
        return { ok: false, ...blocked, failure }
      }
      if (error.message === BRIDGE_AUTHOR_OPTED_OUT) {
        return { ok: false, status: 403, body: { ...OPTED_OUT_BODY }, failure: 'failed' }
      }
      if (STICKER_REFUSED.test(error.message ?? '')) {
        return { ok: false, status: 422, body: { error: error.message, code: 'STICKER_REFUSED' }, failure: 'failed' }
      }
      if (MESSAGE_TOO_LONG.test(error.message ?? '')) {
        return { ok: false, status: 400, body: { error: error.message }, failure: 'failed' }
      }
      return { ok: false, status: 500, body: { error: error.message }, failure: 'failed' }
    }

    // The row exists and belongs to this bot (checked above), so zero rows is
    // AutoMod dropping the edit.
    const updated = updatedRows?.[0]
    if (!updated) {
      return { ok: false, status: 403, body: { ...AUTOMOD_BLOCKED_BODY }, failure: 'automod_blocked' }
    }

    await this.logBotAction(botId, 'message_edited', { message_id: messageId }, { channelId: message.channel_id })
    if (mirrorDeferred) await enqueueMirror([messageId])

    return { ok: true, message: updated }
  }

  // APPLICATION COMMANDS

  private async getCommands(req: BotRequest, res: Response) {
    try {
      const { data, error } = await supabase.rpc('get_bot_commands', { p_bot_id: req.bot!.id })
      if (error) {
        const answer = commandErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      res.json(Array.isArray(data) ? data : [])
    } catch (error: any) {
      console.error('Get commands error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /** Body: the bot's whole command set. Names absent from it are deleted; kept names keep their ids. */
  private async replaceCommands(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const checked = validateCommands(req.body)
      if (!checked.ok) return res.status(400).json({ error: checked.error })

      const { data, error } = await supabase.rpc('bot_commands_replace', { p_bot_id: botId, p_commands: checked.value })
      if (error) {
        const answer = commandErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      await this.logBotAction(botId, 'commands_replaced', { count: checked.value.length })
      res.json(Array.isArray(data) ? data : [])
    } catch (error: any) {
      console.error('Replace commands error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /** Body: one command, created or replaced by name. 201 when created. */
  private async upsertCommand(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const checked = validateCommand(req.body)
      if (!checked.ok) return res.status(400).json({ error: checked.error })

      const { data, error } = await supabase.rpc('bot_command_upsert', { p_bot_id: botId, p_command: checked.value })
      if (error) {
        const answer = commandErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      const created = data?.created === true
      await this.logBotAction(botId, created ? 'command_created' : 'command_updated', {
        command_id: data?.command?.id ?? null,
        name: checked.value.name,
      })
      res.status(created ? 201 : 200).json(data?.command ?? null)
    } catch (error: any) {
      console.error('Upsert command error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async deleteCommand(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const { commandId } = req.params
      if (!UUID_PATTERN.test(commandId)) return res.status(404).json(UNKNOWN_COMMAND)

      const { data, error } = await supabase
        .from('bot_commands')
        .delete()
        .eq('id', commandId)
        .eq('bot_id', botId)
        .select('id')
      if (error) return res.status(500).json({ error: error.message })
      if (!Array.isArray(data) || data.length === 0) return res.status(404).json(UNKNOWN_COMMAND)

      await this.logBotAction(botId, 'command_deleted', { command_id: commandId })
      res.status(204).send()
    } catch (error: any) {
      console.error('Delete command error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  // INTERACTIONS

  /** The bot's own interaction, or null when absent or another bot's. */
  private async loadInteraction(botId: string, interactionId: string): Promise<InteractionContext | null> {
    if (!UUID_PATTERN.test(interactionId)) return null
    const { data, error } = await supabase
      .from('bot_interactions')
      .select('id, channel_id, thread_id, user_id, command_name, ephemeral')
      .eq('id', interactionId)
      .eq('bot_id', botId)
      .maybeSingle()
    if (error) throw new Error(`bot_interactions lookup failed: ${error.message}`)
    return (data as InteractionContext | null) ?? null
  }

  /**
   * A private reply's parts: content and embeds as POST /channels/:id/messages reads them
   * (system parts dropped, embeds reduced, paths stripped, role and channel mentions resolved
   * against the interaction's channel), with no message written.
   */
  private async privateReplyParts(content: any, embeds: any, channelId: string, botId: string): Promise<any[]> {
    return resolveMentionParts(formatContent(content, embeds), channelId, botId)
  }

  private privateReply(reply: any, parts: any[]) {
    const content = Array.isArray(reply?.content) ? reply.content : parts
    return { id: reply?.id ?? null, ephemeral: true, content: this.contentToText(content), content_raw: content }
  }

  /**
   * A public reply; metadata.interaction names the invocation. The original's outcome is
   * recorded, a thrown write as 'failed': an unrecorded row stays 'responding' until it expires.
   */
  private async postInteractionMessage(
    botId: string,
    interaction: InteractionContext,
    body: Record<string, any>,
    followup: boolean,
  ): Promise<WriteResult> {
    let result: WriteResult
    try {
      result = await this.createBotMessage(
        botId,
        interaction.channel_id,
        { content: body.content, embeds: body.embeds, thread_id: interaction.thread_id },
        {
          id: interaction.id,
          name: interaction.command_name,
          user_id: interaction.user_id,
          ...(followup ? { followup: true } : {}),
        },
      )
    } catch (error) {
      if (!followup) await this.recordInteraction(botId, interaction.id, null, 'failed')
      throw error
    }
    if (!followup) {
      await this.recordInteraction(botId, interaction.id, result.ok ? result.message.id : null, result.ok ? null : result.failure)
    }
    return result
  }

  /** bot_interaction_record; logs and swallows its failure. */
  private async recordInteraction(botId: string, id: string, messageId: string | null, failure: WriteFailure | null) {
    try {
      const { error } = await supabase.rpc('bot_interaction_record', {
        p_bot_id: botId,
        p_id: id,
        p_message_id: messageId,
        p_error: failure,
      })
      if (error) console.error(`bot_interaction_record failed for ${id}:`, error.message)
    } catch (error: any) {
      console.error(`bot_interaction_record failed for ${id}:`, error?.message ?? error)
    }
  }

  /** bot_interaction_reply's action, carried out and answered. */
  private async answerReply(
    res: Response,
    botId: string,
    interaction: InteractionContext,
    body: Record<string, any>,
    parts: any[],
    outcome: any,
    followup: boolean,
  ) {
    switch (outcome?.action) {
      case 'stored':
        return res.json(this.privateReply(outcome.reply, parts))
      case 'edit_message': {
        const result = await this.editBotMessage(botId, outcome.message_id, body.content, body.embeds)
        if (!result.ok) return res.status(result.status).json(result.body)
        return res.json(this.formatMessage(result.message))
      }
      case 'create_message': {
        const result = await this.postInteractionMessage(botId, interaction, body, followup)
        if (!result.ok) return res.status(result.status).json(result.body)
        return res.json(this.formatMessage(result.message))
      }
      default:
        console.error(`bot_interaction_reply answered no known action for ${interaction.id}:`, outcome)
        return res.status(500).json({ error: 'Interaction reply failed' })
    }
  }

  /**
   * Body {type: 4, data: {content, embeds, flags}} replies, {type: 5, data: {flags}} defers;
   * flags 64 makes the reply private to the invoker. bot_interaction_ack acknowledges before any
   * message is written, so of two answers one acknowledges and the other gets 400.
   */
  private async interactionCallback(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const { interactionId } = req.params
      const { type, data } = req.body ?? {}
      if (type !== CALLBACK_REPLY && type !== CALLBACK_DEFER) {
        return res.status(400).json({ error: 'type must be 4 (reply) or 5 (defer)' })
      }
      if (data !== undefined && data !== null && !isPlainObject(data)) {
        return res.status(400).json({ error: 'data must be an object' })
      }
      const body: Record<string, any> = data ?? {}
      const flags = replyFlags(body.flags)
      if (flags === null) return res.status(400).json({ error: 'flags must be 0 or 64' })
      if (!UUID_PATTERN.test(interactionId)) return res.status(404).json(UNKNOWN_INTERACTION)

      const defer = type === CALLBACK_DEFER
      const ephemeral = flags === EPHEMERAL
      let reply: any[] | null = null
      if (!defer) {
        if (formatContent(body.content, body.embeds).length === 0) {
          return res.status(400).json({ error: 'Cannot send an empty message' })
        }
        if (ephemeral) {
          const interaction = await this.loadInteraction(botId, interactionId)
          if (!interaction) return res.status(404).json(UNKNOWN_INTERACTION)
          reply = await this.privateReplyParts(body.content, body.embeds, interaction.channel_id, botId)
        }
      }

      const { data: ack, error } = await supabase.rpc('bot_interaction_ack', {
        p_bot_id: botId,
        p_id: interactionId,
        p_defer: defer,
        p_ephemeral: ephemeral,
        p_reply: reply,
      })
      if (error) {
        const answer = interactionErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      if (defer || ephemeral) return res.status(204).send()

      if (!isPlainObject(ack) || typeof ack.channel_id !== 'string') {
        console.error(`bot_interaction_ack answered no channel for ${interactionId}:`, ack)
        return res.status(500).json({ error: 'Interaction reply failed' })
      }
      const result = await this.postInteractionMessage(botId, ack as InteractionContext, body, false)
      if (!result.ok) return res.status(result.status).json(result.body)
      res.status(204).send()
    } catch (error: any) {
      console.error('Interaction callback error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /** Body {content, embeds}: edits the reply, or posts it after a defer. The acknowledgement's flags decide privacy. */
  private async interactionResponse(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const { interactionId } = req.params
      const body: Record<string, any> = isPlainObject(req.body) ? req.body : {}
      if (formatContent(body.content, body.embeds).length === 0) {
        return res.status(400).json({ error: 'Cannot send an empty message' })
      }
      const interaction = await this.loadInteraction(botId, interactionId)
      if (!interaction) return res.status(404).json(UNKNOWN_INTERACTION)

      // Parts go with every call: the row's ephemeral decides, and it is set by the acknowledgement.
      const parts = await this.privateReplyParts(body.content, body.embeds, interaction.channel_id, botId)
      const { data, error } = await supabase.rpc('bot_interaction_reply', {
        p_bot_id: botId,
        p_id: interactionId,
        p_kind: 'original',
        p_ephemeral: interaction.ephemeral === true,
        p_reply: parts,
      })
      if (error) {
        const answer = interactionErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      return await this.answerReply(res, botId, interaction, body, parts, data, false)
    } catch (error: any) {
      console.error('Interaction response error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /** Body {content, embeds, flags}: a further reply, private with flags 64. */
  private async interactionFollowup(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      const { interactionId } = req.params
      const body: Record<string, any> = isPlainObject(req.body) ? req.body : {}
      const flags = replyFlags(body.flags)
      if (flags === null) return res.status(400).json({ error: 'flags must be 0 or 64' })
      if (formatContent(body.content, body.embeds).length === 0) {
        return res.status(400).json({ error: 'Cannot send an empty message' })
      }
      const interaction = await this.loadInteraction(botId, interactionId)
      if (!interaction) return res.status(404).json(UNKNOWN_INTERACTION)

      // A public follow-up's parts bound its length before its slot is taken.
      const parts = await this.privateReplyParts(body.content, body.embeds, interaction.channel_id, botId)
      const { data, error } = await supabase.rpc('bot_interaction_reply', {
        p_bot_id: botId,
        p_id: interactionId,
        p_kind: 'followup',
        p_ephemeral: flags === EPHEMERAL,
        p_reply: parts,
      })
      if (error) {
        const answer = interactionErrorResponse(error)
        return res.status(answer.status).json(answer.body)
      }
      return await this.answerReply(res, botId, interaction, body, parts, data, true)
    } catch (error: any) {
      console.error('Interaction follow-up error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }
  
  private async deleteMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const botId = req.bot!.id
      
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, bot_id, channel_id, thread_id, metadata, is_deleted')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      // The bot's own message needs the channel visible; another author's, manage_messages too.
      const access = await this.channelWriteAccess(
        botId,
        message.channel_id,
        message.bot_id === botId ? null : 'manage_messages',
      )
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }
      
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      await this.logBotAction(botId, 'message_deleted', { message_id: messageId }, { channelId: message.channel_id })

      // A soft-deleted row was dispatched when is_deleted was set.
      if (this.deletes && message.is_deleted !== true) {
        this.deletes
          .messageHardDeleted({
            id: messageId,
            channel_id: message.channel_id,
            thread_id: message.thread_id ?? null,
            metadata: message.metadata ?? null,
          })
          .catch(err => console.error(`MESSAGE_DELETE dispatch failed for ${messageId}:`, err))
      }
      
      res.status(204).send()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async addReaction(req: BotRequest, res: Response) {
    try {
      const { messageId, emoji } = req.params
      const { metadata } = req.body
      const botId = req.bot!.id
      
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      const access = await this.channelWriteAccess(botId, message.channel_id, 'add_reactions')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }
      
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emoji)
      
      const insertData: any = {
        message_id: messageId,
        bot_id: botId,
        metadata: reactionMetadata(metadata)
      }
      
      if (isUUID) {
        insertData.emoji_id = emoji
      } else {
        insertData.custom_emoji_content = emoji
        insertData.emoji_id = null
      }
      
      console.log(`Adding reaction: ${isUUID ? 'custom' : 'native'} emoji "${emoji}" to message ${messageId}`)
      
      const { error } = await supabase
        .from('reactions')
        .insert(insertData)
      
      if (error) {
        // check_message_emoji_reaction_limit: 20 different emoji per message, as Discord's 30010.
        if (error.code === '23514' && error.message?.startsWith('REACTION_LIMIT')) {
          return res.status(400).json({ error: 'Maximum number of reactions reached (20)', code: 30010 })
        }
        console.error('Reaction insert error:', error);
        return res.status(500).json({ error: error.message })
      }
      
      res.status(204).send()
    } catch (error: any) {
      console.error('Add reaction exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  private async removeReaction(req: BotRequest, res: Response) {
    try {
      const { messageId, emoji } = req.params
      const { discord_user_id } = req.body ?? {}
      const botId = req.bot!.id
      
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      const access = await this.channelWriteAccess(botId, message.channel_id, 'add_reactions')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }
      
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emoji)
      
      let query = supabase
        .from('reactions')
        .delete()
        .eq('message_id', messageId)
        .eq('bot_id', botId)
      
      if (isUUID) {
        query = query.eq('emoji_id', emoji)
      } else {
        query = query.is('emoji_id', null).eq('custom_emoji_content', emoji)
      }

      if (discord_user_id && typeof discord_user_id === 'string') {
        query = query.filter('metadata->discord_user->>id', 'eq', discord_user_id)
      }
      
      console.log(`Removing reaction: ${isUUID ? 'custom' : 'native'} emoji "${emoji}" from message ${messageId}`)
      
      const { error } = await query
      
      if (error) {
        console.error('Reaction delete error:', error);
        return res.status(500).json({ error: error.message })
      }
      
      res.status(204).send()
    } catch (error: any) {
      console.error('Remove reaction exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  private async triggerTyping(req: BotRequest, res: Response) {
    try {
      // No database effect; answers as a send to the channel would.
      const access = await this.channelWriteAccess(req.bot!.id, req.params.channelId, 'send_messages')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }
      res.status(204).send()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // GUILD ENDPOINTS
  
  private async getGuild(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId || req.params.guildId
      const botId = req.bot!.id
      
      const { data: permission } = await supabase
        .from('bot_server_permissions')
        .select('*')
        .eq('bot_id', botId)
        .eq('server_id', serverId)
        .eq('is_active', true)
        .single()
      
      if (!permission) {
        return res.status(403).json({ error: 'Bot not in server' })
      }
      
      const { data: guild, error } = await supabase
        .from('servers')
        .select(`
          *,
          owner:profiles!servers_owner_fkey(id, username, display_name, avatar_url)
        `)
        .eq('id', serverId)
        .single()
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(this.formatGuild(guild))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async getGuildMembers(req: BotRequest, res: Response) {
    try {
      // Route registered under both /servers/:serverId and /guilds/:guildId.
      const serverId = req.params.serverId || req.params.guildId
      const { after } = req.query
      const limit = queryLimit(req.query.limit, 100, MAX_MEMBERS_PER_READ)
      const botId = req.bot!.id

      // Keyset cursor, as Discord's: the last user.id of the previous page.
      if (after !== undefined && (typeof after !== 'string' || !UUID_PATTERN.test(after))) {
        return res.status(400).json({ error: 'after must be a user id' })
      }
      
      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) {
        return res.status(403).json({ error: 'Bot not in guild' })
      }
      
      let query = supabase
        .from('user_servers')
        .select(`
          *,
          user:profiles!user_servers_user_id_fkey(id, username, display_name, avatar_url, status, domain, is_local)
        `)
        .eq('server_id', serverId)
        .order('user_id')
        .limit(limit)
      
      if (after) {
        query = query.gt('user_id', after)
      }
      
      const { data: members, error } = await query
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(members?.map(m => this.formatMember(m)) || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async getGuildChannels(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId || req.params.guildId
      const botId = req.bot!.id
      
      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) {
        return res.status(403).json({ error: 'Bot not in server' })
      }
      
      const { data: channels, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', serverId)
        .order('order')
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      const visible = await visibleChannels(botId, serverId, channels ?? [])
      res.json(visible.map(c => this.formatChannel(c)))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // USER ENDPOINTS
  
  // CHANNEL / CATEGORY CREATION (used by bridges to mirror server structure)
  //
  // Authorization is `manage_channels` from bot_server_permissions, granted by
  // the server owner at install time. No server-owner check here: that gate
  // belongs to the calling tool (e.g. the /bridge clone-server slash command).

  private async createCategory(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const { name, order } = req.body as { name?: string; order?: number }
      const botId = req.bot!.id

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' })
      }

      const allowed = await checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const { data, error } = await supabase
        .from('channel_categories')
        .insert({
          server_id: serverId,
          name: name.trim().slice(0, 100),
          order: typeof order === 'number' ? order : 0,
        })
        .select('*')
        .single()

      if (error) return res.status(500).json({ error: error.message })

      await this.logBotAction(botId, 'category_created', { server_id: serverId, category_id: data.id }, { serverId })
      res.status(201).json(data)
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async createChannel(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const { name, type, category_id, description, order } =
        req.body as {
          name?: string
          type?: number
          category_id?: string | null
          description?: string | null
          order?: number
        }
      const botId = req.bot!.id

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' })
      }
      // Harmony channel types: 0=text, 1=voice, 2=category.
      // Category is rejected here; use the /categories endpoint.
      const channelType = type === 1 ? 1 : 0

      const allowed = await checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const { data, error } = await supabase
        .from('channels')
        .insert({
          server_id: serverId,
          name: name.trim().slice(0, 100),
          type: channelType,
          category: category_id || null,
          description: description ? description.slice(0, 1024) : null,
          order: typeof order === 'number' ? order : 0,
        })
        .select('*')
        .single()

      // The database applies the channel naming rule (channel_name_normalized): a text channel's
      // name is lowercased with '-' for spaces, and one the rule empties is a check violation.
      if (error?.code === '23514') return res.status(400).json({ error: error.message })
      if (error) return res.status(500).json({ error: error.message })

      await this.logBotAction(botId, 'channel_created', { server_id: serverId, channel_id: data.id }, { serverId, channelId: data.id })
      res.status(201).json(this.formatChannel(data))
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async updateCategory(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const categoryId = req.params.categoryId
      const { name, order } = req.body as { name?: string; order?: number }
      const botId = req.bot!.id

      const allowed = await checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const patch: Record<string, unknown> = {}
      if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 100)
      if (typeof order === 'number') patch.order = order
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' })
      }

      const { data, error } = await supabase
        .from('channel_categories')
        .update(patch)
        .eq('id', categoryId)
        .eq('server_id', serverId)
        .select('*')
        .single()

      if (error) return res.status(500).json({ error: error.message })
      if (!data) return res.status(404).json({ error: 'Category not found' })

      res.json(data)
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async updateChannel(req: BotRequest, res: Response) {
    try {
      const channelId = req.params.channelId
      const { order, category_id } = req.body as { order?: number; category_id?: string | null }
      const botId = req.bot!.id

      const { data: existing, error: fetchError } = await supabase
        .from('channels')
        .select('id, server_id')
        .eq('id', channelId)
        .maybeSingle()

      if (fetchError) return res.status(500).json({ error: fetchError.message })
      if (!existing?.server_id) return res.status(404).json({ error: 'Channel not found' })

      const allowed = await checkServerPermission(
        botId,
        existing.server_id,
        'manage_channels',
      )
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const patch: Record<string, unknown> = {}
      if (typeof order === 'number') patch.order = order
      if (category_id !== undefined) patch.category = category_id || null
      if (Object.keys(patch).length === 0) {
        return res.status(400).json({ error: 'No valid fields to update' })
      }

      const { data, error } = await supabase
        .from('channels')
        .update(patch)
        .eq('id', channelId)
        .select('*')
        .single()

      if (error) return res.status(500).json({ error: error.message })

      res.json(this.formatChannel(data))
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async getCategories(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId || req.params.guildId
      const botId = req.bot!.id
      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) return res.status(403).json({ error: 'Bot not in server' })

      const { data, error } = await supabase
        .from('channel_categories')
        .select('*')
        .eq('server_id', serverId)
        .order('order')

      if (error) return res.status(500).json({ error: error.message })
      // As channel_categories RLS for members: a channel manager sees every category, anyone
      // else those holding a channel they see.
      if (await checkServerPermission(botId, serverId, 'manage_channels')) return res.json(data || [])
      const { data: channels, error: channelsError } = await supabase
        .from('channels')
        .select('id, category')
        .eq('server_id', serverId)
      if (channelsError) return res.status(500).json({ error: channelsError.message })
      const filed = ((channels ?? []) as Array<{ id: string; category: string | null }>).filter((c) => c.category)
      const visible = await visibleChannels(botId, serverId, filed)
      const shown = new Set(visible.map((c) => c.category))
      res.json((data || []).filter((k: { id: string }) => shown.has(k.id)))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async getRoles(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) return res.status(403).json({ error: 'Bot not in server' })

      const { data, error } = await supabase
        .from('server_roles')
        .select('id, name, color, position, permissions, is_default, is_admin, mentionable, hoist')
        .eq('server_id', serverId)
        .order('position', { ascending: false })

      if (error) return res.status(500).json({ error: error.message })
      // permissions is bigint -> returned as string by PostgREST; pass through.
      res.json(data || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  /**
   * Role-write authority: manage_roles, the bits the bot may set (grantableRoleBits) and the
   * exclusive position cap (rolePositionCap).
   */
  private async loadRoleAuthority(botId: string, serverId: string): Promise<
    | { ok: true; grantable: bigint; positionCap: number }
    | { ok: false; status: number; error: string }
  > {
    const install = await loadInstall(botId, serverId)
    if (!install || install.manage_roles !== true) {
      return { ok: false, status: 403, error: 'Missing permission: manage_roles' }
    }

    const [rolesResult, serverResult] = await Promise.all([
      supabase
        .from('server_roles')
        .select('id, position, permissions, is_default, is_admin')
        .eq('server_id', serverId),
      supabase.from('servers').select('owner').eq('id', serverId).maybeSingle(),
    ])
    const roles = rolesResult.data as RoleRow[] | null
    const server = serverResult.data as { owner: string | null } | null
    if (rolesResult.error || serverResult.error || !Array.isArray(roles) || !server) {
      console.error('Role authority lookup failed:', rolesResult.error?.message ?? serverResult.error?.message)
      return { ok: false, status: 500, error: 'Role lookup failed' }
    }

    const installerIsOwner = server.owner != null && server.owner === install.installed_by
    let installerRoleIds = new Set<string>()
    if (!installerIsOwner) {
      const { data: held, error } = await supabase
        .from('user_roles')
        .select('role_id')
        .eq('user_id', install.installed_by as string)
        .eq('server_id', serverId)
      if (error || !Array.isArray(held)) {
        console.error('Installer role lookup failed:', error?.message)
        return { ok: false, status: 500, error: 'Role lookup failed' }
      }
      installerRoleIds = new Set(held.map((row: { role_id: string }) => row.role_id))
    }

    const everyone = roles.find((role) => role.is_default === true)
    const everyonePermissions = everyone ? parseMask(everyone.permissions ?? 0) ?? 0n : 0n

    return {
      ok: true,
      grantable: grantableRoleBits(install, u64(everyonePermissions)),
      positionCap: rolePositionCap(roles, installerIsOwner, installerRoleIds),
    }
  }

  private positionCapError(positionCap: number) {
    return Number.isFinite(positionCap)
      ? { error: 'Role position must be below the bot\'s highest manageable position', max_position: positionCap - 1 }
      : { error: 'Role position out of range' }
  }

  // Request masks: unparseable reads as 0, ADMINISTRATOR is cleared.
  private requestedRoleMask(permissions: unknown): bigint {
    return (parseMask(permissions ?? 0) ?? 0n) & ~ADMINISTRATOR
  }

  private missingBitsError(missing: bigint, scope: string) {
    return {
      error: `Cannot grant permissions the bot does not hold ${scope}`,
      missing_permissions: missing.toString(),
    }
  }

  private async createRole(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const { name, color, position, permissions, mentionable, hoist } =
        req.body as {
          name?: string
          color?: string | null
          position?: number
          permissions?: string | number | null
          mentionable?: boolean
          hoist?: boolean
        }

      if (!name || typeof name !== 'string' || !name.trim()) {
        return res.status(400).json({ error: 'name is required' })
      }

      const authority = await this.loadRoleAuthority(botId, serverId)
      if (!authority.ok) {
        return res.status(authority.status).json({ error: authority.error })
      }

      const rolePosition = typeof position === 'number' ? position : 0
      if (!Number.isInteger(rolePosition)) {
        return res.status(400).json({ error: 'position must be an integer' })
      }
      if (!(rolePosition < authority.positionCap)) {
        return res.status(403).json(this.positionCapError(authority.positionCap))
      }

      // Bigint bitmask in string form; JS numbers cannot carry 53+ bit ints.
      const permMask = this.requestedRoleMask(permissions)
      const missing = u64(permMask) & ~authority.grantable
      if (missing !== 0n) {
        return res.status(403).json(this.missingBitsError(missing, 'in this server'))
      }

      const { data, error } = await supabase
        .from('server_roles')
        .insert({
          server_id: serverId,
          name: name.trim().slice(0, 100),
          color: color || null,
          position: rolePosition,
          permissions: permMask.toString(),
          mentionable: mentionable ?? true,
          hoist: hoist ?? false,
          is_default: false,
          is_admin: false,
        })
        .select('id, name, color, position, permissions, mentionable, hoist')
        .single()

      if (error) return res.status(500).json({ error: error.message })

      await this.logBotAction(botId, 'role_created', { server_id: serverId, role_id: data.id }, { serverId })
      res.status(201).json(data)
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  /**
   * The existing role a bot may edit or delete: not @everyone, not an administrator role, and
   * strictly below the position cap.
   */
  private async loadManageableRole(
    serverId: string,
    roleId: string,
    positionCap: number,
  ): Promise<{ ok: true; role: RoleRow } | { ok: false; status: number; error: string }> {
    const { data: role, error } = await supabase
      .from('server_roles')
      .select('id, position, permissions, is_default, is_admin')
      .eq('id', roleId)
      .eq('server_id', serverId)
      .maybeSingle()

    if (error || !role) {
      return { ok: false, status: 404, error: 'Role not found' }
    }
    if (role.is_default || isAdminRole(role)) {
      return { ok: false, status: 403, error: 'Cannot modify default or admin roles via bot API' }
    }
    if (!((role.position ?? 0) < positionCap)) {
      return { ok: false, status: 403, error: 'Role is at or above the bot\'s highest manageable position' }
    }
    return { ok: true, role }
  }

  private async updateRole(req: BotRequest, res: Response) {
    try {
      const { serverId, roleId } = req.params
      const botId = req.bot!.id
      const { name, color, position, permissions, mentionable, hoist } =
        req.body as {
          name?: string
          color?: string | null
          position?: number
          permissions?: string | number | null
          mentionable?: boolean
          hoist?: boolean
        }

      const authority = await this.loadRoleAuthority(botId, serverId)
      if (!authority.ok) {
        return res.status(authority.status).json({ error: authority.error })
      }

      const existing = await this.loadManageableRole(serverId, roleId, authority.positionCap)
      if (!existing.ok) {
        return res.status(existing.status).json({ error: existing.error })
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 100)
      if (color !== undefined) patch.color = color || null
      if (typeof position === 'number') {
        if (!Number.isInteger(position)) {
          return res.status(400).json({ error: 'position must be an integer' })
        }
        if (!(position < authority.positionCap)) {
          return res.status(403).json(this.positionCapError(authority.positionCap))
        }
        patch.position = position
      }
      if (mentionable !== undefined) patch.mentionable = mentionable
      if (hoist !== undefined) patch.hoist = hoist
      if (permissions !== undefined) {
        const permMask = this.requestedRoleMask(permissions)
        // Bits the role already carries may stay; only added bits must be the bot's.
        const current = u64(parseMask(existing.role.permissions ?? 0) ?? 0n)
        const missing = u64(permMask) & ~current & ~authority.grantable
        if (missing !== 0n) {
          return res.status(403).json(this.missingBitsError(missing, 'in this server'))
        }
        patch.permissions = permMask.toString()
      }

      const { data, error } = await supabase
        .from('server_roles')
        .update(patch)
        .eq('id', roleId)
        .eq('server_id', serverId)
        .select('id, name, color, position, permissions, mentionable, hoist')
        .maybeSingle()

      if (error) return res.status(500).json({ error: error.message })
      if (!data) return res.status(404).json({ error: 'Role not found' })

      await this.logBotAction(botId, 'role_updated', { server_id: serverId, role_id: roleId }, { serverId })
      res.json(data)
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async deleteRole(req: BotRequest, res: Response) {
    try {
      const { serverId, roleId } = req.params
      const botId = req.bot!.id

      const authority = await this.loadRoleAuthority(botId, serverId)
      if (!authority.ok) {
        return res.status(authority.status).json({ error: authority.error })
      }

      const existing = await this.loadManageableRole(serverId, roleId, authority.positionCap)
      if (!existing.ok) {
        return res.status(existing.status).json({ error: existing.error })
      }

      const { error } = await supabase
        .from('server_roles')
        .delete()
        .eq('id', roleId)
        .eq('server_id', serverId)

      if (error) return res.status(500).json({ error: error.message })

      await this.logBotAction(botId, 'role_deleted', { server_id: serverId, role_id: roleId }, { serverId })
      res.status(204).send()
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async resolveChannelServer(channelId: string): Promise<string | null> {
    const { data } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()
    return data?.server_id ?? null
  }

  private async getChannelPermissionOverrides(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const botId = req.bot!.id
      const serverId = await this.resolveChannelServer(channelId)
      if (!serverId) return res.status(404).json({ error: 'Channel not found' })

      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) return res.status(403).json({ error: 'Bot not in server' })

      const { data, error } = await supabase
        .from('channel_permission_overrides')
        .select('id, channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions')
        .eq('channel_id', channelId)

      if (error) return res.status(500).json({ error: error.message })
      res.json(data || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  /**
   * manage_channels in the channel's server, and the bot's permissions in the channel
   * (botChannelMask), which bound what an override write may grant.
   */
  private async loadOverrideAuthority(botId: string, serverId: string, channelId: string): Promise<
    | { ok: true; channelMask: bigint }
    | { ok: false; status: number; error: string }
  > {
    const install: InstallRow | null = await loadInstall(botId, serverId)
    if (!install || install.manage_channels !== true) {
      return { ok: false, status: 403, error: 'Missing permission: manage_channels' }
    }
    const layer = await loadEveryoneLayer(serverId, channelId)
    if (!layer) {
      return { ok: false, status: 500, error: 'Permission lookup failed' }
    }
    return { ok: true, channelMask: botChannelMask(install, layer, channelId) }
  }

  // Stored override masks, unsigned. An unreadable allow counts as empty and an unreadable deny
  // as total, so neither hides a grant.
  private storedOverride(row: { allow_permissions?: unknown; deny_permissions?: unknown }) {
    const allow = parseMask(row.allow_permissions ?? 0)
    const deny = parseMask(row.deny_permissions ?? 0)
    return {
      allow: allow === null ? 0n : u64(allow),
      deny: deny === null ? ALL_BITS : u64(deny),
    }
  }

  private async upsertChannelPermissionOverride(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const botId = req.bot!.id
      const { target_type, role_id, user_id, allow_permissions, deny_permissions } =
        req.body as {
          target_type?: 'role' | 'user'
          role_id?: string | null
          user_id?: string | null
          allow_permissions?: string | number
          deny_permissions?: string | number
        }

      const serverId = await this.resolveChannelServer(channelId)
      if (!serverId) return res.status(404).json({ error: 'Channel not found' })

      const authority = await this.loadOverrideAuthority(botId, serverId, channelId)
      if (!authority.ok) {
        return res.status(authority.status).json({ error: authority.error })
      }

      if (target_type !== 'role' && target_type !== 'user') {
        return res.status(400).json({ error: 'target_type must be role or user' })
      }
      if (target_type === 'role' && !role_id) {
        return res.status(400).json({ error: 'role_id is required for role overrides' })
      }
      if (target_type === 'user' && !user_id) {
        return res.status(400).json({ error: 'user_id is required for user overrides' })
      }

      const parsedAllow = parseMask(allow_permissions ?? 0)
      const parsedDeny = parseMask(deny_permissions ?? 0)
      if (parsedAllow === null || parsedDeny === null) {
        return res.status(400).json({ error: 'Invalid permission bitmask' })
      }
      const allowMask = parsedAllow & ~ADMINISTRATOR
      const denyMask = parsedDeny & ~ADMINISTRATOR

      const baseQuery = supabase
        .from('channel_permission_overrides')
        .select('id, allow_permissions, deny_permissions')
        .eq('channel_id', channelId)

      const { data: existing, error: lookupErr } =
        target_type === 'role'
          ? await baseQuery.eq('role_id', role_id!).is('user_id', null).maybeSingle()
          : await baseQuery.eq('user_id', user_id!).is('role_id', null).maybeSingle()

      if (lookupErr) return res.status(500).json({ error: lookupErr.message })

      // Lifting a deny grants as surely as adding an allow.
      const grants = overrideGrants(
        existing ? this.storedOverride(existing) : null,
        { allow: u64(allowMask), deny: u64(denyMask) },
      )
      const missing = grants & ~authority.channelMask
      if (missing !== 0n) {
        return res.status(403).json(this.missingBitsError(missing, 'in this channel'))
      }

      if (allowMask === 0n && denyMask === 0n) {
        if (existing?.id) {
          await supabase.from('channel_permission_overrides').delete().eq('id', existing.id)
        }
        return res.status(204).send()
      }

      const row = {
        allow_permissions: allowMask.toString(),
        deny_permissions: denyMask.toString(),
        updated_at: new Date().toISOString(),
      }

      if (existing?.id) {
        const { data, error } = await supabase
          .from('channel_permission_overrides')
          .update(row)
          .eq('id', existing.id)
          .select('*')
          .single()
        if (error) return res.status(500).json({ error: error.message })
        return res.json(data)
      }

      const { data, error } = await supabase
        .from('channel_permission_overrides')
        .insert({
          channel_id: channelId,
          target_type,
          role_id: target_type === 'role' ? role_id : null,
          user_id: target_type === 'user' ? user_id : null,
          ...row,
        })
        .select('*')
        .single()

      if (error) return res.status(500).json({ error: error.message })
      res.status(201).json(data)
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async deleteChannelPermissionOverrideForRole(req: BotRequest, res: Response) {
    try {
      const { channelId, roleId } = req.params
      const botId = req.bot!.id
      const serverId = await this.resolveChannelServer(channelId)
      if (!serverId) return res.status(404).json({ error: 'Channel not found' })

      const authority = await this.loadOverrideAuthority(botId, serverId, channelId)
      if (!authority.ok) {
        return res.status(authority.status).json({ error: authority.error })
      }

      const { data: existing, error: lookupErr } = await supabase
        .from('channel_permission_overrides')
        .select('id, allow_permissions, deny_permissions')
        .eq('channel_id', channelId)
        .eq('role_id', roleId)
        .is('user_id', null)

      if (lookupErr || !Array.isArray(existing)) {
        return res.status(500).json({ error: lookupErr?.message ?? 'Override lookup failed' })
      }

      // Deleting lifts every deny the override carries.
      const lifted = existing.reduce((mask, row) => mask | this.storedOverride(row).deny, 0n)
      const missing = lifted & ~authority.channelMask
      if (missing !== 0n) {
        return res.status(403).json(this.missingBitsError(missing, 'in this channel'))
      }

      const { error } = await supabase
        .from('channel_permission_overrides')
        .delete()
        .eq('channel_id', channelId)
        .eq('role_id', roleId)
        .is('user_id', null)

      if (error) return res.status(500).json({ error: error.message })
      res.status(204).send()
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }

  private async getUser(req: BotRequest, res: Response) {
    try {
      const { userId } = req.params
      
      const { data: user, error } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, bio')
        .eq('id', userId)
        .single()
      
      if (error) {
        return res.status(404).json({ error: 'User not found' })
      }
      
      res.json(this.formatUser(user))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async getCurrentBot(req: BotRequest, res: Response) {
    try {
      const botId = req.bot!.id
      
      const { data: bot, error } = await supabase
        .from('bots')
        .select('*')
        .eq('id', botId)
        .single()
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json({ ...this.formatBot(bot), capabilities: GATEWAY_CAPABILITIES })
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // PERMISSION HELPERS
  
  /**
   * The bot is a bridge bot (bot_type 'bridge') and its bridge relays the channel: a
   * discord_bridge_channels pair of the v2 bridge whose bot it is, or, for a bot that is no v2
   * bridge's bot, a v1 discord_bridge_pairings row of the channel's server whose bot the pairing's
   * creator or the server's owner owns or installed. A pairing names no bot. False on any failed
   * lookup. A true answer is cached for BRIDGE_PAIR_TTL_MS.
   */
  private async bridgePairsChannel(botId: string, channelId: string | null | undefined): Promise<boolean> {
    if (!channelId) return false
    const key = `${botId}:${channelId}`
    if (this.bridgePairs.get(key)) return true
    const paired = await this.lookupBridgePair(botId, channelId)
    if (paired) this.bridgePairs.set(key, true)
    return paired
  }

  private async lookupBridgePair(botId: string, channelId: string): Promise<boolean> {
    const { data: bot, error: botError } = await supabase
      .from('bots')
      .select('bot_type, owner_id')
      .eq('id', botId)
      .maybeSingle()
    if (botError || bot?.bot_type !== 'bridge') return false

    const { data: bridges, error: bridgeError } = await supabase
      .from('discord_bridges')
      .select('id')
      .eq('bot_id', botId)
    if (bridgeError || !Array.isArray(bridges)) return false

    if (bridges.length > 0) {
      const { data: pairs, error: pairError } = await supabase
        .from('discord_bridge_channels')
        .select('id')
        .in('bridge_id', bridges.map((b: { id: string }) => b.id))
        .eq('harmony_channel_id', channelId)
        .limit(1)
      return !pairError && Array.isArray(pairs) && pairs.length > 0
    }

    const serverId = await lookupChannelServerId(channelId)
    if (!serverId) return false
    const { data: pairing, error: pairingError } = await supabase
      .from('discord_bridge_pairings')
      .select('created_by')
      .eq('server_id', serverId)
      .maybeSingle()
    if (pairingError || !pairing) return false

    const { data: server } = await supabase
      .from('servers')
      .select('owner')
      .eq('id', serverId)
      .maybeSingle()
    const { data: install } = await supabase
      .from('bot_server_permissions')
      .select('installed_by')
      .eq('bot_id', botId)
      .eq('server_id', serverId)
      .maybeSingle()
    const trusted = [pairing.created_by, server?.owner].filter(Boolean)
    return trusted.includes(bot.owner_id) || trusted.includes(install?.installed_by)
  }

  /**
   * A write in a channel (botCanWriteChannel). A missing flag, installation or channel answers
   * `Missing permission: <flag>`; a channel the bot cannot see, or whose visibility lookup
   * fails, `Channel not visible to this bot`; a flag whose bit @everyone's override denies
   * there, `Missing permission in this channel: <flag>`.
   */
  private async channelWriteAccess(
    botId: string,
    channelId: string | null | undefined,
    flag: ChannelWriteFlag | null,
  ): Promise<ChannelAccess> {
    const hidden: ChannelAccess = { ok: false, error: 'Channel not visible to this bot' }
    const denied: ChannelAccess = flag ? { ok: false, error: `Missing permission: ${flag}` } : hidden
    if (!channelId) return denied
    const serverId = await lookupChannelServerId(channelId)
    if (!serverId) return denied
    const install = await loadInstall(botId, serverId)
    if (!install || (flag !== null && install[flag] !== true)) return denied
    const layer = await loadEveryoneLayer(serverId, channelId)
    if (!layer || !botCanSeeChannel(install, layer, channelId)) return hidden
    if (!botCanWriteChannel(install, layer, channelId, flag)) {
      return { ok: false, error: `Missing permission in this channel: ${flag}` }
    }
    return { ok: true }
  }

  /**
   * Earliest created_at the bot reads in a channel: null with botReadsHistory, else the install
   * time ('infinity' when the row has none). Undefined when a lookup fails.
   */
  private async historySince(botId: string, channelId: string, serverId?: string): Promise<string | null | undefined> {
    const channelServerId = serverId ?? (await lookupChannelServerId(channelId))
    if (!channelServerId) return undefined
    const install = await loadInstall(botId, channelServerId)
    const layer = install ? await loadEveryoneLayer(channelServerId, channelId) : null
    if (!install || !layer) return undefined
    if (botReadsHistory(install, layer, channelId)) return null
    return typeof install.installed_at === 'string' ? install.installed_at : 'infinity'
  }

  /** A message dated `createdAt` is within the bot's history of the channel. */
  private async withinHistory(botId: string, channelId: string, createdAt: string, serverId?: string): Promise<boolean> {
    const since = await this.historySince(botId, channelId, serverId)
    if (since === null) return true
    if (since === undefined) return false
    const at = Date.parse(createdAt)
    const floor = Date.parse(since)
    return Number.isFinite(at) && Number.isFinite(floor) && at >= floor
  }

  /**
   * read_messages and botCanSeeChannel: allowed_channel_ids, which also grants a channel
   * @everyone cannot view, else VIEW_CHANNEL as a holder of @everyone. False on any failed lookup.
   */
  private async canReadChannel(botId: string, channelId: string, serverId?: string): Promise<boolean> {
    const channelServerId = serverId ?? (await lookupChannelServerId(channelId))
    if (!channelServerId) return false

    const install = await loadInstall(botId, channelServerId)
    if (!install || install.read_messages !== true) return false

    const layer = await loadEveryoneLayer(channelServerId, channelId)
    if (!layer) return false

    return botCanReadChannel(install, layer, channelId)
  }

  private async checkBotInGuild(botId: string, guildId: string): Promise<boolean> {
    const { data } = await supabase
      .from('bot_server_permissions')
      .select('id')
      .eq('bot_id', botId)
      .eq('server_id', guildId)
      .eq('is_active', true)
      .single()
    
    return !!data
  }
  
  // FORMATTERS
  
  private formatAvatarUrl(avatarPath: string | null | undefined): string | undefined {
    return absoluteAvatarUrl(avatarPath)
  }
  
  private formatMessage(message: any) {
    const author = message.bot || message.user
    
    return {
      id: message.id,
      channel_id: message.channel_id,
      thread_id: message.thread_id ?? null,
      author: author ? {
        id: author.id,
        username: author.username,
        display_name: author.display_name,
        avatar: this.formatAvatarUrl(author.avatar_url),
        bot: !!message.bot  // Flag to indicate if this is a bot message
      } : null,
      content: this.contentToText(message.content),
      // A system notice has no author; metadata names the people it is about.
      is_system: message.is_system === true,
      reply_to: message.reply_to ?? null,
      timestamp: message.created_at,
      edited_timestamp: message.updated_at,
      mentions: this.extractMentions(message.content),
      metadata: message.metadata // Include metadata in response
    }
  }
  
  private formatGuild(guild: any) {
    return {
      id: guild.id,
      name: guild.name,
      icon: absoluteServerIconUrl(guild.icon),
      owner_id: guild.owner,
      description: guild.description,
      member_count: guild.member_count || 0
    }
  }
  
  private formatChannel(channel: any) {
    return {
      id: channel.id,
      type: DISCORD_CHANNEL_TYPE[channel.type as number] ?? 0,
      guild_id: channel.server_id,
      name: channel.name,
      position: channel.order ?? 0,
      order: channel.order ?? 0,
      parent_id: channel.category,
      category_id: channel.category,
    }
  }
  
  private formatMember(member: any) {
    return {
      user: member.user ? {
        id: member.user.id,
        username: member.user.username,
        display_name: member.user.display_name,
        domain: member.user.domain ?? null,
        is_local: member.user.is_local ?? true,
        avatar: this.formatAvatarUrl(member.user.avatar_url)
      } : null,
      nick: member.nickname,
      roles: member.roles || [],
      joined_at: member.created_at
    }
  }
  
  private formatUser(user: any) {
    return {
      id: user.id,
      username: user.username,
      display_name: user.display_name,
      avatar: this.formatAvatarUrl(user.avatar_url),
      bio: user.bio
    }
  }
  
  private formatBot(bot: any) {
    return {
      id: bot.id,
      username: bot.username,
      discriminator: bot.discriminator,
      avatar: this.formatAvatarUrl(bot.avatar_url),
      bot: true,
      verified: bot.is_verified,
      public: bot.is_public
    }
  }
  
  private contentToText(content: any): string {
    if (typeof content === 'string') return content
    
    if (Array.isArray(content)) {
      return content
        .filter(part => part.type === 'text')
        .map(part => part.text || part.value || '')  // Support both 'text' and 'value' for compatibility
        .join(' ')
    }
    
    return ''
  }
  
  private extractMentions(content: any): string[] {
    if (!Array.isArray(content)) return []
    
    return content
      .filter(part => part.type === 'mention')
      .map(part => part.user_id)
      .filter(Boolean)
  }
  
  // INVITE PREVIEW (public invite cards for bridge embeds)

  private async getInvitePreview(req: BotRequest, res: Response) {
    try {
      const { code } = req.params
      if (!code) {
        return res.status(400).json({ error: 'Invite code is required' })
      }

      const { data: rows, error } = await supabase.rpc('lookup_invite_by_code', { p_code: code })
      if (error) {
        return res.status(500).json({ error: error.message })
      }

      const invite = Array.isArray(rows) ? rows[0] : null
      if (!invite || invite.used) {
        return res.status(404).json({ error: 'Invite not found or expired' })
      }
      if (invite.expires_at && new Date(invite.expires_at) < new Date()) {
        return res.status(404).json({ error: 'Invite expired' })
      }

      const { count: memberCount } = await supabase
        .from('user_servers')
        .select('*', { count: 'exact', head: true })
        .eq('server_id', invite.server_id)
        .eq('status', 'accepted')

      const publicUrl = process.env.PUBLIC_URL || process.env.SUPABASE_URL || ''
      const serverIconUrl = absoluteServerIconUrl(invite.server_icon)

      const { data: server } = await supabase
        .from('servers')
        .select('description')
        .eq('id', invite.server_id)
        .maybeSingle()

      const invitePath = `/invite/${invite.code}`
      const inviteUrl = publicUrl ? `${publicUrl.replace(/\/$/, '')}${invitePath}` : invitePath

      res.json({
        code: invite.code,
        invite_url: inviteUrl,
        server_name: invite.server_name || 'Harmony Server',
        server_description: server?.description ?? null,
        server_icon_url: serverIconUrl,
        member_count: memberCount ?? 0,
      })
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  // EMOJI METHODS
  
  // Every emojis row is readable by every account (policy emojis_select_all), so every row
  // is visible to a bot. ?id= answers a removed emoji too, with its deleted_at; the list holds
  // active emoji only.
  private async getEmojis(req: BotRequest, res: Response) {
    try {
      const { url, id } = req.query

      // ?id= answers one emoji: its object, or 404.
      if (id !== undefined) {
        if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
          return res.status(400).json({ error: 'id must be an emoji UUID' })
        }
        const { data: emoji, error } = await supabase.from('emojis').select('*').eq('id', id).maybeSingle()
        if (error) {
          return res.status(500).json({ error: error.message })
        }
        if (!emoji) {
          return res.status(404).json({ error: 'Emoji not found' })
        }
        return res.json(emoji)
      }
      
      let query = supabase.from('emojis').select('*').is('deleted_at', null)
      
      // Filtering by url answers "does this Discord emoji already exist".
      if (url && typeof url === 'string') {
        query = query.eq('url', url)
      }
      
      const { data: emojis, error } = await query
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(emojis || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async getServerEmojis(req: BotRequest, res: Response) {
    const serverId = req.params.serverId
    if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
    if (!(await this.checkBotInGuild(req.bot!.id, serverId))) {
      return res.status(403).json({ error: 'Bot is not in this server' })
    }
    const { data, error } = await supabase
      .from('emojis')
      .select('id, name, url, server_id, discord_emoji_id')
      .eq('server_id', serverId)
      .is('deleted_at', null)
    if (error) return res.status(500).json({ error: error.message })
    res.json(data ?? [])
  }

  private emojiError(res: Response, error: { code?: string; message: string }) {
    if (error.message?.startsWith('SERVER_EMOJI_LIMIT')) {
      return res.status(409).json({ error: error.message, code: 'EMOJI_LIMIT' })
    }
    if (error.code === '23505') return res.status(409).json({ error: error.message, code: 'EMOJI_NAME_TAKEN' })
    if (error.code === 'P0002') return res.status(404).json({ error: error.message })
    const refused = this.refusalCode(error, ['EMOJI_NOT_LINKED', 'EMOJI_REMOVED'])
    if (refused) return res.status(403).json({ error: error.message, code: refused })
    const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500
    return res.status(status).json({ error: error.message })
  }

  /** The CODE of a 42501 raised as 'CODE: text', when it is one of `codes`. */
  private refusalCode(error: { code?: string; message: string }, codes: string[]): string | null {
    if (error.code !== '42501') return null
    return codes.find((code) => error.message?.startsWith(`${code}:`)) ?? null
  }

  /**
   * Deletes what the bot's removals left past the kept count: the RPC lists the rows, their
   * files go first, then the RPC deletes the rows. A failed file removal leaves its rows for
   * the next call.
   */
  private async evictBridgeRemoved(
    rpc: 'bridge_evict_removed_emojis' | 'bridge_evict_retired_stickers',
    bucket: string,
    botId: string,
    serverId: string,
  ): Promise<void> {
    try {
      const { data, error } = await supabase.rpc(rpc, { p_bot_id: botId, p_server_id: serverId, p_ids: null })
      if (error) return console.warn(`${rpc} list failed: ${error.message}`)
      const past = (Array.isArray(data) ? data : []) as Array<{ id: string; path: string | null }>
      if (past.length === 0) return
      const paths = past.map((row) => row.path).filter((path): path is string => !!path)
      if (paths.length > 0) {
        const { error: removeError } = await supabase.storage.from(bucket).remove(paths)
        if (removeError) return console.warn(`${rpc} file removal failed: ${removeError.message}`)
      }
      const { error: deleteError } = await supabase.rpc(rpc, {
        p_bot_id: botId, p_server_id: serverId, p_ids: past.map((row) => row.id),
      })
      if (deleteError) console.warn(`${rpc} delete failed: ${deleteError.message}`)
    } catch (error) {
      console.warn(`${rpc} failed:`, error)
    }
  }

  private async listDiscordEmojis(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const listed = await selectAllById<any>((afterId) => {
        const query = supabase
          .from('emojis')
          .select('id, name, url, discord_emoji_id, deleted_at, bridge_removed_at')
          .eq('server_id', serverId)
          .or('deleted_at.is.null,discord_emoji_id.not.is.null')
        return (afterId ? query.gt('id', afterId) : query).order('id').limit(LIST_PAGE)
      })
      if (listed.error) return res.status(500).json({ error: listed.error.message })
      // A partial list would have the bridge plan against emoji it cannot see.
      if (listed.truncated) return res.status(500).json({ error: `more than ${LIST_MAX_ROWS} emoji rows`, code: 'LIST_TOO_LARGE' })
      const { data: limit, error: limitError } = await supabase.rpc('server_emoji_limit')
      if (limitError) return res.status(500).json({ error: limitError.message })
      if (limit == null) return res.status(500).json({ error: 'emoji limit unavailable' })
      // imported: the bridge may remove it. restorable: removed by the bridge, so it may restore it.
      const emojis = listed.rows.map((e: any) => {
        const imported = isBridgeImportedEmoji(serverId, e)
        return {
          id: e.id, name: e.name, url: e.url, discord_emoji_id: e.discord_emoji_id, removed: e.deleted_at != null,
          imported,
          restorable: imported && e.deleted_at != null && e.bridge_removed_at === e.deleted_at,
        }
      })
      res.json({ limit, emojis })
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async removeServerEmoji(req: BotRequest, res: Response) {
    try {
      const { serverId, emojiId } = req.params
      const botId = req.bot!.id
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!UUID_PATTERN.test(emojiId)) return res.status(400).json({ error: 'emojiId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const { data, error } = await supabase.rpc('bridge_remove_server_emoji', {
        p_bot_id: botId,
        p_server_id: serverId,
        p_emoji_id: emojiId,
      })
      if (error) return this.emojiError(res, error)
      if (data === 'removed') {
        await this.logBotAction(botId, 'emoji_removed', { emojiId, serverId }, { serverId })
        await this.evictBridgeRemoved('bridge_evict_removed_emojis', EMOJI_BUCKET, botId, serverId)
      }
      res.status(204).end()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async importDiscordEmoji(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const { discord_emoji_id: discordEmojiId, name, animated, update } = req.body ?? {}
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (typeof discordEmojiId !== 'string' || !DISCORD_EMOJI_ID.test(discordEmojiId)) {
        return res.status(400).json({ error: 'discord_emoji_id must be a Discord snowflake' })
      }
      if (typeof name !== 'string' || !EMOJI_NAME.test(name)) {
        return res.status(400).json({ error: 'name must be 1-32 of A-Z, a-z, 0-9, _' })
      }

      const { data: bridge, error: bridgeError } = await supabase
        .from('discord_bridges')
        .select('id')
        .eq('server_id', serverId)
        .eq('bot_id', botId)
        .maybeSingle()
      if (bridgeError) return res.status(500).json({ error: bridgeError.message })
      if (!bridge) return res.status(403).json({ error: 'Bot is not the Discord bridge of this server' })

      const call = (url: string | null) => supabase.rpc('bridge_import_server_emoji', {
        p_bot_id: botId,
        p_server_id: serverId,
        p_discord_emoji_id: discordEmojiId,
        p_name: name,
        p_url: url,
        p_update: update === true,
      })

      // Without an image URL the RPC answers existing or linked rows and refuses a new one.
      let { data, error } = await call(null)
      if (error && error.message === 'invalid emoji url') {
        const url = await storeDiscordEmojiImage(serverId, discordEmojiId, animated === true)
        ;({ data, error } = await call(url))
        if (error) {
          // Every import of this Discord emoji stores to the same path: a row may hold the image.
          const { data: holder, error: holderError } = await supabase
            .from('emojis')
            .select('id')
            .eq('server_id', serverId)
            .eq('discord_emoji_id', discordEmojiId)
            .maybeSingle()
          if (!holder && !holderError) {
            await supabase.storage.from(EMOJI_BUCKET)
              .remove([discordEmojiStoragePath(serverId, discordEmojiId, animated === true)])
              .catch((e: unknown) => console.error('Emoji image cleanup failed:', e))
          }
        }
      }
      if (error) return this.emojiError(res, error)
      const row = Array.isArray(data) ? data[0] : null
      if (!row) return res.status(500).json({ error: 'Import returned no row' })
      if (row.status === 'created') {
        await this.logBotAction(botId, 'emoji_imported', { emojiId: row.id, serverId, discordEmojiId }, { serverId })
      } else if (row.status === 'updated') {
        await this.logBotAction(botId, 'emoji_updated', { emojiId: row.id, serverId, discordEmojiId }, { serverId })
      }
      res.status(row.status === 'created' ? 201 : 200).json(row)
    } catch (error: any) {
      console.error('Import Discord emoji exception:', error)
      res.status(502).json({ error: error.message })
    }
  }

  private stickerError(res: Response, error: { code?: string; message: string }) {
    if (error.message?.startsWith('STICKER_LIMIT')) {
      return res.status(409).json({ error: error.message, code: 'STICKER_LIMIT' })
    }
    if (error.code === '23505' && !error.message?.startsWith('STICKER_FILE_TAKEN')) {
      return res.status(409).json({ error: error.message, code: 'STICKER_NAME_TAKEN' })
    }
    if (error.code === 'P0002') return res.status(404).json({ error: error.message })
    const refused = this.refusalCode(error, ['STICKER_NOT_LINKED'])
    if (refused) return res.status(403).json({ error: error.message, code: refused })
    const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500
    return res.status(status).json({ error: error.message })
  }

  private async listDiscordStickers(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const listed = await selectAllById<any>((afterId) => {
        const query = supabase
          .from('stickers')
          .select('id, name, description, url, discord_sticker_id, removed_at, created_at')
          .eq('scope', 'server')
          .eq('server_id', serverId)
          .or('removed_at.is.null,discord_sticker_id.not.is.null')
        return (afterId ? query.gt('id', afterId) : query).order('id').limit(LIST_PAGE)
      })
      if (listed.error) return res.status(500).json({ error: listed.error.message })
      if (listed.truncated) return res.status(500).json({ error: `more than ${LIST_MAX_ROWS} sticker rows`, code: 'LIST_TOO_LARGE' })
      const { data: limit, error: limitError } = await supabase.rpc('sticker_limit', { p_scope: 'server' })
      if (limitError) return res.status(500).json({ error: limitError.message })
      if (limit == null) return res.status(500).json({ error: 'sticker limit unavailable' })
      // Read by id keyset; answered oldest first.
      listed.rows.sort((a: any, b: any) =>
        a.created_at < b.created_at ? -1 : a.created_at > b.created_at ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
      const stickers = listed.rows.map((s: any) => ({
        id: s.id, name: s.name, description: s.description, url: s.url,
        discord_sticker_id: s.discord_sticker_id, removed: s.removed_at != null,
      }))
      res.json({ limit, stickers })
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async removeServerSticker(req: BotRequest, res: Response) {
    try {
      const { serverId, stickerId } = req.params
      const botId = req.bot!.id
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!UUID_PATTERN.test(stickerId)) return res.status(400).json({ error: 'stickerId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const { data, error } = await supabase.rpc('bridge_retire_server_sticker', {
        p_bot_id: botId,
        p_server_id: serverId,
        p_sticker_id: stickerId,
      })
      if (error) return this.stickerError(res, error)
      if (data === 'removed') {
        await this.logBotAction(botId, 'sticker_removed', { stickerId, serverId }, { serverId })
        await this.evictBridgeRemoved('bridge_evict_retired_stickers', STICKER_BUCKET, botId, serverId)
      }
      res.status(204).end()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  /** Body { discord_sticker_id, name, description, format_type, update? }; the file is copied only for a new sticker. */
  private async importDiscordSticker(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const { discord_sticker_id: discordStickerId, name, description, format_type: formatType, update } = req.body ?? {}
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (typeof discordStickerId !== 'string' || !DISCORD_STICKER_ID.test(discordStickerId)) {
        return res.status(400).json({ error: 'discord_sticker_id must be a Discord snowflake' })
      }
      if (typeof name !== 'string' || typeof description !== 'string') {
        return res.status(400).json({ error: 'name and description must be strings' })
      }
      if (!Number.isInteger(formatType)) return res.status(400).json({ error: 'format_type must be an integer' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return

      const call = (file: { path: string; url: string; width: number; height: number; durationMs: number | null } | null) =>
        supabase.rpc('bridge_import_server_sticker', {
          p_bot_id: botId,
          p_server_id: serverId,
          p_discord_sticker_id: discordStickerId,
          p_name: name,
          p_description: description,
          p_update: update === true,
          p_path: file?.path ?? null,
          p_url: file?.url ?? null,
          p_width: file?.width ?? null,
          p_height: file?.height ?? null,
          p_duration_ms: file?.durationMs ?? null,
        })

      // Without a file the RPC answers existing or linked rows and refuses a new one.
      let { data, error } = await call(null)
      if (error && error.message === 'invalid sticker file') {
        // A new sticker: the cap answers before the file is fetched. enforce_sticker_limit decides at the insert.
        const { data: cap } = await supabase.rpc('sticker_limit', { p_scope: 'server' })
        const { count: held } = await supabase
          .from('stickers')
          .select('id', { count: 'exact', head: true })
          .eq('scope', 'server')
          .eq('server_id', serverId)
          .is('removed_at', null)
        if (typeof cap === 'number' && typeof held === 'number' && held >= cap) {
          return res.status(409).json({ error: `STICKER_LIMIT: at most ${cap} server stickers`, code: 'STICKER_LIMIT' })
        }
        let stored
        try {
          stored = await storeDiscordSticker(serverId, discordStickerId, formatType)
        } catch (e: any) {
          if (e instanceof StickerFileError) {
            return res.status(422).json({ error: e.message, code: 'STICKER_FILE', reason: e.reason })
          }
          throw e
        }
        ;({ data, error } = await call(stored))
        // Each upload has its own random path: unless this call created the row, the file is unused.
        if (error || data?.[0]?.status !== 'created') await removeStoredSticker(stored.path)
      }
      if (error) return this.stickerError(res, error)
      const row = Array.isArray(data) ? data[0] : null
      if (!row) return res.status(500).json({ error: 'Import returned no row' })
      if (row.status === 'created') {
        await this.logBotAction(botId, 'sticker_imported', { stickerId: row.id, serverId, discordStickerId }, { serverId })
      } else if (row.status === 'updated') {
        await this.logBotAction(botId, 'sticker_updated', { stickerId: row.id, serverId, discordStickerId }, { serverId })
      }
      res.status(row.status === 'created' ? 201 : 200).json(row)
    } catch (error: any) {
      console.error('Import Discord sticker exception:', error)
      res.status(502).json({ error: error.message })
    }
  }

  // True when the bot bridges the server; otherwise the response is already sent.
  private async requireSoundBridge(req: BotRequest, res: Response, serverId: string): Promise<boolean> {
    const { data: bridge, error } = await supabase
      .from('discord_bridges')
      .select('id')
      .eq('server_id', serverId)
      .eq('bot_id', req.bot!.id)
      .maybeSingle()
    if (error) { res.status(500).json({ error: error.message }); return false }
    if (!bridge) { res.status(403).json({ error: 'Bot is not the Discord bridge of this server' }); return false }
    return true
  }

  private soundError(res: Response, error: { code?: string; message: string }) {
    if (error.message?.startsWith('SOUNDBOARD_FULL')) {
      return res.status(409).json({ error: error.message, code: 'SOUND_LIMIT' })
    }
    const refused = this.refusalCode(error, ['SOUND_NOT_LINKED'])
    if (refused) return res.status(403).json({ error: error.message, code: refused })
    const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500
    return res.status(status).json({ error: error.message })
  }

  private async listServerSounds(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const { data, error } = await supabase
        .from('server_sounds')
        .select('id, name, emoji, emoji_id, volume, discord_sound_id')
        .eq('server_id', serverId)
      if (error) return res.status(500).json({ error: error.message })
      res.json(data ?? [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async importDiscordSound(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const b = req.body ?? {}
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (typeof b.discord_sound_id !== 'string' || !DISCORD_SOUND_ID.test(b.discord_sound_id)) {
        return res.status(400).json({ error: 'discord_sound_id must be a Discord snowflake' })
      }
      // Lengths in code points, as char_length in bridge_import_server_sound counts them.
      const name = typeof b.name === 'string' ? b.name.trim() : ''
      const nameLength = [...name].length
      if (nameLength < 1 || nameLength > 32) return res.status(400).json({ error: 'name must be 1-32 characters' })
      let emoji: string | null = null
      if (b.emoji !== null && b.emoji !== undefined) {
        const trimmed = typeof b.emoji === 'string' ? b.emoji.trim() : ''
        const emojiLength = [...trimmed].length
        if (emojiLength < 1 || emojiLength > 16) return res.status(400).json({ error: 'emoji must be 1-16 characters or null' })
        emoji = trimmed
      }
      const emojiId = b.emoji_id ?? null
      if (emojiId !== null && (typeof emojiId !== 'string' || !UUID_PATTERN.test(emojiId))) {
        return res.status(400).json({ error: 'emoji_id must be a UUID or null' })
      }
      if (typeof b.volume !== 'number' || !Number.isFinite(b.volume) || b.volume < 0 || b.volume > 1) {
        return res.status(400).json({ error: 'volume must be a number from 0 to 1' })
      }
      if (b.update !== undefined && typeof b.update !== 'boolean') {
        return res.status(400).json({ error: 'update must be a boolean' })
      }
      const update = b.update === true

      if (!(await this.requireSoundBridge(req, res, serverId))) return

      const call = (storagePath: string | null, durationMs: number | null) => supabase.rpc('bridge_import_server_sound', {
        p_bot_id: botId,
        p_server_id: serverId,
        p_discord_sound_id: b.discord_sound_id,
        p_name: name,
        p_emoji: emoji,
        p_emoji_id: emojiId,
        p_volume: b.volume,
        p_update: update,
        p_storage_path: storagePath,
        p_duration_ms: durationMs,
      })

      // Without a stored clip the RPC answers existing or linked rows and refuses a new one.
      let storedPath: string | null = null
      let { data, error } = await call(null, null)
      if (error && error.message === 'invalid sound file') {
        // A new sound: the cap answers before the clip is fetched. enforce_server_sound_limit decides at the insert.
        const { count: held } = await supabase
          .from('server_sounds')
          .select('id', { count: 'exact', head: true })
          .eq('server_id', serverId)
        if (typeof held === 'number' && held >= MAX_SERVER_SOUNDS) {
          return res.status(409).json({
            error: `SOUNDBOARD_FULL: a server holds at most ${MAX_SERVER_SOUNDS} sounds`, code: 'SOUND_LIMIT',
          })
        }
        const stored = await storeDiscordSound(serverId, b.discord_sound_id)
        storedPath = stored.storagePath
        ;({ data, error } = await call(stored.storagePath, stored.durationMs))
        if (error) {
          await removeStoredSound(stored.storagePath)
          return this.soundError(res, error)
        }
      }
      if (error) return this.soundError(res, error)
      const row = Array.isArray(data) ? data[0] : null
      if (!row) return res.status(500).json({ error: 'Import returned no row' })
      // A concurrent import won the race; the clip we stored is an orphan.
      if (storedPath && row.status !== 'created') await removeStoredSound(storedPath)
      if (row.status === 'created') {
        await this.logBotAction(botId, 'sound_imported', { soundId: row.id, serverId, discordSoundId: b.discord_sound_id }, { serverId })
      } else if (row.status === 'updated') {
        await this.logBotAction(botId, 'sound_updated', { soundId: row.id, serverId, discordSoundId: b.discord_sound_id }, { serverId })
      }
      res.status(row.status === 'created' ? 201 : 200).json(row)
    } catch (error: any) {
      console.error('Import Discord sound exception:', error)
      res.status(502).json({ error: error.message })
    }
  }

  private async deleteServerSound(req: BotRequest, res: Response) {
    try {
      const { serverId, soundId } = req.params
      const botId = req.bot!.id
      if (!UUID_PATTERN.test(serverId)) return res.status(400).json({ error: 'serverId must be a UUID' })
      if (!UUID_PATTERN.test(soundId)) return res.status(400).json({ error: 'soundId must be a UUID' })
      if (!(await this.requireSoundBridge(req, res, serverId))) return
      const { data, error } = await supabase.rpc('bridge_delete_server_sound', {
        p_bot_id: botId,
        p_server_id: serverId,
        p_sound_id: soundId,
      })
      if (error) return this.soundError(res, error)
      if (!data) return res.status(404).json({ error: 'Sound not found in this server' })
      await removeStoredSound(data as string)
      await this.logBotAction(botId, 'sound_deleted', { soundId, serverId }, { serverId })
      res.status(204).end()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }

  private async createEmoji(req: BotRequest, res: Response) {
    try {
      const { name, url, server_id, domain } = req.body
      const botId = req.bot!.id
      
      if (!name || !url) {
        return res.status(400).json({ error: 'Missing required fields: name, url' })
      }
      
      // Bots may create federated emojis only; server_id must be null.
      if (server_id !== null && server_id !== undefined) {
        return res.status(403).json({ error: 'Bots can only create federated emojis (server_id must be null)' })
      }

      // Without a domain the row would be an instance emoji, offered to every local account.
      if (typeof domain !== 'string' || !domain.trim()) {
        return res.status(400).json({ error: 'domain is required: the instance the federated emoji comes from' })
      }
      
      // RPC is SECURITY DEFINER; it bypasses RLS.
      const { data: newEmoji, error: insertError } = await supabase
        .rpc('create_federated_emoji', {
          p_name: name,
          p_url: url,
          p_created_by: botId,
          p_domain: domain.trim()
        })
      
      if (insertError) {
        console.error('Emoji insert error:', insertError);
        return res.status(insertError.code === '22023' ? 400 : 500).json({ error: insertError.message })
      }
      
      // RPC returns an array.
      const emoji = Array.isArray(newEmoji) && newEmoji.length > 0 ? newEmoji[0] : null
      
      if (!emoji) {
        return res.status(500).json({ error: 'Failed to create emoji' })
      }
      
      await this.logBotAction(botId, 'emoji_created', { emojiId: emoji.id, name })
      
      res.status(201).json(emoji)
    } catch (error: any) {
      console.error('Create emoji exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  // AUDIT LOGGING
  
  /** The server of a channel for an audit row; null when the lookup finds none. */
  private async auditServerOf(channelId: string): Promise<string | null> {
    const cached = this.auditChannelServers.get(channelId)
    if (cached) return cached
    const serverId = await lookupChannelServerId(channelId)
    if (serverId) this.auditChannelServers.set(channelId, serverId)
    return serverId
  }

  /**
   * Never throws; an audit failure must not fail the request that triggered it. `where` fills
   * the server_id and channel_id columns; a channel alone is resolved to its server.
   */
  private async logBotAction(
    botId: string,
    action: string,
    metadata: any,
    where: { serverId?: string | null; channelId?: string | null } = {},
  ) {
    try {
      const channelId = where.channelId ?? null
      const serverId = where.serverId ?? (channelId ? await this.auditServerOf(channelId) : null)
      // supabase-js resolves with { error } rather than rejecting; a catch alone observes nothing.
      const { error } = await supabase
        .from('bot_audit_log')
        .insert({
          bot_id: botId,
          action_type: action,
          server_id: serverId,
          channel_id: channelId,
          success: true,
          metadata
        })

      if (error) {
        console.error(`Failed to log bot action '${action}':`, error.message, error.code ?? '')
      }
    } catch (error: any) {
      console.error(`Failed to log bot action '${action}':`, error?.message ?? error)
    }
  }
}

