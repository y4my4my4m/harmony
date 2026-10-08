/**
 * Pointer drag on the rail: mouse threshold, combine, reorder, touch
 * long-press, Escape cancel and the Alt+Arrow keyboard move.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mount, flushPromises, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { computed, ref } from 'vue'
import type { Server, ServerFolder } from '@/types'

vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
  useRoute: () => ({ name: 'Chat', params: {}, fullPath: '/chat' }),
}))
vi.mock('vue-i18n', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-i18n')>()),
  useI18n: () => ({ t: (key: string) => key, locale: ref('en') }),
}))
vi.mock('@/composables/useLeaveServer', () => ({ useLeaveServer: () => ({ leaveServer: vi.fn(), isOwner: () => false }) }))
vi.mock('vue-toastification', () => ({ useToast: () => ({ success: vi.fn(), error: vi.fn() }) }))
vi.mock('@/composables/useServerPermissions', () => ({
  useServerPermissions: () => ({
    serverSettingsPermissions: computed(() => ({ canEditBasicInfo: false })),
    channelPermissions: computed(() => ({ canCreateChannels: false })),
  }),
}))
vi.mock('@/services/AuthContextService', () => ({
  authContextService: { getCurrentContext: vi.fn().mockResolvedValue({ isAuthenticated: false }), getCurrentProfileId: vi.fn() },
}))
vi.mock('@/services/UserEventChannel', () => ({
  userEventChannel: { connect: vi.fn(), on: vi.fn().mockReturnValue(() => {}), send: vi.fn(), disconnect: vi.fn() },
}))
vi.mock('@/stores/auth', () => ({ useAuthStore: vi.fn(() => ({ session: { user: { id: 'me' } } })) }))
vi.mock('@/router', () => ({ default: { push: vi.fn() } }))
vi.mock('@/utils/faviconBadge', () => ({ updateFaviconBadge: vi.fn() }))

import ServerRail from '../ServerRail.vue'
import { LONG_PRESS_MS } from '../useRailDrag'
import { useServerChannelStore } from '@/stores/useServerChannel'

const s = (id: string, position: number, folder_id: string | null = null) =>
  ({ id, name: id, position, folder_id }) as unknown as Server

/** Entry pitch in the fake layout: 48 px icon + 8 px gap. */
const PITCH = 56
/** First entry's top; keeps test pointers clear of the autoscroll band. */
const OFFSET = 100
/** Pointer y at `fraction` of entry `index`. */
const at = (index: number, fraction = 0.5) => OFFSET + index * PITCH + 48 * fraction

function fakeLayout(root: HTMLElement) {
  const tops = new Map<Element, number>()
  root.querySelectorAll('[data-rail-kind]').forEach((el, i) => tops.set(el, OFFSET + i * PITCH))
  root.querySelectorAll('[data-rail-root]').forEach((el) => {
    const inner = el.querySelector('[data-rail-kind]')
    if (inner) tops.set(el, tops.get(inner)!)
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this === root) return { top: 0, bottom: 2000, left: 0, right: 72, width: 72, height: 2000, x: 0, y: 0 } as DOMRect
    const top = tops.get(this) ?? 0
    return { top, bottom: top + 48, left: 12, right: 60, width: 48, height: 48, x: 12, y: top } as DOMRect
  })
}

const pointer = (type: string, y: number, extra: Partial<PointerEventInit> = {}) =>
  new PointerEvent(type, { bubbles: true, clientX: 30, clientY: y, pointerId: 1, pointerType: 'mouse', button: 0, ...extra })

const frame = () => new Promise(r => setTimeout(r, 20))

