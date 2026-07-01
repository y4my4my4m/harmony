import { describe, it, expect } from 'vitest'
import { generateGlyphPreview } from '@/utils/glyphPreview'

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
    const huge = 'x'.repeat(10_000)
    expect(generateGlyphPreview(huge).length).toBeLessThanOrEqual(48)
  })
})
