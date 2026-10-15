/**
 * READ_MESSAGE_HISTORY as Discord: the newest page of a channel that withholds it starts this
 * session's view (begin_channel_history_view) and reads from its start. Older pages and later
 * opens in the same session start nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/supabase', () => ({ supabase: { rpc } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/AuthContextService', () => ({ authContextService: {} }))
vi.mock('@/services/userDataService', () => ({ userDataService: {} }))

import { CoreMessageService } from '@/services/core/CoreMessageService'
import { clearHistoryCutoffs, historyCutoff, historyViewBegun, recordHistoryCutoff } from '@/services/channelHistoryCutoff'

const START = '2026-10-15T12:00:00+00:00'
const page = (since: string | null, ids: string[] = []) => ({
  data: { messages: ids.map(id => ({ id })), reactions: [], history_since: since },
  error: null,
})
const load = (params: { channelId?: string; conversationId?: string; limit: number; before?: string }) =>
  (CoreMessageService.getInstance() as unknown as {
    tryLoadMessagePage: (p: typeof params) => Promise<{ messages: Array<{ id: string }> } | null>
  }).tryLoadMessagePage(params)
const calls = () => rpc.mock.calls.map(c => c[0])

describe('CoreMessageService history view', () => {
  beforeEach(() => {
    rpc.mockReset()
    clearHistoryCutoffs()
  })

  it('a channel that reads its history loads one page and starts no view', async () => {
    rpc.mockResolvedValueOnce(page(null, ['m1']))
    const result = await load({ channelId: 'c1', limit: 50 })
    expect(calls()).toEqual(['get_message_page'])
    expect(result!.messages.map(m => m.id)).toEqual(['m1'])
    expect(historyViewBegun('c1')).toBe(false)
  })

  it('a first page reporting a cutoff starts the view and reads again', async () => {
    rpc
      .mockResolvedValueOnce(page('infinity'))
      .mockResolvedValueOnce({ data: START, error: null })
      .mockResolvedValueOnce(page(START, ['m2']))
    const result = await load({ channelId: 'c1', limit: 50 })
    expect(calls()).toEqual(['get_message_page', 'begin_channel_history_view', 'get_message_page'])
    expect(result!.messages.map(m => m.id)).toEqual(['m2'])
    expect(historyCutoff('c1')).toBe(START)
  })

  it('a known cutoff starts the view before the first read', async () => {
    recordHistoryCutoff('c1', 'infinity')
    rpc.mockResolvedValueOnce({ data: START, error: null }).mockResolvedValueOnce(page(START, ['m3']))
    await load({ channelId: 'c1', limit: 50 })
    expect(calls()).toEqual(['begin_channel_history_view', 'get_message_page'])
  })

  it('later opens and older pages in the same session start nothing', async () => {
    rpc
      .mockResolvedValueOnce(page('infinity'))
      .mockResolvedValueOnce({ data: START, error: null })
      .mockResolvedValueOnce(page(START))
    await load({ channelId: 'c1', limit: 50 })
    rpc.mockReset()
    rpc.mockResolvedValueOnce(page(START, ['m4'])).mockResolvedValueOnce(page(START))
    await load({ channelId: 'c1', limit: 50 })
    await load({ channelId: 'c1', limit: 50, before: START })
    expect(calls()).toEqual(['get_message_page', 'get_message_page'])
  })

  it('an older page never starts a view', async () => {
    rpc.mockResolvedValueOnce(page('infinity'))
    await load({ channelId: 'c1', limit: 50, before: START })
    expect(calls()).toEqual(['get_message_page'])
    expect(historyCutoff('c1')).toBe('infinity')
  })

  it('a failed start keeps the page it read', async () => {
    rpc.mockResolvedValueOnce(page('infinity')).mockResolvedValueOnce({ data: null, error: { message: 'boom' } })
    const result = await load({ channelId: 'c1', limit: 50 })
    expect(calls()).toEqual(['get_message_page', 'begin_channel_history_view'])
    expect(result!.messages).toEqual([])
  })

  it('a conversation never starts a view', async () => {
    rpc.mockResolvedValueOnce(page(null, ['d1']))
    await load({ conversationId: 'v1', limit: 50 })
    expect(calls()).toEqual(['get_message_page'])
  })
})
