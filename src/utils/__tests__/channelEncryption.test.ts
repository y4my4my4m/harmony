import { describe, it, expect } from 'vitest'
import {
  extractPlaintextMentionParts,
  isUndecrypted,
  parseEffectiveChannelEncryption,
  resolveChannelEncryption,
  undecryptedDisplayParts,
  withPlaintextMentions,
} from '@/utils/channelEncryption'

const ROLE_ID = '3f2b0f0e-5a0c-4a6e-9a55-1f4f8a2b9c01'

describe('resolveChannelEncryption', () => {
  const on = { messages_encrypted: true, voice_encrypted: true }
  const off = { messages_encrypted: false, voice_encrypted: false }

  it('treats a server without a policy row as disabled', () => {
    const r = resolveChannelEncryption(null, on)
    expect(r.serverMode).toBe('disabled')
    expect(r.messagesEncrypted).toBe(false)
    expect(r.voiceEncrypted).toBe(false)
    expect(r.messagesLocked).toBe(true)
    expect(r.voiceLocked).toBe(true)
  })

  it('lets the channel row decide under optional', () => {
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, on).messagesEncrypted).toBe(true)
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, off).messagesEncrypted).toBe(false)
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, null).messagesEncrypted).toBe(false)
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, off).messagesLocked).toBe(false)
  })

  it('forces messages on under both required modes, whatever the row says', () => {
    for (const mode of ['required', 'required_local_only']) {
      const r = resolveChannelEncryption({ encryption_mode: mode }, off)
      expect(r.messagesEncrypted).toBe(true)
      expect(r.messagesLocked).toBe(true)
    }
  })

  it('forces voice on when the server requires encrypted voice, even with messages disabled', () => {
    const r = resolveChannelEncryption({ encryption_mode: 'disabled', voice_encryption_mode: 'required' }, off)
    expect(r.voiceEncrypted).toBe(true)
    expect(r.voiceLocked).toBe(true)
    expect(r.messagesEncrypted).toBe(false)
  })

  it('lets the channel row decide voice unless messages are disabled or voice is required', () => {
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, on).voiceEncrypted).toBe(true)
    expect(resolveChannelEncryption({ encryption_mode: 'required' }, off).voiceEncrypted).toBe(false)
    expect(resolveChannelEncryption({ encryption_mode: 'required' }, off).voiceLocked).toBe(false)
  })

  it('defaults history visibility to joined', () => {
    expect(resolveChannelEncryption({ encryption_mode: 'optional' }, null).historyVisibility).toBe('joined')
    expect(resolveChannelEncryption(
      { encryption_mode: 'optional' },
      { ...on, history_visibility: 'shared' },
    ).historyVisibility).toBe('shared')
  })

  it('treats an unknown server mode as disabled', () => {
    expect(resolveChannelEncryption({ encryption_mode: 'bogus' }, on).messagesEncrypted).toBe(false)
  })
})

describe('parseEffectiveChannelEncryption', () => {
  it('maps the RPC jsonb', () => {
    const parsed = parseEffectiveChannelEncryption({
      channel_id: 'c1',
      server_id: 's1',
      server_mode: 'optional',
      voice_mode: 'disabled',
      messages_encrypted: true,
      voice_encrypted: false,
      messages_locked: false,
      voice_locked: false,
      history_visibility: 'joined',
      enabled_at: '2026-10-01T00:00:00Z',
      enabled_by: 'p1',
      bot_count: 2,
      bridge_count: 1,
    })
    expect(parsed).toEqual({
      channelId: 'c1',
      serverId: 's1',
      serverMode: 'optional',
      voiceMode: 'disabled',
      messagesEncrypted: true,
      voiceEncrypted: false,
      messagesLocked: false,
      voiceLocked: false,
      historyVisibility: 'joined',
      enabledAt: '2026-10-01T00:00:00Z',
      enabledBy: 'p1',
      botCount: 2,
      bridgeCount: 1,
    })
  })

  it('returns null for NULL and malformed input', () => {
    expect(parseEffectiveChannelEncryption(null)).toBeNull()
    expect(parseEffectiveChannelEncryption({})).toBeNull()
    expect(parseEffectiveChannelEncryption('x')).toBeNull()
  })

  it('reads a non-boolean messages_encrypted as off', () => {
    expect(parseEffectiveChannelEncryption({ channel_id: 'c1', messages_encrypted: 'true' })?.messagesEncrypted).toBe(false)
  })
})

