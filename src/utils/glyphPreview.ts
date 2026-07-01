/** Decorative symbols shown in place of encrypted ciphertext. */
export const GLYPH_CHARS =
  '█▓▒░▄▀■□▪▫●○◘◙▬¤§¶ƒαßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■'

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

/** Deterministic glyph string for a ciphertext blob (purely decorative). */
export function generateGlyphPreview(content: string, seedSuffix = ''): string {
  const displayLength = Math.min(Math.max(Math.floor(content.length / 4), 12), 48)
  const seed = hashString(content + seedSuffix)
  let out = ''
  for (let i = 0; i < displayLength; i++) {
    const charIndex = (seed * (i + 1) * 31) % GLYPH_CHARS.length
    out += GLYPH_CHARS[charIndex]
  }
  return out
}
