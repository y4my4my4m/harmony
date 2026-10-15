import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import {
  beginHistoryView,
  clearHistoryCutoffs,
  historyCutoff,
  historyViewBegun,
  recordHistoryCutoff,
} from '@/services/channelHistoryCutoff'

describe('channelHistoryCutoff', () => {
  beforeEach(() => {
    rpc.mockReset()
    clearHistoryCutoffs()
  })

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

  it('starts a view once the server returns its start, and forgets it on sign-out', async () => {
    rpc.mockResolvedValueOnce({ data: '2026-10-15T12:00:00+00:00', error: null })
    expect(await beginHistoryView('c1')).toBe(true)
    expect(rpc).toHaveBeenCalledWith('begin_channel_history_view', { p_channel_id: 'c1' })
    expect(historyViewBegun('c1')).toBe(true)
    expect(historyCutoff('c1')).toBe('2026-10-15T12:00:00+00:00')
    clearHistoryCutoffs()
    expect(historyViewBegun('c1')).toBe(false)
  })

  it('starts nothing where the channel reads its history or the call fails', async () => {
    rpc.mockResolvedValueOnce({ data: null, error: null })
    expect(await beginHistoryView('c1')).toBe(false)
    rpc.mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    expect(await beginHistoryView('c2')).toBe(false)
    rpc.mockRejectedValueOnce(new Error('offline'))
    expect(await beginHistoryView('c3')).toBe(false)
    expect(['c1', 'c2', 'c3'].some(historyViewBegun)).toBe(false)
  })
})
