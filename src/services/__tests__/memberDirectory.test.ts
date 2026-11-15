import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The member list of the open server: which mode a server opens in, what each mode reads,
// and that a server which is not open is never read.

const h = vi.hoisted(() => {
  const events = new EventTarget()
  return {
    events,
    capability: true,
    available: true,
    /** Members per server; ids m0..m(n-1), the first `online` of them present. */
    servers: {} as Record<string, { total: number; online: number }>,
    pages: [] as Array<{ serverId: string; offset: number; limit: number; query: string | null }>,
    searches: [] as Array<{ serverId: string; query: string }>,
    legacyReads: [] as string[],
    primed: [] as string[][],
    contexts: new Map<string, { ids: string[]; options: any }>(),
    roles: [] as string[],
    /** Error the next page reads throw; null for none. */
    pageError: null as null | { code?: string; message: string },
    /** Unsubscribes wait for this to resolve. */
    unsubscribeGate: null as null | Promise<void>,
    /** What the instance says of the open server's list. */
    live: true,
    maxAgeMs: 0,
  }
})

const member = (n: number, online: boolean) => ({
  id: `m${n}`, group: online ? 'online' : 'offline', username: `user${n}`, display_name: `User ${n}`,
  online, presence_status: online ? 1 : 0, is_mobile: false, role_ids: [],
})

vi.mock('@/services/instanceCapabilities', () => ({ hasCapability: () => h.capability }))
vi.mock('@/services/memberDirectoryService', () => ({
  memberDirectoryAvailable: () => h.available,
  fetchMemberPage: vi.fn(async (serverId: string, offset: number, limit: number, query?: string | null) => {
    if (!h.available) return null
    h.pages.push({ serverId, offset, limit, query: query ?? null })
    if (h.pageError) throw h.pageError
    const server = h.servers[serverId]
    // A query matches every tenth member.
    const all = Array.from({ length: server.total }, (_, i) => i).filter(i => !query || i % 10 === 0)
    const online = all.filter(i => i < server.online).length
    return {
      total: all.length,
      offset,
      groups: [{ key: 'online', count: online }, { key: 'offline', count: all.length - online }].filter(g => g.count > 0),
      members: all.slice(offset, offset + limit).map(i => member(i, i < server.online)),
      live: h.live,
      maxAgeMs: h.maxAgeMs,
    }
  }),
  searchServerMembers: vi.fn(async (serverId: string, query: string) => {
    if (!h.available) return null
    h.searches.push({ serverId, query })
    return [member(1234, false)]
  }),
}))
vi.mock('@/services/userDataService', () => ({
  userDataService: {
    addEventListener: (type: string, fn: EventListener) => h.events.addEventListener(type, fn),
    primeMembers: vi.fn(async (members: Array<{ id: string }>) => { h.primed.push(members.map(m => m.id)) }),
    subscribeToContext: vi.fn(async (id: string, _type: string, ids: string[], options: any) => { h.contexts.set(id, { ids, options }) }),
    unsubscribeFromContext: vi.fn(async (id: string) => {
      if (h.unsubscribeGate) await h.unsubscribeGate
      h.contexts.delete(id)
    }),
    setContextMembers: vi.fn((id: string, ids: string[]) => { const c = h.contexts.get(id); if (c) c.ids = ids }),
    getContextMemberCount: (id: string) => h.contexts.get(id)?.ids.length ?? 0,
  },
}))
vi.mock('@/services/usersService', () => ({
  getUserIdsForServer: vi.fn(async (serverId: string) => {
    h.legacyReads.push(serverId)
    return Array.from({ length: h.servers[serverId].total }, (_, i) => `m${i}`)
  }),
}))
vi.mock('@/stores/useServerRoles', () => ({
  useServerRolesStore: () => ({ setMemberRoles: (serverId: string) => { h.roles.push(serverId) } }),
}))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { memberDirectory } from '@/services/memberDirectory'

const flush = async () => { for (let i = 0; i < 10; i++) await Promise.resolve() }

