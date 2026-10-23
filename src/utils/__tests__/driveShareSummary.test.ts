import { describe, expect, it } from 'vitest'
import { driveShareSummary } from '../driveShareSummary'

const NOW = Date.parse('2026-10-23T00:00:00Z')
const link = (expires_at: string | null) => ({ scope: 'link', expires_at })
const user = { scope: 'user', expires_at: null }

describe('driveShareSummary', () => {
  it('reads a file with no share, or only an expired link, as private', () => {
    expect(driveShareSummary([], NOW)).toEqual({ kind: 'private' })
    expect(driveShareSummary([link('2026-10-22T00:00:00Z')], NOW)).toEqual({ kind: 'private' })
  })

  it('names a live link, people, and both', () => {
    expect(driveShareSummary([link(null)], NOW)).toEqual({ kind: 'link' })
    expect(driveShareSummary([link('2026-10-24T00:00:00Z')], NOW)).toEqual({ kind: 'link' })
    expect(driveShareSummary([user, user], NOW)).toEqual({ kind: 'people', others: 2 })
    expect(driveShareSummary([link(null), user], NOW)).toEqual({ kind: 'both', others: 1 })
    expect(driveShareSummary([link('2026-10-22T00:00:00Z'), user], NOW)).toEqual({ kind: 'people', others: 1 })
  })
})
