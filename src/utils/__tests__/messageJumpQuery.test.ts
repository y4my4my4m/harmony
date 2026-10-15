import { describe, expect, it, vi } from 'vitest'
import type { RouteLocationNormalizedLoaded, Router } from 'vue-router'
import { readJumpTarget, takeJumpTarget, withoutJumpTarget } from '../messageJumpQuery'

describe('readJumpTarget', () => {
  it('reads the message and the search terms', () => {
    expect(readJumpTarget({ messageId: 'm1', searchQuery: 'cat pics' })).toEqual({ messageId: 'm1', searchQuery: 'cat pics' })
    expect(readJumpTarget({ messageId: 'm1' })).toEqual({ messageId: 'm1' })
    expect(readJumpTarget({ messageId: 'm1', searchQuery: '' })).toEqual({ messageId: 'm1' })
  })

  it('ignores a missing, empty or repeated messageId', () => {
    expect(readJumpTarget({})).toBeNull()
    expect(readJumpTarget({ messageId: '' })).toBeNull()
    expect(readJumpTarget({ messageId: ['m1', 'm2'] })).toBeNull()
  })
})

describe('withoutJumpTarget', () => {
  it('keeps every other parameter', () => {
    expect(withoutJumpTarget({ messageId: 'm1', searchQuery: 'x', tab: 'files' })).toEqual({ tab: 'files' })
  })
})

describe('takeJumpTarget', () => {
  it('returns the target and replaces the URL without it', () => {
    const replace = vi.fn().mockResolvedValue(undefined)
    const route = { query: { messageId: 'm1', searchQuery: 'x', tab: 'files' } } as unknown as RouteLocationNormalizedLoaded
    expect(takeJumpTarget(route, { replace } as unknown as Router)).toEqual({ messageId: 'm1', searchQuery: 'x' })
    expect(replace).toHaveBeenCalledWith({ query: { tab: 'files' } })
  })

  it('leaves the URL alone when there is no target', () => {
    const replace = vi.fn()
    const route = { query: { tab: 'files' } } as unknown as RouteLocationNormalizedLoaded
    expect(takeJumpTarget(route, { replace } as unknown as Router)).toBeNull()
    expect(replace).not.toHaveBeenCalled()
  })
})
