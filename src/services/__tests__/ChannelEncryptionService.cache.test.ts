import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import {
  cachedEffectiveChannelEncryption,
  fetchEffectiveChannelEncryption,
  forgetChannelEncryption,
  setChannelEncryption,
} from '@/services/ChannelEncryptionService'

const SERVER_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const SERVER_B = 'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee'
const CHANNEL_A = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CHANNEL_B = 'ffffffff-ffff-ffff-ffff-ffffffffffff'

const encryptedByChannel = new Map<string, boolean>()
const serverOf: Record<string, string> = { [CHANNEL_A]: SERVER_A, [CHANNEL_B]: SERVER_B }
let pending: Array<() => void> | null = null

function row(channelId: string) {
  return {
    channel_id: channelId,
    server_id: serverOf[channelId],
    server_mode: 'optional',
    voice_mode: 'disabled',
    messages_encrypted: encryptedByChannel.get(channelId) === true,
  }
}

function effectiveReads(): number {
  return (supabase.rpc as any).mock.calls.filter(([fn]: [string]) => fn === 'effective_channel_encryption').length
}

function broadcast(table: string, fields: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent('server-structure:settings-change', { detail: { table, new: fields } }))
}

beforeEach(() => {
  vi.clearAllMocks()
  forgetChannelEncryption()
  encryptedByChannel.clear()
  pending = null
  ;(supabase.rpc as any).mockImplementation((fn: string, args: any) => {
    const answer = () => ({ data: row(args.p_channel_id), error: null })
    if (fn === 'set_channel_encryption') {
      encryptedByChannel.set(args.p_channel_id, args.p_messages_encrypted === true)
      return Promise.resolve(answer())
    }
    if (pending) {
      // Captures the answer at call time, as the database would.
      const snapshot = answer()
      return new Promise((resolve) => pending!.push(() => resolve(snapshot)))
    }
    return Promise.resolve(answer())
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('effective channel encryption cache', () => {
  it('answers a second read from the first', async () => {
    encryptedByChannel.set(CHANNEL_A, true)
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect(effectiveReads()).toBe(1)
  })

  it('shares one request between concurrent reads', async () => {
    const [a, b, c] = await Promise.all([
      cachedEffectiveChannelEncryption(CHANNEL_A),
      cachedEffectiveChannelEncryption(CHANNEL_A),
      fetchEffectiveChannelEncryption(CHANNEL_A),
    ])
    expect([a, b, c].map((s) => s?.channelId)).toEqual([CHANNEL_A, CHANNEL_A, CHANNEL_A])
    expect(effectiveReads()).toBe(1)
  })

  it('a fresh read, such as opening the channel, refreshes the entry the send uses', async () => {
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    encryptedByChannel.set(CHANNEL_A, true)
    await fetchEffectiveChannelEncryption(CHANNEL_A)
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect(effectiveReads()).toBe(2)
  })

  it('a channel row broadcast drops that channel only', async () => {
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    await cachedEffectiveChannelEncryption(CHANNEL_B)
    encryptedByChannel.set(CHANNEL_A, true)
    broadcast('channel_encryption_settings', { channel_id: CHANNEL_A, messages_encrypted: true })

    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    await cachedEffectiveChannelEncryption(CHANNEL_B)
    expect(effectiveReads()).toBe(3)
  })

  it('a server policy broadcast drops the channels of that server only', async () => {
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    await cachedEffectiveChannelEncryption(CHANNEL_B)
    broadcast('server_encryption_settings', { server_id: SERVER_A, encryption_mode: 'required' })

    await cachedEffectiveChannelEncryption(CHANNEL_A)
    await cachedEffectiveChannelEncryption(CHANNEL_B)
    expect(effectiveReads()).toBe(3)
  })

  it('a read overlapping a broadcast does not write its older answer back', async () => {
    pending = []
    const read = cachedEffectiveChannelEncryption(CHANNEL_A)
    encryptedByChannel.set(CHANNEL_A, true)
    broadcast('channel_encryption_settings', { channel_id: CHANNEL_A, messages_encrypted: true })
    pending.forEach((resolve) => resolve())
    expect((await read)?.messagesEncrypted).toBe(false)

    pending = null
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect(effectiveReads()).toBe(2)
  })

  it('set_channel_encryption writes its result as the entry', async () => {
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    await setChannelEncryption(CHANNEL_A, { messagesEncrypted: true })
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect(effectiveReads()).toBe(1)
  })

  it('forgetting every entry, as sign-out does, reads again', async () => {
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    forgetChannelEncryption()
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    expect(effectiveReads()).toBe(2)
  })

  it('an entry past the TTL answers at once and refreshes behind the answer', async () => {
    vi.useFakeTimers()
    await cachedEffectiveChannelEncryption(CHANNEL_A)
    encryptedByChannel.set(CHANNEL_A, true)
    vi.advanceTimersByTime(5 * 60_000)

    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(false)
    expect(effectiveReads()).toBe(2)
    await vi.runAllTimersAsync()
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.messagesEncrypted).toBe(true)
    expect(effectiveReads()).toBe(2)
  })

  it('does not keep a failed read', async () => {
    ;(supabase.rpc as any).mockResolvedValueOnce({ data: null, error: { message: 'down' } })
    await expect(cachedEffectiveChannelEncryption(CHANNEL_A)).rejects.toMatchObject({ message: 'down' })
    expect((await cachedEffectiveChannelEncryption(CHANNEL_A))?.channelId).toBe(CHANNEL_A)
    expect(effectiveReads()).toBe(2)
  })
})
