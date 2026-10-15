import { beforeEach, describe, expect, it } from 'vitest'
import { clearHistoryCutoffs, historyCutoff, recordHistoryCutoff } from '@/services/channelHistoryCutoff'

describe('channelHistoryCutoff', () => {
  beforeEach(() => clearHistoryCutoffs())

  it('keeps what get_message_page reported per channel', () => {
    recordHistoryCutoff('c1', '2026-10-15T10:00:00+00:00')
    recordHistoryCutoff('c2', null)
    expect(historyCutoff('c1')).toBe('2026-10-15T10:00:00+00:00')
    expect(historyCutoff('c2')).toBeNull()
    expect(historyCutoff('c3')).toBeNull()
    expect(historyCutoff(null)).toBeNull()
  })

  it('leaves a channel unchanged when a page carried no history_since', () => {
    recordHistoryCutoff('c1', '2026-10-15T10:00:00+00:00')
    recordHistoryCutoff('c1', undefined)
    expect(historyCutoff('c1')).toBe('2026-10-15T10:00:00+00:00')
    recordHistoryCutoff('c1', null)
    expect(historyCutoff('c1')).toBeNull()
  })
})
