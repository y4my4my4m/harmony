/**
 * New-device pairing panel: the code shows as text to copy, and choosing Scan or paste while
 * the code is still being prepared keeps the scanner, withdrawing the request that arrives late.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const { pairing, identity } = vi.hoisted(() => ({
  pairing: { startNewDevice: vi.fn(), waitForKeys: vi.fn(), answerApproverCode: vi.fn(), completeNewDevice: vi.fn() },
  identity: { buildLabel: vi.fn(() => 'Firefox on Linux'), cancelPairingRequest: vi.fn(async () => {}) },
}))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => ({ polite: vi.fn(), assertive: vi.fn(), announce: vi.fn() }) }))
vi.mock('@/services/encryption/DevicePairingService', () => ({ devicePairingService: pairing }))
vi.mock('@/services/encryption/DeviceIdentityService', () => ({ deviceIdentityService: identity }))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: {
    getCurrentContext: vi.fn(async () => ({ isAuthenticated: true, profileId: 'p1', authUser: { id: 'auth-1' } })),
  },
}))
vi.mock('@/utils/qrCode', () => ({ renderQrDataUrl: vi.fn(async () => 'data:image/png;base64,') }))
vi.mock('../QrScanner.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'QrScannerStub', render: () => h('div', { 'data-testid': 'qr-scanner' }) }) }
})

import DevicePairingPanel from '../DevicePairingPanel.vue'

enableAutoUnmount(afterEach)

const CODE = `HMP:${'A'.repeat(92)}`

function newPairing(requestId: string) {
  return {
    requestId,
    expiresAt: Date.now() + 600_000,
    qrText: CODE,
    session: { spent: false, discard: vi.fn() },
  }
}

function mountPanel() {
  return mount(DevicePairingPanel, {
    attachTo: document.body,
    global: {
      mocks: { $t: (key: string) => key },
      stubs: { Icon: true, LoadingSpinner: true, 'i18n-t': true },
    },
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  for (const fn of Object.values(pairing)) fn.mockReset()
  identity.cancelPairingRequest.mockClear()
  pairing.waitForKeys.mockImplementation(() => new Promise(() => {}))
})

describe('DevicePairingPanel', () => {
  it('shows the code as text under the QR code', async () => {
    pairing.startNewDevice.mockResolvedValue(newPairing('r1'))
    const wrapper = mountPanel()
    await flushPromises()
    expect(wrapper.get<HTMLTextAreaElement>('[data-testid="pairing-code-text"]').element.value).toBe(CODE)
    expect(wrapper.find('[data-testid="pairing-qr"]').exists()).toBe(true)
  })

  it('keeps the scanner when Scan or paste is chosen before the code is ready', async () => {
    let ready!: (p: ReturnType<typeof newPairing>) => void
    pairing.startNewDevice.mockImplementation(() => new Promise((resolve) => { ready = resolve }))
    const wrapper = mountPanel()
    await flushPromises()
    await wrapper.get('button.pp-link').trigger('click')
    expect(wrapper.find('[data-testid="qr-scanner"]').exists()).toBe(true)

    const late = newPairing('r-late')
    ready(late)
    await flushPromises()
    expect(wrapper.find('[data-testid="qr-scanner"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="pairing-code-text"]').exists()).toBe(false)
    expect(identity.cancelPairingRequest).toHaveBeenCalledWith('r-late')
    expect(late.session.discard).toHaveBeenCalled()
    expect(pairing.waitForKeys).not.toHaveBeenCalled()
  })
})
