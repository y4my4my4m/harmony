/**
 * Pairing code as text: copied with the Clipboard API or, without it, from the selected field;
 * when neither works the code is left selected with a note to copy it by hand.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { ref } from 'vue'

const announcer = vi.hoisted(() => ({ polite: vi.fn(), assertive: vi.fn(), announce: vi.fn() }))

vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('@/composables/useAnnouncer', () => ({ useAnnouncer: () => announcer }))

import PairingCodeField from '../PairingCodeField.vue'

enableAutoUnmount(afterEach)

const CODE = 'HMP:AQIDBAUGBwgJCgsMDQ4PEBESExQVFhcYGRobHB0eHyAhIiMkJSYnKCkqKywtLi8wMTIzNDU2Nzg5Ojs8PT4_QEFCQ0RF'
const writeText = vi.fn()

function mountField(props: Record<string, unknown> = {}) {
  return mount(PairingCodeField, {
    attachTo: document.body,
    props: { code: CODE, ...props },
    global: { mocks: { $t: (key: string) => key }, stubs: { Icon: true } },
  })
}

beforeEach(() => {
  document.body.innerHTML = ''
  writeText.mockReset()
  announcer.polite.mockClear()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  ;(document as unknown as { execCommand: (c: string) => boolean }).execCommand = vi.fn(() => false)
})

describe('PairingCodeField', () => {
  it('shows the whole code in a read-only field', () => {
    const wrapper = mountField()
    const field = wrapper.get<HTMLTextAreaElement>('[data-testid="pairing-code-text"]')
    expect(field.element.value).toBe(CODE)
    expect(field.element.readOnly).toBe(true)
  })

  it('copies the code and says so', async () => {
    writeText.mockResolvedValue(undefined)
    const wrapper = mountField()
    await wrapper.get('[data-testid="pairing-code-copy"]').trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith(CODE)
    expect(wrapper.get('[data-testid="pairing-code-copy"]').text()).toBe('common.copied')
    expect(announcer.polite).toHaveBeenCalledWith('common.copied')
    expect(wrapper.find('[data-testid="pairing-code-copy-failed"]').exists()).toBe(false)
  })

  it('copies the selected field when the Clipboard API refuses', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    vi.mocked(document.execCommand).mockReturnValue(true)
    const wrapper = mountField()
    await wrapper.get('[data-testid="pairing-code-copy"]').trigger('click')
    await flushPromises()
    expect(document.execCommand).toHaveBeenCalledWith('copy')
    expect(wrapper.get('[data-testid="pairing-code-copy"]').text()).toBe('common.copied')
  })

  it('selects the code and asks for a manual copy when nothing copies', async () => {
    writeText.mockRejectedValue(new DOMException('denied', 'NotAllowedError'))
    const wrapper = mountField()
    await wrapper.get('[data-testid="pairing-code-copy"]').trigger('click')
    await flushPromises()
    const field = wrapper.get<HTMLTextAreaElement>('[data-testid="pairing-code-text"]').element
    expect(document.activeElement).toBe(field)
    expect(field.selectionStart).toBe(0)
    expect(field.selectionEnd).toBe(CODE.length)
    const note = wrapper.get('[data-testid="pairing-code-copy-failed"]')
    expect(note.text()).toBe('encryption.code.copyFailed')
    expect(field.getAttribute('aria-describedby')).toBe(note.attributes('id'))
    expect(wrapper.get('[data-testid="pairing-code-copy"]').text()).toBe('encryption.code.copyCode')
  })

  it('offers no copy of an expired code', () => {
    const wrapper = mountField({ expired: true })
    expect(wrapper.get('[data-testid="pairing-code-copy"]').attributes('disabled')).toBeDefined()
  })
})
