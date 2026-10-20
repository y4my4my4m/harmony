import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const effective = vi.hoisted(() => vi.fn())
const conversation = vi.hoisted(() => vi.fn())
const voice = vi.hoisted(() => ({
  canParticipate: vi.fn(() => false),
  participationBlocker: vi.fn(async () => null as 'setup' | 'unlock' | null),
}))

vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/ChannelEncryptionService', () => ({ fetchEffectiveChannelEncryption: effective }))
vi.mock('@/services/conversationEncryption', () => ({ fetchConversationEncryption: conversation }))
vi.mock('@/services/encryption/VoiceE2EEService', () => ({ voiceE2EEService: voice }))
vi.mock('@/i18n', async () => {
  const { createI18n } = await import('vue-i18n')
  const en = (await import('@/locales/en.json')).default
  return { i18n: createI18n({ legacy: false, locale: 'en', messages: { en } }) }
})

import { callRequiresE2EE, ensureCanJoinCall, promptCallEncryptionSetup } from '../voiceEncryptionGate'
import { ENCRYPTION_ACTION_EVENT } from '@/composables/useEncryptionAction'
import { localDMCallConversationId } from '@/utils/callRooms'

const CONVERSATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const CHANNEL = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

const actions: CustomEvent[] = []
const onAction = (event: Event) => { actions.push(event as CustomEvent) }

beforeEach(() => {
  effective.mockReset()
  conversation.mockReset()
  voice.canParticipate.mockReset().mockReturnValue(false)
  voice.participationBlocker.mockReset().mockResolvedValue(null)
  actions.length = 0
  window.addEventListener(ENCRYPTION_ACTION_EVENT, onAction)
})

afterEach(() => {
  window.removeEventListener(ENCRYPTION_ACTION_EVENT, onAction)
})

describe('localDMCallConversationId', () => {
  it('reads the conversation of a local DM call room only', () => {
    expect(localDMCallConversationId(`dm-${CONVERSATION}`)).toBe(CONVERSATION)
    expect(localDMCallConversationId(CHANNEL)).toBeNull()
    expect(localDMCallConversationId(`federated-dm-${CONVERSATION}`)).toBeNull()
    expect(localDMCallConversationId('dm-not-a-uuid')).toBeNull()
    expect(localDMCallConversationId(null)).toBeNull()
  })
})

describe('callRequiresE2EE', () => {
  it("follows a voice channel's effective voice encryption", async () => {
    effective.mockResolvedValueOnce({ voiceEncrypted: true, messagesEncrypted: false })
    await expect(callRequiresE2EE('server', CHANNEL)).resolves.toBe(true)
    expect(effective).toHaveBeenCalledWith(CHANNEL)

    effective.mockResolvedValueOnce({ voiceEncrypted: false, messagesEncrypted: true })
    await expect(callRequiresE2EE('server', CHANNEL)).resolves.toBe(false)

    effective.mockResolvedValueOnce(null)
    await expect(callRequiresE2EE('server', CHANNEL)).resolves.toBe(false)
    expect(conversation).not.toHaveBeenCalled()
  })

  it("follows a local DM call's conversation encryption", async () => {
    conversation.mockResolvedValueOnce(true)
    await expect(callRequiresE2EE('dm', `dm-${CONVERSATION}`)).resolves.toBe(true)
    expect(conversation).toHaveBeenCalledWith(CONVERSATION)

    conversation.mockResolvedValueOnce(false)
    await expect(callRequiresE2EE('dm', `dm-${CONVERSATION}`)).resolves.toBe(false)
    expect(effective).not.toHaveBeenCalled()
  })

  it('never encrypts a federated DM call, whatever the conversation says', async () => {
    conversation.mockResolvedValue(true)
    await expect(callRequiresE2EE('dm', `federated-dm-${CONVERSATION}-1700000000`)).resolves.toBe(false)
    expect(conversation).not.toHaveBeenCalled()
    expect(effective).not.toHaveBeenCalled()
  })

  it('throws when the channel state cannot be read', async () => {
    effective.mockRejectedValueOnce(new Error('offline'))
    await expect(callRequiresE2EE('server', CHANNEL)).rejects.toThrow('offline')
  })
})

describe('promptCallEncryptionSetup', () => {
  it('asks for setup or unlock with the scope message', async () => {
    await expect(promptCallEncryptionSetup('setup', 'channel'))
      .resolves.toBe('This voice channel is end-to-end encrypted. Set up encryption to join.')
    await expect(promptCallEncryptionSetup('unlock', 'dm', { toast: false }))
      .resolves.toMatch(/^Calls in this conversation are end-to-end encrypted\. Unlock encryption/)

    expect(actions.map((e) => e.detail)).toEqual([
      { reason: 'setup', message: 'This voice channel is end-to-end encrypted. Set up encryption to join.', toast: true },
      expect.objectContaining({ reason: 'unlock', toast: false }),
    ])
  })
})

describe('ensureCanJoinCall', () => {
  it('reads nothing for a device that can encrypt', async () => {
    voice.canParticipate.mockReturnValue(true)
    await expect(ensureCanJoinCall('dm', `dm-${CONVERSATION}`)).resolves.toBe(true)
    expect(conversation).not.toHaveBeenCalled()
    expect(actions).toHaveLength(0)
  })

  it('lets a device without keys into an unencrypted call', async () => {
    conversation.mockResolvedValue(false)
    await expect(ensureCanJoinCall('dm', `dm-${CONVERSATION}`)).resolves.toBe(true)
    expect(voice.participationBlocker).not.toHaveBeenCalled()
    expect(actions).toHaveLength(0)
  })

  it('prompts and refuses when an encrypted call needs keys this device lacks', async () => {
    conversation.mockResolvedValue(true)
    voice.participationBlocker.mockResolvedValue('setup')
    await expect(ensureCanJoinCall('dm', `dm-${CONVERSATION}`)).resolves.toBe(false)
    expect(actions).toHaveLength(1)
    expect(actions[0].detail).toEqual({
      reason: 'setup',
      message: 'Calls in this conversation are end-to-end encrypted. Set up encryption to call or answer.',
      toast: true,
    })
  })

  it('lets the join re-check when the state cannot be read', async () => {
    effective.mockRejectedValue(new Error('offline'))
    await expect(ensureCanJoinCall('server', CHANNEL)).resolves.toBe(true)
    expect(actions).toHaveLength(0)
  })
})
