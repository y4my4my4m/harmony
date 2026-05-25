import { describe, it, expect } from 'vitest'
import { generateBotToken, hashBotToken } from '@/utils/botUtils'

describe('botUtils', () => {
  describe('generateBotToken', () => {
    it('generates a token with the default prefix', () => {
      const token = generateBotToken()
      expect(token).toMatch(/^harmony_bot_[0-9a-f]{64}$/)
    })

    it('generates a token with a custom prefix', () => {
      const token = generateBotToken('custom_')
      expect(token.startsWith('custom_')).toBe(true)
    })

    it('generates unique tokens', () => {
      const token1 = generateBotToken()
      const token2 = generateBotToken()
      expect(token1).not.toBe(token2)
    })

    it('generates tokens of consistent length', () => {
      const token = generateBotToken()
      // "harmony_bot_" (12) + 64 hex chars = 76
      expect(token.length).toBe(12 + 64)
    })
  })

  describe('hashBotToken', () => {
    it('produces a 64-character hex hash', async () => {
      const hash = await hashBotToken('test-token')
      expect(hash).toMatch(/^[0-9a-f]{64}$/)
    })

    it('produces consistent hashes for same input', async () => {
      const hash1 = await hashBotToken('same-token')
      const hash2 = await hashBotToken('same-token')
      expect(hash1).toBe(hash2)
    })

    it('produces different hashes for different inputs', async () => {
      const hash1 = await hashBotToken('token-a')
      const hash2 = await hashBotToken('token-b')
      expect(hash1).not.toBe(hash2)
    })
  })
})
