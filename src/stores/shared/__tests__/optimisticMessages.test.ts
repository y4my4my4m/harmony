import { describe, it, expect } from 'vitest'
import {
  getRandomId,
  createTempMessageId,
  isOptimisticId,
  findOptimisticMatchIndex,
} from '../optimisticMessages'

describe('optimistic message helpers', () => {
  describe('createTempMessageId / isOptimisticId', () => {
    it('mints temp ids that are detected as optimistic', () => {
      const id = createTempMessageId()
      expect(id.startsWith('temp-')).toBe(true)
      expect(isOptimisticId(id)).toBe(true)
    })

    it('does not flag persisted (uuid-like) ids as optimistic', () => {
      expect(isOptimisticId('a1b2c3d4-e5f6-7890-abcd-ef1234567890')).toBe(false)
      expect(isOptimisticId(undefined)).toBe(false)
      expect(isOptimisticId(null)).toBe(false)
    })

    it('mints unique ids even when called in the same tick', () => {
      const ids = new Set(Array.from({ length: 100 }, () => createTempMessageId()))
      expect(ids.size).toBe(100)
    })

    it('getRandomId never returns an empty string', () => {
      expect(getRandomId().length).toBeGreaterThan(0)
    })
  })

  describe('findOptimisticMatchIndex', () => {
    it('matches on client_nonce first (survives encryption / content mismatch)', () => {
      const messages = [
        { id: 'temp-1', user_id: 'p1', content: [{ text: 'plaintext' }], metadata: { client_nonce: 'n1' } },
      ]
      // Incoming row holds ciphertext content but echoes the same nonce.
      const incoming = { user_id: 'p1', content: [{ text: 'CIPHER' }], metadata: { client_nonce: 'n1' } }
      expect(findOptimisticMatchIndex(messages, incoming)).toBe(0)
    })

    it('falls back to user_id + content when there is no nonce', () => {
      const messages = [
        { id: 'temp-1', user_id: 'p1', content: [{ text: 'hi' }] },
      ]
      const incoming = { user_id: 'p1', content: [{ text: 'hi' }] }
      expect(findOptimisticMatchIndex(messages, incoming)).toBe(0)
    })

    it('does not match a different user even with identical content', () => {
      const messages = [
        { id: 'temp-1', user_id: 'p1', content: [{ text: 'hi' }] },
      ]
      const incoming = { user_id: 'p2', content: [{ text: 'hi' }] }
      expect(findOptimisticMatchIndex(messages, incoming)).toBe(-1)
    })

    it('ignores already-persisted rows (only matches temp- ids)', () => {
      const messages = [
        { id: 'real-uuid', user_id: 'p1', content: [{ text: 'hi' }], metadata: { client_nonce: 'n1' } },
      ]
      const incoming = { user_id: 'p1', content: [{ text: 'hi' }], metadata: { client_nonce: 'n1' } }
      expect(findOptimisticMatchIndex(messages, incoming)).toBe(-1)
    })

    it('returns -1 when nothing matches', () => {
      const messages = [
        { id: 'temp-1', user_id: 'p1', content: [{ text: 'a' }], metadata: { client_nonce: 'n1' } },
      ]
      const incoming = { user_id: 'p1', content: [{ text: 'b' }], metadata: { client_nonce: 'n2' } }
      expect(findOptimisticMatchIndex(messages, incoming)).toBe(-1)
    })
  })
})
