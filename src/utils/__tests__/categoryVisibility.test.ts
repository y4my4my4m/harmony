import { describe, it, expect } from 'vitest'
import { categoryHiddenFromMembers, visibleCategories } from '@/utils/categoryVisibility'

const cats = [{ id: 'staff' }, { id: 'public' }, { id: 'general' }]
const channels = { general: [{ id: 'g1' }], staff: [] as { id: string }[] }

describe('visibleCategories', () => {
  it('shows a member only the categories holding a channel they see', () => {
    expect(visibleCategories(cats, channels, false).map(c => c.id)).toEqual(['general'])
  })

  it('shows a channel manager every category, empty ones included', () => {
    expect(visibleCategories(cats, channels, true).map(c => c.id)).toEqual(['staff', 'public', 'general'])
  })
})

describe('categoryHiddenFromMembers', () => {
  const privateIds = new Set(['p1', 'p2'])
  const isPrivate = (id: string) => privateIds.has(id)

  it('is true for an empty category', () => {
    expect(categoryHiddenFromMembers(undefined, isPrivate)).toBe(true)
    expect(categoryHiddenFromMembers([], isPrivate)).toBe(true)
  })

  it('is true when every channel is hidden from @everyone', () => {
    expect(categoryHiddenFromMembers([{ id: 'p1' }, { id: 'p2' }], isPrivate)).toBe(true)
  })

  it('is false with one channel open to @everyone', () => {
    expect(categoryHiddenFromMembers([{ id: 'p1' }, { id: 'open' }], isPrivate)).toBe(false)
  })
})
