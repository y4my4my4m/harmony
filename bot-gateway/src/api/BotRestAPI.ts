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
  grantableRoleBits,
  isAdminRole,
  loadEveryoneLayer,
  loadInstall,
  overrideGrants,
  parseMask,
  rolePositionCap,
  u64,
} from '../auth/botPermissions.js'
import { applyBridgeAttachmentPolicy } from '../utils/mirrorExternalMedia.js'
import { stripBotSuppliedPaths } from '../utils/messageMedia.js'
import { absoluteAvatarUrl } from '../utils/avatarUrl.js'
import { isDiscordCdnUrl } from '../utils/emojiUrl.js'
import { DISCORD_EMOJI_ID, EMOJI_NAME, storeDiscordEmojiImage } from '../utils/discordEmojiImport.js'
import { TTLCache } from '../utils/TTLCache.js'

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
// set_message_embeds_suppressed, webhook by execute_channel_webhook.
const SERVER_METADATA_KEYS = new Set([
  'type', 'federated', 'ap_id', 'from_domain', 'original_url', 'published', 'conversation',
  'in_reply_to_ap', 'pending_thread_ap_id', 'federated_at', 'federated_to', 'automod',
  'bot', 'created_via', 'embeds', 'suppress_embeds', 'webhook',
])

// The displayed author of a relayed message (src/utils/messageAuthor.ts in the client). Kept
// only from a bridge bot whose bridge relays the channel (bridgePairsChannel).
const BRIDGE_AUTHOR_KEYS = new Set(['discord_user', 'bridge_source'])

/** EmbedProvider in the client's src/types/chat.ts. */
const EMBED_PROVIDERS = new Set(['harmony-post', 'harmony-invite', 'fediverse-post', 'youtube', 'spotify', 'generic'])

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

/** True when bot metadata names the relayed author, which only a relaying bridge may. */
export function claimsBridgeAuthor(input: unknown): boolean {
  return !!input && typeof input === 'object' && !Array.isArray(input)
    && Object.keys(input).some((key) => BRIDGE_AUTHOR_KEYS.has(key))
}

/** An embed part as the client reads it (EmbedContent), or null. */
export function embedPart(part: Record<string, unknown>): Record<string, unknown> | null {
  const { url, provider, previewId, collapsed } = part
  if (typeof url !== 'string' || url.length > 2048 || !/^https?:\/\/\S+$/i.test(url)) return null
  if (typeof provider !== 'string' || !EMBED_PROVIDERS.has(provider)) return null
  if (typeof previewId !== 'string' || !previewId || previewId.length > 2048) return null
  return { type: 'embed', url, provider, previewId, ...(typeof collapsed === 'boolean' ? { collapsed } : {}) }
}

/**
 * Bot-supplied parts without system parts, which are server-generated join and leave
 * notices, and with embed parts reduced to their fields or dropped when malformed.
 */
export function botContentParts(parts: unknown[]): any[] {
  const out: any[] = []
  for (const part of parts) {
    if (part && typeof part === 'object' && !Array.isArray(part)) {
      const type = (part as { type?: unknown }).type
      if (type === 'system') continue
      if (type === 'embed') {
        const embed = embedPart(part as Record<string, unknown>)
        if (embed) out.push(embed)
        continue
      }
    }
    out.push(part)
  }
  return out
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  messageHardDeleted(message: { id: string; channel_id: string | null; metadata: unknown }): Promise<void>
}

/** A bridge pairing removed keeps answering true for at most this long. */
const BRIDGE_PAIR_TTL_MS = 60_000

export class BotRestAPI {
  public router: Router
  private readonly bridgePairs = new TTLCache<string, true>(5_000, BRIDGE_PAIR_TTL_MS)
  
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
    this.route('post', '/servers/:serverId/emojis/discord', this.importDiscordEmoji)

    // Content patch that leaves updated_at alone; no "(edited)" marker.
    this.route('patch', '/messages/:messageId/content-silent', this.silentUpdateMessageContent)

