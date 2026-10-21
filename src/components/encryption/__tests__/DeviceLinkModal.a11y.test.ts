/**
 * Link-a-device dialog: each phase is announced (code shown, needs unlock,
 * failed), failures assertively, and focus lands on the new phase's control
 * when the previous one unmounted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'
import { userEventChannel } from '@/services/UserEventChannel'
import { renderQrDataUrl } from '@/utils/qrCode'
import { authContextService } from '@/services/AuthContextService'

const { announcer, megolm, pairing } = vi.hoisted(() => ({
  announcer: { polite: vi.fn(), assertive: vi.fn() },
  megolm: {
    isUnlocked: vi.fn(() => true),
    canExportPairingKeys: vi.fn(() => true),
    isInitialized: vi.fn(() => true),
    initialize: vi.fn(async (_authUserId: string) => {}),
    whenInitSettled: vi.fn(async (_ms: number) => {}),
  },
  pairing: { startApproverCode: vi.fn(), findAnswer: vi.fn(async () => null) },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('@/composables/useAnnouncer', () => ({
  useAnnouncer: () => ({ ...announcer, announce: vi.fn() }),
}))
vi.mock('@/composables/useDeviceApprovals', () => ({ useDeviceApprovals: () => ({ linkInProgress: ref(false) }) }))
vi.mock('@/services/UserEventChannel', () => ({ userEventChannel: { on: vi.fn(() => () => {}) } }))
vi.mock('@/services/encryption/MegolmMessageEncryptionService', () => ({ megolmMessageEncryptionService: megolm }))
vi.mock('@/services/encryption/DevicePairingService', () => ({ devicePairingService: pairing }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn(async () => ({ isAuthenticated: true, profileId: 'p1' })),
    getCurrentAuthUser: vi.fn(async () => ({ id: 'auth-1' })),
  },
}))
vi.mock('@/utils/qrCode', () => ({ renderQrDataUrl: vi.fn(async () => 'data:image/png;base64,') }))
vi.mock('../QrScanner.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'QrScannerStub', render: () => h('div') }) }
})

import DeviceLinkModal from '../DeviceLinkModal.vue'

enableAutoUnmount(afterEach)

const SESSION = { expiresAt: Date.now() + 300_000, text: () => 'HMP:x', expired: () => false }

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
  announcer.polite.mockClear()
  announcer.assertive.mockClear()
  megolm.isUnlocked.mockReset()
  megolm.isUnlocked.mockReturnValue(true)
  megolm.isInitialized.mockReturnValue(true)
  megolm.initialize.mockReset()
  megolm.initialize.mockResolvedValue(undefined)
  megolm.whenInitSettled.mockReset()
  megolm.whenInitSettled.mockResolvedValue(undefined)
  pairing.startApproverCode.mockReset()
  vi.mocked(userEventChannel.on).mockClear()
  vi.mocked(authContextService.getCurrentContext).mockClear()
})

function mountModal(mode: 'scan' | 'show') {
  return mount(DeviceLinkModal, {
    attachTo: document.body,
    props: { mode },
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { Icon: true, LoadingSpinner: true, 'i18n-t': true, KeyRecoveryModal: true },
    },
  })
}

describe('DeviceLinkModal phases', () => {
  it('announces that the code is shown and waiting', async () => {
    pairing.startApproverCode.mockResolvedValue(SESSION)
    mountModal('show')
    await flushPromises()
    expect(document.querySelector('[data-testid="device-link-modal"]')?.getAttribute('data-phase')).toBe('show')
    expect(announcer.polite).toHaveBeenCalledWith('encryption.linkDevice.a11y.showing')
  })

  it('announces that encryption must be unlocked first', async () => {
    megolm.isUnlocked.mockReturnValue(false)
    mountModal('scan')
    await flushPromises()
    expect(announcer.polite).toHaveBeenCalledWith('encryption.linkDevice.needUnlockLocked')
  })

  // Cold start: nothing has restored this device's stored keys yet (Settings > Privacy did it).
  it('restores the stored keys before calling the device locked', async () => {
    let unlocked = false
    megolm.isUnlocked.mockImplementation(() => unlocked)
    megolm.isInitialized.mockReturnValue(false)
    megolm.initialize.mockImplementation(async () => { unlocked = true })
    mountModal('scan')
    await flushPromises()
    expect(megolm.initialize).toHaveBeenCalledWith('auth-1')
    expect(document.querySelector('[data-testid="device-link-modal"]')?.getAttribute('data-phase')).toBe('scan')
    expect(announcer.polite).not.toHaveBeenCalledWith('encryption.linkDevice.needUnlockLocked')
  })

  it('waits for a restore already running instead of starting another', async () => {
    let unlocked = false
    megolm.isUnlocked.mockImplementation(() => unlocked)
    megolm.whenInitSettled.mockImplementation(async () => { unlocked = true })
    mountModal('scan')
    await flushPromises()
    expect(megolm.initialize).not.toHaveBeenCalled()
    expect(megolm.whenInitSettled).toHaveBeenCalled()
    expect(document.querySelector('[data-testid="device-link-modal"]')?.getAttribute('data-phase')).toBe('scan')
  })

  it('is locked when the restore finds no stored keys', async () => {
    megolm.isUnlocked.mockReturnValue(false)
    megolm.isInitialized.mockReturnValue(false)
    mountModal('scan')
    await flushPromises()
    expect(megolm.initialize).toHaveBeenCalledWith('auth-1')
    expect(announcer.polite).toHaveBeenCalledWith('encryption.linkDevice.needUnlockLocked')
  })

  it('waits for a restore that never settles no longer than whenInitSettled does', async () => {
    megolm.isUnlocked.mockReturnValue(false)
    megolm.isInitialized.mockReturnValue(false)
    megolm.initialize.mockImplementation(() => new Promise<void>(() => {}))
    mountModal('scan')
    await flushPromises()
    expect(megolm.initialize).toHaveBeenCalledWith('auth-1')
    expect(megolm.whenInitSettled).toHaveBeenCalledWith(10_000)
    expect(document.querySelector('[data-testid="device-link-modal"]')?.getAttribute('data-phase')).toBe('need-unlock')
  })

  it('starts no code when closed while the restore runs', async () => {
    let unlocked = false
    megolm.isUnlocked.mockImplementation(() => unlocked)
    let settle!: () => void
    megolm.whenInitSettled.mockImplementation(() => new Promise<void>((resolve) => { settle = resolve }))
    pairing.startApproverCode.mockResolvedValue(SESSION)
    const wrapper = mountModal('show')
    await flushPromises()
    wrapper.unmount()
    unlocked = true
    settle()
    await flushPromises()
    expect(authContextService.getCurrentContext).not.toHaveBeenCalled()
    expect(pairing.startApproverCode).not.toHaveBeenCalled()
    expect(userEventChannel.on).not.toHaveBeenCalled()
  })

  it('starts no polling when closed while the code renders', async () => {
    let rendered!: (url: string) => void
    vi.mocked(renderQrDataUrl).mockImplementationOnce(() => new Promise<string>((resolve) => { rendered = resolve }))
    pairing.startApproverCode.mockResolvedValue(SESSION)
    const wrapper = mountModal('show')
    await flushPromises()
    expect(pairing.startApproverCode).toHaveBeenCalled()
    wrapper.unmount()
    rendered('data:image/png;base64,')
    await flushPromises()
    expect(userEventChannel.on).not.toHaveBeenCalled()
  })

  it('announces a failure assertively and focuses Try again', async () => {
    pairing.startApproverCode.mockRejectedValue(new Error('Server unreachable'))
    mountModal('show')
    await flushPromises()
    expect(announcer.assertive).toHaveBeenCalledWith('Server unreachable')
    const error = document.querySelector('[data-testid="link-error"]')!
    expect(error.contains(document.activeElement)).toBe(true)
    expect(document.activeElement?.textContent?.trim()).toBe('encryption.linkDevice.tryAgain')
  })
})