beforeEach(async () => {
  await memberDirectory.close()
  h.unsubscribeGate = null
  h.capability = true
  h.available = true
  h.pageError = null
  h.live = true
  h.maxAgeMs = 0
  h.servers = { small: { total: 4, online: 1 }, mid: { total: 150, online: 20 }, big: { total: 1503, online: 49 } }
  h.pages.length = 0
  h.searches.length = 0
  h.legacyReads.length = 0
  h.primed.length = 0
  h.roles.length = 0
  h.contexts.clear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('opening a server', () => {
  it('a small server arrives whole in one request', async () => {
    await memberDirectory.open('small')
    expect(memberDirectory.mode).toBe('complete')
    expect(memberDirectory.total).toBe(4)
    expect(h.pages).toEqual([{ serverId: 'small', offset: 0, limit: 100, query: null }])
    expect(h.contexts.get('small')).toEqual({ ids: ['m0', 'm1', 'm2', 'm3'], options: { preloaded: true } })
    expect(h.legacyReads).toEqual([])
    expect(h.roles).toEqual(['small'])
  })

  it('a server of up to 200 members arrives whole in two', async () => {
    await memberDirectory.open('mid')
    expect(memberDirectory.mode).toBe('complete')
    expect(memberDirectory.total).toBe(150)
    expect(h.pages.map(p => [p.offset, p.limit])).toEqual([[0, 100], [100, 100]])
    expect(h.contexts.get('mid')?.ids).toHaveLength(150)
  })

  it('a larger server opens as a window: one page, the count from the instance', async () => {
    await memberDirectory.open('big')
    expect(memberDirectory.mode).toBe('windowed')
    expect(memberDirectory.total).toBe(1503)
    expect(h.pages).toHaveLength(1)
    expect(h.contexts.get('big')?.options).toEqual({ preloaded: true, partial: true })
    expect(h.contexts.get('big')?.ids).toHaveLength(100)
    const slots = memberDirectory.slots()
    expect(slots.filter(s => s.type === 'header')).toEqual([
      { type: 'header', groupKey: 'online', count: 49 },
      { type: 'header', groupKey: 'offline', count: 1454 },
    ])
    expect(slots.filter(s => s.type === 'member')).toHaveLength(100)
    expect(slots.filter(s => s.type === 'placeholder')).toHaveLength(1403)
  })

  it('reads nothing of a server that is not open', async () => {
    await memberDirectory.open('small')
    expect(h.pages.every(p => p.serverId === 'small')).toBe(true)
    expect(h.legacyReads).toEqual([])
  })

  it('two callers of the same server share one read', async () => {
    await Promise.all([memberDirectory.open('big'), memberDirectory.open('big')])
    await memberDirectory.open('big')
    expect(h.pages).toHaveLength(1)
  })

  it('opening another server closes the first', async () => {
    await memberDirectory.open('small')
    await memberDirectory.open('big')
    expect(h.contexts.has('small')).toBe(false)
    expect(memberDirectory.serverId).toBe('big')
  })

  it('a server left while it loads is not adopted', async () => {
    const first = memberDirectory.open('big')
    await memberDirectory.open('small')
    await first
    expect(memberDirectory.serverId).toBe('small')
    expect(memberDirectory.mode).toBe('complete')
    expect(h.contexts.has('big')).toBe(false)
  })
})

describe('an instance without the member directory', () => {
  it('reads member ids in pages and lets the context load profiles', async () => {
    h.capability = false
    await memberDirectory.open('big')
    expect(memberDirectory.mode).toBe('legacy')
    expect(memberDirectory.total).toBe(1503)
    expect(h.pages).toEqual([])
    expect(h.legacyReads).toEqual(['big'])
    expect(h.contexts.get('big')?.ids).toHaveLength(1503)
    expect(h.contexts.get('big')?.options).toBeUndefined()
  })

  it('functions found absent (PGRST202) read the same way', async () => {
    h.available = false
    await memberDirectory.open('small')
    expect(memberDirectory.mode).toBe('legacy')
    expect(h.legacyReads).toEqual(['small'])
  })

  it('a capability list that gains the directory is read at the next open', async () => {
    h.capability = false
    await memberDirectory.open('small')
    expect(memberDirectory.mode).toBe('legacy')
    h.capability = true
    await memberDirectory.open('big')
    expect(memberDirectory.mode).toBe('windowed')
  })
})

describe('a failed read', () => {
  it('of the head is tried again later, and never becomes a read of every member', async () => {
    vi.useFakeTimers()
    h.pageError = { message: 'timeout' }
    await memberDirectory.open('big')
    expect(memberDirectory.mode).toBe('idle')
    expect(memberDirectory.loading).toBe(false)
    expect(h.legacyReads).toEqual([])
    expect(h.pages).toHaveLength(1)

    await vi.advanceTimersByTimeAsync(1500)
    expect(h.pages, 'not before the pause').toHaveLength(1)
    h.pageError = null
    await vi.advanceTimersByTimeAsync(1000)
    expect(memberDirectory.mode).toBe('windowed')
    expect(memberDirectory.total).toBe(1503)
    expect(h.legacyReads).toEqual([])
  })

  it('for a caller who is not a member opens an empty list', async () => {
    h.pageError = { code: '42501', message: 'server members: not a member' }
    await memberDirectory.open('big')
    expect(memberDirectory.mode).toBe('complete')
    expect(memberDirectory.total).toBe(0)
    expect(h.legacyReads).toEqual([])
  })

  it('of a page is asked again after a pause, not at once', async () => {
    vi.useFakeTimers()
    await memberDirectory.open('big')
    h.pages.length = 0
    h.pageError = { message: 'offline' }
    memberDirectory.showRanges([[700, 720]])
    await vi.advanceTimersByTimeAsync(500)
    expect(h.pages.map(p => p.offset), 'one try per page').toEqual([600, 700])

    await vi.advanceTimersByTimeAsync(1000)
    memberDirectory.showRanges([[705, 725]])
    await vi.advanceTimersByTimeAsync(100)
    expect(h.pages, 'nothing while the pause lasts').toHaveLength(2)

    h.pageError = null
    await vi.advanceTimersByTimeAsync(4000)
    expect(memberDirectory.slots().find(s => s.type === 'member' && s.index === 705)).toBeTruthy()
    const tries = h.pages.length
    await vi.advanceTimersByTimeAsync(20000)
    expect(h.pages, 'settled').toHaveLength(tries)
  })

  it('of the first page of a search is asked again, and the list comes back', async () => {
    vi.useFakeTimers()
    await memberDirectory.open('big')
    h.pages.length = 0
    h.pageError = { message: 'offline' }
    memberDirectory.search('user')
    await vi.advanceTimersByTimeAsync(100)
    expect(h.pages).toHaveLength(1)
    expect(memberDirectory.answered).toBe(false)
    h.pageError = null
    await vi.advanceTimersByTimeAsync(4000)
    expect(memberDirectory.answered).toBe(true)
    expect(memberDirectory.listed).toBe(151)
  })
})

describe('switching servers quickly', () => {
  const gate = () => {
    let release!: () => void
    h.unsubscribeGate = new Promise<void>((resolve) => { release = resolve })
    return () => { h.unsubscribeGate = null; release() }
  }

  it('A to B to C while A still closes ends on C', async () => {
    await memberDirectory.open('small')
    const release = gate()
    const toMid = memberDirectory.open('mid')
    const toBig = memberDirectory.open('big')
    release()
    await Promise.all([toMid, toBig])
    await flush()
    expect(memberDirectory.serverId).toBe('big')
    expect(memberDirectory.mode).toBe('windowed')
    expect(h.contexts.has('small')).toBe(false)
    expect(h.contexts.has('mid')).toBe(false)
    expect(h.pages.every(p => p.serverId !== 'mid'), 'the server passed over is never read').toBe(true)
  })

  it('A to B and back to A keeps the context A opens with', async () => {
    await memberDirectory.open('small')
    const release = gate()
    const toBig = memberDirectory.open('big')
    const back = memberDirectory.open('small')
    release()
    await Promise.all([toBig, back])
    await flush()
    expect(memberDirectory.serverId).toBe('small')
    expect(memberDirectory.mode).toBe('complete')
    expect(h.contexts.get('small')?.ids).toHaveLength(4)
    expect(h.contexts.has('big')).toBe(false)
  })
})

describe('a windowed list', () => {
  it('loads the pages that scroll into view, with a margin, once each', async () => {
    await memberDirectory.open('big')
    h.pages.length = 0
    memberDirectory.showRanges([[700, 720]])
    memberDirectory.showRanges([[700, 720]])
    await flush()
    expect(h.pages.map(p => p.offset)).toEqual([600, 700])
    expect(memberDirectory.slots().find(s => s.type === 'member' && s.index === 705)).toBeTruthy()
    // The context follows the pages held: its members take presence broadcasts.
    expect(h.contexts.get('big')?.ids).toHaveLength(300)
    h.pages.length = 0
    memberDirectory.showRanges([[705, 725]])
    await flush()
    expect(h.pages).toEqual([])
  })

  it('rows on both sides of a collapsed group load their own pages only', async () => {
    h.servers.big = { total: 23030, online: 3030 }
    await memberDirectory.open('big')
    h.pages.length = 0
    memberDirectory.showRanges([[0, 29], [3030, 3050]])
    await flush()
    await flush()
    expect(h.pages.map(p => p.offset)).toEqual([2900, 3000, 3100])
    h.pages.length = 0
    await flush()
    expect(h.pages, 'settled').toEqual([])
    expect(h.contexts.get('big')!.ids.length).toBeLessThanOrEqual(600)
  })

  it('answers with other counts are followed by one re-read per interval, not chased', async () => {
    vi.useFakeTimers()
    memberDirectory.attach()
    try {
      await memberDirectory.open('big')
      memberDirectory.showRanges([[80, 120]])
      await vi.advanceTimersByTimeAsync(10)
      h.pages.length = 0
      // A member comes online: page 200's counts differ from the pages held, which turn stale.
      h.servers.big = { total: 1503, online: 50 }
      memberDirectory.showRanges([[180, 220]])
      await vi.advanceTimersByTimeAsync(100)
      // The absent page at once; the stale ones wait for the interval since the list opened.
      expect(h.pages.map(p => p.offset)).toEqual([200])
      await vi.advanceTimersByTimeAsync(3000)
      expect(h.pages.map(p => p.offset).sort((a, b) => a - b)).toEqual([100, 200, 200])

      // Another change inside the interval: the absent page loads, the stale ones wait.
      h.pages.length = 0
      h.servers.big = { total: 1503, online: 51 }
      memberDirectory.showRanges([[280, 320]])
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.pages.map(p => p.offset)).toEqual([300])
      await vi.advanceTimersByTimeAsync(2500)
      expect(h.pages.map(p => p.offset).sort((a, b) => a - b), 'the pages in view, once').toEqual([200, 300, 300])
      h.pages.length = 0
      await vi.advanceTimersByTimeAsync(10000)
      expect(h.pages, 'settled').toEqual([])
    } finally {
      memberDirectory.detach()
    }
  })

  it('holds a bounded number of pages', async () => {
    await memberDirectory.open('big')
    for (let from = 0; from < 1500; from += 100) {
      memberDirectory.showRanges([[from, from + 20]])
      await flush()
    }
    expect(h.contexts.get('big')!.ids.length).toBeLessThanOrEqual(600)
  })

  it('a presence change re-reads the visible pages, at most once per interval', async () => {
    vi.useFakeTimers()
    memberDirectory.attach()
    try {
      await memberDirectory.open('big')
      memberDirectory.showRanges([[80, 100]])
      await vi.advanceTimersByTimeAsync(3000)
      h.pages.length = 0
      for (let i = 0; i < 50; i++) h.events.dispatchEvent(new CustomEvent('presence-event', { detail: { userId: `m${i}`, online: true } }))
      await vi.advanceTimersByTimeAsync(100)
      expect(h.pages.map(p => p.offset)).toEqual([0, 100])

      h.pages.length = 0
      for (let i = 0; i < 50; i++) h.events.dispatchEvent(new CustomEvent('presence-event', { detail: { userId: `m${i}`, online: false } }))
      await vi.advanceTimersByTimeAsync(1000)
      expect(h.pages, 'inside the interval').toEqual([])
      await vi.advanceTimersByTimeAsync(2500)
      expect(h.pages.map(p => p.offset)).toEqual([0, 100])
    } finally {
      memberDirectory.detach()
    }
  })

  it('an order the instance holds is not read again before it can have changed', async () => {
    vi.useFakeTimers()
    memberDirectory.attach()
    try {
      h.maxAgeMs = 8000
      await memberDirectory.open('big')
      await vi.advanceTimersByTimeAsync(20000)
      h.pages.length = 0
      h.events.dispatchEvent(new CustomEvent('presence-event', { detail: { userId: 'm1', online: true } }))
      await vi.advanceTimersByTimeAsync(7000)
      expect(h.pages, 'the order held may still predate the change').toEqual([])
      await vi.advanceTimersByTimeAsync(1500)
      expect(h.pages.map(p => p.offset)).toEqual([0])
    } finally {
      memberDirectory.detach()
    }
  })

  it('a server whose presence is not broadcast is read again on a timer while shown', async () => {
    vi.useFakeTimers()
    h.live = false
    await memberDirectory.open('big')
    h.pages.length = 0
    await vi.advanceTimersByTimeAsync(60000)
    expect(h.pages, 'not while nobody shows it').toEqual([])

    memberDirectory.attach()
    try {
      // Overdue when it comes on screen: read at the next check, then every 20 s.
      await vi.advanceTimersByTimeAsync(6000)
      expect(h.pages.map(p => p.offset)).toEqual([0])
      await vi.advanceTimersByTimeAsync(15000)
      expect(h.pages.map(p => p.offset)).toEqual([0])
      await vi.advanceTimersByTimeAsync(6000)
      expect(h.pages.map(p => p.offset)).toEqual([0, 0])
    } finally {
      memberDirectory.detach()
    }
  })

  it('a server whose presence is broadcast waits a minute without an event', async () => {
    vi.useFakeTimers()
    memberDirectory.attach()
    try {
      await memberDirectory.open('big')
      h.pages.length = 0
      await vi.advanceTimersByTimeAsync(50000)
      expect(h.pages).toEqual([])
      await vi.advanceTimersByTimeAsync(15000)
      expect(h.pages.map(p => p.offset)).toEqual([0])
    } finally {
      memberDirectory.detach()
    }
  })

  it('this client\'s own status change is read at once, whatever the age of the order', async () => {
    vi.useFakeTimers()
    memberDirectory.attach()
    try {
      h.maxAgeMs = 8000
      await memberDirectory.open('big')
      await vi.advanceTimersByTimeAsync(500)
      h.pages.length = 0
      h.events.dispatchEvent(new CustomEvent('presence-event', { detail: { userId: 'me', self: true } }))
      await vi.advanceTimersByTimeAsync(50)
      expect(h.pages.map(p => p.offset)).toEqual([0])
    } finally {
      memberDirectory.detach()
    }
  })

  it('a list nobody shows is not re-read until it is shown', async () => {
    vi.useFakeTimers()
    await memberDirectory.open('big')
    await vi.advanceTimersByTimeAsync(3000)
    h.pages.length = 0
    h.events.dispatchEvent(new CustomEvent('presence-event', { detail: { userId: 'm1', online: true } }))
    await vi.advanceTimersByTimeAsync(5000)
    expect(h.pages).toEqual([])
    memberDirectory.attach()
    await vi.advanceTimersByTimeAsync(100)
    expect(h.pages.length).toBeGreaterThan(0)
    memberDirectory.detach()
  })

  it('search is answered by the instance and restores the list when cleared', async () => {
    await memberDirectory.open('big')
    h.pages.length = 0
    memberDirectory.search('user')
    await flush()
    expect(h.pages).toEqual([{ serverId: 'big', offset: 0, limit: 100, query: 'user' }])
    expect(memberDirectory.listed).toBe(151)
    expect(memberDirectory.total, 'the server count stays').toBe(1503)

    memberDirectory.search('')
    await flush()
    expect(memberDirectory.listed).toBe(1503)
    expect(memberDirectory.query).toBe('')
  })

  it('becomes a whole list when the server shrinks under the limit', async () => {
    await memberDirectory.open('big')
    h.servers.big = { total: 120, online: 5 }
    memberDirectory.refresh()
    await flush()
    await flush()
    expect(memberDirectory.mode).toBe('complete')
    expect(memberDirectory.total).toBe(120)
    expect(h.contexts.get('big')?.options).toEqual({ preloaded: true })
  })
})

describe('a whole list', () => {
  it('follows joins through its context and turns windowed past the limit', async () => {
    h.servers.mid = { total: 200, online: 20 }
    await memberDirectory.open('mid')
    expect(memberDirectory.mode).toBe('complete')

    h.servers.mid = { total: 201, online: 20 }
    h.contexts.get('mid')!.ids.push('m200')
    h.events.dispatchEvent(new CustomEvent('context-updated', { detail: { contextId: 'mid', type: 'member-join', userId: 'm200' } }))
    expect(memberDirectory.total).toBe(201)
    await flush()
    await flush()
    expect(memberDirectory.mode).toBe('windowed')
  })
})

describe('member search for pickers', () => {
  it('caches what the instance found', async () => {
    const found = await memberDirectory.searchMembers('big', 'user1234')
    expect(found?.map(m => m.id)).toEqual(['m1234'])
    expect(h.searches).toEqual([{ serverId: 'big', query: 'user1234' }])
    expect(h.primed).toContainEqual(['m1234'])
  })
})
