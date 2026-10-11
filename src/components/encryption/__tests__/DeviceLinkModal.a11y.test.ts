/**
 * Link-a-device dialog: each phase is announced (code shown, needs unlock,
 * failed), failures assertively, and focus lands on the new phase's control
 * when the previous one unmounted.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'

const { announcer, megolm, pairing } = vi.hoisted(() => ({
  announcer: { polite: vi.fn(), assertive: vi.fn() },
  megolm: { isUnlocked: vi.fn(() => true), canExportPairingKeys: vi.fn(() => true) },
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
  authContextService: { getCurrentContext: vi.fn(async () => ({ isAuthenticated: true, profileId: 'p1' })) },
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
  megolm.isUnlocked.mockReturnValue(true)
  pairing.startApproverCode.mockReset()
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
