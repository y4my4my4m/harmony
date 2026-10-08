import { describe, it, expect } from 'vitest'
import {
  generateGlyphPreview,
  estimatePlaintextChars,
  GLYPH_WIDTH_RATIO,
  MAX_GLYPHS,
  MIN_GLYPHS,
} from '@/utils/glyphPreview'

/** Megolm wire format, as MegolmService.encryptMessageInner writes it. */
async function megolmCiphertext(plaintext: string): Promise<string> {
  const key = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt'])
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const sealed = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext)))
  const combined = new Uint8Array(iv.length + sealed.length)
  combined.set(iv)
  combined.set(sealed, iv.length)
  return btoa(String.fromCharCode(...combined))
}

const textParts = (text: string) => JSON.stringify([{ type: 'text', text }])

describe('generateGlyphPreview', () => {
  it('is deterministic for the same content and seed suffix', () => {
    const a = generateGlyphPreview('ciphertext-blob', 'msg-1')
    const b = generateGlyphPreview('ciphertext-blob', 'msg-1')
    expect(a).toBe(b)
  })

  it('differs when message id seed changes', () => {
    const a = generateGlyphPreview('same-content', 'msg-a')
    const b = generateGlyphPreview('same-content', 'msg-b')
    expect(a).not.toBe(b)
  })

  it('caps length regardless of huge ciphertext', () => {
    const huge = 'x'.repeat(100_000)
    expect(generateGlyphPreview(huge).length).toBe(MAX_GLYPHS)
  })
})

describe('placeholder sized from the ciphertext', () => {
  it('recovers the plaintext length of a one-part text message', async () => {
    for (const len of [0, 1, 7, 40, 133, 600]) {
      const ct = await megolmCiphertext(textParts('a'.repeat(len)))
      expect(estimatePlaintextChars(ct)).toBe(len)
    }
  })

  it('fills as many lines as the text it replaces', async () => {
    // Line capacity in advance units: body text 0.5em per char, glyphs 0.72em.
    const lineEm = 40
    const lines = (count: number, advanceEm: number) => Math.ceil((count * advanceEm) / lineEm)
    for (const len of [30, 79, 80, 200, 450]) {
      const text = 'a'.repeat(len)
      const glyphs = generateGlyphPreview(await megolmCiphertext(textParts(text)), 'm')
      expect(glyphs.length).toBe(Math.max(Math.round(len * GLYPH_WIDTH_RATIO), MIN_GLYPHS))
      expect(Math.abs(lines(glyphs.length, 0.72) - lines(len, 0.5))).toBeLessThanOrEqual(1)
    }
  })

  it('a long message no longer collapses to a one-line placeholder', async () => {
    const ct = await megolmCiphertext(textParts('word '.repeat(100)))
    expect(generateGlyphPreview(ct).length).toBeGreaterThan(300)
  })

  it('falls back for content that is not base64', () => {
    expect(estimatePlaintextChars('encrypted!')).toBeNull()
    expect(generateGlyphPreview('encrypted!').length).toBe(MIN_GLYPHS)
  })
})
