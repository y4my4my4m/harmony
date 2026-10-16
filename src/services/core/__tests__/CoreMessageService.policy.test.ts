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

const limits = { maxLength: 2000, maxMedia: 20 }
vi.mock('@/services/core/messageLimits', () => ({
  messageLimits: vi.fn(async () => ({ ...limits })),
}))

import { CoreMessageService } from '@/services/core/CoreMessageService'
import { forgetChannelEncryption } from '@/services/ChannelEncryptionService'
import { forgetConversationEncryption } from '@/services/conversationEncryption'

const CHANNEL_ENCRYPTED = {
  message: 'CHANNEL_ENCRYPTED: this channel is end-to-end encrypted and rejects plaintext messages',
}

// Tiny chainable mock for supabase.from(...).select(...).eq(...).maybeSingle()
// and supabase.from('messages').insert(...).select('*'), awaited as an array
// (channel sends) or through .single() (DMs).
function setupSupabase({
  channelEncrypted,
  rpcError,
  conversationEnabled,
  insertedMessage,
  insertError,
  insertDropped,
  blockNotice,
  refusePlaintext,
}: {
  channelEncrypted?: boolean
  rpcError?: boolean
  conversationEnabled?: boolean
  insertedMessage?: any
  insertError?: { message: string }
  /** Channel insert returns no row, as when AutoMod drops it. */
  insertDropped?: boolean
  blockNotice?: any
  /** A plaintext channel row fails as enforce_channel_message_encryption() fails it. */
  refusePlaintext?: boolean
} = {}) {
  /** enforce_conversation_message_encryption(): unconsented plaintext into an encrypted conversation. */
  const conversationRefusal = (row: any) =>
    row.conversation_id && state.conversationEnabled && !row.encrypted
      && row.metadata?.plaintext_override?.authorized !== true
      ? { message: 'CONVERSATION_ENCRYPTED: this conversation is end-to-end encrypted and rejects plaintext messages' }
      : undefined
  const insertedRows: any[] = []
  /** Mutable after setup: what the database answers from then on. */
  const state = {
    channelEncrypted: channelEncrypted === true,
    conversationEnabled: conversationEnabled === true,
    refusePlaintext: refusePlaintext === true,
  }

  ;(supabase.rpc as any).mockImplementation((fn: string, args: any) => {
    if (fn === 'get_automod_block_notice') return Promise.resolve({ data: blockNotice ?? null, error: null })
    if (fn !== 'effective_channel_encryption') throw new Error(`Unhandled rpc in test mock: ${fn}`)
    if (rpcError) return Promise.resolve({ data: null, error: { message: 'rpc down' } })
    return Promise.resolve({
      data: {
        channel_id: args.p_channel_id,
        server_id: SERVER_ID,
        server_mode: state.channelEncrypted ? 'optional' : 'disabled',
        voice_mode: 'disabled',
        messages_encrypted: state.channelEncrypted,
        voice_encrypted: false,
        messages_locked: !state.channelEncrypted,
        voice_locked: true,
        history_visibility: 'joined',
        bot_count: 0,
        bridge_count: 0,
      },
      error: null,
    })
  })

  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'conversation_encryption_settings') {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: () => Promise.resolve({
              data: state.conversationEnabled ? { encryption_enabled: true } : null,
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
          const error = insertError ?? (state.refusePlaintext && row.channel_id && !row.encrypted
            ? CHANNEL_ENCRYPTED
            : conversationRefusal(row))
          return {
            select: () => ({
              single: () => Promise.resolve(error
                ? { data: null, error }
                : { data: one, error: null }),
              then: (resolve: any) => resolve(error
                ? { data: null, error }
                : { data: insertDropped ? [] : [one], error: null }),
            }),
          }
        },
      }
    }
    throw new Error(`Unhandled table in test mock: ${table}`)
  })

  return { insertedRows, state }
}

/** Calls the send made of PostgREST, other than the insert itself. */
function readsBesideInsert(): string[] {
  const tables = (supabase.from as any).mock.calls.map(([table]: [string]) => table)
    .filter((table: string) => table !== 'messages')
  const rpcs = (supabase.rpc as any).mock.calls.map(([fn]: [string]) => `rpc:${fn}`)
  return [...tables, ...rpcs]
}

