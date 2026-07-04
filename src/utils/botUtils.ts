export function generateBotToken(prefix = 'harmony_bot_'): string {
  const randomBytes = new Uint8Array(32)
  crypto.getRandomValues(randomBytes)
  const randomHex = Array.from(randomBytes, b => b.toString(16).padStart(2, '0')).join('')
  return `${prefix}${randomHex}`
}

/**
 * SHA-256 is deliberate: tokens carry 256 bits of entropy, so a slow hash
 * (bcrypt/argon2) adds nothing, and the digest doubles as the DB lookup key.
 */
export async function hashBotToken(token: string): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  const hashBuffer = await crypto.subtle.digest('SHA-256', data)
  const hashArray = Array.from(new Uint8Array(hashBuffer))
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('')
}

