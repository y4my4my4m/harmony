import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'

const CURRENT_USER_ID = '11111111-1111-1111-1111-111111111111'
const SERVER_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'
const CHANNEL_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'
const CONVERSATION_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc'

vi.mock('@/services/userDataService', () => ({
  userDataService: {
    getCurrentUser: vi.fn(() => ({ id: '11111111-1111-1111-1111-111111111111' })),
  },
}))

vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentProfileId: vi.fn().mockResolvedValue('11111111-1111-1111-1111-111111111111'),
    getCurrentContext: vi.fn().mockResolvedValue({
      isAuthenticated: true,
      authUser: { id: '11111111-1111-1111-1111-111111111111' },
      profileId: '11111111-1111-1111-1111-111111111111',
    }),
  },
}))

// Stub the lazy encryption import. We override the behavior per test via
// `mockEncryptionService`.
let encState: {
  hasService: boolean
  initialized: boolean
  hasRecoveryKey: boolean
  isUnlocked: boolean
  throwOnEncrypt: boolean
} = {
  hasService: true,
  initialized: true,
  hasRecoveryKey: true,
  isUnlocked: true,
  throwOnEncrypt: false,
}

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({
  megolmMessageEncryptionService: {
    isInitialized: () => encState.initialized,
    initialize: vi.fn().mockResolvedValue(undefined),
    hasRecoveryKey: vi.fn(async () => encState.hasRecoveryKey),
    isUnlocked: () => encState.isUnlocked,
    encryptMessage: vi.fn(async (_content: any) => {
      if (encState.throwOnEncrypt) throw new Error('synthetic encrypt failure')
      return {
        encrypted: true,
        content: [{ type: 'text', text: 'CIPHERTEXT' }],
        encryption_metadata: {
          algorithm: 'megolm_v3',
          session_id: 'session-xyz',
          message_index: 0,
          sender_user_id: 'user',
          timestamp: Date.now(),
        },
      }
    }),
  },
}))

import { CoreMessageService } from '@/services/core/CoreMessageService'

// Tiny chainable mock for supabase.from(...).select(...).eq(...).maybeSingle()
// and supabase.from('messages').insert(...).select('*'), awaited as an array
// (channel sends) or through .single() (DMs).
function setupSupabase({
  channelEncrypted,
  rpcError,
  conversationEnabled,
  maxMediaConfig,
  insertedMessage,
  insertError,
  insertDropped,
  blockNotice,
}: {
  channelEncrypted?: boolean
  rpcError?: boolean
  conversationEnabled?: boolean
  maxMediaConfig?: number
  insertedMessage?: any
  insertError?: { message: string }
  /** Channel insert returns no row, as when AutoMod drops it. */
  insertDropped?: boolean
  blockNotice?: any
} = {}) {
  const insertedRows: any[] = []

  ;(supabase.rpc as any).mockImplementation((fn: string, args: any) => {
    if (fn === 'get_automod_block_notice') return Promise.resolve({ data: blockNotice ?? null, error: null })
    if (fn !== 'effective_channel_encryption') throw new Error(`Unhandled rpc in test mock: ${fn}`)
    if (rpcError) return Promise.resolve({ data: null, error: { message: 'rpc down' } })
    return Promise.resolve({
      data: {
        channel_id: args.p_channel_id,
        server_id: SERVER_ID,
        server_mode: channelEncrypted ? 'optional' : 'disabled',
        voice_mode: 'disabled',
        messages_encrypted: channelEncrypted === true,
        voice_encrypted: false,
        messages_locked: !channelEncrypted,
        voice_locked: true,
        history_visibility: 'joined',
        bot_count: 0,
        bridge_count: 0,
      },
      error: null,
    })
  })

  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'instance_config') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: { config_value: maxMediaConfig ?? 20 },
              error: null,
            }),
          }),
        }),
      }
    }
    if (table === 'conversation_encryption_settings') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: conversationEnabled ? { encryption_enabled: true } : null,
              error: null,
            }),
          }),
        }),
      }
    }
    if (table === 'user_servers') {
      return {
        select: () => ({ eq: () => Promise.resolve({ data: [{ user_id: CURRENT_USER_ID }], error: null }) }),
      }
    }
    if (table === 'conversation_participants') {
      return {
        select: () => ({
          eq: () => ({
            is: () => Promise.resolve({ data: [{ user_id: CURRENT_USER_ID }], error: null }),
          }),
        }),
      }
    }
    if (table === 'messages') {
      return {
        insert: (row: any) => {
          insertedRows.push(row)
          const one = insertedMessage ?? { id: 'msg-1', ...row }
          return {
            select: () => ({
              single: () => Promise.resolve(insertError
                ? { data: null, error: insertError }
                : { data: one, error: null }),
              then: (resolve: any) => resolve(insertError
                ? { data: null, error: insertError }
                : { data: insertDropped ? [] : [one], error: null }),
            }),
          }
        },
      }
    }
    throw new Error(`Unhandled table in test mock: ${table}`)
  })

  return { insertedRows }
}

