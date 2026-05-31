import { describe, it, expect } from 'vitest'
import {
  electKeyCoordinator,
  __voiceKeyBytesToBase64,
  __voiceKeyBase64ToBytes,
} from '../VoiceE2EEService'

describe('electKeyCoordinator', () => {
  it('returns null for an empty room', () => {
    expect(electKeyCoordinator([])).toBeNull()
  })

  it('returns the only member', () => {
    expect(electKeyCoordinator(['bob'])).toBe('bob')
  })

  it('picks the lexicographically smallest id deterministically', () => {
    expect(electKeyCoordinator(['charlie', 'alice', 'bob'])).toBe('alice')
  })

  it('is order-independent (same set, same coordinator)', () => {
    const a = electKeyCoordinator(['x', 'a', 'm'])
    const b = electKeyCoordinator(['m', 'x', 'a'])
    expect(a).toBe(b)
    expect(a).toBe('a')
  })

  it('does not mutate the input array', () => {
    const input = ['c', 'a', 'b']
    electKeyCoordinator(input)
    expect(input).toEqual(['c', 'a', 'b'])
  })

  it('handles UUID-style identities', () => {
    const ids = [
      'ffffffff-0000-0000-0000-000000000000',
      '00000000-1111-1111-1111-111111111111',
      'aaaaaaaa-2222-2222-2222-222222222222',
    ]
    expect(electKeyCoordinator(ids)).toBe('00000000-1111-1111-1111-111111111111')
  })
})

describe('voice key base64 round-trip', () => {
  it('round-trips a random 32-byte key exactly', () => {
    const key = crypto.getRandomValues(new Uint8Array(32))
    const restored = __voiceKeyBase64ToBytes(__voiceKeyBytesToBase64(key))
    expect(Array.from(restored)).toEqual(Array.from(key))
  })

  it('round-trips bytes with high values and zeros', () => {
    const key = new Uint8Array([0, 255, 1, 254, 128, 0, 0, 127])
    const restored = __voiceKeyBase64ToBytes(__voiceKeyBytesToBase64(key))
    expect(Array.from(restored)).toEqual(Array.from(key))
  })
})
