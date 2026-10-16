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

vi.mock('@/services/core/messageLimits', () => ({
  messageLimits: vi.fn(async () => ({ maxLength: 2000, maxMedia: 20 })),
}))

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
import { forgetChannelEncryption } from '@/services/ChannelEncryptionService'

const CHANNEL_ENCRYPTED = {
  message: 'CHANNEL_ENCRYPTED: this channel is end-to-end encrypted and rejects plaintext messages',
}

/**
 * `state.channelEncrypted` is what effective_channel_encryption answers; `state.refusePlaintext`
 * makes the insert of a plaintext row fail as enforce_channel_message_encryption() does.
 */
function setup(channelEncrypted: boolean, options: { refusePlaintext?: boolean } = {}) {
  const inserted: any[] = []
  const state = { channelEncrypted, refusePlaintext: options.refusePlaintext === true }
  ;(supabase.rpc as any).mockImplementation((_fn: string, args: any) => Promise.resolve({
    data: {
      channel_id: args.p_channel_id,
      server_id: SERVER_ID,
      server_mode: 'optional',
      voice_mode: 'disabled',
      messages_encrypted: state.channelEncrypted,
    },
    error: null,
  }))
  ;(supabase.from as any).mockImplementation((table: string) => {
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
          const refused = state.refusePlaintext && !row.encrypted
          return {
            select: () => ({
              then: (resolve: any) => resolve(refused
                ? { data: null, error: CHANNEL_ENCRYPTED }
                : { data: [{ id: 'm1', ...row }], error: null }),
            }),
          }
        },
      }
    }
    throw new Error(`Unhandled table in test mock: ${table}`)
  })
  vi.spyOn(threadService, 'getThread').mockResolvedValue({ id: THREAD_ID, channel_id: CHANNEL_ID } as any)
  return Object.assign(inserted, { state })
}

describe('ThreadService.sendThreadMessage encryption', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forgetChannelEncryption()
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

  it('lists the attachments of an encrypted reply under the parent channel room', async () => {
    const inserted = setup(true)
    const path = `c/${CHANNEL_ID}/${PROFILE_ID}/a.png`
    await threadService.sendThreadMessage(THREAD_ID, [{ type: 'file', fileType: 'image', url: '', path } as any])
    expect(inserted[0].media_paths).toEqual([path])
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

  it('reads the channel state once for consecutive replies', async () => {
    const inserted = setup(false)
    await threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'one' }])
    await threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'two' }])
    expect(inserted).toHaveLength(2)
    expect(supabase.rpc).toHaveBeenCalledTimes(1)
  })

  it('re-sends encrypted when the database refuses plaintext into a channel encrypted since the last read', async () => {
    const inserted = setup(false)
    await threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'warm' }])
    inserted.length = 0
    inserted.state.channelEncrypted = true
    inserted.state.refusePlaintext = true

    const sent = await threadService.sendThreadMessage(THREAD_ID, [{ type: 'text', text: 'hi' }])

    expect(inserted.map((row) => row.encrypted)).toEqual([false, true])
    expect(sent).toMatchObject({ id: 'm1', encrypted: true })
  })
})
