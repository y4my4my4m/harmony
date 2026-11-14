import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const db = vi.hoisted(() => ({
  usernames: ['alice'] as string[],
  fail: false,
  queries: [] as string[][],
}))

vi.mock('@/supabase', () => ({
  supabase: {
    from: () => {
      let names: string[] = []
      const q: any = {
        select: () => q,
        in: (_col: string, values: string[]) => { names = values; db.queries.push(values); return q },
        eq: () => q,
        then: (resolve: any) => resolve(db.fail
          ? { data: null, error: { message: 'unavailable' } }
          : { data: names.filter((n) => db.usernames.includes(n)).map((username) => ({ username })), error: null }),
      }
      return q
    },
  },
}))

type Lookup = typeof import('@/utils/localHandleLookup')
let lookup: Lookup

beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  db.fail = false
  db.queries = []
  lookup = await import('@/utils/localHandleLookup')
})
afterEach(() => vi.useRealTimers())

async function settle() {
  await vi.advanceTimersByTimeAsync(200)
}

describe('localHandleLookup', () => {
  it('answers each username once, in one batched query', async () => {
    lookup.requestLocalHandle('alice')
    lookup.requestLocalHandle('nobody')
    lookup.requestLocalHandle('nobody')
    expect(lookup.localHandleExists('alice')).toBeUndefined()
    await settle()
    expect(db.queries).toEqual([['alice', 'nobody']])
    expect(lookup.localHandleExists('alice')).toBe(true)
    expect(lookup.localHandleExists('nobody')).toBe(false)
    lookup.requestLocalHandle('nobody')
    await settle()
    expect(db.queries).toHaveLength(1)
  })

  it('bumps the absent count only when a username has no account', async () => {
    lookup.requestLocalHandle('alice')
    await settle()
    expect(lookup.absentLocalHandleCount.value).toBe(0)
    lookup.requestLocalHandle('nobody')
    await settle()
    expect(lookup.absentLocalHandleCount.value).toBe(1)
  })

  it('matches the exact username, as the send path does', async () => {
    lookup.requestLocalHandle('Alice')
    await settle()
    expect(lookup.localHandleExists('Alice')).toBe(false)
  })

  it('records nothing on a failed lookup and retries after 30 s', async () => {
    db.fail = true
    lookup.requestLocalHandle('nobody')
    await settle()
    expect(lookup.localHandleExists('nobody')).toBeUndefined()
    expect(lookup.absentLocalHandleCount.value).toBe(0)
    lookup.requestLocalHandle('nobody')
    await settle()
    expect(db.queries).toHaveLength(1)
    db.fail = false
    await vi.advanceTimersByTimeAsync(30_000)
    lookup.requestLocalHandle('nobody')
    await settle()
    expect(db.queries).toHaveLength(2)
    expect(lookup.localHandleExists('nobody')).toBe(false)
  })
})
