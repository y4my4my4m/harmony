import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import en from '@/locales/en.json'
import Icon from '@/components/common/Icon.vue'
import {
  SERVER_CATEGORIES,
  buildServerSearchFilter,
  categoryIcon,
  categoryLabelKey,
  escapeLikePattern,
  inferServerCategory,
  isServerCategory,
  normalizeSearchTerm,
  resolveServerCategory,
  reuseUnchangedRows,
  MAX_SEARCH_TERM_LENGTH,
} from '../serverDiscovery'

describe('inferServerCategory', () => {
  it('matches whole words only', () => {
    expect(inferServerCategory('Main Hall', 'A place to paint')).toBe('other')
    expect(inferServerCategory('Artemis', null)).toBe('other')
    expect(inferServerCategory('Showcase', 'Fun times')).toBe('other')
  })

  it('matches keywords regardless of case and punctuation', () => {
    expect(inferServerCategory('AI Lab')).toBe('technology')
    expect(inferServerCategory('The Pixel Den', 'Indie games, speedruns & chill')).toBe('gaming')
    expect(inferServerCategory('Studio', 'digital-art / illustration')).toBe('art_design')
  })

  it('uses category order to break ties', () => {
    expect(inferServerCategory('Gaming community')).toBe('gaming')
    expect(inferServerCategory('Friends of Physics')).toBe('community')
  })

  it('reads the description when the name has no keyword', () => {
    expect(inferServerCategory('Harmony HQ', 'Weekly football talk')).toBe('sports')
  })

  it('only returns ids from SERVER_CATEGORIES', () => {
    for (const name of ['Main Hall', 'AI Lab', 'Jazz Night', 'Physics Club', 'Gym rats']) {
      expect(SERVER_CATEGORIES).toContain(inferServerCategory(name))
    }
  })
})

describe('resolveServerCategory', () => {
  it('uses the chosen category over the inferred one', () => {
    expect(resolveServerCategory({ name: 'Minecraft Club', description: null, category: 'music' }))
      .toBe('music')
  })

  it('keeps a chosen "other" instead of inferring', () => {
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'other' })).toBe('other')
  })

  it('infers when no category is chosen', () => {
    expect(resolveServerCategory({ name: 'Minecraft Club', category: null })).toBe('gaming')
    expect(resolveServerCategory({ name: 'Minecraft Club' })).toBe('gaming')
    expect(resolveServerCategory({ name: 'Harmony HQ', description: 'Weekly football talk' }))
      .toBe('sports')
  })

  it('infers when the stored value is not a category id', () => {
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'Music' })).toBe('gaming')
    expect(resolveServerCategory({ name: 'Minecraft Club', category: '' })).toBe('gaming')
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'toString' })).toBe('gaming')
  })

  it('ignores the category of a remote server', () => {
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'music', is_local_server: false }))
      .toBe('gaming')
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'music', is_local_server: true }))
      .toBe('music')
    expect(resolveServerCategory({ name: 'Minecraft Club', category: 'music', is_local_server: null }))
      .toBe('music')
  })
})

describe('category ids', () => {
  // Mirrors servers_category_check in db_schema/migrations/20261006400001_server_category.sql.
  it('match the database CHECK', () => {
    expect([...SERVER_CATEGORIES]).toEqual([
      'gaming', 'technology', 'art_design', 'music', 'education',
      'entertainment', 'community', 'science', 'sports', 'other',
    ])
  })

  it('are recognised by isServerCategory and nothing else is', () => {
    for (const id of SERVER_CATEGORIES) expect(isServerCategory(id)).toBe(true)
    for (const value of ['Gaming', 'Art & Design', '', 'constructor', null, undefined, 3]) {
      expect(isServerCategory(value)).toBe(false)
    }
  })

  it.each([...SERVER_CATEGORIES])('%s has an English label', (id) => {
    const key = categoryLabelKey(id)
    expect(key).toMatch(/^server\./)
    const label = (en.server as Record<string, unknown>)[key!.slice('server.'.length)]
    expect(typeof label).toBe('string')
    expect((label as string).length).toBeGreaterThan(0)
  })

  it.each([...SERVER_CATEGORIES])('%s has an icon the Icon component draws', (id) => {
    const name = categoryIcon(id)
    expect(name).toBeTruthy()
    const wrapper = mount(Icon, { props: { name: name! } })
    expect(wrapper.find('svg.lucide').exists()).toBe(true)
  })

  it('has no label or icon for unknown ids', () => {
    expect(categoryLabelKey('Gaming')).toBeNull()
    expect(categoryIcon('Gaming')).toBeNull()
  })
})

