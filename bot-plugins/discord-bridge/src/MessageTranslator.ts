export class MessageTranslator {
  private serverId: string | null = null
  private harmonyDomain: string | null = null
  
  /**
   * Set the server ID for emoji lookups
   */
  setServerId(serverId: string) {
    this.serverId = serverId
  }
  
  /**
   * Set the Harmony instance domain for federation mentions
   * Must be called before using the translator
   */
  setHarmonyDomain(domain: string) {
    if (!domain) {
      throw new Error('Harmony domain is required')
    }
    this.harmonyDomain = domain
  }
  
  /**
   * Get the configured Harmony domain (throws if not configured)
   */
  private getHarmonyDomain(): string {
    if (!this.harmonyDomain) {
      throw new Error('MessageTranslator: harmonyDomain not configured. Call setHarmonyDomain() first.')
    }
    return this.harmonyDomain
  }
  
  /**
   * Convert Discord message to Harmony MessageParts format
   * This creates the proper format that Harmony's database expects
   */
  discordToHarmonyParts(discordMsg: any): any[] {
    const parts: any[] = []
    
    console.log('🔍 discordToHarmonyParts input:', {
      contentType: typeof discordMsg.content,
      contentIsArray: Array.isArray(discordMsg.content),
      content: discordMsg.content
    })
    
    // Text content - parse for emojis, mentions, and channel references
    if (discordMsg.content && typeof discordMsg.content === 'string') {
      const content = discordMsg.content
      
      // Combined regex to match all special tokens in order of appearance:
      // - Custom emojis: <a:name:id> or <:name:id>
      // - User mentions: <@id> or <@!id>
      // - Role mentions: <@&id>
      // - Channel mentions: <#id>
      const tokenRegex = /<(a?):(\w+):(\d+)>|<@!?(\d+)>|<@&(\d+)>|<#(\d+)>/g
      
      let lastIndex = 0
      let match
      
      while ((match = tokenRegex.exec(content)) !== null) {
        // Add text before the token
        if (match.index > lastIndex) {
          const textBefore = content.substring(lastIndex, match.index)
          if (textBefore) {
            parts.push({ type: 'text', text: textBefore })
          }
        }
        
        if (match[2] && match[3]) {
          // Custom emoji: <a:name:id> or <:name:id>
          const isAnimated = match[1] === 'a'
          const emojiName = match[2]
          const discordEmojiId = match[3]
          const discordEmojiUrl = `https://cdn.discordapp.com/emojis/${discordEmojiId}.${isAnimated ? 'gif' : 'png'}`
          
          console.log(`🎨 D→H Custom emoji: :${emojiName}: → ${discordEmojiUrl}`)
          
          parts.push({
            type: 'emoji',
            emoji: {
              name: emojiName,
              url: discordEmojiUrl,
              id: null,
              domain: 'discord.com',
              display_name: emojiName,
              server_id: this.serverId
            }
          })
        } else if (match[4]) {
          // User mention: <@id> or <@!id>
          const discordUserId = match[4]
          const user = discordMsg.mentions?.users?.get(discordUserId)
          
          if (user) {
            // Create proper mention MessagePart for Discord user
            console.log(`🔔 D→H Mention: <@${discordUserId}> → @${user.username}@discord.com (ID: ${discordUserId})`)
            parts.push({
              type: 'mention',
              userId: discordUserId, // Store Discord snowflake ID for reverse translation
              username: user.username,
              domain: 'discord.com',
              isLocal: false,
              displayName: user.globalName || user.username,
              isBridged: true,
              bridgeSource: 'discord'
            })
          } else {
            // User not found in mentions cache, keep as text
            console.log(`⚠️ D→H Mention: <@${discordUserId}> not found in mentions cache`)
            parts.push({ type: 'text', text: match[0] })
          }
        } else if (match[5]) {
          // Role mention: <@&id>
          const roleId = match[5]
          const role = discordMsg.mentions?.roles?.get(roleId)
          
          // Roles don't have a direct equivalent in Harmony, show as styled text
          parts.push({ 
            type: 'text', 
            text: role ? `@${role.name}` : match[0] 
          })
        } else if (match[6]) {
          // Channel mention: <#id>
          const channelId = match[6]
          const channel = discordMsg.mentions?.channels?.get(channelId)
          
          // Channel mentions shown as text (could be enhanced later)
          parts.push({ 
            type: 'text', 
            text: channel ? `#${channel.name}` : match[0] 
          })
        }
        
        lastIndex = tokenRegex.lastIndex
      }
      
      // Add remaining text after last token
      if (lastIndex < content.length) {
        const remainingText = content.substring(lastIndex)
        if (remainingText) {
          parts.push({ type: 'text', text: remainingText })
        }
      }
      
      // Post-process: detect plain @username mentions (for Harmony users)
      // These are typed manually in Discord (not using Discord's autocomplete)
      // Convert them to proper mention parts so they appear as mentions in Harmony
      const processedParts: any[] = []
      const plainMentionRegex = /@([a-zA-Z0-9_-]+)(?!\S)/g
      
      for (const part of parts) {
        if (part.type === 'text') {
          const text = part.text
          let textLastIndex = 0
          let mentionMatch
          
          while ((mentionMatch = plainMentionRegex.exec(text)) !== null) {
            // Add text before the mention
            if (mentionMatch.index > textLastIndex) {
              processedParts.push({ type: 'text', text: text.substring(textLastIndex, mentionMatch.index) })
            }
            
            const username = mentionMatch[1]
            console.log(`🔔 D→H Plain mention detected: @${username} (Harmony user)`)
            
            // Create mention part for Harmony user
            processedParts.push({
              type: 'mention',
              userId: `unresolved-${username}`, // Will be resolved by Harmony
              username: username,
              domain: null, // Local user
              isLocal: true,
              displayName: username
            })
            
            textLastIndex = plainMentionRegex.lastIndex
          }
          
          // Add remaining text
          if (textLastIndex < text.length) {
            processedParts.push({ type: 'text', text: text.substring(textLastIndex) })
          } else if (textLastIndex === 0) {
            // No mentions found, keep original part
            processedParts.push(part)
          }
        } else {
          processedParts.push(part)
        }
      }
      
      // Replace parts with processed parts if any mentions were found
      if (processedParts.length > 0) {
        parts.length = 0
        parts.push(...processedParts)
      }
    }
    
    // Attachments as proper file parts (images, videos, files)
    if (discordMsg.attachments && discordMsg.attachments.size > 0) {
      console.log(`📎 D→H ${discordMsg.attachments.size} attachment(s):`)
      discordMsg.attachments.forEach((attachment: any) => {
        const contentType = attachment.contentType || ''
        const isImage = contentType.startsWith('image/')
        const isVideo = contentType.startsWith('video/')
        const fileType = isImage ? 'image' : isVideo ? 'video' : 'file'
        
        console.log(`   📎 ${attachment.name} (${fileType}) → ${attachment.url}`)
        
        parts.push({
          type: 'file',
          url: attachment.url,
          fileName: attachment.name,
          fileType: fileType
        })
      })
    }
    
    // Embeds (links with previews) - only for rich embeds with URLs
    if (discordMsg.embeds && discordMsg.embeds.length > 0) {
      discordMsg.embeds.forEach((embed: any) => {
        if (embed.url) {
          parts.push({
            type: 'url',
            url: embed.url,
            preview: true
          })
        }
      })
    }
    
    return parts
  }
  
  /**
   * Convert Discord message to Harmony format (legacy string version)
   */
  discordToHarmony(discordMsg: any): string {
    let content = discordMsg.content
    
    // Translate user mentions: <@123> -> @username
    content = content.replace(/<@!?(\d+)>/g, (match: string, id: string) => {
      const user = discordMsg.mentions.users.get(id)
      return user ? `@${user.username}` : match
    })
    
    // Translate role mentions: <@&123> -> @role
    content = content.replace(/<@&(\d+)>/g, (match: string, id: string) => {
      const role = discordMsg.mentions.roles.get(id)
      return role ? `@${role.name}` : match
    })
    
    // Translate channel mentions: <#123> -> #channel
    content = content.replace(/<#(\d+)>/g, (match: string, id: string) => {
      const channel = discordMsg.mentions.channels.get(id)
      return channel ? `#${channel.name}` : match
    })
    
    // Translate custom emojis: <:name:123> or <a:name:123> -> :name:
    content = content.replace(/<a?:(\w+):\d+>/g, ':$1:')
    
    return content
  }
  
  /**
   * Extract Discord user metadata for puppeting
   */
  extractDiscordUserMetadata(discordMsg: any): any {
    return {
      discord_user: {
        id: discordMsg.author.id,
        username: discordMsg.author.username,
        discriminator: discordMsg.author.discriminator,
        display_name: discordMsg.author.globalName || discordMsg.author.username,
        avatar_url: discordMsg.author.displayAvatarURL({ size: 256 })
      },
      bridge_source: 'discord'
    }
  }
  
  /**
   * Convert Harmony message to Discord format
   * @param harmonyMsg - The Harmony message object
   * @param discordMemberCache - Optional cache of Discord members for username-to-ID lookup
   */
  harmonyToDiscord(harmonyMsg: any, discordMemberCache?: Map<string, string>): string {
    let content = ''
    
    // If content_raw exists, use it to properly parse MessageParts
    if (harmonyMsg.content_raw && Array.isArray(harmonyMsg.content_raw)) {
      const parts = harmonyMsg.content_raw.map((part: any) => {
        if (part.type === 'text') {
          return part.text || ''
        } else if (part.type === 'mention') {
          // Handle mention parts
          
          // Check if this is a bridged Discord mention (has isBridged flag or domain is discord.com)
          if (part.domain === 'discord.com' && part.userId) {
            // Discord user mention - userId contains the Discord ID
            // Check if it's a valid Discord snowflake (numeric)
            if (/^\d+$/.test(part.userId)) {
              console.log(`🔔 H→D Mention (Discord user): @${part.username} → <@${part.userId}>`)
              return `<@${part.userId}>`
            } else {
              console.log(`⚠️ H→D Mention: Invalid Discord ID: ${part.userId}`)
            }
          }
          
          // Try to find this user in Discord by username
          if (discordMemberCache) {
            const lookupUsername = part.username?.toLowerCase()
            const discordId = discordMemberCache.get(lookupUsername)
            if (discordId) {
              console.log(`🔔 H→D Mention: @${part.username} → <@${discordId}> (found in Discord)`)
              return `<@${discordId}>`
            }
          }
          
          // Fallback: show as @username@domain for Harmony users not in Discord
          const username = part.username || 'unknown'
          // Use the domain from the mention, fall back to configured Harmony domain
          const domain = part.domain || this.getHarmonyDomain()
          const federatedMention = `@${username}@${domain}`
          console.log(`🔔 H→D Mention (Harmony user): ${federatedMention}`)
          return federatedMention
        } else if (part.type === 'emoji') {
          // Convert Harmony emoji to Discord format
          const emoji = part.emoji
          console.log('🎭 Converting emoji to Discord:', JSON.stringify(emoji, null, 2))
          if (emoji) {
            // If it's a Discord emoji (has domain), try to reconstruct Discord emoji format
            if (emoji.domain === 'discord.com' && emoji.url) {
              // Extract Discord emoji ID from URL: https://cdn.discordapp.com/emojis/123.png
              const match = emoji.url.match(/emojis\/(\d+)\.(png|gif|webp)/)
              if (match) {
                const emojiId = match[1]
                const isAnimated = match[2] === 'gif'
                // Use Discord emoji format: <:name:id> or <a:name:id> for animated
                return `<${isAnimated ? 'a' : ''}:${emoji.name}:${emojiId}>`
              }
            }
            
            // For Harmony native emojis, we can't render them in Discord directly
            // Just show the name
            return `:${emoji.name}:`
          }
          return ''
        } else if (part.type === 'file') {
          // File attachments - Discord will auto-embed images/videos
          return part.url || ''
        } else if (part.type === 'url') {
          // URL parts
          return part.url || ''
        } else if (part.type === 'hashtag') {
          // Hashtags - show as plain text
          return `#${part.name || ''}`
        }
        return ''
      })
      
      content = parts.filter(Boolean).join('')
    } else if (harmonyMsg.content) {
      // Fallback to simple content string
      content = harmonyMsg.content
    }
    
    // Remove [Discord] prefix if present (avoid loops)
    content = content.replace(/^\*\*\[Discord\]\*\*\s+/, '')
    
    // Extract username if in "username: message" format
    const match = content.match(/^(.+?):\s+(.+)$/)
    if (match) {
      const [, , message] = match
      // Don't add prefix since we're using puppeting
      content = message
    }
    
    // Limit length to Discord's 2000 character limit
    if (content.length > 2000) {
      content = content.substring(0, 1997) + '...'
    }
    
    return content
  }
  
  /**
   * Convert Harmony message to Discord format (old method, kept for compatibility)
   */
  harmonyToDiscordOld(harmonyMsg: any): string {
    let content = harmonyMsg.content
    
    // Remove [Discord] prefix if present (avoid loops)
    content = content.replace(/^\*\*\[Discord\]\*\*\s+/, '')
    
    // Extract username if in "username: message" format
    const match = content.match(/^(.+?):\s+(.+)$/)
    if (match) {
      const [, username, message] = match
      content = `**[Harmony]** ${username}: ${message}`
    } else {
      content = `**[Harmony]** ${content}`
    }
    
    // Limit length to Discord's 2000 character limit
    if (content.length > 2000) {
      content = content.substring(0, 1997) + '...'
    }
    
    return content
  }
  
  /**
   * Check if message should be bridged (avoid infinite loops)
   */
  shouldBridge(message: string): boolean {
    // Don't bridge if message is already from the bridge
    if (message.startsWith('**[Discord]**') || message.startsWith('**[Harmony]**')) {
      return false
    }
    
    return true
  }
  
  /**
   * Extract attachments from Discord message
   */
  extractAttachments(discordMsg: any): string[] {
    return discordMsg.attachments.map((att: any) => att.url)
  }
  
  /**
   * Format attachment links for Harmony
   */
  formatAttachments(attachments: string[]): string {
    if (attachments.length === 0) return ''
    
    return '\n📎 ' + attachments.map(url => `<${url}>`).join(' ')
  }
  
  /**
   * Convert Discord emoji (for reactions) to Harmony emoji ID
   * This looks up or creates the emoji in Harmony's database
   */
  async discordEmojiToHarmonyId(
    discordEmojiId: string | null,
    discordEmojiName: string | null,
    _isAnimated: boolean = false
  ): Promise<string | null> {
    // For Unicode emojis, just return the emoji character as-is
    if (!discordEmojiId && discordEmojiName) {
      // Unicode emoji - Harmony should handle it directly
      // Return the name which is the actual emoji character
      return discordEmojiName
    }
    
    // For custom Discord emojis, we need to find or create it in Harmony
    if (discordEmojiId && discordEmojiName) {
      // Return a special format that the bridge can handle
      // Format: discord:name:id
      // The bot API will need to handle this format
      return `discord:${discordEmojiName}:${discordEmojiId}`
    }
    
    return null
  }
}

