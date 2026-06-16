import { Router, Request, Response } from 'express'
import { supabase } from '../config/supabase.js'
import { botAuthMiddleware } from '../auth/BotAuthMiddleware.js'
import { applyBridgeAttachmentPolicy } from '../utils/mirrorExternalMedia.js'

export interface BotRequest extends Request {
  bot?: {
    id: string
    username: string
    scopes: string[]
  }
}

export class BotRestAPI {
  public router: Router
  
  constructor() {
    this.router = Router()
    this.setupMiddleware()
    this.setupRoutes()
  }
  
  private setupMiddleware() {
    // Apply bot authentication to all routes
    this.router.use(botAuthMiddleware)
  }
  
  private setupRoutes() {
    // =====================================================
    // CHANNEL ENDPOINTS
    // =====================================================
    
    // Send message to channel
    this.router.post('/channels/:channelId/messages', this.sendMessage.bind(this))
    
    // Get channel messages
    this.router.get('/channels/:channelId/messages', this.getMessages.bind(this))
    
    // Get single message
    this.router.get('/messages/:messageId', this.getMessage.bind(this))
    
    // Edit message
    this.router.patch('/messages/:messageId', this.editMessage.bind(this))
    
    // Delete message
    this.router.delete('/messages/:messageId', this.deleteMessage.bind(this))
    
    // Add reaction
    this.router.put('/messages/:messageId/reactions/:emoji', this.addReaction.bind(this))
    
    // Remove reaction
    this.router.delete('/messages/:messageId/reactions/:emoji', this.removeReaction.bind(this))
    
    // Trigger typing indicator
    this.router.post('/channels/:channelId/typing', this.triggerTyping.bind(this))
    
    // =====================================================
    // SERVER ENDPOINTS (Harmony terminology)
    // =====================================================
    
    // Get server info
    this.router.get('/servers/:serverId', this.getGuild.bind(this))
    
    // Get server members
    this.router.get('/servers/:serverId/members', this.getGuildMembers.bind(this))
    
    // Get server channels
    this.router.get('/servers/:serverId/channels', this.getGuildChannels.bind(this))

    // Create channel / category (bot must have manage_channels)
    this.router.post('/servers/:serverId/channels', this.createChannel.bind(this))
    this.router.post('/servers/:serverId/categories', this.createCategory.bind(this))

    // List categories (for clone/diff)
    this.router.get('/servers/:serverId/categories', this.getCategories.bind(this))

    // Roles: list + create (bot must have manage_channels - role creation is
    // part of the same admin clone flow as channel creation; there is no
    // separate manage_roles bot permission).
    this.router.get('/servers/:serverId/roles', this.getRoles.bind(this))
    this.router.post('/servers/:serverId/roles', this.createRole.bind(this))
    this.router.patch('/servers/:serverId/roles/:roleId', this.updateRole.bind(this))
    this.router.delete('/servers/:serverId/roles/:roleId', this.deleteRole.bind(this))

    // Channel permission overrides (for Discord bridge permission sync)
    this.router.get('/channels/:channelId/permission-overrides', this.getChannelPermissionOverrides.bind(this))
    this.router.put('/channels/:channelId/permission-overrides', this.upsertChannelPermissionOverride.bind(this))
    this.router.delete('/channels/:channelId/permission-overrides/role/:roleId', this.deleteChannelPermissionOverrideForRole.bind(this))

    // Legacy aliases (Discord terminology - deprecated)
    this.router.get('/guilds/:guildId', this.getGuild.bind(this))
    this.router.get('/guilds/:guildId/members', this.getGuildMembers.bind(this))
    this.router.get('/guilds/:guildId/channels', this.getGuildChannels.bind(this))
    
    // =====================================================
    // EMOJI ENDPOINTS
    // =====================================================
    
    // Get emojis (query by URL if provided)
    this.router.get('/emojis', this.getEmojis.bind(this))
    
    // Create emoji (for Discord/federated emojis)
    this.router.post('/emojis', this.createEmoji.bind(this))

    // Silent content patch (e.g. refresh attachment URLs without "(edited)")
    this.router.patch('/messages/:messageId/content-silent', this.silentUpdateMessageContent.bind(this))
    
    // =====================================================
    // USER ENDPOINTS
    // =====================================================
    
    // Get user info
    this.router.get('/users/:userId', this.getUser.bind(this))
    
    // Get current bot user
    this.router.get('/users/@me', this.getCurrentBot.bind(this))
  }
  
