import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

const PROFILE_ID = '11111111-1111-1111-1111-111111111111'
const SERVER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CHANNEL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const THREAD_ID = 'dddddddd-dddd-dddd-dddd-dddddddddddd'

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentProfileId: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
  },
}))

vi.mock('@/utils/messageEmbedUtils', () => ({ ensureMessageEmbeds: vi.fn() }))

const enc = { hasRecoveryKey: true, isUnlocked: true }
const encryptMessage = vi.fn(async (_content: any, _room: string, _recipients: string[]) => ({
  encrypted: true,
  content: [{ type: 'text', text: 'CIPHERTEXT' }],
  encryption_metadata: { algorithm: 'megolm_v3', session_id: 's', message_index: 0 },
}))

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: {
    isInitialized: () => true,
    initialize: vi.fn(),
    hasRecoveryKey: vi.fn(async () => enc.hasRecoveryKey),
    isUnlocked: () => enc.isUnlocked,
    encryptMessage: (...args: [any, string, string[]]) => encryptMessage(...args),
  },
}))

import { threadService } from '@/services/ThreadService'

function setup(channelEncrypted: boolean) {
  const inserted: any[] = []
  ;(supabase.rpc as any).mockImplementation((_fn: string, args: any) => Promise.resolve({
    data: {
      channel_id: args.p_channel_id,
      server_id: SERVER_ID,
      server_mode: 'optional',
      voice_mode: 'disabled',
      messages_encrypted: channelEncrypted,
    },
    error: null,
  }))
  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'instance_config') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }
    }
    if (table === 'channels') {
      return {
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { server_id: SERVER_ID }, error: null }) }) }),
      }
    }
    if (table === 'user_servers') {
      return { select: () => ({ eq: () => Promise.resolve({ data: [{ user_id: PROFILE_ID }], error: null }) }) }
    }
    if (table === 'messages') {
      return {
        insert: (row: any) => {
          inserted.push(row)
          return {
            select: () => ({
              single: () => Promise.resolve({ data: { id: 'm1', ...row }, error: null }),
              then: (resolve: any) => resolve({ data: [{ id: 'm1', ...row }], error: null }),
            }),
          }
        },
      }
    }
    throw new Error(`Unhandled table in test mock: ${table}`)
  })
  vi.spyOn(threadService, 'getThread').mockResolvedValue({ id: THREAD_ID, channel_id: CHANNEL_ID } as any)
  return inserted
}

describe('ThreadService.sendThreadMessage encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    enc.hasRecoveryKey = true
    enc.isUnlocked = true
  })

  it('sends plaintext in a thread of an unencrypted channel', async () => {
    const inserted = setup(false)
    await threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'hi' }])
    expect(inserted[0]).toMatchObject({ encrypted: false, content: [{ type: 'text', text: 'hi' }], channel_id: CHANNEL_ID })
    expect(supabase.rpc).toHaveBeenCalledWith('effective_channel_encryption', { p_channel_id: CHANNEL_ID })
  })

  it('encrypts under the parent channel room and keeps mention parts beside the ciphertext', async () => {
    const inserted = setup(true)
    await threadService.sendThreadMessage(THREAD_ID, [
      { type: 'role_mention', roleId: '3f2b0f0e-5a0c-4a6e-9a55-1f4f8a2b9c01', roleName: 'Mods', roleColor: null },
      { type: 'text', text: ' ping' },
    ])
    expect(encryptMessage).toHaveBeenCalledWith(expect.any(Array), CHANNEL_ID, [PROFILE_ID])
    expect(inserted[0].encrypted).toBe(true)
    expect(inserted[0].content).toEqual([
      { type: 'text', text: 'CIPHERTEXT' },
      { type: 'role_mention', roleId: '3f2b0f0e-5a0c-4a6e-9a55-1f4f8a2b9c01' },
    ])
  })

  it('refuses a sender without keys instead of sending plaintext', async () => {
    const inserted = setup(true)
    enc.hasRecoveryKey = false
    await expect(
      threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'hi' }], undefined, undefined, {
        allowPlaintextFallback: true,
      }),
    ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'setup' })
    expect(inserted).toHaveLength(0)
  })
})
