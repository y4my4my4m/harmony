import { describe, it, expect, vi, beforeEach } from 'vitest'

// A deferred engagement in the delivery queue is built when each attempt is sent: the
// immediate attempt and every retry read the reactor's state at that moment.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', SUPABASE_URL: 'http://localhost:54321', PUBLIC_SUPABASE_URL: 'http://localhost:54321' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../services/PerformanceMonitor.js', () => ({
  performanceMonitor: { recordMetric: vi.fn() },
}))
vi.mock('../services/BlockedInstancesCache.js', () => ({
  BlockedInstancesCache: { isBlocked: vi.fn(() => false) },
}))
const signed: any[] = []
vi.mock('../activitypub/SignatureService.js', () => ({
  SignatureService: { signRequest: vi.fn(async (_url: string, _m: string, body: any) => { signed.push(body); return { headers: {} } }) },
}))
vi.mock('../utils/ssrfProtection.js', () => ({
  safeFetch: vi.fn(),
  validateExternalUrl: vi.fn(),
}))

type Row = Record<string, any>
let interactions: Row[] = []
const queueInserts: Row[] = []
const queueUpdates: Row[] = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    rpc: () => Promise.resolve({ error: null }),
    from: (table: string) => {
      const filters: Array<(r: Row) => boolean> = []
      let patch: Row | null = null
      const rows = () => (table === 'post_interactions' ? interactions : [])
      const c: any = {
        select: () => c,
        eq: (col: string, val: any) => { filters.push((r) => r[col] === val); return c },
        in: (col: string, vals: any[]) => { filters.push((r) => vals.includes(r[col])); return c },
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        insert: (row: any) => { queueInserts.push(row); return Promise.resolve({ error: null }) },
        update: (row: Row) => { patch = row; return c },
        then: (resolve: any) => {
          if (patch) queueUpdates.push(patch)
          return resolve({ data: rows().filter((r) => filters.every((f) => f(r))), error: null })
        },
      }
      return c
    },
  }),
}))

const { DeliveryQueue } = await import('../activitypub/DeliveryQueue.js')
const { safeFetch } = await import('../utils/ssrfProtection.js')

const deferred = (fields: Row = {}) => ({
  type: 'harmony:DeferredEngagement',
  post_id: 'p1',
  user_id: 'me',
  username: 'me',
  post_ap_id: 'https://mk.test/notes/1',
  target_host: 'mk.test',
  to: ['https://mk.test/users/author'],
  ...fields,
})

const queued = (activity: Row) => ({
  id: 'q1', activity_data: activity, target_inbox_url: 'https://mk.test/inbox', sender_id: 'me',
  actor_username: null, attempts: 1, max_attempts: 5, next_attempt_at: new Date().toISOString(),
})

const deliverQueued = (item: Row) => (DeliveryQueue as any).deliverActivity(item)

beforeEach(() => {
  interactions = []
  signed.length = 0
  queueInserts.length = 0
  queueUpdates.length = 0
  vi.mocked(safeFetch).mockReset().mockResolvedValue(new Response('', { status: 202 }))
})

describe('deferred engagement delivery', () => {
  it('sends the newest reaction at the immediate attempt, and queues the deferral on failure', async () => {
    interactions = [
      { id: 'fav', post_id: 'p1', user_id: 'me', interaction_type: 'favorite', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r1', post_id: 'p1', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🎉', created_at: '2026-10-01T10:00:00Z' },
    ]
    vi.mocked(safeFetch).mockResolvedValue(new Response('', { status: 503 }))

    await DeliveryQueue.enqueue(deferred(), 'https://mk.test/inbox', 'me')

    expect(signed[0]).toMatchObject({ type: 'Like', _misskey_reaction: '🎉', to: ['https://mk.test/users/author'] })
    expect(queueInserts[0].activity_data).toEqual(deferred())
  })

  it('a retry sends the state of its own moment, signing what it sends', async () => {
    interactions = [
      { id: 'fav', post_id: 'p1', user_id: 'me', interaction_type: 'favorite', created_at: '2026-10-01T10:00:00Z' },
      { id: 'r2', post_id: 'p1', user_id: 'me', interaction_type: 'emoji_reaction', custom_emoji_content: '🔥', created_at: '2026-10-01T10:05:00Z' },
    ]

    expect(await deliverQueued(queued(deferred()))).toBe(true)

    expect(signed[0]).toMatchObject({ type: 'Like', _misskey_reaction: '🔥' })
    const [, init] = vi.mocked(safeFetch).mock.calls[0]
    expect(JSON.parse(String((init as any).body))).toEqual(signed[0])
    expect(queueUpdates.at(-1)).toMatchObject({ status: 'delivered' })
  })

  it('a retry with nothing left to send is cancelled without a request', async () => {
    expect(await deliverQueued(queued(deferred()))).toBe(true)

    expect(safeFetch).not.toHaveBeenCalled()
    expect(queueUpdates.at(-1)).toMatchObject({ status: 'cancelled' })
  })

  it('a retried Undo is sent while the person holds nothing', async () => {
    expect(await deliverQueued(queued(deferred({ undo_favourite_id: 'fav' })))).toBe(true)

    expect(signed[0]).toMatchObject({ type: 'Undo', object: { type: 'Like', id: 'https://harmony.test/users/me/likes/fav' } })
  })

  it('sends a queued activity that is not deferred as it was queued', async () => {
    const create = { type: 'Create', id: 'https://harmony.test/activities/1' }

    expect(await deliverQueued(queued(create))).toBe(true)

    expect(signed[0]).toEqual(create)
  })
})
