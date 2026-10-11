/**
 * ChannelEditModal.vue for keyboard and screen-reader users: a labelled modal dialog
 * whose close paths ask before dropping unsaved edits, a tablist, and channel
 * overrides as Deny / Inherit / Allow radio groups named by the permission.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { resetLayersForTests } from '@/utils/a11y/layers'
import type { Channel } from '@/types'

const { confirmMock, overrideMock } = vi.hoisted(() => ({
  confirmMock: vi.fn(),
  overrideMock: vi.fn(),
}))

vi.mock('vue-i18n', async (importOriginal) => {
  const messages = (await import('@/locales/en.json')).default as Record<string, any>
  const t = (key: string, a?: unknown, b?: unknown) => {
    let message = key.split('.').reduce<any>((node, part) => node?.[part], messages)
    if (typeof message !== 'string') return key
    const count = typeof a === 'number' ? a : typeof b === 'number' ? b : undefined
    const named: Record<string, unknown> = { ...(typeof a === 'object' && a ? a : {}), ...(count !== undefined ? { count, n: count } : {}) }
    if (count !== undefined && message.includes(' | ')) {
      const forms = message.split(' | ')
      message = forms[forms.length === 3 ? Math.min(count, 2) : count === 1 ? 0 : 1]
    }
    return message
      .replace(/\{'([^']*)'\}/g, '$1')
      .replace(/\{(\w+)\}/g, (_: string, name: string) => String(named[name] ?? `{${name}}`))
  }
  return { ...(await importOriginal<typeof import('vue-i18n')>()), useI18n: () => ({ t }) }
})
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', async () => {
  const { computed } = await import('vue')
  return {
    useServerPermissions: () => ({
      canManageChannels: computed(() => true),
      canManageWebhooks: computed(() => false),
      isCurrentUserServerOwner: computed(() => true),
    }),
  }
})
vi.mock('@/stores/useServerChannel', () => ({ useServerChannelStore: () => ({ updateChannel: vi.fn() }) }))
vi.mock('@/services/userDataService', () => ({ userDataService: { getCurrentUser: () => ({ isAdmin: false }) } }))
vi.mock('@/composables/useConfirmDialog', () => ({ useConfirmDialog: () => ({ confirm: confirmMock }) }))
vi.mock('@/services/RoleService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/RoleService')>()),
  roleService: {
    getRolesForServer: vi.fn().mockResolvedValue([
      { id: 'r-mod', name: 'Moderator', position: 2, color: '#f00', is_default: false },
      { id: 'r-everyone', name: '@everyone', position: 0, color: null, is_default: true },
    ]),
    getChannelOverrides: vi.fn().mockResolvedValue([]),
    setChannelOverride: overrideMock,
  },
}))

async function stub(name: string) {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name, props: ['channelId', 'channel', 'canManage', 'name', 'size'], render: () => h('span', { class: name }) }) }
}
vi.mock('@/components/ChannelEncryptionSection.vue', () => stub('ChannelEncryptionSection'))
vi.mock('@/components/ChannelWebhooksSection.vue', () => stub('ChannelWebhooksSection'))
vi.mock('@/components/common/Icon.vue', () => stub('Icon'))
vi.mock('@/components/common/ToggleSwitch.vue', () => stub('ToggleSwitch'))

const { default: ChannelEditModal } = await import('../ChannelEditModal.vue')

enableAutoUnmount(afterEach)

const channel = { id: 'c1', server_id: 's1', name: 'ops', type: 0, description: null, slowmode_seconds: 0 } as unknown as Channel

function mountModal() {
  return mount(ChannelEditModal, { props: { show: true, channel }, attachTo: document.body })
}

const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]')!
const tabs = () => Array.from(dialog().querySelectorAll<HTMLElement>('[role="tab"]'))

function key(target: Element, k: string, init: KeyboardEventInit = {}) {
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }))
}

async function openPermissions() {
  const wrapper = mountModal()
  await flushPromises()
  tabs()[1].click()
  await flushPromises()
  return wrapper
}

const radiogroup = (name: string) =>
  Array.from(dialog().querySelectorAll<HTMLElement>('[role="radiogroup"]')).find(
    group => document.getElementById(group.getAttribute('aria-labelledby')!)?.textContent === name,
  )!

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
  confirmMock.mockReset()
  overrideMock.mockReset().mockResolvedValue(true)
})

describe('ChannelEditModal dialog', () => {
  it('is a modal dialog named by its title, with a named close button and focus inside', async () => {
    mountModal()
    await flushPromises()
    const el = dialog()
    expect(el.getAttribute('aria-modal')).toBe('true')
    expect(document.getElementById(el.getAttribute('aria-labelledby')!)?.textContent).toBe('Edit channel')
    expect(el.querySelector('.modal-close')?.getAttribute('aria-label')).toBe('Close')
    expect(el.contains(document.activeElement)).toBe(true)
  })

  it('closes on Escape when nothing changed', async () => {
    const wrapper = mountModal()
    await flushPromises()
    key(document.activeElement!, 'Escape')
    await flushPromises()
    expect(confirmMock).not.toHaveBeenCalled()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('asks before Escape drops an edited name, and stays open when the user keeps editing', async () => {
    const wrapper = mountModal()
    await flushPromises()
    const name = dialog().querySelector<HTMLInputElement>('#channel-name')!
    name.value = 'renamed'
    name.dispatchEvent(new Event('input'))
    await nextTick()

    confirmMock.mockResolvedValueOnce(false)
    key(name, 'Escape')
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toBeUndefined()

    confirmMock.mockResolvedValueOnce(true)
    dialog().querySelector<HTMLButtonElement>('.modal-close')!.click()
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(2)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('asks before Cancel drops an unsaved override', async () => {
    const wrapper = await openPermissions()
    const send = radiogroup('Send Messages')
    send.querySelector<HTMLElement>('[data-state="deny"]')!.click()
    await nextTick()
    confirmMock.mockResolvedValueOnce(true)
    dialog().querySelector<HTMLButtonElement>('.btn-secondary')!.click()
    await flushPromises()
    expect(confirmMock).toHaveBeenCalledTimes(1)
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})

describe('ChannelEditModal tabs', () => {
  it('is a tablist; arrows move focus and selection, and the panel is labelled by its tab', async () => {
    mountModal()
    await flushPromises()
    const list = dialog().querySelector('[role="tablist"]')!
    const [general, permissions] = tabs()
    expect(general.getAttribute('aria-selected')).toBe('true')
    expect(general.getAttribute('tabindex')).toBe('0')
    expect(permissions.getAttribute('aria-selected')).toBe('false')
    expect(permissions.getAttribute('tabindex')).toBe('-1')

    general.focus()
    key(general, 'ArrowRight')
    await flushPromises()
    expect(document.activeElement).toBe(permissions)
    expect(permissions.getAttribute('aria-selected')).toBe('true')
    const panel = dialog().querySelector('[role="tabpanel"]')!
    expect(panel.id).toBe(permissions.getAttribute('aria-controls'))
    expect(panel.getAttribute('aria-labelledby')).toBe(permissions.id)

    key(permissions, 'Home')
    await flushPromises()
    expect(document.activeElement).toBe(general)
    expect(list.contains(document.activeElement)).toBe(true)
  })
})

describe('ChannelEditModal permission overrides', () => {
  it('renders each permission as a radio group named by it, with named Deny / Inherit / Allow radios', async () => {
    await openPermissions()
    const group = radiogroup('Send Messages')
    expect(group).toBeTruthy()
    expect(document.getElementById(group.getAttribute('aria-describedby')!)?.textContent).toBe('Post messages in this channel.')
    const radios = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))
    expect(radios.map(r => r.textContent?.trim())).toEqual(['Deny', 'Inherit', 'Allow'])
    expect(radios.map(r => r.getAttribute('aria-checked'))).toEqual(['false', 'true', 'false'])
    expect(radios.map(r => r.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('moves and selects with arrow keys, wrapping, and saves the chosen state', async () => {
    await openPermissions()
    const group = radiogroup('Send Messages')
    const [deny, inherit, allow] = Array.from(group.querySelectorAll<HTMLElement>('[role="radio"]'))

    inherit.focus()
    key(inherit, 'ArrowRight')
    await nextTick()
    expect(document.activeElement).toBe(allow)
    expect(allow.getAttribute('aria-checked')).toBe('true')
    expect(inherit.getAttribute('aria-checked')).toBe('false')

    key(allow, 'ArrowRight')
    await nextTick()
    expect(document.activeElement).toBe(deny)
    expect(deny.getAttribute('aria-checked')).toBe('true')

    // The role's rail entry reports the unsaved change.
    const pill = dialog().querySelector<HTMLElement>('.perm-role-pill[aria-current="true"]')!
    expect(pill.textContent).toContain('Unsaved changes')

    dialog().querySelector<HTMLButtonElement>('.modal-footer .btn-primary')!.click()
    await flushPromises()
    expect(overrideMock).toHaveBeenCalledWith('c1', 'role', 'r-everyone', {}, { SEND_MESSAGES: true }, expect.any(Array))
  })

  it('marks the selected role in the rail with aria-current', async () => {
    await openPermissions()
    const pills = Array.from(dialog().querySelectorAll<HTMLElement>('.perm-role-pill'))
    expect(pills.map(p => p.getAttribute('aria-current'))).toEqual([null, 'true'])
    pills[0].click()
    await nextTick()
    expect(pills[0].getAttribute('aria-current')).toBe('true')
    expect(pills[1].getAttribute('aria-current')).toBeNull()
  })
})
