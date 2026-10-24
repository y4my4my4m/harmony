import { describe, it, expect, beforeEach, vi } from 'vitest'
import { supabase } from '@/supabase'
import { forgetChannelEncryption, setChannelEncryption } from '@/services/ChannelEncryptionService'

const CHANNEL = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb'

function answer(history: string) {
  return { data: { channel_id: CHANNEL, server_id: 's1', server_mode: 'optional', history_visibility: history }, error: null }
}

const calls = () => (supabase.rpc as any).mock.calls.map(([fn, args]: [string, any]) => [fn, args])

beforeEach(() => {
  vi.clearAllMocks()
  forgetChannelEncryption()
  ;(supabase.rpc as any).mockImplementation((fn: string, args: any) =>
    Promise.resolve(answer(fn === 'set_channel_history_visibility' ? args.p_history_visibility : 'all')))
})

describe('setChannelEncryption history visibility', () => {
  it('goes through set_channel_history_visibility alone', async () => {
    const state = await setChannelEncryption(CHANNEL, { historyVisibility: 'pinned' })
    expect(calls()).toEqual([
      ['set_channel_history_visibility', { p_channel_id: CHANNEL, p_history_visibility: 'pinned' }],
    ])
    expect(state?.historyVisibility).toBe('pinned')
  })

  it('never passes a history value to set_channel_encryption', async () => {
    await setChannelEncryption(CHANNEL, { messagesEncrypted: true, historyVisibility: 'none' })
    expect(calls()).toEqual([
      ['set_channel_encryption', { p_channel_id: CHANNEL, p_messages_encrypted: true, p_voice_encrypted: null, p_history_visibility: null }],
      ['set_channel_history_visibility', { p_channel_id: CHANNEL, p_history_visibility: 'none' }],
    ])
  })

  it('reads an answer from before 20261028200001 as all', async () => {
    ;(supabase.rpc as any).mockResolvedValue(answer('joined'))
    expect((await setChannelEncryption(CHANNEL, { voiceEncrypted: true }))?.historyVisibility).toBe('all')
  })

  it('throws the server refusal', async () => {
    ;(supabase.rpc as any).mockResolvedValue({ data: null, error: { code: '42501', message: 'Missing MANAGE_CHANNELS' } })
    await expect(setChannelEncryption(CHANNEL, { historyVisibility: 'none' })).rejects.toMatchObject({ code: '42501' })
  })
})