describe('normalizeSearchTerm', () => {
  it('collapses whitespace and trims', () => {
    expect(normalizeSearchTerm('  foo \n\t bar  ')).toBe('foo bar')
  })

  it('caps length', () => {
    expect(normalizeSearchTerm('x'.repeat(500))).toHaveLength(MAX_SEARCH_TERM_LENGTH)
  })
})

describe('escapeLikePattern', () => {
  it('escapes LIKE metacharacters and the escape character', () => {
    expect(escapeLikePattern('100%_off\\')).toBe('100\\%\\_off\\\\')
  })

  it('leaves ordinary text untouched', () => {
    expect(escapeLikePattern('hello world')).toBe('hello world')
  })
})

describe('buildServerSearchFilter', () => {
  it('returns null for blank input', () => {
    expect(buildServerSearchFilter('   ')).toBeNull()
  })

  it('quotes the pattern for both columns', () => {
    expect(buildServerSearchFilter('rust')).toBe(
      'name.ilike."%rust%",description.ilike."%rust%"',
    )
  })

  it('keeps PostgREST reserved characters inside quotes', () => {
    const filter = buildServerSearchFilter('a,b.c:(d)')!
    expect(filter).toBe('name.ilike."%a,b.c:(d)%",description.ilike."%a,b.c:(d)%"')
  })

  it('escapes quotes and backslashes for the quoted value', () => {
    // LIKE escape doubles the backslash, quoting doubles it again.
    expect(buildServerSearchFilter('say "hi" \\o/')).toBe(
      'name.ilike."%say \\"hi\\" \\\\\\\\o/%",description.ilike."%say \\"hi\\" \\\\\\\\o/%"',
    )
  })

  it('escapes % and _ so they match literally', () => {
    expect(buildServerSearchFilter('50%_')).toBe(
      'name.ilike."%50\\\\%\\\\_%",description.ilike."%50\\\\%\\\\_%"',
    )
  })

  it('maps * to the single-character wildcard', () => {
    expect(buildServerSearchFilter('a*b')).toBe('name.ilike."%a_b%",description.ilike."%a_b%"')
  })
})

describe('reuseUnchangedRows', () => {
  const row = (id: string, name = id, extra: Record<string, unknown> = {}) => ({ id, name, member_count: 1, ...extra })

  it('returns prev itself when every row is equal and in order', () => {
    const prev = [row('a'), row('b')]
    expect(reuseUnchangedRows(prev, [row('a'), row('b')])).toBe(prev)
  })

  it('keeps unchanged objects and takes changed ones from next', () => {
    const prev = [row('a'), row('b')]
    const next = [row('a'), row('b', 'renamed')]
    const merged = reuseUnchangedRows(prev, next)
    expect(merged).not.toBe(prev)
    expect(merged[0]).toBe(prev[0])
    expect(merged[1]).toBe(next[1])
  })

  it('follows the order of next and drops rows absent from it', () => {
    const prev = [row('a'), row('b'), row('c')]
    const merged = reuseUnchangedRows(prev, [row('c'), row('a')])
    expect(merged).toEqual([row('c'), row('a')])
    expect(merged[0]).toBe(prev[2])
    expect(merged[1]).toBe(prev[0])
  })

  it('treats an added row as a change', () => {
    const prev = [row('a')]
    const next = [row('new'), row('a')]
    const merged = reuseUnchangedRows(prev, next)
    expect(merged).toHaveLength(2)
    expect(merged[0]).toBe(next[0])
    expect(merged[1]).toBe(prev[0])
  })

  it('compares key sets, not only values', () => {
    const prev = [{ id: 'a', x: undefined } as { id: string; x?: number; y?: number }]
    const next = [{ id: 'a', y: undefined } as { id: string; x?: number; y?: number }]
    expect(reuseUnchangedRows(prev, next)[0]).toBe(next[0])
  })

  it('reuses nothing from an empty prev', () => {
    const next = [row('a')]
    expect(reuseUnchangedRows([], next)).toEqual(next)
  })
})
