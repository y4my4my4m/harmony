import { beforeEach, describe, expect, it, vi } from 'vitest'

const megolm = vi.hoisted(() => ({
  isInitialized: vi.fn(() => false),
  isUnlocked: vi.fn(() => false),
  hasRecoveryKey: vi.fn(async () => false),
  whenInitSettled: vi.fn(async () => undefined),
  encryptMessage: vi.fn(async () => ({ content: [{ type: 'text', text: 'cipher' }], encryption_metadata: { session_id: 's' } })),
  decryptMessage: vi.fn(),
}))

vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({ megolmMessageEncryptionService: megolm }))
vi.mock('@/services/core/channelMessageEncryption', () => ({ getEncryptionService: async () => megolm }))

import { voiceE2EEService, voiceKeyRoomId, __voiceKeyBytesToBase64 } from '../VoiceE2EEService'

const CONVERSATION = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b'
const CHANNEL = 'b2c3d4e5-f6a7-4b8c-9d0e-1f2a3b4c5d6e'

beforeEach(() => {
  for (const fn of Object.values(megolm)) fn.mockClear()
  megolm.isInitialized.mockReturnValue(false)
  megolm.isUnlocked.mockReturnValue(false)
  megolm.hasRecoveryKey.mockResolvedValue(false)
})

describe('voice key Megolm room', () => {
  it('is the conversation for a local DM call and the room itself otherwise', () => {
    expect(voiceKeyRoomId(`dm-${CONVERSATION}`)).toBe(CONVERSATION)
    expect(voiceKeyRoomId(CHANNEL)).toBe(CHANNEL)
    expect(voiceKeyRoomId(`federated-dm-${CONVERSATION}`)).toBe(`federated-dm-${CONVERSATION}`)
  })

  it('wraps a DM call key in the conversation room for the given recipients', async () => {
    const key = new Uint8Array(32).fill(7)
    await voiceE2EEService.wrapKey(key, `dm-${CONVERSATION}`, ['peer'])
    expect(megolm.encryptMessage).toHaveBeenCalledWith(
      [{ type: 'text', text: __voiceKeyBytesToBase64(key) }], CONVERSATION, ['peer'])

    await voiceE2EEService.wrapKey(key, CHANNEL, ['peer'])
    expect(megolm.encryptMessage).toHaveBeenLastCalledWith(expect.any(Array), CHANNEL, ['peer'])
  })

  it('unwraps a DM call key from the conversation room', async () => {
    const key = new Uint8Array(32).fill(9)
    megolm.decryptMessage.mockResolvedValue({ content: [{ type: 'text', text: __voiceKeyBytesToBase64(key) }] })
    const cipher = { content: [{ type: 'text', text: 'cipher' }], encryption_metadata: { session_id: 's' } } as any

    const unwrapped = await voiceE2EEService.unwrapKey(cipher, `dm-${CONVERSATION}`)
    expect(Array.from(unwrapped!)).toEqual(Array.from(key))
    expect(megolm.decryptMessage).toHaveBeenCalledWith(expect.objectContaining({ channel_id: CONVERSATION }))
  })
})

describe('participationBlocker', () => {
  it('answers null for unlocked keys', async () => {
    megolm.isInitialized.mockReturnValue(true)
    megolm.isUnlocked.mockReturnValue(true)
    await expect(voiceE2EEService.participationBlocker()).resolves.toBeNull()
    expect(megolm.whenInitSettled).not.toHaveBeenCalled()
  })

  it('answers null when the unlock in flight completes', async () => {
    megolm.whenInitSettled.mockImplementationOnce(async () => {
      megolm.isInitialized.mockReturnValue(true)
      megolm.isUnlocked.mockReturnValue(true)
    })
    await expect(voiceE2EEService.participationBlocker()).resolves.toBeNull()
  })

  it("answers 'unlock' for keys that exist but are not loaded", async () => {
    megolm.isInitialized.mockReturnValue(true)
    megolm.hasRecoveryKey.mockResolvedValue(true)
    await expect(voiceE2EEService.participationBlocker()).resolves.toBe('unlock')
  })

  it("answers 'setup' without keys", async () => {
    megolm.isInitialized.mockReturnValue(true)
    await expect(voiceE2EEService.participationBlocker()).resolves.toBe('setup')
    megolm.isInitialized.mockReturnValue(false)
    await expect(voiceE2EEService.participationBlocker()).resolves.toBe('setup')
  })
})
