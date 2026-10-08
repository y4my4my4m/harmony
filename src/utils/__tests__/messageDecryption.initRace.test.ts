/**
 * processMessageDecryption against an encryption initialize() still running
 * its stored-key auto-unlock: isInitialized() is already true, isUnlocked() is
 * not. Rows returned in that window paint as glyphs and reflow when the unlock
 * lands; the first paint carries plaintext instead.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { Message } from '@/types'

const svc = vi.hoisted(() => {
  let unlocked = false
  let settle: (() => void) | null = null
  let pending: Promise<void> | null = null
  return {
    reset() {
      unlocked = false
      pending = new Promise<void>(resolve => { settle = resolve })
    },
    unlock() {
      unlocked = true
      settle?.()
      pending = null
    },
    service: {
      isInitialized: () => true,
      isUnlocked: () => unlocked,
      initialize: vi.fn(),
      whenInitSettled: vi.fn((timeoutMs: number) => {
        if (!pending) return Promise.resolve()
        return Promise.race([pending, new Promise<void>(r => setTimeout(r, timeoutMs))])
      }),
      getCurrentUserId: () => 'me',
      getIdentityCreatedAt: async () => null,
      decryptMessage: vi.fn(async () => {
        if (!unlocked) throw new Error('No inbound session')
        return { content: [{ type: 'text', text: 'hello' }], senderVerified: true }
      }),
    },
  }
})

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: svc.service,
}))
vi.mock('@/supabase', () => ({ supabase: { auth: { getSession: vi.fn() } } }))
vi.mock('@/utils/debug', () => ({ debug: { log: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { processMessageDecryption, INIT_SETTLE_TIMEOUT_MS } from '@/utils/messageDecryption'

const encryptedRow = (): Message => ({
  id: 'm1',
  user_id: 'u2',
  conversation_id: 'c1',
  channel_id: '',
  created_at: new Date('2026-10-08T00:00:00Z'),
  content: [{ type: 'text', text: 'AAAA' }],
  encrypted: true,
  encryption_metadata: { sender_user_id: 'u2' },
  reactions: [],
} as unknown as Message)

beforeEach(() => {
  vi.useFakeTimers()
  svc.reset()
  svc.service.decryptMessage.mockClear()
  svc.service.whenInitSettled.mockClear()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('processMessageDecryption during auto-unlock', () => {
  it('waits for the in-flight unlock and returns plaintext', async () => {
    const result = processMessageDecryption([encryptedRow()])
    await vi.advanceTimersByTimeAsync(300)
    svc.unlock()
    const [row] = await result

    expect(row.decrypted).toBe(true)
    expect(row.encrypted).toBe(false)
    expect(row.content).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('returns the rows undecrypted once the wait times out', async () => {
    const result = processMessageDecryption([encryptedRow()])
    await vi.advanceTimersByTimeAsync(INIT_SETTLE_TIMEOUT_MS + 1)
    const [row] = await result

    expect(row.decrypted).toBeFalsy()
    expect(row.encrypted).toBe(true)
    expect(svc.service.decryptMessage).not.toHaveBeenCalled()
  })

  it('does not wait on plaintext pages', async () => {
    const plain = { ...encryptedRow(), encrypted: false, encryption_metadata: null } as unknown as Message
    const [row] = await processMessageDecryption([plain])

    expect(row).toBe(plain)
    expect(svc.service.whenInitSettled).not.toHaveBeenCalled()
  })
})
