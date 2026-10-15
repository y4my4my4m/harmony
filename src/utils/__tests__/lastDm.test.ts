import { beforeEach, describe, expect, it } from 'vitest'
import { dmButtonTarget, forgetLastDm, lastDm, rememberLastDm } from '../lastDm'

beforeEach(() => localStorage.clear())

describe('last DM memory', () => {
  it('keeps one conversation per account', () => {
    rememberLastDm('me', 'c1')
    rememberLastDm('me', 'c2')
    rememberLastDm('other', 'c9')
    expect(lastDm('me')).toBe('c2')
    expect(lastDm('other')).toBe('c9')
    forgetLastDm('me')
    expect(lastDm('me')).toBeNull()
    expect(lastDm(null)).toBeNull()
  })
})

describe('dmButtonTarget', () => {
  const base = { inDms: false, mobile: false, last: 'c2', known: ['c1', 'c2'] }

  it('returns to the last opened conversation from a channel', () => {
    expect(dmButtonTarget(base)).toEqual({ conversationId: 'c2' })
    expect(dmButtonTarget({ ...base, known: null })).toEqual({ conversationId: 'c2' })
  })

  it('shows the list when already in DMs, on a phone, with no memory or a conversation gone from the list', () => {
    expect(dmButtonTarget({ ...base, inDms: true })).toBe('list')
    expect(dmButtonTarget({ ...base, mobile: true })).toBe('list')
    expect(dmButtonTarget({ ...base, last: null })).toBe('list')
    expect(dmButtonTarget({ ...base, known: ['c1'] })).toBe('list')
  })
})
