import { describe, it, expect } from 'vitest'
import { applyInlineFormatToggle, hasInlineFormatMarkers } from '@/utils/richTextFormatting'

describe('applyInlineFormatToggle', () => {
  it('wraps a selection in bold markers', () => {
    const result = applyInlineFormatToggle('hello world', 6, 11, 'bold')
    expect(result.text).toBe('hello **world**')
    expect(result.selectionStart).toBe(8)
    expect(result.selectionEnd).toBe(13)
  })

  it('unwraps bold when markers are present', () => {
    const result = applyInlineFormatToggle('hello **world**', 8, 13, 'bold')
    expect(result.text).toBe('hello world')
    expect(result.selectionStart).toBe(6)
    expect(result.selectionEnd).toBe(11)
  })

  it('inserts empty bold markers at the cursor', () => {
    const result = applyInlineFormatToggle('hello', 5, 5, 'bold')
    expect(result.text).toBe('hello****')
    expect(result.selectionStart).toBe(7)
    expect(result.selectionEnd).toBe(7)
  })

  it('wraps italic without conflicting with bold markers', () => {
    expect(hasInlineFormatMarkers('**x**', 2, 3, 'italic')).toBe(false)
    const result = applyInlineFormatToggle('*hello*', 1, 6, 'italic')
    expect(result.text).toBe('hello')
  })
})
