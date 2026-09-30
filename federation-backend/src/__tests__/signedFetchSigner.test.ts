import { describe, it, expect, vi, beforeEach } from 'vitest'
import crypto from 'crypto'

// signedApFetch({ signAs }): the named local user's key signs, or nothing is sent.

vi.mock('../config/supabase.js', () => ({ getSupabaseClient: vi.fn() }))
vi.mock('../middleware/errorHandler.js', () => ({
  AppError: class AppError extends Error {
    statusCode: number
    constructor(statusCode: number, message: string) {
      super(message)
      this.statusCode = statusCode
    }
  },
}))
vi.mock('../utils/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../utils/ssrfProtection.js', () => ({ safeFetch: vi.fn() }))

import { SignatureService } from '../activitypub/SignatureService.js'
import { safeFetch } from '../utils/ssrfProtection.js'
import { getSupabaseClient } from '../config/supabase.js'

const { privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const PROFILES: Record<string, any> = {
  bob: { id: 'bob', username: 'bob', domain: 'harmony.test', is_local: true },
  carol: { id: 'carol', username: 'carol', domain: 'harmony.test', is_local: true },
  remote: { id: 'remote', username: 'dora', domain: 'remote.test', is_local: false },
}
let keys: Record<string, string>
let keyWrites: string[]

beforeEach(() => {
  vi.mocked(safeFetch).mockReset()
  vi.mocked(safeFetch).mockResolvedValue(new Response('{}', { status: 200 }))
  keys = { bob: privateKey, carol: privateKey }
  keyWrites = []

  vi.mocked(getSupabaseClient).mockReturnValue({
    from: (table: string) => {
      let id: string | undefined
      const q: any = {
        select: () => q,
        limit: () => q,
        eq: (col: string, val: string) => { if (col === 'id' || col === 'user_id') id = val; return q },
        upsert: (row: any) => { keyWrites.push(row.user_id); return Promise.resolve({ error: { message: 'refused' } }) },
        update: () => q,
        single: () => q.maybeSingle(),
        maybeSingle: () => {
          if (table === 'profiles') return Promise.resolve({ data: id ? PROFILES[id] ?? null : null, error: null })
          if (table === 'user_private_keys') {
            if (!id) return Promise.resolve({ data: { user_id: 'carol' }, error: null })
            return Promise.resolve(keys[id] ? { data: { private_key: keys[id] }, error: null } : { data: null, error: { message: 'none' } })
          }
          return Promise.resolve({ data: null, error: null })
        },
      }
      return q
    },
  } as any)
})

describe('signedApFetch signAs', () => {
  it('signs with the named user\'s key', async () => {
    await SignatureService.signedApFetch('https://remote.test/servers/1', { signAs: 'bob' })

    expect(safeFetch).toHaveBeenCalledTimes(1)
    const headers = (vi.mocked(safeFetch).mock.calls[0][1] as any).headers
    expect(headers.Signature).toContain('keyId="https://harmony.test/users/bob#main-key"')
    expect(headers.Signature).toContain('headers="(request-target) host date"')
  })

  it('signs with some local key when no user is named', async () => {
    await SignatureService.signedApFetch('https://remote.test/servers/1')
    const headers = (vi.mocked(safeFetch).mock.calls[0][1] as any).headers
    expect(headers.Signature).toContain('keyId="https://harmony.test/users/carol#main-key"')
  })

  it('refuses a remote profile, sending nothing and generating no key for it', async () => {
    await expect(SignatureService.signedApFetch('https://remote.test/servers/1', { signAs: 'remote' })).rejects.toThrow()
    expect(safeFetch).not.toHaveBeenCalled()
    expect(keyWrites).toEqual([])
  })

  it('refuses an unknown profile', async () => {
    await expect(SignatureService.signedApFetch('https://remote.test/servers/1', { signAs: 'ghost' })).rejects.toThrow()
    expect(safeFetch).not.toHaveBeenCalled()
  })

  it('sends nothing when the named user cannot sign, rather than falling back to unsigned', async () => {
    delete keys.bob
    await expect(SignatureService.signedApFetch('https://remote.test/servers/1', { signAs: 'bob' })).rejects.toThrow()
    expect(safeFetch).not.toHaveBeenCalled()
  })
})