describe('extractPlaintextMentionParts', () => {
  it('keeps only the keys the server accepts', () => {
    const parts = extractPlaintextMentionParts([
      { type: 'text', text: 'hello ' },
      { type: 'mention', userId: 'u1', username: 'bob', domain: 'harmony.test', isLocal: true, displayName: 'Bob' },
      { type: 'role_mention', roleId: ROLE_ID, roleName: 'Mods', roleColor: '#fff' },
      { type: 'emoji', emoji: { name: 'x' } },
    ] as any)
    expect(parts).toEqual([
      { type: 'mention', userId: 'u1', username: 'bob', domain: 'harmony.test', isLocal: true },
      { type: 'role_mention', roleId: ROLE_ID },
    ])
  })

  it('drops text, duplicates, empty usernames and non-uuid role ids', () => {
    const parts = extractPlaintextMentionParts([
      { type: 'mention', userId: 'u1', username: 'bob' },
      { type: 'mention', userId: 'u1', username: 'bob' },
      { type: 'mention', username: '' },
      { type: 'role_mention', roleId: 'everyone' },
      { type: 'role_mention', roleId: ROLE_ID },
      { type: 'role_mention', roleId: ROLE_ID.toUpperCase() },
    ] as any)
    expect(parts).toEqual([
      { type: 'mention', userId: 'u1', username: 'bob' },
      { type: 'role_mention', roleId: ROLE_ID },
    ])
  })

  it('keeps @here, the one role id that is no uuid', () => {
    const parts = extractPlaintextMentionParts([
      { type: 'role_mention', roleId: 'here', roleName: 'here', roleColor: null },
      { type: 'role_mention', roleId: 'here' },
      { type: 'role_mention', roleId: 'HERE' },
    ] as any)
    expect(parts).toEqual([{ type: 'role_mention', roleId: 'here' }])
  })

  it('drops fields beyond the server limits', () => {
    const parts = extractPlaintextMentionParts([
      { type: 'mention', username: 'x'.repeat(101) },
      { type: 'mention', username: 'ok', userId: 'u'.repeat(65), domain: 'd'.repeat(254) },
    ] as any)
    expect(parts).toEqual([{ type: 'mention', username: 'ok' }])
  })

  it('caps the number of parts at 100', () => {
    const many = Array.from({ length: 150 }, (_, i) => ({ type: 'mention', username: `u${i}` }))
    expect(extractPlaintextMentionParts(many as any)).toHaveLength(100)
  })

  it('returns nothing for non-array content', () => {
    expect(extractPlaintextMentionParts(null)).toEqual([])
    expect(extractPlaintextMentionParts('x' as any)).toEqual([])
  })
})

describe('withPlaintextMentions', () => {
  it('puts the ciphertext first and the mention parts after it', () => {
    const stored = withPlaintextMentions(
      [{ type: 'text', text: 'CIPHER' }] as any,
      [{ type: 'mention', userId: 'u1', username: 'bob', displayName: 'Bob' }, { type: 'text', text: 'secret' }] as any,
    )
    expect(stored).toEqual([
      { type: 'text', text: 'CIPHER' },
      { type: 'mention', userId: 'u1', username: 'bob' },
    ])
    expect(JSON.stringify(stored)).not.toContain('secret')
    expect(JSON.stringify(stored)).not.toContain('Bob')
  })

  it('refuses encrypted content without a ciphertext part', () => {
    expect(() => withPlaintextMentions([], [])).toThrow()
  })
})

describe('undecrypted rendering', () => {
  const stored = [
    { type: 'text', text: 'CIPHER' },
    { type: 'mention', userId: 'u1', username: 'injected' },
    { type: 'role_mention', roleId: ROLE_ID },
  ] as any

  it('renders the ciphertext part alone, never the plaintext parts beside it', () => {
    expect(undecryptedDisplayParts(stored)).toEqual([{ type: 'text', text: 'CIPHER' }])
  })

  it('renders nothing when the first part is not text', () => {
    expect(undecryptedDisplayParts([{ type: 'mention', username: 'x' }] as any)).toEqual([])
    expect(undecryptedDisplayParts(null)).toEqual([])
  })

  it('flags a message as undecrypted only while it is still ciphertext', () => {
    expect(isUndecrypted({ encrypted: true })).toBe(true)
    expect(isUndecrypted({ encrypted: true, decrypted: false })).toBe(true)
    expect(isUndecrypted({ encrypted: false, decrypted: true })).toBe(false)
    expect(isUndecrypted({ encrypted: false })).toBe(false)
    expect(isUndecrypted(null)).toBe(false)
  })
})
