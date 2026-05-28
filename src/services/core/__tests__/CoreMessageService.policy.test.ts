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
          algorithm: 'megolm_v1',
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
// and supabase.from('messages').insert(...).select('*').single().
function setupSupabase({
  encryptionMode,
  conversationEnabled,
  maxMediaConfig,
  insertedMessage,
}: {
  encryptionMode?: 'disabled' | 'optional' | 'required'
  conversationEnabled?: boolean
  maxMediaConfig?: number
  insertedMessage?: any
} = {}) {
  const insertedRows: any[] = []

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
    if (table === 'server_encryption_settings') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: encryptionMode ? { encryption_mode: encryptionMode } : null,
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
          return {
            select: () => ({
              single: () => Promise.resolve({
                data: insertedMessage ?? { id: 'msg-1', ...row },
                error: null,
              }),
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
    it('inserts plaintext when server has encryption disabled', async () => {
      const { insertedRows } = setupSupabase({ encryptionMode: 'disabled' })

      const msg = await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        { type: 'text', text: 'hi' },
      ] as any)

      expect(msg).toBeDefined()
      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].content).toEqual([{ type: 'text', text: 'hi' }])
    })

    it('encrypts when optional + keys unlocked', async () => {
      const { insertedRows } = setupSupabase({ encryptionMode: 'optional' })

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        { type: 'text', text: 'hi' },
      ] as any)

      expect(insertedRows[0].encrypted).toBe(true)
      expect(insertedRows[0].encryption_metadata?.algorithm).toBe('megolm_v1')
    })

    it('fails closed on optional + encryption locked', async () => {
      setupSupabase({ encryptionMode: 'optional' })
      encState.isUnlocked = false

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_LOCKED' })
    })

    it('silently sends plaintext on optional + no recovery key (user never opted in)', async () => {
      // Behavior change: in OPTIONAL mode, a user who has never set up
      // encryption is fully within policy to send plaintext. Don't prompt
      // them on every send - they never opted in. Only LOCKED (they did
      // opt in but forgot to unlock) and FAILED (encrypt attempted, threw)
      // should fail closed.
      const { insertedRows } = setupSupabase({ encryptionMode: 'optional' })
      encState.hasRecoveryKey = false

      const msg = await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        { type: 'text', text: 'hi' },
      ] as any)

      expect(msg).toBeDefined()
      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override?.authorized).toBe(true)
      expect(insertedRows[0].metadata?.plaintext_override?.reason).toBe('optional_no_recovery_key')
    })

    it('fails closed on optional + encryption throws', async () => {
      setupSupabase({ encryptionMode: 'optional' })
      encState.throwOnEncrypt = true

      await expect(
        service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'hi' }] as any),
      ).rejects.toMatchObject({ code: 'ENCRYPTION_FAILED_NO_FALLBACK' })
    })

    it('still rejects on required mode even with explicit override', async () => {
      setupSupabase({ encryptionMode: 'required' })
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
      ).rejects.toMatchObject({ code: 'ENCRYPTION_LOCKED' })
    })

    it('allows plaintext when override is explicit (optional + locked)', async () => {
      const { insertedRows } = setupSupabase({ encryptionMode: 'optional' })
      encState.isUnlocked = false

      const msg = await service.sendChannelMessage(
        SERVER_ID,
        CHANNEL_ID,
        [{ type: 'text', text: 'hi' }] as any,
        undefined,
        undefined,
        { allowPlaintextFallback: true },
      )

      expect(msg).toBeDefined()
      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override?.authorized).toBe(true)
      expect(insertedRows[0].metadata?.plaintext_override?.reason).toBe('optional_encryption_locked')
    })

    it('allows plaintext when override is explicit (optional + encrypt throws)', async () => {
      const { insertedRows } = setupSupabase({ encryptionMode: 'optional' })
      encState.throwOnEncrypt = true

      await service.sendChannelMessage(
        SERVER_ID,
        CHANNEL_ID,
        [{ type: 'text', text: 'hi' }] as any,
        undefined,
        undefined,
        { allowPlaintextFallback: true },
      )

      expect(insertedRows[0].encrypted).toBe(false)
      expect(insertedRows[0].metadata?.plaintext_override?.reason).toBe('optional_encrypt_failed')
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