    // Merges bridge metadata (e.g. discord_message_id) without bumping updated_at.
    this.route('patch', '/messages/:messageId/metadata', this.mergeMessageMetadata)

    // USER ENDPOINTS

    // Express matches in registration order; /users/:userId would otherwise
    // capture "@me" and hand it to a uuid column.
    this.route('get', '/users/@me', this.getCurrentBot)

    this.route('get', '/users/:userId', this.getUser)

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

      const { data: updated, error } = await supabase.rpc('update_message_content_silent', {
        p_message_id: messageId,
        p_old_content: message.content,
        p_content: await this.resolveMentionParts(botContentParts(content), message.channel_id),
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

  // MESSAGE ENDPOINTS
  
  private async sendMessage(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { content, embeds, reply_to, metadata } = req.body
      const botId = req.bot!.id
      
      console.log(`Bot ${req.bot!.username} (${botId}) attempting to send message to channel ${channelId}`)
      console.log(`Received metadata:`, JSON.stringify(metadata, null, 2))
      
      const access = await this.channelWriteAccess(botId, channelId, 'send_messages')
      if (!access.ok) {
        console.log(`Permission denied for bot ${botId} in channel ${channelId}: ${access.error}`)
        return res.status(403).json({ error: access.error })
      }
      
      // Instance attachment policy (e.g. mirroring Discord CDN URLs into
      // user_media) is applied here, keeping bots policy-agnostic.
      const messageContent = await applyBridgeAttachmentPolicy(
        await this.resolveMentionParts(this.formatContent(content, embeds), channelId),
        botId,
        channelId,
      )
      if (!Array.isArray(messageContent) || messageContent.length === 0) {
        return res.status(400).json({ error: 'Cannot send an empty message' })
      }

      const bridgeAuthor = claimsBridgeAuthor(metadata) && await this.bridgePairsChannel(botId, channelId)
      const messageMetadata = {
        ...botSuppliedMetadata(metadata, { bridgeAuthor }),
        bot: true,
        created_via: 'bot_api',
      }
      
      // Array response, not .single(): the server's AutoMod drops a blocked row and
      // the insert returns zero rows. PostgREST rolls a zero-row singular request
      // back, which would discard the AutoMod event.
      const { data: rows, error } = await supabase
        .from('messages')
        .insert({
          channel_id: channelId,
          bot_id: botId,  // Use bot_id instead of user_id
          content: messageContent,
          reply_to: reply_to || null,
          metadata: messageMetadata
        })
        .select(`
          *,
          bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
      
      if (error) {
        console.error('Error sending message:', error)
        const blocked = moderationErrorResponse(error)
        if (blocked) return res.status(blocked.status).json(blocked.body)
        return res.status(500).json({ error: error.message })
      }

      const message = rows?.[0]
      if (!message) {
        return res.status(403).json(AUTOMOD_BLOCKED_BODY)
      }
      
      await this.logBotAction(botId, 'message_sent', { channel_id: channelId, message_id: message.id })

      this.triggerLinkPreviewEnrichment(message.id)

      res.status(201).json(this.formatMessage(message))
    } catch (error: any) {
      console.error('Send message error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
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

      const { data: message, error } = await supabase
        .from('messages')
        .select(`
          *,
          user:profiles!messages_user_id_fkey(id, username, display_name, avatar_url),
          bot:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
        .eq('channel_id', channelId)
        .eq('metadata->>discord_message_id', discordMessageId)
        .eq('is_deleted', false)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()

      if (error) {
        return res.status(500).json({ error: error.message })
      }
      if (!message) {
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
      const { limit = 50, before, after } = req.query
      const botId = req.bot!.id
      
      const canRead = await this.canReadChannel(botId, channelId)
      if (!canRead) {
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
        .limit(Number(limit))
      
      if (before) {
        query = query.lt('created_at', before as string)
      }
      if (after) {
        query = query.gt('created_at', after as string)
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
      
      res.json(this.formatMessage(message))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async editMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const { content } = req.body
      const botId = req.bot!.id
      
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, bot_id, channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message || message.bot_id !== botId) {
        return res.status(403).json({ error: 'Cannot edit messages from other bots or users' })
      }

      // BUGS.md H38: editing one's own message requires only `send_messages`.
      // Bridge bots hold `send_messages` alone, so gating on `manage_messages`
      // breaks Discord edit-sync. The ownership check above guarantees the bot
      // is the author. `deleteMessage` mirrors this: `manage_messages` is
      // required only for other bots' messages.
      const access = await this.channelWriteAccess(botId, message.channel_id, 'send_messages')
      if (!access.ok) {
        return res.status(403).json({ error: access.error })
      }
      
      const messageContent = await applyBridgeAttachmentPolicy(
        await this.resolveMentionParts(this.formatContent(content), message.channel_id),
        botId,
        message.channel_id,
      )
      if (!Array.isArray(messageContent) || messageContent.length === 0) {
        return res.status(400).json({ error: 'Cannot send an empty message' })
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
      
      if (error) {
        const blocked = moderationErrorResponse(error)
        if (blocked) return res.status(blocked.status).json(blocked.body)
        return res.status(500).json({ error: error.message })
      }

      // The row exists and belongs to this bot (checked above), so zero rows is
      // AutoMod dropping the edit.
      const updated = updatedRows?.[0]
      if (!updated) {
        return res.status(403).json(AUTOMOD_BLOCKED_BODY)
      }
      
      await this.logBotAction(botId, 'message_edited', { message_id: messageId })
      
      res.json(this.formatMessage(updated))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  private async deleteMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const botId = req.bot!.id
      
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, bot_id, channel_id, metadata, is_deleted')
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
      
      await this.logBotAction(botId, 'message_deleted', { message_id: messageId })

      // A soft-deleted row was dispatched when is_deleted was set.
      if (this.deletes && message.is_deleted !== true) {
        this.deletes
          .messageHardDeleted({ id: messageId, channel_id: message.channel_id, metadata: message.metadata ?? null })
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
      const { limit = 100, after } = req.query
      const botId = req.bot!.id
      
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
        .limit(Number(limit))
      
      if (after) {
        query = query.gt('joined_at', after as string)
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
      
      res.json(channels?.map(c => this.formatChannel(c)) || [])
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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
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

      await this.logBotAction(botId, 'category_created', { server_id: serverId, category_id: data.id })
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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
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

      if (error) return res.status(500).json({ error: error.message })

      await this.logBotAction(botId, 'channel_created', { server_id: serverId, channel_id: data.id })
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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
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

      const allowed = await this.checkServerPermission(
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
      res.json(data || [])
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

      await this.logBotAction(botId, 'role_created', { server_id: serverId, role_id: data.id })
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

      await this.logBotAction(botId, 'role_updated', { server_id: serverId, role_id: roleId })
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

      await this.logBotAction(botId, 'role_deleted', { server_id: serverId, role_id: roleId })
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
      
      res.json(this.formatBot(bot))
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // PERMISSION HELPERS
  
  /**
   * The bot is a bridge bot (bot_type 'bridge') and its bridge relays the channel: a
   * discord_bridge_channels pair of the v2 bridge whose bot it is, or, for a bot that is no v2
   * bridge's bot, a v1 discord_bridge_pairings row of the channel's server. False on any
   * failed lookup. A true answer is cached for BRIDGE_PAIR_TTL_MS.
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
      .select('bot_type')
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

    const serverId = await this.channelServerId(channelId)
    if (!serverId) return false
    const { data: pairing, error: pairingError } = await supabase
      .from('discord_bridge_pairings')
      .select('server_id')
      .eq('server_id', serverId)
      .maybeSingle()
    return !pairingError && !!pairing
  }

  private async channelServerId(channelId: string): Promise<string | null> {
    const { data: channel } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .maybeSingle()
    return channel?.server_id ?? null
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
    const serverId = await this.channelServerId(channelId)
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
   * read_messages and botCanSeeChannel: allowed_channel_ids, which also grants a channel
   * @everyone cannot view, else VIEW_CHANNEL as a holder of @everyone. False on any failed lookup.
   */
  private async canReadChannel(botId: string, channelId: string, serverId?: string): Promise<boolean> {
    const channelServerId = serverId ?? (await this.channelServerId(channelId))
    if (!channelServerId) return false

    const install = await loadInstall(botId, channelServerId)
    if (!install || install.read_messages !== true) return false

    const layer = await loadEveryoneLayer(channelServerId, channelId)
    if (!layer) return false

    return botCanReadChannel(install, layer, channelId)
  }

  /**
   * Server-scoped permission check for server-wide actions such as
   * channel/category creation.
   */
  private async checkServerPermission(botId: string, serverId: string, permission: string): Promise<boolean> {
    const { data, error } = await supabase.rpc('check_bot_permission', {
      p_bot_id: botId,
      p_server_id: serverId,
      p_permission: permission,
    })
    if (error) {
      console.error(`[checkServerPermission] RPC error: ${error.message}`)
      return false
    }
    return data === true
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
  
  /**
   * role_mention and channel_mention parts against the channel's server: a role or channel of
   * that server keeps its part, carrying the stored name (and the role's color); any other part
   * of those types becomes the text `@name` or `#name`. Notifications of a kept role mention
   * follow handle_role_mention_notifications (MENTION_EVERYONE, mentionable roles).
   */
  private async resolveMentionParts(parts: any[], channelId: string | null | undefined): Promise<any[]> {
    if (!Array.isArray(parts)) return parts
    const isRole = (p: any) => p?.type === 'role_mention'
    const isChannel = (p: any) => p?.type === 'channel_mention'
    if (!parts.some((p) => isRole(p) || isChannel(p))) return parts

    const serverId = channelId ? await this.channelServerId(channelId) : null
    const uuids = (values: unknown[]) =>
      [...new Set(values.filter((v): v is string => typeof v === 'string' && UUID_PATTERN.test(v)))]
    const roleIds = uuids(parts.filter(isRole).map((p) => p.roleId))
    const channelIds = uuids(parts.filter(isChannel).map((p) => p.channelId))

    const roles = new Map<string, { name: string; color: string | null }>()
    if (serverId && roleIds.length > 0) {
      const { data } = await supabase
        .from('server_roles')
        .select('id, name, color')
        .eq('server_id', serverId)
        .in('id', roleIds)
      for (const r of (data ?? []) as Array<{ id: string; name: string; color: string | null }>) {
        roles.set(r.id, { name: r.name, color: r.color ?? null })
      }
    }
    const channels = new Map<string, string>()
    if (serverId && channelIds.length > 0) {
      const { data } = await supabase
        .from('channels')
        .select('id, name')
        .eq('server_id', serverId)
        .in('id', channelIds)
      for (const c of (data ?? []) as Array<{ id: string; name: string }>) channels.set(c.id, c.name)
    }

    const label = (value: unknown, fallback: string) =>
      typeof value === 'string' && value.trim() !== '' ? value : fallback
    return parts.map((part) => {
      if (isRole(part)) {
        const role = roles.get(part.roleId)
        if (!role) return { type: 'text', text: `@${label(part.roleName, 'role')}` }
        return { type: 'role_mention', roleId: part.roleId, roleName: role.name, roleColor: role.color }
      }
      if (isChannel(part)) {
        const name = channels.get(part.channelId)
        if (name === undefined) return { type: 'text', text: `#${label(part.name, 'channel')}` }
        const out: Record<string, unknown> = { type: 'channel_mention', channelId: part.channelId, serverId, name }
        if (typeof part.messageId === 'string' && UUID_PATTERN.test(part.messageId)) out.messageId = part.messageId
        return out
      }
      return part
    })
  }

  private formatContent(content: string | any[], embeds?: any[]): any[] {
    const parts: any[] = []
    
    if (Array.isArray(content)) {
      parts.push(...botContentParts(stripBotSuppliedPaths(content)))
    } else if (content) {
      parts.push({ type: 'text', text: content })
    }
    
    if (Array.isArray(embeds) && embeds.length > 0) {
      parts.push(...botContentParts(embeds.map(e => ({ ...e, type: 'embed' }))))
    }
    
    return parts
  }
  
  private formatMessage(message: any) {
    const author = message.bot || message.user
    
    return {
      id: message.id,
      channel_id: message.channel_id,
      author: author ? {
        id: author.id,
        username: author.username,
        display_name: author.display_name,
        avatar: this.formatAvatarUrl(author.avatar_url),
        bot: !!message.bot  // Flag to indicate if this is a bot message
      } : null,
      content: this.contentToText(message.content),
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
      icon: guild.icon_url,
      owner_id: guild.owner,
      description: guild.description,
      member_count: guild.member_count || 0
    }
  }
  
  private formatChannel(channel: any) {
    return {
      id: channel.id,
      type: channel.type === 'text' ? 0 : channel.type === 'voice' ? 2 : 0,
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
      joined_at: member.joined_at
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
      let serverIconUrl: string | null = null
      const icon = invite.server_icon as string | null | undefined
      if (icon) {
        if (icon.startsWith('http://') || icon.startsWith('https://')) {
          serverIconUrl = icon
        } else if (icon.startsWith('/')) {
          serverIconUrl = publicUrl ? `${publicUrl}${icon}` : icon
        } else if (publicUrl) {
          serverIconUrl =
            `${publicUrl}/storage/v1/render/image/public/server_icons/${icon}?width=128&height=128&resize=contain&quality=80`
        }
      }

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
  // is visible to a bot.
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
      
      let query = supabase.from('emojis').select('*')
      
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
    if (error) return res.status(500).json({ error: error.message })
    res.json(data ?? [])
  }

  private async importDiscordEmoji(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId
      const botId = req.bot!.id
      const { discord_emoji_id: discordEmojiId, name, animated } = req.body ?? {}
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
      })

      // Without an image URL the RPC answers existing or linked rows and refuses a new one.
      let { data, error } = await call(null)
      if (error && error.message === 'invalid emoji url') {
        const url = await storeDiscordEmojiImage(serverId, discordEmojiId, animated === true)
        ;({ data, error } = await call(url))
      }
      if (error) {
        const status = error.code === '42501' ? 403 : error.code === '22023' ? 400 : 500
        return res.status(status).json({ error: error.message })
      }
      const row = Array.isArray(data) ? data[0] : null
      if (!row) return res.status(500).json({ error: 'Import returned no row' })
      if (row.status === 'created') {
        await this.logBotAction(botId, 'emoji_imported', { emojiId: row.id, serverId, discordEmojiId })
      }
      res.status(row.status === 'created' ? 201 : 200).json(row)
    } catch (error: any) {
      console.error('Import Discord emoji exception:', error)
      res.status(502).json({ error: error.message })
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
      
      // RPC is SECURITY DEFINER; it bypasses RLS.
      const { data: newEmoji, error: insertError } = await supabase
        .rpc('create_federated_emoji', {
          p_name: name,
          p_url: url,
          p_created_by: botId,
          p_domain: domain || null
        })
      
      if (insertError) {
        console.error('Emoji insert error:', insertError);
        return res.status(500).json({ error: insertError.message })
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
  
  // Never throws; an audit failure must not fail the request that triggered it.
  private async logBotAction(botId: string, action: string, metadata: any) {
    try {
      // supabase-js resolves with { error } rather than rejecting; a catch alone observes nothing.
      const { error } = await supabase
        .from('bot_audit_log')
        .insert({
          bot_id: botId,
          action_type: action,
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

