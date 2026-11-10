export interface BridgeAuthor {
  platform: 'matrix' | 'discord'
  id: string
  username: string
  display_name?: string
  avatar_url?: string
}

/** These fields become the displayed author, not arbitrary bridge metadata. */
export function bridgeAuthor(input: unknown, platform: string | null): BridgeAuthor | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if ((platform !== 'matrix' && platform !== 'discord') || value.platform !== platform) return null
  if (typeof value.id !== 'string' || value.id.length > 512) return null
  if (platform === 'matrix' ? !/^@[^\s:]+:[^\s]+$/.test(value.id) : !/^[0-9]{1,20}$/.test(value.id)) return null
  if (typeof value.username !== 'string' || !value.username.trim() || value.username.length > 100) return null
  const author: BridgeAuthor = { platform, id: value.id, username: value.username }
  if (typeof value.display_name === 'string' && value.display_name.trim()) author.display_name = value.display_name.slice(0, 100)
  if (typeof value.avatar_url === 'string' && value.avatar_url.length <= 2048) {
    try {
      const url = new URL(value.avatar_url)
      if ((url.protocol === 'https:' || url.protocol === 'http:') && !url.username && !url.password) author.avatar_url = url.href
    } catch { /* An invalid optional avatar must not discard the author's text. */ }
  }
  return author
}

/** Legacy Discord metadata remains readable without rewriting historical messages. */
export function bridgedMessageAuthor(message: any): Record<string, unknown> | null {
  if (!message.bot_id) return null
  const generic = message.metadata?.bridge_author
  const author = bridgeAuthor(generic, generic?.platform)
  if (author) return {
    id: author.id, username: author.username, display_name: author.display_name,
    avatar: author.avatar_url, nickname: null, bot: false,
    bridge_source: author.platform, bridge_author: true,
    ...(author.platform === 'discord' ? { discord_user: true } : {}),
  }
  const discord = message.metadata?.discord_user
  if (!discord || typeof discord !== 'object') return null
  return {
    id: discord.id, username: discord.username, display_name: discord.display_name,
    avatar: discord.avatar_url, nickname: null, bot: false, discord_user: true,
  }
}
