import { describe, it, expect, vi } from 'vitest'
import { routeMessageEvent } from '@/stores/shared/realtimeMessageEvent'

const handlers = () => ({
  onInsert: vi.fn(),
  onUpdate: vi.fn(),
  onDelete: vi.fn(),
})

describe('routeMessageEvent', () => {
  it('routes INSERT with the CDC envelope the store handlers expect', () => {
    const h = handlers()
    routeMessageEvent({ op: 'INSERT', new: { id: 'm1' }, old: null }, h)
    expect(h.onInsert).toHaveBeenCalledWith({ new: { id: 'm1' } })
    expect(h.onUpdate).not.toHaveBeenCalled()
    expect(h.onDelete).not.toHaveBeenCalled()
  })

  it('routes UPDATE with both new and old', () => {
    const h = handlers()
    routeMessageEvent({ op: 'UPDATE', new: { id: 'm1', is_deleted: true }, old: { id: 'm1' } }, h)
    expect(h.onUpdate).toHaveBeenCalledWith({ new: { id: 'm1', is_deleted: true }, old: { id: 'm1' } })
  })

  it('passes old: null on UPDATE when the payload omits it', () => {
    const h = handlers()
    routeMessageEvent({ op: 'UPDATE', new: { id: 'm1' } }, h)
    expect(h.onUpdate).toHaveBeenCalledWith({ new: { id: 'm1' }, old: null })
  })

  it('routes DELETE off the old row', () => {
    const h = handlers()
    routeMessageEvent({ op: 'DELETE', new: null, old: { id: 'm1' } }, h)
    expect(h.onDelete).toHaveBeenCalledWith({ old: { id: 'm1' } })
  })

  // The trigger sends `new` null on DELETE and `old` null on INSERT. A handler
  // invoked with the wrong half would dereference undefined.
  it('ignores an op whose row half is missing', () => {
    const h = handlers()
    routeMessageEvent({ op: 'INSERT', new: null }, h)
    routeMessageEvent({ op: 'DELETE', old: null }, h)
    routeMessageEvent({ op: 'UPDATE' }, h)
    expect(h.onInsert).not.toHaveBeenCalled()
    expect(h.onUpdate).not.toHaveBeenCalled()
    expect(h.onDelete).not.toHaveBeenCalled()
  })

  it('ignores malformed and unknown payloads', () => {
    const h = handlers()
    routeMessageEvent(null, h)
    routeMessageEvent(undefined, h)
    routeMessageEvent({}, h)
    routeMessageEvent({ op: 'TRUNCATE', new: { id: 'm1' } }, h)
    expect(h.onInsert).not.toHaveBeenCalled()
    expect(h.onUpdate).not.toHaveBeenCalled()
    expect(h.onDelete).not.toHaveBeenCalled()
  })
})
