/**
 * The rows a jump loads: the page before the target through the paged loader,
 * which applies the READ_MESSAGE_HISTORY cutoff, and the target with the rows
 * after it, read from the target's own created_at.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const core = vi.hoisted(() => ({
  loadMessage: vi.fn(),
  loadMessagesFrom: vi.fn(),
  loadChannelMessages: vi.fn(),
  loadConversationMessages: vi.fn(),
}))

vi.mock('@/services/core', () => ({ coreMessageService: core }))
vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { MessageService } from '@/services/MessageService'
import { JUMP_AFTER, JUMP_BEFORE } from '@/utils/messageWindow'

const AT = '2026-10-01T00:40:00.123456+00:00'
const target = { id: 't', channel_id: 'c1', thread_id: null, created_at: AT }
const row = (id: string) => ({ id, channel_id: 'c1', created_at: AT })

describe('MessageService.loadMessageWindow', () => {
  const service = MessageService.getInstance()

  beforeEach(() => {
    Object.values(core).forEach(fn => fn.mockReset())
  })

  it('reads the page before the target and the rows from the target on, at its exact time', async () => {
    core.loadMessage.mockResolvedValueOnce(target)
    core.loadChannelMessages.mockResolvedValueOnce(Array.from({ length: JUMP_BEFORE }, (_, i) => row(`b${i}`)))
    core.loadMessagesFrom.mockResolvedValueOnce([target, row('a0')])

    const window = await service.loadMessageWindow({ channelId: 'c1' }, 't', { isRemote: false })

    expect(core.loadChannelMessages).toHaveBeenCalledWith('c1', { limit: JUMP_BEFORE, before: AT, isRemote: false })
    expect(core.loadMessagesFrom).toHaveBeenCalledWith({ channelId: 'c1' }, { from: AT, inclusive: true, limit: JUMP_AFTER + 1 })
    expect(window!.messages.map(m => m.id)).toEqual([...Array.from({ length: JUMP_BEFORE }, (_, i) => `b${i}`), 't', 'a0'])
    expect(window!.allOlderLoaded).toBe(false)
    expect(window!.hasNewer).toBe(false)
  })

  it('reads a conversation through its own loader', async () => {
    core.loadMessage.mockResolvedValueOnce({ id: 't', conversation_id: 'v1', created_at: AT })
    core.loadConversationMessages.mockResolvedValueOnce([])
    core.loadMessagesFrom.mockResolvedValueOnce([{ id: 't', conversation_id: 'v1', created_at: AT }])

    const window = await service.loadMessageWindow({ conversationId: 'v1' }, 't')

    expect(core.loadConversationMessages).toHaveBeenCalledWith('v1', { limit: JUMP_BEFORE, before: AT })
    expect(window!.allOlderLoaded).toBe(true)
  })

  it.each([
    ['missing or hidden by RLS', null],
    ['deleted', { ...target, is_deleted: true }],
    ['a thread reply', { ...target, thread_id: 'th1' }],
    ["another channel's", { ...target, channel_id: 'c2' }],
  ])('loads nothing around a target that is %s', async (_label, found) => {
    core.loadMessage.mockResolvedValueOnce(found)
    expect(await service.loadMessageWindow({ channelId: 'c1' }, 't')).toBeNull()
    expect(core.loadMessagesFrom).not.toHaveBeenCalled()
  })
})
