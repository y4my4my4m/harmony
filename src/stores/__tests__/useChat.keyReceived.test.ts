import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const decrypt = vi.hoisted(() => vi.fn(async (messages: any[]) =>
  messages.map(m => (m.encrypted ? { ...m, decrypted: true } : m))))

vi.mock('@/utils/messageDecryption', () => ({ processMessageDecryption: decrypt }))

import { useChatStore } from '@/stores/useChat'

function encrypted(id: string) {
  return { id, encrypted: true, decrypted: false, content: [] } as any
}

describe('useChat re-decrypt on megolm-key-received', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    decrypt.mockClear()
  })

  it("re-decrypts the open channel and every cached one for roomId '*'", async () => {
    const store = useChatStore()
    store.currentChannelId = 'channel-1'
    store.messages = [encrypted('m1')]
    store.messageCache.set('channel-2', { messages: [encrypted('m2')] } as any)

    await store.reprocessEncryptedMessages('*')

    expect(store.messages[0].decrypted).toBe(true)
    expect(store.messageCache.get('channel-2')!.messages[0].decrypted).toBe(true)
  })

  it('re-decrypts only the named room for a concrete roomId', async () => {
    const store = useChatStore()
    store.currentChannelId = 'channel-1'
    store.messages = [encrypted('m1')]
    store.messageCache.set('channel-2', { messages: [encrypted('m2')] } as any)

    await store.reprocessEncryptedMessages('channel-2')

    expect(store.messages[0].decrypted).toBe(false)
    expect(store.messageCache.get('channel-2')!.messages[0].decrypted).toBe(true)
  })
})
