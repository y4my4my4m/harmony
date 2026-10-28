/**
 * CopyIdButton.vue: copies the given id and toasts the outcome; the accessible name says what is
 * copied and, with a target, for whom.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import CopyIdButton from '../CopyIdButton.vue'

vi.mock('vue-i18n', async () => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, params: Record<string, unknown> = {}) => {
    const message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    return message.replace(/\{(\w+)\}/g, (_: string, name: string) => String(params[name] ?? `{${name}}`))
  }
  return { useI18n: () => ({ t, locale: { value: 'en' } }) }
})

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, render: () => h('span') }) }
}
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const writeText = vi.fn()

beforeEach(() => {
  toast.success.mockReset()
  toast.error.mockReset()
  writeText.mockReset()
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
})

afterEach(() => {
  Reflect.deleteProperty(navigator, 'clipboard')
})

describe('CopyIdButton', () => {
  it('names a user ID button after its target and copies the id', async () => {
    writeText.mockResolvedValue(undefined)
    const w = mount(CopyIdButton, { props: { id: 'u-1', kind: 'user', target: '@alice' } })
    const button = w.get('button')
    expect(button.attributes('type')).toBe('button')
    expect(button.attributes('aria-label')).toBe('Copy user ID: @alice')
    expect(button.attributes('title')).toBe('Copy user ID: @alice')
    await button.trigger('click')
    await flushPromises()
    expect(writeText).toHaveBeenCalledWith('u-1')
    expect(toast.success).toHaveBeenCalledWith('User ID copied')
  })

  it('names a server ID button without a target', () => {
    const w = mount(CopyIdButton, { props: { id: 's-1', kind: 'server' } })
    expect(w.get('button').attributes('aria-label')).toBe('Copy server ID')
  })

  it('reports a refused clipboard', async () => {
    writeText.mockRejectedValue(new Error('denied'))
    const w = mount(CopyIdButton, { props: { id: 's-1', kind: 'server', target: 'Hub' } })
    await w.get('button').trigger('click')
    await flushPromises()
    expect(toast.success).not.toHaveBeenCalled()
    expect(toast.error).toHaveBeenCalledWith("Couldn't copy the server ID")
  })

  it('does not bubble the click to a clickable row', async () => {
    writeText.mockResolvedValue(undefined)
    const onRow = vi.fn()
    const Host = defineComponent({
      render: () => h('div', { onClick: onRow }, [h(CopyIdButton, { id: 'u-2', kind: 'user' })]),
    })
    const w = mount(Host)
    await w.get('button').trigger('click')
    expect(onRow).not.toHaveBeenCalled()
  })
})
