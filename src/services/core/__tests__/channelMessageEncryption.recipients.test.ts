/**
 * encryptChannelContent's recipients: the room's members from the encryption service (one cached
 * request), not every member of the server read in pages on each send. An instance without
 * get_room_member_ids falls back to the server's members.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { supabase } from '@/supabase'

const { service } = vi.hoisted(() => ({
  service: {
    isInitialized: () => true,
    hasRecoveryKey: async () => true,
    isUnlocked: () => true,
    roomRecipients: vi.fn(),
    encryptMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'ciphertext' }], encryption_metadata: {} })),
  },
}))

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({ megolmMessageEncryptionService: service }))

import { encryptChannelContent } from '../channelMessageEncryption'

const params = { serverId: 'srv', channelId: 'chan', senderId: 'me', content: [{ type: 'text', text: 'hi' }] as any }

function userServers(ids: string[]) {
  const range = vi.fn(async () => ({ data: ids.map(user_id => ({ user_id })), error: null, count: ids.length }))
  const chain: any = { select: () => chain, eq: () => chain, order: () => chain, range }
  vi.mocked(supabase.from).mockReturnValue(chain)
  return range
}

beforeEach(() => {
  vi.mocked(supabase.from).mockReset()
  service.roomRecipients.mockReset()
  service.encryptMessage.mockClear()
})

describe('encryptChannelContent recipients', () => {
  it('are the room members, with no read of the server\'s members', async () => {
    service.roomRecipients.mockResolvedValue(['a', 'b'])
    await encryptChannelContent(params)
    expect(service.roomRecipients).toHaveBeenCalledWith('chan')
    expect(supabase.from).not.toHaveBeenCalled()
    expect(service.encryptMessage).toHaveBeenCalledWith(params.content, 'chan', ['a', 'b', 'me'])
  })

  it('are the server\'s members when the instance cannot name the room\'s', async () => {
    service.roomRecipients.mockResolvedValue(null)
    const range = userServers(['a', 'me'])
    await encryptChannelContent(params)
    expect(supabase.from).toHaveBeenCalledWith('user_servers')
    expect(range).toHaveBeenCalledTimes(1)
    expect(service.encryptMessage).toHaveBeenCalledWith(params.content, 'chan', ['a', 'me'])
  })
})
