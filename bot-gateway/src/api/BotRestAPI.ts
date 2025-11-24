import { Router, Request, Response, NextFunction } from 'express'
import { supabase } from '../config/supabase.js'
import { botAuthMiddleware } from '../auth/BotAuthMiddleware.js'

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
    
    // Edit message
    this.router.patch('/messages/:messageId', this.editMessage.bind(this))
    
    // Delete message
    this.router.delete('/messages/:messageId', this.deleteMessage.bind(this))
    
    // Add reaction
    this.router.put('/messages/:messageId/reactions/:emoji', this.addReaction.bind(this))
    
    // Trigger typing indicator
    this.router.post('/channels/:channelId/typing', this.triggerTyping.bind(this))
    
    // =====================================================
    // GUILD (SERVER) ENDPOINTS
    // =====================================================
    
    // Get guild info
    this.router.get('/guilds/:guildId', this.getGuild.bind(this))
    
    // Get guild members
    this.router.get('/guilds/:guildId/members', this.getGuildMembers.bind(this))
    
    // Get guild channels
    this.router.get('/guilds/:guildId/channels', this.getGuildChannels.bind(this))
    
    // =====================================================
    // USER ENDPOINTS
    // =====================================================
    
    // Get user info
    this.router.get('/users/:userId', this.getUser.bind(this))
    
    // Get current bot user
    this.router.get('/users/@me', this.getCurrentBot.bind(this))
  }
  
  // =====================================================
  // MESSAGE ENDPOINTS
  // =====================================================
  
  private async sendMessage(req: BotRequest, res: Response) {
    try {
      const { channelId } = req.params
      const { content, embeds, reply_to } = req.body
      const botId = req.bot!.id
      
      // Check permissions
      const canSend = await this.checkChannelPermission(botId, channelId, 'send_messages')
      if (!canSend) {
        return res.status(403).json({ error: 'Missing permission: send_messages' })
      }
      
      // Format content
      const messageContent = this.formatContent(content, embeds)
      
      // Insert message
      const { data: message, error } = await supabase
        .from('messages')
        .insert({
          channel_id: channelId,
          user_id: botId,
          content: messageContent,
          reply_to: reply_to || null,
          metadata: { bot: true, created_via: 'bot_api' }
        })
        .select(`
          *,
          author:profiles!messages_user_id_fkey(id, username, display_name, avatar_url)
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
          author:profiles!messages_user_id_fkey(id, username, display_name, avatar_url)
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
  
  private async editMessage(req: BotRequest, res: Response) {
    try {
      const { messageId } = req.params
      const { content } = req.body
      const botId = req.bot!.id
      
      // Check if bot owns the message
      const { data: message } = await supabase
        .from('messages')
        .select('user_id, channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message || message.user_id !== botId) {
        return res.status(403).json({ error: 'Cannot edit messages from other users' })
      }
      
      // Check permissions
      const canManage = await this.checkChannelPermission(botId, message.channel_id, 'manage_messages')
      if (!canManage) {
        return res.status(403).json({ error: 'Missing permission: manage_messages' })
      }
      
      const messageContent = this.formatContent(content)
      
      const { data: updated, error } = await supabase
        .from('messages')
        .update({ 
          content: messageContent,
          updated_at: new Date().toISOString()
        })
        .eq('id', messageId)
        .select(`
          *,
          author:profiles!messages_user_id_fkey(id, username, display_name, avatar_url)
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
        .select('user_id, channel_id')
        .eq('id', messageId)
        .single()
      
      if (!message) {
        return res.status(404).json({ error: 'Message not found' })
      }
      
      if (message.user_id !== botId) {
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
      
      const { error } = await supabase
        .from('reactions')
        .insert({
          message_id: messageId,
          user_id: botId,
          emoji_id: emoji
        })
      
      if (error) {
        return res.status(500).json({ error: error.message })
      }
      
      res.status(204).send()
    } catch (error: any) {
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
      const { guildId } = req.params
      const botId = req.bot!.id
      
      // Check if bot is in the guild
      const { data: permission } = await supabase
        .from('bot_server_permissions')
        .select('*')
        .eq('bot_id', botId)
        .eq('server_id', guildId)
        .eq('is_active', true)
        .single()
      
      if (!permission) {
        return res.status(403).json({ error: 'Bot not in guild' })
      }
      
      const { data: guild, error } = await supabase
        .from('servers')
        .select(`
          *,
          owner:profiles!servers_owner_fkey(id, username, display_name, avatar_url)
        `)
        .eq('id', guildId)
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
      const { guildId } = req.params
      const { limit = 100, after } = req.query
      const botId = req.bot!.id
      
      // Check if bot is in the guild
      const hasAccess = await this.checkBotInGuild(botId, guildId)
      if (!hasAccess) {
        return res.status(403).json({ error: 'Bot not in guild' })
      }
      
      let query = supabase
        .from('user_servers')
        .select(`
          *,
          user:profiles!user_servers_user_id_fkey(id, username, display_name, avatar_url, status)
        `)
        .eq('server_id', guildId)
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
      const { guildId } = req.params
      const botId = req.bot!.id
      
      const hasAccess = await this.checkBotInGuild(botId, guildId)
      if (!hasAccess) {
        return res.status(403).json({ error: 'Bot not in guild' })
      }
      
      const { data: channels, error } = await supabase
        .from('channels')
        .select('*')
        .eq('server_id', guildId)
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
    const { data: channel } = await supabase
      .from('channels')
      .select('server_id')
      .eq('id', channelId)
      .single()
    
    if (!channel) return false
    
    // Check bot permission
    const { data } = await supabase.rpc('check_bot_permission', {
      p_bot_id: botId,
      p_server_id: channel.server_id,
      p_permission: permission
    })
    
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
  
  private formatContent(content: string, embeds?: any[]): any[] {
    const parts: any[] = []
    
    if (content) {
      parts.push({ type: 'text', value: content })
    }
    
    if (embeds && embeds.length > 0) {
      parts.push(...embeds.map(e => ({ type: 'embed', ...e })))
    }
    
    return parts
  }
  
  private formatMessage(message: any) {
    return {
      id: message.id,
      channel_id: message.channel_id,
      author: message.author ? {
        id: message.author.id,
        username: message.author.username,
        display_name: message.author.display_name,
        avatar: message.author.avatar_url
      } : null,
      content: this.contentToText(message.content),
      timestamp: message.created_at,
      edited_timestamp: message.updated_at,
      mentions: this.extractMentions(message.content)
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
        avatar: member.user.avatar_url
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
      avatar: user.avatar_url,
      bio: user.bio
    }
  }
  
  private formatBot(bot: any) {
    return {
      id: bot.id,
      username: bot.username,
      discriminator: bot.discriminator,
      avatar: bot.avatar_url,
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
        .map(part => part.value || '')
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

