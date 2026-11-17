/**
 * Relayed authors. Discord bridges send metadata.discord_user; the Matrix service sends
 * metadata.bridge_author = { platform: 'matrix', id, username, display_name?, avatar_url? }, stored
 * as metadata.matrix_user (db_schema guard_matrix_author) with bridge_source 'matrix'.
 */

export interface MatrixAuthor {
  id: string
  username: string
  display_name?: string
  avatar_url?: string
}

// MXID: '@' localpart ':' server name; at most 255 characters (Matrix spec, user identifiers).
export const MATRIX_USER_ID = /^@[^\s:]+:\S+$/

/** The Matrix author a bot names in metadata.bridge_author, or null when it is not a valid one. */
export function matrixAuthor(input: unknown): MatrixAuthor | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null
  const value = input as Record<string, unknown>
  if (value.platform !== 'matrix') return null
  if (typeof value.id !== 'string' || value.id.length > 255 || !MATRIX_USER_ID.test(value.id)) return null
  if (typeof value.username !== 'string' || !value.username.trim() || value.username.length > 100) return null
  const author: MatrixAuthor = { id: value.id, username: value.username }
  if (typeof value.display_name === 'string' && value.display_name.trim()) author.display_name = value.display_name.slice(0, 100)
  if (typeof value.avatar_url === 'string' && value.avatar_url.length <= 2048) {
    try {
      const url = new URL(value.avatar_url)
      if (url.protocol === 'https:' && !url.username && !url.password) author.avatar_url = url.href
    } catch { /* An invalid optional avatar keeps the author's name. */ }
  }
  return author
}

/** The event author of a relayed message, from matrix_user or discord_user; null for any other row. */
export function bridgedMessageAuthor(message: any): Record<string, unknown> | null {
  if (!message.bot_id) return null
  const matrix = message.metadata?.matrix_user
  if (matrix && typeof matrix === 'object' && typeof matrix.id === 'string') {
    return {
      id: matrix.id, username: matrix.username, display_name: matrix.display_name,
      avatar: matrix.avatar_url, nickname: null, bot: false,
      bridge_source: 'matrix', bridge_author: true,
    }
  }
  const discord = message.metadata?.discord_user
  if (!discord || typeof discord !== 'object') return null
  return {
    id: discord.id, username: discord.username, display_name: discord.display_name,
    avatar: discord.avatar_url, nickname: null, bot: false, discord_user: true,
  }
}