describe('CoreMessageService - encryption policy (fail-closed by default)', () => {
  let service: CoreMessageService

  beforeEach(() => {
    vi.clearAllMocks()
    service = CoreMessageService.getInstance()
    encState = {
      hasService: true,
      initialized: true,
      hasRecoveryKey: true,
      isUnlocked: true,
      throwOnEncrypt: false,
    }
  })

  describe('sendChannelMessage', () => {
    const MENTION = {
      type: 'mention',
      userId: '22222222-2222-2222-2222-222222222222',
      username: 'bob',
      domain: 'harmony.test',
      isLocal: true,
      displayName: 'Bob Display',
    }

    it('inserts plaintext when the channel is not encrypted', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: false })

      const msg = await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        { type: 'text', text: 'hi' },
      ] as any)

      expect(msg).toBeDefined()
      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].content).toEqual([{ type: 'text', text: 'hi' }])
      expect(supabase.rpc).toHaveBeenCalledWith('effective_channel_encryption', { p_channel_id: CHANNEL_ID })
    })

    it('does not encrypt an unencrypted channel even when the sender holds keys', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: false })

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any)

      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override).toBeUndefined()
    })

    it('encrypts in an encrypted channel and stores mention parts beside the ciphertext', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: true })

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        MENTION,
        { type: 'text', text: ' hi' },
      ] as any)

      expect(insertedRows[0].encrypted).toBe(true)
      expect(insertedRows[0].encryption_metadata?.algorithm).toBe('megolm_v3')
      expect(insertedRows[0].content).toEqual([
        { type: 'text', text: 'CIPHERTEXT' },
        {
          type: 'mention',
          userId: '22222222-2222-2222-2222-222222222222',
          username: 'bob',
          domain: 'harmony.test',
          isLocal: true,
        },
      ])
    })

    it('asks a sender without keys to set up encryption instead of sending plaintext', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: true })
      encState.hasRecoveryKey = false

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'setup' })
      expect(insertedRows).toHaveLength(0)
    })

    it('asks a sender with locked keys to unlock, whatever the fallback option says', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: true })
      encState.isUnlocked = false

      await expect(
        service.sendChannelMessage(
          SERVER_ID,
          CHANNEL_ID,
          [{ type: 'text', text: 'hi' }] as any,
          undefined,
          undefined,
          { allowPlaintextFallback: true },
        ),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'unlock' })
      expect(insertedRows).toHaveLength(0)
    })

    it('refuses to send when encryption throws', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: true })
      encState.throwOnEncrypt = true

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'failed' })
      expect(insertedRows).toHaveLength(0)
    })

    it('refuses to send when the channel state cannot be read', async () => {
      const { insertedRows } = setupSupabase({ rpcError: true })

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'unavailable' })
      expect(insertedRows).toHaveLength(0)
    })

    it('reports a database plaintext rejection as a changed channel', async () => {
      setupSupabase({
        channelEncrypted: false,
        insertError: { message: 'CHANNEL_ENCRYPTED: this channel is end-to-end encrypted and rejects plaintext messages' },
      })

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'changed' })
    })

    it('reports a row AutoMod dropped with the server\'s reason', async () => {
      setupSupabase({
        channelEncrypted: false,
        insertDropped: true,
        blockNotice: { rule_type: 'keyword', rule_name: 'Words', event_type: 'message', message: 'Keep it clean.', timeout_until: null },
      })

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'bad' }] as any),
      ).rejects.toMatchObject({ code: 'AUTOMOD_BLOCKED', message: 'Keep it clean.' })
      expect(supabase.rpc).toHaveBeenCalledWith('get_automod_block_notice', { p_channel_id: CHANNEL_ID })
    })

    it('reports a member timeout raised by the database', async () => {
      setupSupabase({
        channelEncrypted: false,
        insertError: { message: 'MEMBER_TIMED_OUT:1790000000' },
      })

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'MEMBER_TIMED_OUT' })
    })
  })

  describe('sendDMMessage', () => {
    it('inserts plaintext when conversation has encryption disabled', async () => {
      const { insertedRows } = setupSupabase({ conversationEnabled: false })

      await service.sendDMMessage(CONVERSATION_ID, [{ type: 'text', text: 'hello' }] as any)

      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override).toBeUndefined()
    })

    it('encrypts when conversation enabled and keys unlocked', async () => {
      const { insertedRows } = setupSupabase({ conversationEnabled: true })

      await service.sendDMMessage(CONVERSATION_ID, [{ type: 'text', text: 'hello' }] as any)

      expect(insertedRows[0].encrypted).toBe(true)
    })

    it('fails closed when conversation enabled and keys locked', async () => {
      setupSupabase({ conversationEnabled: true })
      encState.isUnlocked = false

      await expect(
        service.sendDMMessage(CONVERSATION_ID, [{ type: 'text', text: 'hello' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_LOCKED' })
    })

    it('fails closed when conversation enabled and encrypt throws', async () => {
      setupSupabase({ conversationEnabled: true })
      encState.throwOnEncrypt = true

      await expect(
        service.sendDMMessage(CONVERSATION_ID, [{ type: 'text', text: 'hello' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_FAILED_NO_FALLBACK' })
    })

    it('allows plaintext only with explicit override', async () => {
      const { insertedRows } = setupSupabase({ conversationEnabled: true })
      encState.isUnlocked = false

      await service.sendDMMessage(
        CONVERSATION_ID,
        [{ type: 'text', text: 'hello' }] as any,
        undefined,
        { allowPlaintextFallback: true },
      )

      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override?.reason).toBe('dm_encryption_locked')
    })
  })
})
