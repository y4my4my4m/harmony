/**
 * Generate a secure bot token
 */
export function generateBotToken(prefix = 'harmony_bot_'): string {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)
  const randomHex = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}${randomHex}`
}

/**
 * Hash a bot token (client-side fallback - server should hash with bcrypt in production)
 */
export async function hashBotToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