  // =====================================================
  // MEDIA
  // =====================================================

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

      const canSend = await this.checkChannelPermission(botId, message.channel_id, 'send_messages')
      if (!canSend) {
        return res.status(403).json({ error: 'Missing permission: send_messages' })
      }

      const { data: updated, error } = await supabase.rpc('update_message_content_silent', {
        p_message_id: messageId,
        p_old_content: message.content,
        p_content: content,
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

  // =====================================================
  // MESSAGE ENDPOINTS
  // =====================================================
  
  private async sendMessage(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { content, embeds, reply_to, metadata } = req.body
      const botId = req.bot!.id
      
      console.log(`🔍 Bot ${req.bot!.username} (${botId}) attempting to send message to channel ${channelId}`)
      console.log(`🔍 Received metadata:`, JSON.stringify(metadata, null, 2))
      
      // Check permissions
      const canSend = await this.checkChannelPermission(botId, channelId, 'send_messages')
      console.log(`🔍 Permission check result: ${canSend}`)
      
      if (!canSend) {
        console.log(`❌ Permission denied for bot ${botId} in channel ${channelId}`)
        return res.status(403).json({ error: 'Missing permission: send_messages' })
      }
      
      // Format content, then apply the instance attachment policy (e.g. mirror
      // Discord CDN URLs into user_media). Resolved here so bots stay policy-agnostic.
      const messageContent = await applyBridgeAttachmentPolicy(
        this.formatContent(content, embeds),
        botId,
      )
      
      // Merge metadata with bot flag and any custom metadata from bridge
      const messageMetadata = {
        bot: true,
        created_via: 'bot_api',
        ...metadata
      }
      
      // Insert message
      const { data: message, error } = await supabase
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
          author:bots!messages_bot_id_fkey(id, username, display_name, avatar_url)
        `)
        .single()
      
      if (error) {
        console.error('Error sending message:', error)
        return res.status(500).json({ error: error.message })
      }
      
      // Log action
      await this.logBotAction(botId, 'message_sent', { channel_id: channelId, message_id: message.id })
      
      res.status(201).json(this.formatMessage(message))
    } catch (error: any) {
      console.error('Send message error:', error)
      res.status(500).json({ error: error.message || 'Internal server error' })
    }
  }
  
  private async getMessages(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { limit = 50, before, after } = req.query
      const botId = req.bot!.id
      
      // Check permissions
      const canRead = await this.checkChannelPermission(botId, channelId, 'read_messages')
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
      
      // Get message with author info
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
      
      // Check if bot has permission to read messages in this channel
      const { data: channel } = await supabase
        .from('channels')
        .select('server_id')
        .eq('id', message.channel_id)
        .single()
      
      if (!channel) {
        return res.status(404).json({ error: 'Channel not found' })
      }
      
      const canRead = await this.checkChannelPermission(botId, message.channel_id, 'read_messages')
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
      
      // Check if bot owns the message
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, bot_id, channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message || message.bot_id !== botId) {
        return res.status(403).json({ error: 'Cannot edit messages from other bots or users' })
      }

      // BUGS.md H38: editing your OWN message should only require `send_messages`
      // (the permission to post in that channel) - requiring `manage_messages`
      // here broke Discord bridge edit-sync because bridge bots typically only
      // hold `send_messages`. The ownership check above already guarantees the
      // bot is the author. `deleteMessage` already follows this pattern (line
      // 307: own-message delete is allowed; `manage_messages` only required for
      // OTHER bots' messages).
      const canSend = await this.checkChannelPermission(botId, message.channel_id, 'send_messages')
      if (!canSend) {
        return res.status(403).json({ error: 'Missing permission: send_messages' })
      }
      
      const messageContent = await applyBridgeAttachmentPolicy(
        this.formatContent(content),
        botId,
      )
      
      const { data: updated, error } = await supabase
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
        .single()
      
      if (error) {
        return res.status(500).json({ error: error.message })
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
      
      // Check if bot owns the message
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, bot_id, channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      if (message.bot_id !== botId) {
        // Check if bot has manage_messages permission
        const canManage = await this.checkChannelPermission(botId, message.channel_id, 'manage_messages')
        if (!canManage) {
          return res.status(403).json({ error: 'Missing permission: manage_messages' })
        }
      }
      
      const { error } = await supabase
        .from('messages')
        .delete()
        .eq('id', messageId)
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      await this.logBotAction(botId, 'message_deleted', { message_id: messageId })
      
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
      
      // Get message to check permissions
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      const canReact = await this.checkChannelPermission(botId, message.channel_id, 'add_reactions')
      if (!canReact) {
        return res.status(403).json({ error: 'Missing permission: add_reactions' })
      }
      
      // Check if emoji is a UUID (custom emoji) or Unicode (native emoji)
      const isUUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(emoji)
      
      const insertData: any = {
        message_id: messageId,
        bot_id: botId,
        metadata: metadata || null
      }
      
      if (isUUID) {
        // Custom emoji - use emoji_id
        insertData.emoji_id = emoji
      } else {
        // Unicode/native emoji - use custom_emoji_content
        insertData.custom_emoji_content = emoji
        insertData.emoji_id = null
      }
      
      console.log(`🎭 Adding reaction: ${isUUID ? 'custom' : 'native'} emoji "${emoji}" to message ${messageId}`)
      
      const { error } = await supabase
        .from('reactions')
        .insert(insertData)
      
      if (error) {
        console.error('❌ Reaction insert error:', error);
        return res.status(500).json({ error: error.message })
      }
      
      res.status(204).send()
    } catch (error: any) {
      console.error('❌ Add reaction exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  private async removeReaction(req: BotRequest, res: Response) {
    try {
      const { messageId, emoji } = req.params
      const botId = req.bot!.id
      
      // Get message to check permissions
      const { data: message } = await supabase
        .from('messages')
        .select('channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      const canReact = await this.checkChannelPermission(botId, message.channel_id, 'add_reactions')
      if (!canReact) {
        return res.status(403).json({ error: 'Missing permission: add_reactions' })
      }
      
      // Check if emoji is a UUID (custom emoji) or Unicode (native emoji)
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
      
      console.log(`🎭 Removing reaction: ${isUUID ? 'custom' : 'native'} emoji "${emoji}" from message ${messageId}`)
      
      const { error } = await query
      
      if (error) {
        console.error('❌ Reaction delete error:', error);
        return res.status(500).json({ error: error.message })
      }
      
      res.status(204).send()
    } catch (error: any) {
      console.error('❌ Remove reaction exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  private async triggerTyping(req: BotRequest, res: Response) {
    try {
      // This is a no-op in the database but returns success for API compatibility
      res.status(204).send()
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // =====================================================
  // GUILD ENDPOINTS
  // =====================================================
  
  private async getGuild(req: BotRequest, res: Response) {
    try {
      const serverId = req.params.serverId || req.params.guildId
      const botId = req.bot!.id
      
      // Check if bot is in the server
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
      // Support both /servers/:serverId and /guilds/:guildId
      const serverId = req.params.serverId || req.params.guildId
      const { limit = 100, after } = req.query
      const botId = req.bot!.id
      
      // Check if bot is in the server
      const hasAccess = await this.checkBotInGuild(botId, serverId)
      if (!hasAccess) {
        return res.status(403).json({ error: 'Bot not in guild' })
      }
      
      let query = supabase
        .from('user_servers')
        .select(`
          *,
          user:profiles!user_servers_user_id_fkey(id, username, display_name, avatar_url, status)
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
        .order('position')
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.json(channels?.map(c => this.formatChannel(c)) || [])
    } catch (error: any) {
      res.status(500).json({ error: error.message })
    }
  }
  
  // =====================================================
  // USER ENDPOINTS
  // =====================================================
  
  // =====================================================
  // CHANNEL / CATEGORY CREATION (used by bridges to mirror server structure)
  // =====================================================
  //
  // These two endpoints intentionally trust the `manage_channels` permission
  // already enforced via bot_server_permissions; we do NOT re-implement a
  // separate "is the invoker server owner" check here because that gate
  // belongs to the *calling tool* (e.g. the /bridge clone-server slash
  // command), not the API. If the bot has `manage_channels` for this server
  // (granted by the server owner during install), it can create channels.

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
      // Harmony channel types: 0=text, 1=voice, 2=category
      // We don't accept category here (use /categories endpoint).
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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      // Permissions arrive as a bigint bitmask in string form (JS can't safely
      // carry 53+ bit ints). Store as-is; never let a bot mint ADMINISTRATOR
      // (bit 0) - that must be granted by a human in the Harmony UI.
      let permMask = 0n
      try {
        permMask = BigInt(permissions ?? 0)
      } catch {
        permMask = 0n
      }
      permMask &= ~(1n << 0n) // strip ADMINISTRATOR

      const { data, error } = await supabase
        .from('server_roles')
        .insert({
          server_id: serverId,
          name: name.trim().slice(0, 100),
          color: color || null,
          position: typeof position === 'number' ? position : 0,
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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const { data: existing, error: fetchErr } = await supabase
        .from('server_roles')
        .select('id, is_default, is_admin')
        .eq('id', roleId)
        .eq('server_id', serverId)
        .single()

      if (fetchErr || !existing) {
        return res.status(404).json({ error: 'Role not found' })
      }
      if (existing.is_default || existing.is_admin) {
        return res.status(403).json({ error: 'Cannot modify default or admin roles via bot API' })
      }

      const patch: Record<string, unknown> = { updated_at: new Date().toISOString() }
      if (typeof name === 'string' && name.trim()) patch.name = name.trim().slice(0, 100)
      if (color !== undefined) patch.color = color || null
      if (typeof position === 'number') patch.position = position
      if (mentionable !== undefined) patch.mentionable = mentionable
      if (hoist !== undefined) patch.hoist = hoist
      if (permissions !== undefined) {
        let permMask = 0n
        try {
          permMask = BigInt(permissions ?? 0)
        } catch {
          permMask = 0n
        }
        permMask &= ~(1n << 0n)
        patch.permissions = permMask.toString()
      }

      const { data, error } = await supabase
        .from('server_roles')
        .update(patch)
        .eq('id', roleId)
        .select('id, name, color, position, permissions, mentionable, hoist')
        .single()

      if (error) return res.status(500).json({ error: error.message })

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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
      }

      const { data: existing, error: fetchErr } = await supabase
        .from('server_roles')
        .select('id, is_default, is_admin')
        .eq('id', roleId)
        .eq('server_id', serverId)
        .single()

      if (fetchErr || !existing) {
        return res.status(404).json({ error: 'Role not found' })
      }
      if (existing.is_default || existing.is_admin) {
        return res.status(403).json({ error: 'Cannot delete default or admin roles via bot API' })
      }

      const { error } = await supabase
        .from('server_roles')
        .delete()
        .eq('id', roleId)

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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
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

      let allowMask = 0n
      let denyMask = 0n
      try {
        allowMask = BigInt(allow_permissions ?? 0)
        denyMask = BigInt(deny_permissions ?? 0)
      } catch {
        return res.status(400).json({ error: 'Invalid permission bitmask' })
      }
      allowMask &= ~(1n << 0n)
      denyMask &= ~(1n << 0n)

      const baseQuery = supabase
        .from('channel_permission_overrides')
        .select('id')
        .eq('channel_id', channelId)

      const { data: existing, error: lookupErr } =
        target_type === 'role'
          ? await baseQuery.eq('role_id', role_id!).is('user_id', null).maybeSingle()
          : await baseQuery.eq('user_id', user_id!).is('role_id', null).maybeSingle()

      if (lookupErr) return res.status(500).json({ error: lookupErr.message })

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

      const allowed = await this.checkServerPermission(botId, serverId, 'manage_channels')
      if (!allowed) {
        return res.status(403).json({ error: 'Missing permission: manage_channels' })
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
  
  // =====================================================
  // PERMISSION HELPERS
  // =====================================================
  
  private async checkChannelPermission(botId: string, channelId: string, permission: string): Promise<boolean> {
    // Get server ID from channel
    const { data: channel, error: channelError } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()
    
    console.log(`🔍 Channel lookup: channelId=${channelId}, serverId=${channel?.server_id}, error=${channelError?.message}`)
    
    if (!channel) return false
    
    // Check bot permission
    const { data, error } = await supabase.rpc('check_bot_permission', {
      p_bot_id: botId,
      p_server_id: channel.server_id,
      p_permission: permission
    })
    
    console.log(`🔍 Permission RPC result: permission=${permission}, result=${data}, error=${error?.message}`)
    
    return data === true
  }
  
  /**
   * Server-scoped permission check (no channelId required).
   * Used for actions like channel/category creation that are server-wide,
   * not channel-specific.
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
  
  // =====================================================
  // FORMATTERS
  // =====================================================
  
  /**
   * Convert a relative avatar path to a full URL
   * Handles both Supabase storage paths and external URLs
   * Uses PUBLIC_URL for external-facing URLs (for Discord, ActivityPub, etc.)
   */
  private formatAvatarUrl(avatarPath: string | null | undefined): string | undefined {
    if (!avatarPath) return undefined
    
    // If already a full URL, return as-is
    if (avatarPath.startsWith('http://') || avatarPath.startsWith('https://')) {
      return avatarPath
    }
    
    // Use PUBLIC_URL for external-facing resources, fallback to SUPABASE_URL
    const publicUrl = process.env.PUBLIC_URL || process.env.SUPABASE_URL
    if (!publicUrl) {
      console.warn('PUBLIC_URL or SUPABASE_URL not set, cannot construct avatar URL')
      return undefined
    }
    
    // Remove leading slash if present
    const cleanPath = avatarPath.startsWith('/') ? avatarPath.slice(1) : avatarPath
    
    // Construct full URL with image optimization params
    return `${publicUrl}/storage/v1/render/image/public/avatars/${cleanPath}?width=256&height=256&resize=contain&quality=80`
  }
  
  private formatContent(content: string | any[], embeds?: any[]): any[] {
    const parts: any[] = []
    
    // If content is already an array of MessageParts, use it directly
    if (Array.isArray(content)) {
      parts.push(...content)
    } else if (content) {
      // If content is a string, wrap it in a text part
      parts.push({ type: 'text', text: content })
    }
    
    if (embeds && embeds.length > 0) {
      parts.push(...embeds.map(e => ({ type: 'embed', ...e })))
    }
    
    return parts
  }
  
  private formatMessage(message: any) {
    // Use bot if present, otherwise use user
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
      position: channel.position,
      parent_id: channel.parent_id
    }
  }
  
  private formatMember(member: any) {
    return {
      user: member.user ? {
        id: member.user.id,
        username: member.user.username,
        display_name: member.user.display_name,
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
  
  // =====================================================
  // EMOJI METHODS
  // =====================================================
  
  private async getEmojis(req: BotRequest, res: Response) {
    try {
      const { url } = req.query
      
      let query = supabase.from('emojis').select('*')
      
      // If URL is provided, filter by it (for checking if Discord emoji exists)
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
  
  private async createEmoji(req: BotRequest, res: Response) {
    try {
      const { name, url, server_id, domain } = req.body
      const botId = req.bot!.id
      
      // Validate required fields
      if (!name || !url) {
        return res.status(400).json({ error: 'Missing required fields: name, url' })
      }
      
      // Only allow federated emojis (server_id must be null) from bots
      if (server_id !== null && server_id !== undefined) {
        return res.status(403).json({ error: 'Bots can only create federated emojis (server_id must be null)' })
      }
      
      // Use RPC function to create emoji (bypasses RLS with SECURITY DEFINER)
      const { data: newEmoji, error: insertError } = await supabase
        .rpc('create_federated_emoji', {
          p_name: name,
          p_url: url,
          p_uploader: botId,
          p_domain: domain || null
        })
      
      if (insertError) {
        console.error('❌ Emoji insert error:', insertError);
        return res.status(500).json({ error: insertError.message })
      }
      
      // RPC returns an array, get first result
      const emoji = Array.isArray(newEmoji) && newEmoji.length > 0 ? newEmoji[0] : null
      
      if (!emoji) {
        return res.status(500).json({ error: 'Failed to create emoji' })
      }
      
      await this.logBotAction(botId, 'emoji_create', { emojiId: emoji.id, name })
      
      res.status(201).json(emoji)
    } catch (error: any) {
      console.error('❌ Create emoji exception:', error);
      res.status(500).json({ error: error.message })
    }
  }
  
  // =====================================================
  // AUDIT LOGGING
  // =====================================================
  
  private async logBotAction(botId: string, action: string, metadata: any) {
    try {
      await supabase
        .from('bot_audit_log')
        .insert({
          bot_id: botId,
          action_type: action,
          success: true,
          metadata
        })
    } catch (error) {
      console.error('Failed to log bot action:', error)
    }
  }
}

