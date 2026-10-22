import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SEND_STALL_MS,
  SendLookupFailedError,
  SendStalledError,
  discardStalledRow,
  findStalledRowMessage,
  insertWithDeadline,
  onStalledRowStored,
  resetStalledSends,
} from '@/stores/shared/stalledSends'

interface Msg { id: string }

function deferred() {
  let resolve!: (m: Msg) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<Msg>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

const handlers = () => ({ landed: vi.fn(), unwanted: vi.fn() })

beforeEach(() => {
  vi.useFakeTimers()
  resetStalledSends()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('insertWithDeadline', () => {
  it('resolves with an answer in time and records nothing', async () => {
    const insert = deferred()
    const h = handlers()
    const sent = insertWithDeadline('temp-1', insert.promise, h)
    insert.resolve({ id: 'a' })
    await expect(sent).resolves.toEqual({ id: 'a' })
    expect(h.unwanted).not.toHaveBeenCalled()
    expect(await findStalledRowMessage('temp-1', async () => ({ id: 'x' }))).toBeNull()
  })

  it('passes an error in time through', async () => {
    const insert = deferred()
    const sent = insertWithDeadline('temp-1', insert.promise, handlers())
    insert.reject(new Error('500'))
    await expect(sent).rejects.toThrow('500')
  })

  it('rejects with SendStalledError at the deadline; the late message lands as the row', async () => {
    const insert = deferred()
    const h = handlers()
    const stored = vi.fn()
    onStalledRowStored(stored)
    const sent = insertWithDeadline('temp-1', insert.promise, h)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(sent).rejects.toBeInstanceOf(SendStalledError)

    insert.resolve({ id: 'late' })
    await vi.waitFor(() => expect(h.landed).toHaveBeenCalledWith({ id: 'late' }))
    expect(h.unwanted).not.toHaveBeenCalled()
    expect(stored).toHaveBeenCalledWith('temp-1')
  })

  it('a late error after the deadline is ignored', async () => {
    const insert = deferred()
    const h = handlers()
    const sent = insertWithDeadline('temp-1', insert.promise, h)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(sent).rejects.toBeInstanceOf(SendStalledError)
    insert.reject(new Error('reset'))
    await Promise.resolve()
    expect(h.landed).not.toHaveBeenCalled()
    expect(h.unwanted).not.toHaveBeenCalled()
  })

  it('the stalled insert landing after a re-send stored the message is unwanted', async () => {
    const first = deferred()
    const h1 = handlers()
    const stalled = insertWithDeadline('temp-1', first.promise, h1)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)

    const second = deferred()
    const h2 = handlers()
    const resent = insertWithDeadline('temp-1', second.promise, h2)
    second.resolve({ id: 'b' })
    await expect(resent).resolves.toEqual({ id: 'b' })
    expect(h2.unwanted).not.toHaveBeenCalled()

    first.resolve({ id: 'a' })
    await vi.waitFor(() => expect(h1.unwanted).toHaveBeenCalledWith({ id: 'a' }))
    expect(h1.landed).not.toHaveBeenCalled()
  })

  it('a re-send answered after the stalled insert landed is unwanted, and still returned', async () => {
    const first = deferred()
    const h1 = handlers()
    const stalled = insertWithDeadline('temp-1', first.promise, h1)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)

    const second = deferred()
    const h2 = handlers()
    const resent = insertWithDeadline('temp-1', second.promise, h2)
    first.resolve({ id: 'a' })
    await vi.waitFor(() => expect(h1.landed).toHaveBeenCalledWith({ id: 'a' }))
    second.resolve({ id: 'b' })
    await expect(resent).resolves.toEqual({ id: 'b' })
    expect(h2.unwanted).toHaveBeenCalledWith({ id: 'b' })
  })

  it('a stalled insert landing after its row was deleted is unwanted', async () => {
    const insert = deferred()
    const h = handlers()
    const sent = insertWithDeadline('temp-1', insert.promise, h)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(sent).rejects.toBeInstanceOf(SendStalledError)
    discardStalledRow('temp-1')
    insert.resolve({ id: 'late' })
    await vi.waitFor(() => expect(h.unwanted).toHaveBeenCalledWith({ id: 'late' }))
    expect(h.landed).not.toHaveBeenCalled()
  })

  it('rows are independent', async () => {
    const stalled = insertWithDeadline('temp-1', deferred().promise, handlers())
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)
    const other = handlers()
    await expect(insertWithDeadline('temp-2', Promise.resolve({ id: 'c' }), other)).resolves.toEqual({ id: 'c' })
    expect(other.unwanted).not.toHaveBeenCalled()
  })
})

describe('findStalledRowMessage', () => {
  it('looks a stalled row up and keeps what it finds as the row', async () => {
    const first = deferred()
    const h = handlers()
    const stalled = insertWithDeadline('temp-1', first.promise, h)
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)

    const lookup = vi.fn(async () => ({ id: 'a' }))
    await expect(findStalledRowMessage('temp-1', lookup)).resolves.toEqual({ id: 'a' })
    // The stalled insert's answer for the same message is not a second copy.
    first.resolve({ id: 'a' })
    await vi.waitFor(() => expect(h.landed).toHaveBeenCalledWith({ id: 'a' }))
    expect(h.unwanted).not.toHaveBeenCalled()
  })

  it('skips the lookup for a row that never stalled', async () => {
    const lookup = vi.fn(async () => ({ id: 'a' }))
    await expect(findStalledRowMessage('temp-9', lookup)).resolves.toBeNull()
    expect(lookup).not.toHaveBeenCalled()
  })

  it('rejects with SendStalledError when the lookup gets no answer', async () => {
    const stalled = insertWithDeadline('temp-1', deferred().promise, handlers())
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)
    const found = findStalledRowMessage('temp-1', () => new Promise<Msg | null>(() => {}))
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(found).rejects.toBeInstanceOf(SendStalledError)
  })

  it('rejects with SendLookupFailedError when the lookup fails', async () => {
    const stalled = insertWithDeadline('temp-1', deferred().promise, handlers())
    vi.advanceTimersByTime(SEND_STALL_MS)
    await expect(stalled).rejects.toBeInstanceOf(SendStalledError)
    const found = findStalledRowMessage('temp-1', async () => { throw new Error('fetch failed') })
    await expect(found).rejects.toBeInstanceOf(SendLookupFailedError)
    await expect(found).rejects.toThrow('fetch failed')
  })
})
