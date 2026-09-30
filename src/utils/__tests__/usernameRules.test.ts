import { describe, it, expect } from 'vitest'
import { normalizeUsernameInput } from '@/utils/usernameRules'

describe('normalizeUsernameInput', () => {
  it('lowercases and strips characters outside a-z0-9_', () => {
    expect(normalizeUsernameInput('Jane.Doe-99')).toBe('janedoe99')
  })

  it('caps the length at 24', () => {
    expect(normalizeUsernameInput('a'.repeat(40))).toHaveLength(24)
  })

  it('returns an empty string for non-strings', () => {
    expect(normalizeUsernameInput(undefined)).toBe('')
  })
})
