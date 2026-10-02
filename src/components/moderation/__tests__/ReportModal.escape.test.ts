import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import ReportModal from '../ReportModal.vue'

const { createReport } = vi.hoisted(() => ({ createReport: vi.fn() }))

vi.mock('@/services/ReportService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/ReportService')>()),
  reportService: { createReport },
}))

// vi.mock factories are hoisted above imports; the stub is built from a dynamic import.
async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Avatar.vue', () => stub('Avatar'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/DisplayName.vue', () => stub('DisplayName'))

enableAutoUnmount(afterEach)

function mountModal() {
  return mount(ReportModal, {
    props: { reportType: 'message', targetMessageId: 'msg-1', targetUserId: 'user-1' },
    attachTo: document.body,
    global: { stubs: { teleport: true } },
  })
}

function pressEscape(target: EventTarget, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, ...init }))
}

async function submit(wrapper: ReturnType<typeof mountModal>) {
  await wrapper.find('input[type="radio"]').setValue(true)
  await wrapper.find('.btn-submit').trigger('click')
}

beforeEach(() => {
  createReport.mockReset()
  document.body.innerHTML = ''
})

describe('ReportModal Escape and focus', () => {
  it('closes on Escape from inside the dialog', () => {
    const wrapper = mountModal()
    const textarea = wrapper.find('textarea').element
    textarea.focus()

    pressEscape(textarea)

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('ignores Escape while a submit is in flight', async () => {
    let resolve!: (result: { ok: true }) => void
    createReport.mockReturnValue(new Promise(r => { resolve = r }))
    const wrapper = mountModal()

    await submit(wrapper)
    expect(wrapper.find('.btn-submit').text()).toBe('Submitting…')
    pressEscape(document)
    expect(wrapper.emitted('close')).toBeUndefined()

    resolve({ ok: true })
    await flushPromises()
    expect(wrapper.find('.success-overlay').exists()).toBe(true)
    pressEscape(document)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('closes on Escape after a failed submit', async () => {
    createReport.mockResolvedValue({ ok: false, message: 'boom' })
    const wrapper = mountModal()

    await submit(wrapper)
    await flushPromises()
    pressEscape(document)

    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('ignores Escape that ends an IME composition', () => {
    const wrapper = mountModal()

    pressEscape(wrapper.find('textarea').element, { isComposing: true })

    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('keeps Escape from reaching window listeners beneath it', async () => {
    const beneath = vi.fn()
    window.addEventListener('keydown', beneath)
    try {
      let resolve!: (result: { ok: false; message: string }) => void
      createReport.mockReturnValue(new Promise(r => { resolve = r }))
      const wrapper = mountModal()

      pressEscape(wrapper.find('textarea').element)
      await submit(wrapper)
      pressEscape(document)
      resolve({ ok: false, message: 'boom' })
      await flushPromises()

      expect(beneath).not.toHaveBeenCalled()
    } finally {
      window.removeEventListener('keydown', beneath)
    }
  })

  it('stops listening once unmounted', () => {
    const wrapper = mountModal()
    wrapper.unmount()

    pressEscape(document)

    expect(wrapper.emitted('close')).toBeUndefined()
  })

  it('focuses the dialog on open and returns focus to the opener on close', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const wrapper = mountModal()
    expect(document.activeElement).toBe(wrapper.find('[role="dialog"]').element)

    wrapper.find('textarea').element.focus()
    wrapper.unmount()
    expect(document.activeElement).toBe(opener)
  })

  it('leaves focus on the body when the opener has left the document', () => {
    const opener = document.createElement('button')
    document.body.appendChild(opener)
    opener.focus()

    const wrapper = mountModal()
    opener.remove()
    wrapper.unmount()

    expect(document.activeElement).toBe(document.body)
  })
})
