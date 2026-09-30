import { describe, it, expect, beforeEach, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { supabase } from '@/supabase'
import { useChannelEncryptionStore } from '@/stores/useChannelEncryption'

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
      messagesEncrypted: false, voiceEncrypted: false, messagesLocked: true, voiceLocked: true,
      historyVisibility: 'joined', enabledAt: null, enabledBy: null, botCount: 0, bridgeCount: 0,
    })
    expect(store.isMessagesEncrypted('c1')).toBe(false)

    store.applyBroadcast({ table: 'server_encryption_settings', new: { server_id: SERVER_ID, encryption_mode: 'optional' } })
    expect(store.isMessagesEncrypted('c1')).toBe(true)
  })
})
