/** Decorative symbols shown in place of encrypted ciphertext. */
export const GLYPH_CHARS =
  '█▓▒░▄▀■□▪▫●○◘◙▬¤§¶ƒαßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■'

/** Megolm wire format: base64(iv[12] || AES-GCM ciphertext || tag[16]). */
const MEGOLM_IV_BYTES = 12
const MEGOLM_TAG_BYTES = 16
/** JSON.stringify([{ type: 'text', text: '' }]).length */
const TEXT_PART_JSON_OVERHEAD = 27

/**
 * Glyph advance over body text advance: the preview font is monospace at
 * 0.6em per glyph plus 0.12em letter-spacing, body text averages about 0.5em
 * per character. A run of length chars * ratio fills about as many lines as
 * the plaintext it stands for.
 */
export const GLYPH_WIDTH_RATIO = 0.7

export const MIN_GLYPHS = 4
/** Bounds the per-message span count; about 850 characters of plaintext. */
export const MAX_GLYPHS = 600

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/**
 * Characters of plaintext a Megolm ciphertext carries, assuming one text part.
 * Exact for ASCII text; multi-byte characters and non-text parts overestimate.
 * Null when `ciphertext` is not base64.
 */
export function estimatePlaintextChars(ciphertext: string): number | null {
  if (!ciphertext || !BASE64.test(ciphertext)) return null
  const padding = ciphertext.endsWith('==') ? 2 : ciphertext.endsWith('=') ? 1 : 0
  const bytes = Math.floor((ciphertext.length * 3) / 4) - padding
  return Math.max(0, bytes - MEGOLM_IV_BYTES - MEGOLM_TAG_BYTES - TEXT_PART_JSON_OVERHEAD)
}

/** Glyph count for a ciphertext; see GLYPH_WIDTH_RATIO. */
export function glyphCountFor(ciphertext: string): number {
  const chars = estimatePlaintextChars(ciphertext) ?? Math.floor(ciphertext.length / 4)
  return Math.min(Math.max(Math.round(chars * GLYPH_WIDTH_RATIO), MIN_GLYPHS), MAX_GLYPHS)
}

function hashString(str: string): number {
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash
  }
  return Math.abs(hash)
}

/**
 * Deterministic glyph string for a ciphertext blob. Its length tracks the
 * plaintext length, so the placeholder wraps to about the height the
 * decrypted text takes.
 */
export function generateGlyphPreview(content: string, seedSuffix = ''): string {
  const displayLength = glyphCountFor(content)
  const seed = hashString(content + seedSuffix)
  let out = ''
  for (let i = 0; i < displayLength; i++) {
    const charIndex = (seed * (i + 1) * 31) % GLYPH_CHARS.length
    out += GLYPH_CHARS[charIndex]
  }
  return out
}
