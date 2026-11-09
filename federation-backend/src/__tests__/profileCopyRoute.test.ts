import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'
import supertest from 'supertest'

// POST /account/profile/copy: who is refused, and that the write goes out with the caller's token.
// What a copy contains is in profileCopy.test.ts.

const config = vi.hoisted(() => ({ INSTANCE_DOMAIN: 'harmony.test' }))
vi.mock('../config/index.js', () => ({ default: config, config }))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
}))
vi.mock('../middleware/rateLimit.js', () => ({
  accountMigrationLimiter: (_req: any, _res: any, next: any) => next(),
}))
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (req: any, res: any, next: any) => {
    if (!req.headers.authorization) return res.status(401).json({ error: 'not_authenticated' })
    req.profileId = 'new'
    return next()
  },
}))
vi.mock('../utils/sessionAssurance.js', () => ({
  bearerToken: (header: string | undefined) => header?.replace(/^Bearer /, '') ?? null,
}))
vi.mock('../activitypub/ActorService.js', () => ({ resolveRemoteAccount: vi.fn() }))
vi.mock('../activitypub/converters/fromActivityPub.js', () => ({
  parseAlsoKnownAs: () => [],
  parseMovedTo: () => null,
}))

const state = vi.hoisted(() => ({
  rows: {} as Record<string, any>,
  writes: [] as Array<{ token: string; update: any; id: unknown }>,
  writeError: null as any,
  built: { update: {}, copied: [], failed: [] } as any,
  buildCalls: [] as any[],
  removed: [] as any[],
}))

vi.mock('../activitypub/profileCopy.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../activitypub/profileCopy.js')>()),
  buildProfileCopy: vi.fn(async (...args: any[]) => {
    state.buildCalls.push(args)
    return state.built
  }),
  removeCopiedImages: vi.fn(async (update: any) => {
    state.removed.push(update)
  }),
}))
vi.mock('../routes/adminEmojis.js', () => ({ sniffImage: () => null }))
vi.mock('../utils/stripMetadata.js', () => ({ stripMediaBytes: async (b: Uint8Array) => b }))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: () => {
      let id: unknown
      const b: any = {
        select: () => b,
        eq: (_c: string, v: unknown) => { id = v; return b },
        maybeSingle: async () => ({ data: state.rows[id as string] ?? null }),
      }
      return b
    },
  }),
  getSupabaseClientWithAuth: (token: string) => ({
    from: () => ({
      update: (update: any) => ({
        eq: async (_c: string, id: unknown) => {
          state.writes.push({ token, update, id })
          return { error: state.writeError }
        },
      }),
    }),
  }),
}))

import router from '../routes/accountMigration.js'

const ORIGIN = '11111111-1111-4111-8111-111111111111'
const OLD_URI = 'https://old.test/users/old'

function app() {
  const a = express()
  a.use(express.json())
  a.use('/account', router)
  return a
}

const copy = (body: Record<string, unknown>) =>
  supertest(app()).post('/account/profile/copy').set('Authorization', 'Bearer tok').send(body)

beforeEach(() => {
  state.writes = []
  state.writeError = null
  state.buildCalls = []
  state.removed = []
  state.built = { update: { bio: 'Old bio' }, copied: ['bio'], failed: [] }
  state.rows = {
    new: {
      id: 'new', auth_user_id: 'auth-new', username: 'new', federated_id: null, also_known_as: [OLD_URI],
      moved_to_uri: null, is_suspended: false, is_local: true, deleted_at: null,
    },
    [ORIGIN]: {
      id: ORIGIN, username: 'old', domain: 'old.test', federated_id: OLD_URI, moved_to_id: 'new',
      display_name: 'Old', bio: 'Old bio', avatar_url: null, banner_url: null, profile_fields: [],
    },
  }
})

describe('POST /account/profile/copy', () => {
  it('needs a session', async () => {
    const res = await supertest(app()).post('/account/profile/copy').send({ origin_id: ORIGIN, fields: ['bio'] })
    expect(res.status).toBe(401)
  })

  it('refuses a malformed origin and an empty field list', async () => {
    expect((await copy({ origin_id: 'nope', fields: ['bio'] })).body.error).toBe('invalid_origin')
    expect((await copy({ origin_id: ORIGIN, fields: [] })).body.error).toBe('no_fields')
    expect((await copy({ origin_id: ORIGIN, fields: ['is_admin'] })).body.error).toBe('no_fields')
    expect(state.writes).toEqual([])
  })

  it('refuses a suspended account before it stores anything', async () => {
    state.rows.new.is_suspended = true
    const res = await copy({ origin_id: ORIGIN, fields: ['avatar'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('account_suspended')
    expect(state.buildCalls).toEqual([])
  })

  it('refuses an account no confirmed move names', async () => {
    state.rows[ORIGIN].moved_to_id = 'someone-else'
    expect((await copy({ origin_id: ORIGIN, fields: ['bio'] })).body.error).toBe('not_verified')

    state.rows[ORIGIN].moved_to_id = 'new'
    state.rows.new.also_known_as = []
    expect((await copy({ origin_id: ORIGIN, fields: ['bio'] })).body.error).toBe('not_verified')

    delete state.rows[ORIGIN]
    const res = await copy({ origin_id: ORIGIN, fields: ['bio'] })
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('not_verified')
    expect(state.buildCalls).toEqual([])
    expect(state.writes).toEqual([])
  })

  it('writes with the caller\'s token, to the caller\'s row, under the auth folder', async () => {
    const res = await copy({ origin_id: ORIGIN, fields: ['bio'] })
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ success: true, copied: ['bio'], failed: [], update: { bio: 'Old bio' } })
    expect(state.writes).toEqual([{ token: 'tok', update: { bio: 'Old bio' }, id: 'new' }])
    expect(state.buildCalls[0][1]).toEqual(['bio'])
    expect(state.buildCalls[0][2]).toBe('auth-new')
  })

  it('answers 422 and writes nothing when nothing could be copied', async () => {
    state.built = { update: {}, copied: [], failed: ['avatar'] }
    const res = await copy({ origin_id: ORIGIN, fields: ['avatar'] })
    expect(res.status).toBe(422)
    expect(res.body).toEqual({ error: 'nothing_to_copy', failed: ['avatar'] })
    expect(state.writes).toEqual([])
  })

  it('removes the stored images when the profile write fails', async () => {
    state.built = { update: { avatar_url: 'auth-new/avatar-1.png' }, copied: ['avatar'], failed: [] }
    state.writeError = { code: '42501', message: 'denied' }
    const res = await copy({ origin_id: ORIGIN, fields: ['avatar'] })
    expect(res.status).toBe(500)
    expect(state.removed).toEqual([{ avatar_url: 'auth-new/avatar-1.png' }])
  })
})
