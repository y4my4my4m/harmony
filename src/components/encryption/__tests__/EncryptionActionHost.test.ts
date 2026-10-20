import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

const toastError = vi.hoisted(() => vi.fn())

vi.mock('vue-toastification', () => ({ useToast: () => ({ error: toastError }) }))
// __esModule: defineAsyncComponent unwraps `default` only from a module it recognises.
vi.mock('@/components/encryption/RecoveryKeySetupWizard.vue', () => ({
  __esModule: true,
  default: { name: 'RecoveryKeySetupWizard', template: '<div data-testid="setup-wizard" />' },
}))
vi.mock('@/components/encryption/KeyRecoveryModal.vue', () => ({
  __esModule: true,
  default: { name: 'KeyRecoveryModal', template: '<div data-testid="unlock-modal" />' },
}))

import EncryptionActionHost from '../EncryptionActionHost.vue'
import { ENCRYPTION_ACTION_EVENT } from '@/composables/useEncryptionAction'

enableAutoUnmount(afterEach)

function dispatch(detail: Record<string, unknown>) {
  window.dispatchEvent(new CustomEvent(ENCRYPTION_ACTION_EVENT, { detail }))
}

beforeEach(() => {
  toastError.mockClear()
  document.body.innerHTML = ''
})

describe('EncryptionActionHost', () => {
  it('toasts the message and opens the setup wizard', async () => {
    mount(EncryptionActionHost, { attachTo: document.body })
    dispatch({ reason: 'setup', message: 'Set up encryption to join.' })
    await flushPromises()
    expect(toastError).toHaveBeenCalledWith('Set up encryption to join.')
    expect(document.body.querySelector('[data-testid="setup-wizard"]')).not.toBeNull()
  })

  it('opens the unlock prompt without a toast when the sender shows the message', async () => {
    mount(EncryptionActionHost, { attachTo: document.body })
    dispatch({ reason: 'unlock', message: 'Unlock encryption to join.', toast: false })
    await flushPromises()
    expect(toastError).not.toHaveBeenCalled()
    expect(document.body.querySelector('[data-testid="unlock-modal"]')).not.toBeNull()
  })
})
