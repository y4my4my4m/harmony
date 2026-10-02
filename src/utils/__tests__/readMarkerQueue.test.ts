import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createReadMarkerQueue, type QueuedRead } from '../readMarkerQueue'

const read = (messageId: string, createdAt: number, channelId: string | null, conversationId: string | null = null): QueuedRead =>
  ({ messageId, createdAt, channelId, conversationId })

describe('createReadMarkerQueue', () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it('sends only the newest read of a burst, after the delay', () => {
    const send = vi.fn(async () => {})
    const q = createReadMarkerQueue(send, 500)
    q.queue(read('m2', 2, 'c1'))
    q.queue(read('m1', 1, 'c1'))
    q.queue(read('m3', 3, 'c1'))
    vi.advanceTimersByTime(499)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(read('m3', 3, 'c1'))
  })

  it('sends a pending read for its own channel when another channel queues', () => {
    const send = vi.fn(async () => {})
    const q = createReadMarkerQueue(send, 500)
    q.queue(read('a1', 10, 'c1'))
    vi.advanceTimersByTime(100)
    q.queue(read('b1', 5, 'c2'))
    expect(send).toHaveBeenCalledWith(read('a1', 10, 'c1'))
    vi.advanceTimersByTime(500)
    expect(send).toHaveBeenLastCalledWith(read('b1', 5, 'c2'))
    expect(send).toHaveBeenCalledTimes(2)
  })

  it('treats a conversation as its own target', () => {
    const send = vi.fn(async () => {})
    const q = createReadMarkerQueue(send, 500)
    q.queue(read('a1', 1, null, 'd1'))
    q.queue(read('b1', 2, null, 'd2'))
    expect(send).toHaveBeenCalledWith(read('a1', 1, null, 'd1'))
  })

  it('flush sends at once and cancels the timer', async () => {
    const send = vi.fn(async () => {})
    const q = createReadMarkerQueue(send, 500)
    q.queue(read('m1', 1, 'c1'))
    await q.flush()
    expect(send).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1000)
    expect(send).toHaveBeenCalledTimes(1)
    await q.flush()
    expect(send).toHaveBeenCalledTimes(1)
  })
})
