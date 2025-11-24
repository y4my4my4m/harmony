export class MessageTranslator {
  /**
   * Convert Discord message to Harmony format (plain content only)
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

