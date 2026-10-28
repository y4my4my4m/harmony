/**
 * OutsideLinkDialog: the held link's address with its host apart, Trust only when signed in,
 * Copy link, and Open passing the Trust box on. One host per window: a link held from the call
 * pop-out shows in the pop-out's host only.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { reactive, ref } from 'vue'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
const pending = vi.hoisted(() => ({ value: null as null | { url: string; host: string | null; masked: boolean; document: Document } }))
const proceed = vi.hoisted(() => vi.fn(async (_trust: boolean) => {}))
const cancel = vi.hoisted(() => vi.fn())
const settings = vi.hoisted(() => ({ signedIn: true }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string, values?: Record<string, unknown>) => (values?.host ? `${key}:${values.host}` : key) }),
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
vi.mock('@/services/outsideLinks', () => ({
  useOutsideLinkPrompt: () => ({ pending: held, proceed, cancel }),
}))
vi.mock('@/stores/outsideLinkSettings', () => ({ useOutsideLinkSettingsStore: () => store }))

const held = ref<typeof pending.value>(null)
const store = reactive(settings)

import OutsideLinkDialog from '../OutsideLinkDialog.vue'

function mountDialog(portal?: HTMLElement) {
  return mount(OutsideLinkDialog, { attachTo: document.body, props: { portal }, global: { stubs: { teleport: true } } })
}

const writeText = vi.fn(async (_text: string) => {})

enableAutoUnmount(afterEach)

beforeEach(() => {
  vi.clearAllMocks()
  store.signedIn = true
  held.value = null
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('OutsideLinkDialog', () => {
  it('renders nothing until a link is held', () => {
    const wrapper = mountDialog()
    expect(wrapper.find('[data-testid="outside-link-dialog"]').exists()).toBe(false)
  })

  it('shows the address with the host apart, described by it', async () => {
    const wrapper = mountDialog()
    held.value = { url: 'https://paypal.com:pw@evil.example/login', host: 'evil.example', masked: true, document }
    await flushPromises()
    const dialog = wrapper.get('[data-testid="outside-link-dialog"]')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(wrapper.get('[data-testid="outside-link-url"]').text()).toBe('https://paypal.com:pw@evil.example/login')
    expect(wrapper.get('[data-testid="outside-link-host"]').text()).toBe('evil.example')
    const described = document.getElementById(dialog.attributes('aria-describedby')!)
    expect(described?.textContent).toContain('outsideLink.maskedLead')
    expect(described?.textContent).toContain('evil.example/login')
  })

  it('offers Trust when signed in and passes it to Open', async () => {
    const wrapper = mountDialog()
    held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document }
    await flushPromises()
    expect(wrapper.get('.outside-link-trust').text()).toBe('outsideLink.trust:evil.example')
    await wrapper.get('[data-testid="outside-link-trust"]').setValue(true)
    await wrapper.get('[data-testid="outside-link-open"]').trigger('click')
    expect(proceed).toHaveBeenCalledWith(true)
  })

  it('offers no Trust signed out', async () => {
    store.signedIn = false
    const wrapper = mountDialog()
    held.value = { url: 'https://evil.example/', host: 'evil.example', masked: false, document }
    await flushPromises()
    expect(wrapper.find('[data-testid="outside-link-trust"]').exists()).toBe(false)
    expect(wrapper.get('.outside-link-lead').text()).toBe('outsideLink.lead')
    await wrapper.get('[data-testid="outside-link-open"]').trigger('click')
    expect(proceed).toHaveBeenCalledWith(false)
  })

  it('copies the address and keeps the dialog open', async () => {
    const wrapper = mountDialog()
    held.value = { url: 'https://evil.example/x', host: 'evil.example', masked: true, document }
    await flushPromises()
    await wrapper.get('[data-testid="outside-link-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('https://evil.example/x')
    expect(toast.success).toHaveBeenCalledWith('outsideLink.copied')
    expect(cancel).not.toHaveBeenCalled()
  })

  it('says when trusting the host failed', async () => {
    proceed.mockRejectedValueOnce(new Error('denied'))
    const wrapper = mountDialog()
    held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document }
    await flushPromises()
    await wrapper.get('[data-testid="outside-link-trust"]').setValue(true)
    await wrapper.get('[data-testid="outside-link-open"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith('outsideLink.trustFailed:evil.example')
  })

  describe('one host per window', () => {
    function popoutContainer(): HTMLElement {
      const popout = document.implementation.createHTMLDocument('call')
      const root = popout.createElement('div')
      popout.body.appendChild(root)
      return root
    }

    it('shows a link held from the pop-out in the pop-out host only', async () => {
      const root = popoutContainer()
      const main = mountDialog()
      const inPopout = mountDialog(root)
      held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document: root.ownerDocument }
      await flushPromises()
      expect(main.find('[data-testid="outside-link-dialog"]').exists()).toBe(false)
      expect(inPopout.find('[data-testid="outside-link-dialog"]').exists()).toBe(true)
    })

    it('mounts the pop-out host in the pop-out container', async () => {
      const root = popoutContainer()
      mount(OutsideLinkDialog, { attachTo: document.body, props: { portal: root } })
      held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document: root.ownerDocument }
      await flushPromises()
      expect(root.querySelector('[data-testid="outside-link-dialog"]')).not.toBeNull()
      expect(document.querySelector('[data-testid="outside-link-dialog"]')).toBeNull()
    })

    it('shows a link held from the main window in the main host only', async () => {
      const main = mountDialog()
      const inPopout = mountDialog(popoutContainer())
      held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document }
      await flushPromises()
      expect(main.find('[data-testid="outside-link-dialog"]').exists()).toBe(true)
      expect(inPopout.find('[data-testid="outside-link-dialog"]').exists()).toBe(false)
    })

    it('cancels the link it shows when the pop-out closes', async () => {
      const root = popoutContainer()
      const inPopout = mountDialog(root)
      held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document: root.ownerDocument }
      await flushPromises()
      inPopout.unmount()
      expect(cancel).toHaveBeenCalledTimes(1)
    })

    it('leaves a main-window link alone when the pop-out closes', async () => {
      const inPopout = mountDialog(popoutContainer())
      held.value = { url: 'https://evil.example/', host: 'evil.example', masked: true, document }
      await flushPromises()
      inPopout.unmount()
      expect(cancel).not.toHaveBeenCalled()
    })
  })
})
