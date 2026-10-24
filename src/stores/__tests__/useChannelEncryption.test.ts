import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'

const capabilities = vi.hoisted(() => ({ encryptedHistory: true }))
vi.mock('@/services/instanceCapabilities', () => ({
  hasCapability: (name: string) => name === 'encrypted-history' && capabilities.encryptedHistory,
}))

const SERVER_ID = 's1'

function mockTables(policy: Record<string, any> | null, rows: Record<string, any>[]) {
  ;(supabase.from as any).mockImplementation((table: string) => {
    if (table === 'server_encryption_settings') {
      return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: policy, error: null }) }) }) }
    }
    if (table === 'channel_encryption_settings') {
      return { select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) }
    }
    throw new Error(`Unhandled table in test mock: ${table}`)
  })
}

describe('useChannelEncryptionStore', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })

  it('asks an instance before 1.9.0 only for the columns it has, and reads the encryption', async () => {
    capabilities.encryptedHistory = false
    let columns = ''
    ;(supabase.from as any).mockImplementation((table: string) => {
      if (table === 'server_encryption_settings') {
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { encryption_mode: 'optional' }, error: null }) }) }) }
      }
      return {
        select: (cols: string) => {
          columns = cols
          return { in: () => Promise.resolve({ data: [{ channel_id: 'c1', messages_encrypted: true, voice_encrypted: false }], error: null }) }
        },
      }
    })
    const store = useChannelEncryptionStore()
    await store.loadServer(SERVER_ID, ['c1'])
    expect(columns).not.toContain('history_visibility')
    expect(store.isMessagesEncrypted('c1')).toBe(true)
    capabilities.encryptedHistory = true
    await useChannelEncryptionStore().loadServer('s2', ['c1'])
    expect(columns).toContain('history_visibility')
  })

  it('knows nothing about a channel until its server has loaded', () => {
    const store = useChannelEncryptionStore()
    expect(store.stateFor('c1')).toBeNull()
    expect(store.isMessagesEncrypted('c1')).toBe(false)
  })

  it('resolves loaded rows against the server floor', async () => {
    mockTables({ encryption_mode: 'optional', voice_encryption_mode: 'disabled' }, [
      { channel_id: 'c1', messages_encrypted: true, voice_encrypted: false },
      { channel_id: 'c2', messages_encrypted: false, voice_encrypted: true },
    ])
    const store = useChannelEncryptionStore()
    await store.loadServer(SERVER_ID, ['c1', 'c2', 'c3'])

    expect(store.isMessagesEncrypted('c1')).toBe(true)
    expect(store.isMessagesEncrypted('c2')).toBe(false)
    expect(store.isVoiceEncrypted('c2')).toBe(true)
    expect(store.isMessagesEncrypted('c3')).toBe(false)
  })

  it('follows server and channel broadcasts', async () => {
    mockTables({ encryption_mode: 'optional' }, [{ channel_id: 'c1', messages_encrypted: false, voice_encrypted: false }])
    const store = useChannelEncryptionStore()
    await store.loadServer(SERVER_ID, ['c1'])

    store.applyBroadcast({ table: 'channel_encryption_settings', new: { channel_id: 'c1', messages_encrypted: true, voice_encrypted: false } })
    expect(store.isMessagesEncrypted('c1')).toBe(true)

    store.applyBroadcast({ table: 'server_encryption_settings', new: { server_id: SERVER_ID, encryption_mode: 'disabled' } })
    expect(store.isMessagesEncrypted('c1')).toBe(false)

    store.applyBroadcast({ table: 'server_encryption_settings', new: { server_id: SERVER_ID, encryption_mode: 'optional' } })
    expect(store.isMessagesEncrypted('c1')).toBe(true)
  })

  it('does not overwrite a stored row with a value the floor fixes', async () => {
    mockTables({ encryption_mode: 'optional' }, [{ channel_id: 'c1', messages_encrypted: true, voice_encrypted: false }])
    const store = useChannelEncryptionStore()
    await store.loadServer(SERVER_ID, ['c1'])

    store.applyEffective({
      channelId: 'c1', serverId: SERVER_ID, serverMode: 'disabled', voiceMode: 'disabled',
      messagesEncrypted: false, voiceEncrypted: false, messagesLocked: true, voiceLocked: false,
      historyVisibility: 'all', enabledAt: null, enabledBy: null, botCount: 0, bridgeCount: 0,
    })
    expect(store.isMessagesEncrypted('c1')).toBe(false)

    store.applyBroadcast({ table: 'server_encryption_settings', new: { server_id: SERVER_ID, encryption_mode: 'optional' } })
    expect(store.isMessagesEncrypted('c1')).toBe(true)
  })

  it('keeps channel voice encryption on a server whose message encryption is disabled', async () => {
    mockTables({ encryption_mode: 'disabled', voice_encryption_mode: 'disabled' }, [
      { channel_id: 'v1', messages_encrypted: false, voice_encrypted: false },
    ])
    const store = useChannelEncryptionStore()
    await store.loadServer(SERVER_ID, ['v1'])
    expect(store.isVoiceEncrypted('v1')).toBe(false)

    store.applyEffective({
      channelId: 'v1', serverId: SERVER_ID, serverMode: 'disabled', voiceMode: 'disabled',
      messagesEncrypted: false, voiceEncrypted: true, messagesLocked: true, voiceLocked: false,
      historyVisibility: 'all', enabledAt: null, enabledBy: null, botCount: 0, bridgeCount: 0,
    })
    expect(store.isVoiceEncrypted('v1')).toBe(true)
    expect(store.isMessagesEncrypted('v1')).toBe(false)
    expect(store.stateFor('v1')?.voiceLocked).toBe(false)

    store.applyBroadcast({ table: 'server_encryption_settings', new: { server_id: SERVER_ID, encryption_mode: 'disabled', voice_encryption_mode: 'required' } })
    expect(store.stateFor('v1')?.voiceLocked).toBe(true)
    store.applyBroadcast({ table: 'channel_encryption_settings', new: { channel_id: 'v1', messages_encrypted: false, voice_encrypted: false } })
    expect(store.isVoiceEncrypted('v1')).toBe(true)
  })
})
