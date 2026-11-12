import { describe, it, expect } from 'vitest'
import { parseThreadSidebarMode, sidebarThreads } from '../threadSidebar'

const t = (id: string, extra: { is_member?: boolean; left?: boolean } = {}) => ({ id, ...extra })

describe('sidebarThreads', () => {
  it('all mode keeps every thread except left ones', () => {
    const threads = [t('a', { is_member: true }), t('b'), t('c', { left: true })]
    expect(sidebarThreads(threads, 'all', null).map(x => x.id)).toEqual(['a', 'b'])
  })

  it('joined mode keeps member threads only', () => {
    const threads = [t('a', { is_member: true }), t('b', { is_member: false }), t('c'), t('d', { is_member: true, left: true })]
    expect(sidebarThreads(threads, 'joined', null).map(x => x.id)).toEqual(['a', 'd'])
  })

  it('keeps the open thread, drops it once closed', () => {
    const threads = [t('a', { is_member: true }), t('b', { is_member: false })]
    expect(sidebarThreads(threads, 'joined', 'b').map(x => x.id)).toEqual(['a', 'b'])
    expect(sidebarThreads(threads, 'joined', null).map(x => x.id)).toEqual(['a'])
    expect(sidebarThreads(threads, 'joined', 'zzz').map(x => x.id)).toEqual(['a'])
  })
})

describe('parseThreadSidebarMode', () => {
  it('reads joined as a string or JSON string', () => {
    expect(parseThreadSidebarMode('joined')).toBe('joined')
    expect(parseThreadSidebarMode('"joined"')).toBe('joined')
  })
  it('reads anything else as all', () => {
    for (const v of [undefined, 'all', 'x', false, null]) expect(parseThreadSidebarMode(v)).toBe('all')
  })
})
