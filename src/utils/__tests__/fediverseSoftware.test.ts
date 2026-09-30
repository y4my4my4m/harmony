import { describe, it, expect } from 'vitest'
import { softwareDisplayName, instanceMonogram } from '@/utils/fediverseSoftware'

describe('softwareDisplayName', () => {
  it('maps NodeInfo ids to project spellings', () => {
    expect(softwareDisplayName('gotosocial')).toBe('GoToSocial')
    expect(softwareDisplayName('Mastodon')).toBe('Mastodon')
    expect(softwareDisplayName('peertube')).toBe('PeerTube')
  })

  it('returns unknown software unchanged and empty input as empty', () => {
    expect(softwareDisplayName('someNewThing')).toBe('someNewThing')
    expect(softwareDisplayName(undefined)).toBe('')
    expect(softwareDisplayName('  ')).toBe('')
  })
})

describe('instanceMonogram', () => {
  it('takes the first alphanumeric character, skipping www.', () => {
    expect(instanceMonogram('mastodon.social')).toBe('M')
    expect(instanceMonogram('www.example.org')).toBe('E')
    expect(instanceMonogram('3dp.chat')).toBe('3')
  })

  it('falls back to a question mark', () => {
    expect(instanceMonogram('')).toBe('?')
    expect(instanceMonogram(null)).toBe('?')
  })
})
