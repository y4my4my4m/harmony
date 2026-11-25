import { describe, it, expect, vi } from 'vitest'
import type { Message } from '@/types'
import { fillThreadGap } from '@/stores/useThreads'

vi.mock('@/services/ThreadService', () => ({ threadService: {} }))

const row = (id: string, at: string | Date): Message =>
  ({ id, created_at: at, user_id: 'u', content: [{ type: 'text', text: id }], thread_id: 't' } as unknown as Message)
const ids = (list: Message[]) => list.map(m => m.id)

describe('fillThreadGap', () => {
  it('reads after the newest stored reply, past an optimistic one, and keeps both', async () => {
    const list = [row('a', new Date('2026-11-01T00:00:00Z')), row('temp-1', new Date('2026-11-01T00:05:00Z'))]
    const read = vi.fn(async () => ({ messages: [row('b', '2026-11-01T00:01:00Z')], has_more: false }))
    const gap = await fillThreadGap(() => list, read)
    expect(read).toHaveBeenCalledWith({ after: '2026-11-01T00:00:00.000Z' })
    expect(ids(gap!.messages)).toEqual(['a', 'b', 'temp-1'])
    expect(ids(gap!.added)).toEqual(['b'])
    expect(gap!.hasMore).toBeUndefined()
  })

  it('replaces the stored rows with a full page and keeps a reply landed during the read', async () => {
    const list = [row('old', '2026-11-01T00:00:00Z')]
    const gap = await fillThreadGap(() => list, async () => {
      list.push(row('live', '2026-11-01T02:00:00Z'))
      return { messages: [row('p1', '2026-11-01T01:00:00Z'), row('p2', '2026-11-01T01:01:00Z')], has_more: true }
    })
    expect(ids(gap!.messages)).toEqual(['p1', 'p2', 'live'])
    expect(gap!.hasMore).toBe(true)
  })

  it('reads the newest page when nothing stored is shown', async () => {
    const read = vi.fn(async () => ({ messages: [row('p1', '2026-11-01T01:00:00Z')], has_more: false }))
    const gap = await fillThreadGap(() => [], read)
    expect(read).toHaveBeenCalledWith({ force: true })
    expect(ids(gap!.messages)).toEqual(['p1'])
  })

  it('lands nothing once the view shows another thread', async () => {
    const list = [row('a', '2026-11-01T00:00:00Z')]
    let current: Message[] | null = list
    const gap = await fillThreadGap(() => current, async () => {
      current = null
      return { messages: [row('b', '2026-11-01T00:01:00Z')], has_more: false }
    })
    expect(gap).toBeNull()
    expect(ids(list)).toEqual(['a'])
  })
})
