import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import 'fake-indexeddb/auto'

import { secureSessionKeyStore } from '../SecureSessionKeyStore'
import { MegolmMessageEncryptionService } from '../MegolmMessageEncryptionService'
import { MegolmService } from '../MegolmService'
import { RecoveryKeyService } from '../RecoveryKeyService'

const USER = 'aaaaaaaa-1111-2222-3333-555555555555'

function aes(extractable: boolean) {
  return crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, extractable, ['encrypt', 'decrypt'])
}

async function derived(extractable: boolean) {
  return { encryptionKey: await aes(extractable), backupKey: await aes(extractable), signingKey: await aes(false) }
}

async function raw(key: CryptoKey) {
  return Array.from(new Uint8Array(await crypto.subtle.exportKey('raw', key)))
}

describe('SecureSessionKeyStore pairing copy', () => {
  beforeEach(async () => {
    await secureSessionKeyStore.clearAll()
  })

  it('keeps no copy unless one is stored, and stores the session keys non-extractable', async () => {
    await secureSessionKeyStore.store(USER, await derived(true))

    expect(await secureSessionKeyStore.loadPairingCopy(USER)).toBeNull()
    const loaded = await secureSessionKeyStore.load(USER)
    expect(loaded?.encryptionKey.extractable).toBe(false)
    expect(loaded?.backupKey.extractable).toBe(false)
  })

  it('stores an extractable copy that exports to the same bytes', async () => {
    const keys = await derived(true)
    await secureSessionKeyStore.store(USER, keys)
    await secureSessionKeyStore.storePairingCopy(USER, keys)

    const copy = await secureSessionKeyStore.loadPairingCopy(USER)
    expect(copy).not.toBeNull()
    expect(await raw(copy!.encryptionKey)).toEqual(await raw(keys.encryptionKey))
    expect(await raw(copy!.backupKey)).toEqual(await raw(keys.backupKey))
    expect((await secureSessionKeyStore.load(USER))?.encryptionKey.extractable).toBe(false)
  })

  it('refuses a copy of non-extractable keys or without stored session keys', async () => {
    await secureSessionKeyStore.store(USER, await derived(true))
    await expect(secureSessionKeyStore.storePairingCopy(USER, await derived(false))).rejects.toThrow()
    await expect(secureSessionKeyStore.storePairingCopy('someone-else', await derived(true))).rejects.toThrow()
    expect(await secureSessionKeyStore.loadPairingCopy('someone-else')).toBeNull()
  })

  it('a later store replaces the copy with the new keys, or drops it when they are not extractable', async () => {
    const first = await derived(true)
    await secureSessionKeyStore.store(USER, first)
    await secureSessionKeyStore.storePairingCopy(USER, first)

    const second = await derived(true)
    await secureSessionKeyStore.store(USER, second)
    const copy = await secureSessionKeyStore.loadPairingCopy(USER)
    expect(await raw(copy!.encryptionKey)).toEqual(await raw(second.encryptionKey))

    await secureSessionKeyStore.store(USER, await derived(false))
    expect(await secureSessionKeyStore.loadPairingCopy(USER)).toBeNull()
  })

  it('clearPairingCopy keeps the session keys; clear removes both', async () => {
    const keys = await derived(true)
    await secureSessionKeyStore.store(USER, keys)
    await secureSessionKeyStore.storePairingCopy(USER, keys)

    await secureSessionKeyStore.clearPairingCopy(USER)
    expect(await secureSessionKeyStore.loadPairingCopy(USER)).toBeNull()
    expect(await secureSessionKeyStore.load(USER)).not.toBeNull()

    await secureSessionKeyStore.storePairingCopy(USER, keys)
    await secureSessionKeyStore.clear(USER)
    expect(await secureSessionKeyStore.loadPairingCopy(USER)).toBeNull()
    expect(await secureSessionKeyStore.load(USER)).toBeNull()
  })
})

describe('MegolmMessageEncryptionService pairing copy', () => {
  const service = MegolmMessageEncryptionService.getInstance()
  const recovery = RecoveryKeyService.getInstance()
  const svc = service as unknown as { currentUserId: string | null; pairingCopy: unknown }

  beforeEach(async () => {
    await secureSessionKeyStore.clearAll()
    recovery.clear()
    svc.currentUserId = USER
    svc.pairingCopy = null
    vi.spyOn(MegolmService.getInstance(), 'isInitialized').mockReturnValue(true)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    svc.currentUserId = null
    svc.pairingCopy = null
    recovery.clear()
  })

  it('after a reload (stored keys only) it cannot export without a copy', async () => {
    recovery.setDerivedKeys(await derived(false))
    expect(service.canExportPairingKeys()).toBe(false)
    expect(service.hasPairingCopy()).toBe(false)
    await expect(service.keepPairingCopy()).rejects.toMatchObject({ code: 'keys_unavailable' })
  })

  it('keeps a copy of the in-memory keys and exports from it after a reload', async () => {
    const keys = await derived(true)
    recovery.setDerivedKeys(keys)
    await secureSessionKeyStore.store(USER, keys)
    await service.keepPairingCopy()
    expect(service.hasPairingCopy()).toBe(true)

    // Reload: in-memory keys are the non-extractable stored ones; the copy is read back.
    const stored = await secureSessionKeyStore.load(USER)
    recovery.setDerivedKeys(stored!)
    svc.pairingCopy = await secureSessionKeyStore.loadPairingCopy(USER)
    expect(service.canExportPairingKeys()).toBe(true)

    await service.removePairingCopy()
    expect(service.hasPairingCopy()).toBe(false)
    expect(service.canExportPairingKeys()).toBe(false)
    expect(await secureSessionKeyStore.loadPairingCopy(USER)).toBeNull()
  })
})
