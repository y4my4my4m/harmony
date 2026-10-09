import { describe, it, expect, beforeEach } from 'vitest'
import { isEmbedHidden, setEmbedHidden } from '../hiddenEmbeds'

describe('hiddenEmbeds', () => {
  beforeEach(() => localStorage.clear())

  it('remembers a hidden embed per message and url', () => {
    expect(isEmbedHidden('m1', 'https://a')).toBe(false)
    setEmbedHidden('m1', 'https://a', true)
    expect(isEmbedHidden('m1', 'https://a')).toBe(true)
    expect(isEmbedHidden('m2', 'https://a')).toBe(false)
    setEmbedHidden('m1', 'https://a', false)
    expect(isEmbedHidden('m1', 'https://a')).toBe(false)
  })

  it('keeps the newest 500 entries', () => {
    for (let i = 0; i < 510; i++) setEmbedHidden(`m${i}`, 'https://a', true)
    expect(isEmbedHidden('m0', 'https://a')).toBe(false)
    expect(isEmbedHidden('m509', 'https://a')).toBe(true)
  })
})
