/**
 * processMessageDecryption records why a message did not decrypt: a forged signature, a missing
 * session key or anything else. sender_verified stays unset on failure; it describes decrypted
 * messages only.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { Message } from '@/types'

const svc = vi.hoisted(() => ({
  decrypt: null as null | ((message: any) => Promise<any>),
  service: {
    isInitialized: () => true,
    isUnlocked: () => true,
    initialize: vi.fn(),
    whenInitSettled: vi.fn(async () => {}),
    getCurrentUserId: () => 'me',
    getIdentityCreatedAt: async () => null,
    prefetchSigningKeys: async () => {},
    decryptMessage: vi.fn(async (message: any) => svc.decrypt!(message)),
  },
}))

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: svc.service,
}))
vi.mock('@/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))
vi.mock('@/services/search/encryptedSearchIndex', () => ({ noteDecryption: vi.fn() }))

import { processMessageDecryption } from '@/utils/messageDecryption'

const row = (id = 'm1', extra: Partial<Message> = {}): Message => ({
  id,
  user_id: 'u2',
  channel_id: 'c1',
  created_at: '2026-11-20T00:00:00Z',
  content: [{ type: 'text', text: 'AAAA' }],
  encrypted: true,
  encryption_metadata: { sender_user_id: 'u2' },
  reactions: [],
  ...extra,
} as unknown as Message)

const kinded = (message: string, kind: string) => Object.assign(new Error(message), { kind })

beforeEach(() => {
  svc.decrypt = null
})

describe('processMessageDecryption failure kinds', () => {
  it('a forged signature is recorded as forged, with no verification flag', async () => {
    svc.decrypt = async () => { throw kinded('Sender signature invalid - refusing to display tampered message', 'forged') }
    const [result] = await processMessageDecryption([row()])
    expect(result.decrypted).toBe(false)
    expect(result.decryption_error).toBe('forged')
    expect(result).not.toHaveProperty('sender_verified')
  })

  it('a missing session key is recorded as missing_key', async () => {
    svc.decrypt = async () => { throw kinded('Session key not available - key request sent to sender', 'missing_key') }
    const [result] = await processMessageDecryption([row()])
    expect(result.decryption_error).toBe('missing_key')
    expect(result).not.toHaveProperty('sender_verified')
  })

  it('an unkinded "No inbound session" error is a missing key', async () => {
    svc.decrypt = async () => { throw new Error('No inbound session found for session x') }
    const [result] = await processMessageDecryption([row()])
    expect(result.decryption_error).toBe('missing_key')
  })

  it('an unverifiable sender is neither forged nor a missing key', async () => {
    svc.decrypt = async () => { throw kinded('Sender signing key unavailable - the message cannot be verified', 'other') }
    const [result] = await processMessageDecryption([row()])
    expect(result.decryption_error).toBe('other')
  })

  it('a later success drops the earlier failure kind', async () => {
    svc.decrypt = async () => ({ content: [{ type: 'text', text: 'hi' }], senderVerified: true })
    const [result] = await processMessageDecryption([row('m1', { decryption_error: 'missing_key' } as Partial<Message>)])
    expect(result.decrypted).toBe(true)
    expect(result.decryption_error).toBeUndefined()
    expect(result.sender_verified).toBe(true)
  })

  it('flags a replayed message', async () => {
    svc.decrypt = async (message) => ({ content: [{ type: 'text', text: 'hi' }], senderVerified: true, replayed: message.id === 'copy' })
    const [first, copy] = await processMessageDecryption([row('first'), row('copy')])
    expect(first.decryption_replayed).toBe(false)
    expect(copy.decryption_replayed).toBe(true)
  })
})
