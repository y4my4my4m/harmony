import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  CONVERSATION_ENCRYPTION_FRESH_MS,
  conversationEncryptionEnabled,
  fetchConversationEncryption,
  forgetConversationEncryption,
  refreshConversationEncryption,
} from '@/services/conversationEncryption'

const CONVERSATION = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

const db = { enabled: false, fail: false }

function settingsReads(): number {
  return (supabase.from as any).mock.calls.filter(([t]: [string]) => t === 'conversation_encryption_settings').length
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  forgetConversationEncryption()
  db.enabled = false
  db.fail = false
  ;(supabase.from as any).mockImplementation(() => ({
    select: () => ({
      eq: () => ({
        maybeSingle: () => Promise.resolve(db.fail
          ? { data: null, error: { message: 'down' } }
          : { data: db.enabled ? { encryption_enabled: true } : null, error: null }),
      }),
    }),
  }))
})

afterEach(() => {
  vi.useRealTimers()
})

describe('conversation encryption answers', () => {
  it('a fresh answer serves the next send', async () => {
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(false)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(false)
    expect(settingsReads()).toBe(1)
  })

  it('the open-time read and both headers share one request', async () => {
    await Promise.all([
      fetchConversationEncryption(CONVERSATION),
      fetchConversationEncryption(CONVERSATION),
      conversationEncryptionEnabled(CONVERSATION),
    ])
    expect(settingsReads()).toBe(1)
  })

  it('an answer past its freshness is read again before the send', async () => {
    await conversationEncryptionEnabled(CONVERSATION)
    db.enabled = true
    vi.advanceTimersByTime(CONVERSATION_ENCRYPTION_FRESH_MS)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(settingsReads()).toBe(2)
  })

  it('typing refreshes an answer past half its freshness, so the send reads none', async () => {
    await conversationEncryptionEnabled(CONVERSATION)
    vi.advanceTimersByTime(CONVERSATION_ENCRYPTION_FRESH_MS / 2 - 1)
    refreshConversationEncryption(CONVERSATION)
    expect(settingsReads()).toBe(1)

    db.enabled = true
    vi.advanceTimersByTime(1)
    refreshConversationEncryption(CONVERSATION)
    refreshConversationEncryption(CONVERSATION)
    expect(settingsReads()).toBe(2)
    await vi.advanceTimersByTimeAsync(0)

    vi.advanceTimersByTime(CONVERSATION_ENCRYPTION_FRESH_MS / 2)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(settingsReads()).toBe(2)
  })

  it('this client\'s toggle writes the answer', async () => {
    await conversationEncryptionEnabled(CONVERSATION)
    window.dispatchEvent(new CustomEvent('dm-encryption-toggled', {
      detail: { conversationId: CONVERSATION, enabled: true },
    }))
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(settingsReads()).toBe(1)
  })

  it('a failed read answers with the previous entry and is not kept', async () => {
    db.enabled = true
    await conversationEncryptionEnabled(CONVERSATION)
    db.fail = true
    vi.advanceTimersByTime(CONVERSATION_ENCRYPTION_FRESH_MS)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(settingsReads()).toBe(3)
  })

  it('a failed first read answers not encrypted, as the uncached read did', async () => {
    db.fail = true
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(false)
  })

  it('sign-out forgets every answer', async () => {
    await conversationEncryptionEnabled(CONVERSATION)
    forgetConversationEncryption()
    await conversationEncryptionEnabled(CONVERSATION)
    expect(settingsReads()).toBe(2)
  })
})
