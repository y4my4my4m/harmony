export class MessageTranslator {
  private serverId: string | null = null
  
  /**
   * Set the server ID for emoji lookups
   */
  setServerId(serverId: string) {
    this.serverId = serverId
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
    
    // Text content
    if (discordMsg.content && typeof discordMsg.content === 'string') {
      let content = discordMsg.content
      
      // Parse content for custom emojis and create proper emoji parts
      // Discord custom emoji format: <:name:id> or <a:name:id> (animated)
      const emojiRegex = /<(a?):(\w+):(\d+)>/g
      let lastIndex = 0
      let match
      let hasContent = false
      
      while ((match = emojiRegex.exec(content)) !== null) {
        hasContent = true
        
        // Add text before the emoji
        if (match.index > lastIndex) {
          const textBefore = content.substring(lastIndex, match.index)
          if (textBefore.trim()) {
            parts.push({ type: 'text', text: textBefore })
          }
        }
        
        // Create emoji part
        // TODO: Query Harmony database to get actual emoji by name
        // For now, create a simple emoji representation
        const isAnimated = match[1] === 'a'
        const emojiName = match[2]
        const discordEmojiId = match[3]
        
        // Format: https://cdn.discordapp.com/emojis/ID.png (or .gif for animated)
        const discordEmojiUrl = `https://cdn.discordapp.com/emojis/${discordEmojiId}.${isAnimated ? 'gif' : 'png'}`
        
        // Create a pseudo-emoji object (matches Harmony's emoji structure)
        // TODO: Look up actual emoji in Harmony DB by name or create it
        parts.push({
          type: 'emoji',
          emoji: {
            name: emojiName,
            url: discordEmojiUrl,
            // These fields would come from Harmony DB lookup:
            id: null,
            domain: 'discord.com', // Mark as Discord emoji
            display_name: emojiName,
            server_id: this.serverId
          }
        })
        
        lastIndex = emojiRegex.lastIndex
      }
      
      // Add remaining text after last emoji
      const remainingText = content.substring(lastIndex)
      
      // Now handle mentions and other replacements on the remaining text
      let processedText = remainingText
      
      // Translate user mentions: <@123> -> @username
      processedText = processedText.replace(/<@!?(\d+)>/g, (match: string, id: string) => {
        const user = discordMsg.mentions?.users?.get(id)
        return user ? `@${user.username}` : match
      })
      
      // Translate role mentions: <@&123> -> @role
      processedText = processedText.replace(/<@&(\d+)>/g, (match: string, id: string) => {
        const role = discordMsg.mentions?.roles?.get(id)
        return role ? `@${role.name}` : match
      })
      
      // Translate channel mentions: <#123> -> #channel
      processedText = processedText.replace(/<#(\d+)>/g, (match: string, id: string) => {
        const channel = discordMsg.mentions?.channels?.get(id)
        return channel ? `#${channel.name}` : match
      })
      
      // If we found emojis, add the processed remaining text
      if (hasContent && processedText.trim()) {
        parts.push({ type: 'text', text: processedText })
      } else if (!hasContent && processedText.trim()) {
        // No emojis found, add the whole processed content as text
        parts.push({ type: 'text', text: processedText })
      }
    }
    
    // Attachments as proper file parts (images, videos, files)
    if (discordMsg.attachments && discordMsg.attachments.size > 0) {
      discordMsg.attachments.forEach((attachment: any) => {
        // Determine if it's an image, video, or other file
        const contentType = attachment.contentType || ''
        const isImage = contentType.startsWith('image/')
        const isVideo = contentType.startsWith('video/')
        
        parts.push({
          type: 'file',
          url: attachment.url,
          fileName: attachment.name,
          fileType: isImage ? 'image' : isVideo ? 'video' : 'file'
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
   */
  harmonyToDiscord(harmonyMsg: any): string {
    let content = ''
    
    // If content_raw exists, use it to properly parse MessageParts
    if (harmonyMsg.content_raw && Array.isArray(harmonyMsg.content_raw)) {
      const parts = harmonyMsg.content_raw.map((part: any) => {
        if (part.type === 'text') {
          return part.text || ''
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
            // Option 1: Just show the name (current)
            // Option 2: Send the image URL (but Discord won't render localhost URLs)
            // Option 3: Upload as attachment (would require more complex logic)
            
            // For now, just use the name
            return `:${emoji.name}:`
          }
          return ''
        } else if (part.type === 'file') {
          // File attachments - Discord will auto-embed images/videos
          return part.url || ''
        } else if (part.type === 'url') {
          // URL parts
          return part.url || ''
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
      const [, username, message] = match
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
    isAnimated: boolean = false
  ): Promise<string | null> {
    // For Unicode emojis, just return the emoji character as-is
    if (!discordEmojiId && discordEmojiName) {
      // Unicode emoji - Harmony should handle it directly
      // Return the name which is the actual emoji character
      return discordEmojiName
    }
    
    // For custom Discord emojis, we need to find or create it in Harmony
    if (discordEmojiId && discordEmojiName) {
      // Build the Discord CDN URL
      const discordEmojiUrl = `https://cdn.discordapp.com/emojis/${discordEmojiId}.${isAnimated ? 'gif' : 'png'}`
      
      // For now, return a special format that the bridge can handle
      // Format: discord:name:id
      // The bot API will need to handle this format
      return `discord:${discordEmojiName}:${discordEmojiId}`
    }
    
    return null
  }
}

