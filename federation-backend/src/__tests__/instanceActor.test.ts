import crypto from 'crypto'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import express from 'express'

// The instance actor is published as an Application at /users/instance.actor
// and resolvable through WebFinger, as Mastodon requires of a signing actor.

vi.mock('../config/index.js', () => ({
  default: { INSTANCE_DOMAIN: 'harmony.test', INSTANCE_NAME: 'Harmony Test', NODE_ENV: 'test' },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../middleware/errorHandler.js', () => ({
  asyncHandler: (fn: any) => (req: any, res: any, next: any) => fn(req, res, next).catch(next),
  AppError: class extends Error {},
}))

const keys = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})
const profileLookups: string[] = []

vi.mock('../config/supabase.js', () => ({
  getSupabaseClient: () => ({
    from: (table: string) => {
      const c: any = {
        select: () => c,
        eq: () => c,
        ilike: (_col: string, v: string) => { profileLookups.push(v); return c },
        maybeSingle: () => Promise.resolve({
          data: table === 'instance_actor_keys' ? { public_key: keys.publicKey, private_key: keys.privateKey } : null,
          error: null,
        }),
      }
      return c
    },
  }),
}))

const { default: instanceActorRouter, __resetInstanceActorKeyCache } = await import('../activitypub/InstanceActor.js')
const { default: webFingerRouter } = await import('../activitypub/WebFingerService.js')
const { default: supertest } = await import('supertest')

function app() {
  const a = express()
  a.use('/', webFingerRouter)
  a.use('/', instanceActorRouter)
  return a
}

beforeEach(() => {
  profileLookups.length = 0
  __resetInstanceActorKeyCache()
})

describe('instance actor', () => {
  it('is an Application with the stored public key', async () => {
    const res = await supertest(app()).get('/users/instance.actor')
    expect(res.status).toBe(200)
    expect(res.headers['content-type']).toContain('application/activity+json')
    const actor = JSON.parse(res.text)
    expect(actor).toMatchObject({
      id: 'https://harmony.test/users/instance.actor',
      type: 'Application',
      preferredUsername: 'instance.actor',
      inbox: 'https://harmony.test/users/instance.actor/inbox',
      endpoints: { sharedInbox: 'https://harmony.test/inbox' },
      publicKey: {
        id: 'https://harmony.test/users/instance.actor#main-key',
        owner: 'https://harmony.test/users/instance.actor',
        publicKeyPem: keys.publicKey,
      },
    })
    expect(JSON.stringify(actor)).not.toContain('PRIVATE KEY')
  })

  it('has an empty outbox', async () => {
    const res = await supertest(app()).get('/users/instance.actor/outbox')
    expect(JSON.parse(res.text)).toMatchObject({ type: 'OrderedCollection', totalItems: 0 })
  })

  it('resolves through WebFinger to its own id, without an account lookup', async () => {
    const res = await supertest(app())
      .get('/.well-known/webfinger')
      .query({ resource: 'acct:instance.actor@harmony.test' })
    expect(res.status).toBe(200)
    const jrd = JSON.parse(res.text)
    expect(jrd.subject).toBe('acct:instance.actor@harmony.test')
    expect(jrd.links).toContainEqual(expect.objectContaining({
      rel: 'self', type: 'application/activity+json', href: 'https://harmony.test/users/instance.actor',
    }))
    expect(profileLookups).toEqual([])
  })
})