describe('CoreMessageService - encryption policy (fail-closed by default)', () => {
  let service: CoreMessageService

  beforeEach(() => {
    vi.clearAllMocks()
    forgetChannelEncryption()
    forgetConversationEncryption()
    limits.maxLength = 2000
    limits.maxMedia = 20
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

    it('lists the attachments of an encrypted channel message in media_paths', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: true })
      const path = `c/${CHANNEL_ID}/${CURRENT_USER_ID}/a.png`

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [
        { type: 'file', fileType: 'image', url: '', path },
      ] as any)
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'no files' }] as any)

      expect(insertedRows[0].media_paths).toEqual([path])
      expect(insertedRows[1].media_paths).toEqual([])
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

    it('lists the attachments of an encrypted DM in media_paths; a plaintext DM carries none', async () => {
      const path = `d/${CONVERSATION_ID}/${CURRENT_USER_ID}/a.png`
      const parts = [{ type: 'file', fileType: 'image', url: '', path }, { type: 'text', text: 'hi' }] as any
      const { insertedRows } = setupSupabase({ conversationEnabled: true })
      await service.sendDMMessage(CONVERSATION_ID, parts)
      expect(insertedRows[0].media_paths).toEqual([path])

      forgetConversationEncryption()
      const plain = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, parts)
      expect(plain.insertedRows[0]).not.toHaveProperty('media_paths')
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

    it('reports a conversation whose recipient deleted their account', async () => {
      setupSupabase({
        insertError: { message: 'RECIPIENT_DELETED: the other participant deleted their account' },
      })

      await expect(
        service.sendDMMessage(CONVERSATION_ID, [{ type: 'text', text: 'hello?' }] as any),
      ).rejects.toMatchObject({ code: 'RECIPIENT_DELETED' })
    })
  })

  describe('round trips', () => {
    const hi = [{ type: 'text', text: 'hi' }] as any

    it('a second channel send reads nothing before the insert', async () => {
      const { insertedRows } = setupSupabase({ channelEncrypted: false })
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      vi.clearAllMocks()

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)

      expect(insertedRows).toHaveLength(2)
      expect(readsBesideInsert()).toEqual([])
    })

    it('a channel the server-structure broadcast reports changed is read again', async () => {
      setupSupabase({ channelEncrypted: false })
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      window.dispatchEvent(new CustomEvent('server-structure:settings-change', {
        detail: { table: 'channel_encryption_settings', new: { channel_id: CHANNEL_ID, messages_encrypted: true } },
      }))
      vi.clearAllMocks()

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)

      expect(readsBesideInsert()).toEqual(['rpc:effective_channel_encryption'])
    })

    it('re-sends encrypted once when the database refuses plaintext into a channel encrypted since the last read', async () => {
      const { insertedRows, state } = setupSupabase({ channelEncrypted: false })
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      insertedRows.length = 0
      state.channelEncrypted = true
      state.refusePlaintext = true

      const sent = await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)

      expect(insertedRows.map((row) => row.encrypted)).toEqual([false, true])
      expect(insertedRows[1].content).toEqual([{ type: 'text', text: 'CIPHERTEXT' }])
      expect(sent).toMatchObject({ encrypted: true })

      // The re-read answer is kept: the next send encrypts without a refusal.
      insertedRows.length = 0
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      expect(insertedRows.map((row) => row.encrypted)).toEqual([true])
    })

    it('keeps the changed refusal when the sender cannot encrypt the re-send', async () => {
      const { insertedRows, state } = setupSupabase({ channelEncrypted: false })
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      insertedRows.length = 0
      state.channelEncrypted = true
      state.refusePlaintext = true
      encState.isUnlocked = false

      await expect(service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi))
        .rejects.toMatchObject({ code: 'ENCRYPTION_REQUIRED', reason: 'changed' })
      expect(insertedRows.map((row) => row.encrypted)).toEqual([false])
    })

    it('checks the limits before the channel state, with the limits read from the store', async () => {
      setupSupabase({ rpcError: true })
      limits.maxLength = 3

      await expect(service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [{ type: 'text', text: 'four' }] as any))
        .rejects.toMatchObject({ code: 'MESSAGE_TOO_LONG' })

      limits.maxLength = 2000
      limits.maxMedia = 1
      const file = { type: 'file', fileType: 'image', url: 'https://example.test/a.png' }
      await expect(service.sendChannelMessage(SERVER_ID, CHANNEL_ID, [file, file] as any))
        .rejects.toMatchObject({ code: 'TOO_MANY_ATTACHMENTS' })
    })

    it('a second DM send reads nothing before the insert', async () => {
      const { insertedRows } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      vi.clearAllMocks()

      await service.sendDMMessage(CONVERSATION_ID, hi)

      expect(insertedRows).toHaveLength(2)
      expect(readsBesideInsert()).toEqual([])
    })

    it('re-sends encrypted once when the database refuses plaintext into a conversation encrypted since the last read', async () => {
      const { insertedRows, state } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      state.conversationEnabled = true
      insertedRows.length = 0
      vi.clearAllMocks()

      const sent = await service.sendDMMessage(CONVERSATION_ID, hi)

      expect(insertedRows.map((row) => row.encrypted)).toEqual([false, true])
      expect(sent).toMatchObject({ encrypted: true })
      expect(readsBesideInsert()).toEqual(['conversation_encryption_settings', 'conversation_participants'])

      // The re-read answer is kept: the next send encrypts without a refusal.
      insertedRows.length = 0
      await service.sendDMMessage(CONVERSATION_ID, hi)
      expect(insertedRows.map((row) => row.encrypted)).toEqual([true])
    })

    it('a sender who cannot encrypt the re-send gets the encryption-required refusal', async () => {
      const { insertedRows, state } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      state.conversationEnabled = true
      encState.isUnlocked = false
      insertedRows.length = 0

      await expect(service.sendDMMessage(CONVERSATION_ID, hi)).rejects.toMatchObject({ code: 'ENCRYPTION_LOCKED' })
      expect(insertedRows.map((row) => row.encrypted)).toEqual([false])
    })

    it('a consented plaintext re-send carries the override the database accepts', async () => {
      const { insertedRows, state } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      state.conversationEnabled = true
      encState.isUnlocked = false
      insertedRows.length = 0

      await service.sendDMMessage(CONVERSATION_ID, hi, undefined, { allowPlaintextFallback: true })
      expect(insertedRows.map((row) => row.metadata?.plaintext_override?.authorized ?? false)).toEqual([false, true])
    })

    it('a conversation:encryption notice answers the next DM send', async () => {
      const { insertedRows, state } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      state.conversationEnabled = true
      window.dispatchEvent(new CustomEvent('dm-encryption-toggled', {
        detail: { conversationId: CONVERSATION_ID, enabled: true },
      }))
      insertedRows.length = 0

      await service.sendDMMessage(CONVERSATION_ID, hi)
      expect(insertedRows.map((row) => row.encrypted)).toEqual([true])
    })

    it('this client\'s toggle answers the next DM send', async () => {
      const { insertedRows } = setupSupabase({ conversationEnabled: false })
      await service.sendDMMessage(CONVERSATION_ID, hi)
      window.dispatchEvent(new CustomEvent('dm-encryption-toggled', {
        detail: { conversationId: CONVERSATION_ID, enabled: true },
      }))
      vi.clearAllMocks()
      insertedRows.length = 0

      await service.sendDMMessage(CONVERSATION_ID, hi)

      expect(insertedRows.map((row) => row.encrypted)).toEqual([true])
      expect(readsBesideInsert()).toEqual(['conversation_participants'])
    })

    it('sign-out drops the answers', async () => {
      setupSupabase({ channelEncrypted: false, conversationEnabled: false })
      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      await service.sendDMMessage(CONVERSATION_ID, hi)
      forgetChannelEncryption()
      forgetConversationEncryption()
      vi.clearAllMocks()

      await service.sendChannelMessage(SERVER_ID, CHANNEL_ID, hi)
      await service.sendDMMessage(CONVERSATION_ID, hi)

      expect(readsBesideInsert()).toEqual(['conversation_encryption_settings', 'rpc:effective_channel_encryption'])
    })
  })

  // System notices are written by the database; the client names the event only.
  describe('notices', () => {
    it('asks the database for the thread notice', async () => {
      ;(supabase.rpc as any).mockResolvedValue({ data: 'notice-id', error: null })

      expect(await service.postThreadCreatedNotice('thread-1')).toEqual({ error: null })
      expect(supabase.rpc).toHaveBeenCalledWith('post_thread_created_notice', { p_thread_id: 'thread-1' })
      expect(supabase.from).not.toHaveBeenCalled()
    })

    it('asks the database for group notices', async () => {
      ;(supabase.rpc as any).mockResolvedValue({ data: 'notice-id', error: null })

      await service.postGroupConversationNotice(CONVERSATION_ID)
      await service.postGroupConversationNotice(CONVERSATION_ID, ['u1', 'u2'])

      expect(supabase.rpc).toHaveBeenNthCalledWith(1, 'post_group_conversation_notice', {
        p_conversation_id: CONVERSATION_ID, p_added_user_ids: null,
      })
      expect(supabase.rpc).toHaveBeenNthCalledWith(2, 'post_group_conversation_notice', {
        p_conversation_id: CONVERSATION_ID, p_added_user_ids: ['u1', 'u2'],
      })
      expect(supabase.from).not.toHaveBeenCalled()
    })
  })
})
