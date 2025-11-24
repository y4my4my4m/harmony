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
}

