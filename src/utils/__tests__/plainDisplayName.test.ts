import { describe, it, expect } from 'vitest'
import { plainDisplayName } from '@/utils/plainDisplayName'

describe('plainDisplayName', () => {
  it('drops custom emoji shortcodes, local, remote and zero-width wrapped', () => {
    expect(plainDisplayName(':blobcat: Alice :verified@remote.example:')).toBe('Alice')
    expect(plainDisplayName('\u200b:misskey@.:\u200bBob')).toBe('Bob')
  })

  it('keeps text that only looks like punctuation', () => {
    expect(plainDisplayName('Time: 10:30')).toBe('Time: 10:30')
  })

  it('joins part arrays and falls back when nothing is left', () => {
    expect(plainDisplayName(['Ca', { text: 'rol' }])).toBe('Carol')
    expect(plainDisplayName(':wave:', 'dave')).toBe('dave')
    expect(plainDisplayName(null, 'erin')).toBe('erin')
  })
})