describe('ServerRail drag', () => {
  let wrapper: VueWrapper
  let store: ReturnType<typeof useServerChannelStore>
  let apply: ReturnType<typeof vi.fn>

  beforeEach(() => {
    setActivePinia(createPinia())
    store = useServerChannelStore()
    store.currentUserId = 'me'
    store.folders = [{ id: 'F1', user_id: 'me', name: 'F', color: '#000', position: 2, is_expanded: true } as ServerFolder]
    store.servers = [s('a', 0), s('b', 1), s('m', 0, 'F1'), s('d', 3)]
    apply = vi.fn(async () => true)
    store.applyRailPlan = apply as any
    wrapper = mount(ServerRail, { props: { servers: store.servers }, attachTo: document.body, global: { stubs: { Teleport: true } } })
    fakeLayout(wrapper.element as HTMLElement)
  })

  afterEach(() => {
    wrapper.unmount()
    vi.restoreAllMocks()
    document.querySelectorAll('.rail-drag-ghost').forEach(g => g.remove())
  })

  const el = (id: string) => wrapper.element.querySelector(`[data-rail-id="${id}"]`) as HTMLElement

  it('does not start a drag under the mouse threshold, and the click still selects', async () => {
    el('d').dispatchEvent(pointer('pointerdown', at(4)))
    window.dispatchEvent(pointer('pointermove', at(4) + 2))
    window.dispatchEvent(pointer('pointerup', at(4) + 2))
    await frame()
    expect(document.querySelector('.rail-drag-ghost')).toBeNull()
    el('d').click()
    expect(wrapper.emitted('select-server')?.[0]).toEqual(['d'])
    expect(apply).not.toHaveBeenCalled()
  })

  it('combines two servers into a new folder', async () => {
    el('d').dispatchEvent(pointer('pointerdown', at(4)))
    window.dispatchEvent(pointer('pointermove', at(4) - 14))
    expect(document.querySelector('.rail-drag-ghost')).not.toBeNull()
    window.dispatchEvent(pointer('pointermove', at(0)))
    await frame()
    const indicator = wrapper.element.querySelector('.rail-drop-indicator') as HTMLElement
    expect(indicator.dataset.mode).toBe('ring')
    window.dispatchEvent(pointer('pointerup', at(0)))
    await flushPromises()
    expect(document.querySelector('.rail-drag-ghost')).toBeNull()
    const plan = apply.mock.calls[0][0]
    expect(plan.createFolder).toMatchObject({ position: 0 })
    expect(plan.serverUpdates.map((u: any) => [u.serverId, u.folderId === plan.createFolder.id, u.position])).toEqual([
      ['a', true, 0],
      ['d', true, 1],
    ])
  })

  it('reorders with a before line and swallows the trailing click', async () => {
    el('d').dispatchEvent(pointer('pointerdown', at(4)))
    window.dispatchEvent(pointer('pointermove', at(4) - 20))
    window.dispatchEvent(pointer('pointermove', at(1, 0.1)))
    await frame()
    expect((wrapper.element.querySelector('.rail-drop-indicator') as HTMLElement).dataset.mode).toBe('line')
    window.dispatchEvent(pointer('pointerup', at(1, 0.1)))
    el('d').click()
    await flushPromises()
    expect(wrapper.emitted('select-server')).toBeUndefined()
    const plan = apply.mock.calls[0][0]
    expect(plan.serverUpdates).toEqual([
      { serverId: 'd', folderId: null, position: 1 },
      { serverId: 'b', folderId: null, position: 2 },
    ])
    expect(plan.folderUpdates).toEqual([{ folderId: 'F1', position: 3 }])
  })

  it('moves a folder member out to root', async () => {
    el('m').dispatchEvent(pointer('pointerdown', at(3)))
    window.dispatchEvent(pointer('pointermove', at(3) + 10))
    window.dispatchEvent(pointer('pointermove', at(4, 0.9)))
    await frame()
    window.dispatchEvent(pointer('pointerup', at(4, 0.9)))
    await flushPromises()
    const plan = apply.mock.calls[0][0]
    expect(plan.deleteFolders).toEqual(['F1'])
    expect(plan.serverUpdates.find((u: any) => u.serverId === 'm')).toEqual({ serverId: 'm', folderId: null, position: 3 })
  })

  it('cancels on Escape', async () => {
    el('d').dispatchEvent(pointer('pointerdown', at(4)))
    window.dispatchEvent(pointer('pointermove', at(0, 0.1)))
    await frame()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    window.dispatchEvent(pointer('pointerup', at(0, 0.1)))
    await flushPromises()
    expect(apply).not.toHaveBeenCalled()
    expect(document.querySelector('.rail-drag-ghost')).toBeNull()
  })

  it('opens the menu on a touch long-press released in place', async () => {
    vi.useFakeTimers()
    try {
      el('m').dispatchEvent(pointer('pointerdown', at(3), { pointerType: 'touch' }))
      vi.advanceTimersByTime(LONG_PRESS_MS + 10)
      window.dispatchEvent(pointer('pointerup', at(3), { pointerType: 'touch' }))
    } finally {
      vi.useRealTimers()
    }
    await flushPromises()
    expect(wrapper.find('.rail-menu [data-action="mark-read"]').exists()).toBe(true)
    expect(wrapper.find('.rail-menu [data-action="remove-from-folder"]').exists()).toBe(true)
  })

  it('treats touch movement before the long-press as a scroll', async () => {
    vi.useFakeTimers()
    try {
      el('d').dispatchEvent(pointer('pointerdown', at(4), { pointerType: 'touch' }))
      window.dispatchEvent(pointer('pointermove', at(4) + 30, { pointerType: 'touch' }))
      vi.advanceTimersByTime(LONG_PRESS_MS + 10)
      window.dispatchEvent(pointer('pointerup', at(4) + 30, { pointerType: 'touch' }))
    } finally {
      vi.useRealTimers()
    }
    await flushPromises()
    expect(wrapper.find('.rail-menu').exists()).toBe(false)
    expect(document.querySelector('.rail-drag-ghost')).toBeNull()
  })

  it('moves the focused entry with Alt+Arrow', async () => {
    el('b').dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true }))
    await flushPromises()
    expect(apply.mock.calls[0][0].serverUpdates).toEqual([
      { serverId: 'b', folderId: null, position: 0 },
      { serverId: 'a', folderId: null, position: 1 },
    ])
  })
})
