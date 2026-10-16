import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  conversationEncryptionEnabled,
  fetchConversationEncryption,
  forgetConversationEncryption,
  isConversationEncryptedRefusal,
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

  it('an answer stands until something says it changed', async () => {
    await conversationEncryptionEnabled(CONVERSATION)
    db.enabled = true
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(false)
    expect(settingsReads()).toBe(1)
    expect(await fetchConversationEncryption(CONVERSATION)).toBe(true)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
  })

  it('tells the database refusal of plaintext from other errors', () => {
    expect(isConversationEncryptedRefusal({ message: 'CONVERSATION_ENCRYPTED: this conversation is end-to-end encrypted' })).toBe(true)
    expect(isConversationEncryptedRefusal({ message: 'RECIPIENT_DELETED' })).toBe(false)
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
    expect(await fetchConversationEncryption(CONVERSATION)).toBe(true)
    expect(await conversationEncryptionEnabled(CONVERSATION)).toBe(true)
    expect(settingsReads()).toBe(2)
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
