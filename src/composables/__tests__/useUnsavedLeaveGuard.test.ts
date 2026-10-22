import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { defineComponent, h } from 'vue'
import { createRouter, createWebHistory, RouterView, type Router } from 'vue-router'
import { pushLayer, resetLayersForTests } from '@/utils/a11y/layers'
import { installOverlayHistory, OVERLAY_STATE_KEY } from '@/utils/overlayHistory'
import { useUnsavedLeaveGuard } from '@/composables/useUnsavedLeaveGuard'

const Page = { render: () => null }

let router: Router
let wrapper: VueWrapper
let uninstall: () => void
let dirty = false
let asks = 0
let answer: ((discard: boolean) => void) | null = null
let guard: ReturnType<typeof useUnsavedLeaveGuard>

const nativeGo = window.history.go.bind(window.history)
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
const position = () => (window.history.state as { position: number }).position
const overlayKey = () => (window.history.state as Record<string, unknown> | null)?.[OVERLAY_STATE_KEY]
const path = () => router.currentRoute.value.fullPath

/** The discard prompt: a dialog layer with a Back entry, closed before it answers. */
function ask(): Promise<boolean> {
  asks++
  return new Promise((resolve) => {
    const close = (discard: boolean) => {
      remove()
      answer = null
      resolve(discard)
    }
    const remove = pushLayer({ kind: 'dialog', element: () => document.body, onEscape: () => close(false) })
    answer = close
  })
}

const Editor = defineComponent({
  setup() {
    guard = useUnsavedLeaveGuard({ dirty: () => dirty, ask })
    return () => h('div')
  },
})

beforeEach(async () => {
  dirty = false
  asks = 0
  answer = null
  // happy-dom applies history.go() synchronously; browsers apply it on a later task.
  vi.spyOn(window.history, 'go').mockImplementation((delta?: number) => {
    setTimeout(() => nativeGo(delta), 0)
  })
  resetLayersForTests()
  router = createRouter({
    history: createWebHistory(),
    routes: [
      { path: '/a', component: Page },
      { path: '/b', component: Page },
      { path: '/edit', component: Editor },
      { path: '/c', component: Page },
    ],
  })
  uninstall = installOverlayHistory(router, () => true)
  wrapper = mount(defineComponent({ render: () => h(RouterView) }), { global: { plugins: [router] } })
  await router.isReady()
  await router.push('/a')
  await router.push('/b')
  await router.push('/edit')
  await settle()
  dirty = true
})

afterEach(() => {
  wrapper.unmount()
  uninstall()
  router.options.history.destroy()
  resetLayersForTests()
  vi.restoreAllMocks()
})

describe('useUnsavedLeaveGuard', () => {
  it('Back with unsaved edits asks on the view\'s own entry; Cancel stays', async () => {
    const own = position()
    window.history.go(-1)
    await settle()
    expect(asks).toBe(1)
    expect(path()).toBe('/edit')
    expect(window.location.pathname).toBe('/edit')
    expect(position()).toBe(own + 1)
    expect(overlayKey()).toEqual(expect.any(String))

    answer!(false)
    await settle()
    expect(path()).toBe('/edit')
    expect(position()).toBe(own)
    expect(overlayKey()).toBeUndefined()

    window.history.go(-1)
    await settle()
    expect(asks).toBe(2)
  })

  it('Discard repeats the Back: the page under the view, one entry down', async () => {
    const own = position()
    window.history.go(-1)
    await settle()
    answer!(true)
    await settle()
    expect(path()).toBe('/b')
    expect(position()).toBe(own - 1)
    expect(asks).toBe(1)
  })

  it('Back without unsaved edits leaves without asking', async () => {
    dirty = false
    window.history.go(-1)
    await settle()
    expect(asks).toBe(0)
    expect(path()).toBe('/b')
  })

  it('a push with unsaved edits waits for the answer; Back from the new page returns to the view', async () => {
    const pushed = router.push('/c')
    await settle()
    expect(asks).toBe(1)
    expect(path()).toBe('/edit')

    answer!(true)
    await pushed
    await settle()
    expect(path()).toBe('/c')

    window.history.go(-1)
    await settle()
    expect(path()).toBe('/edit')
  })

  it('a leave after confirmLeave() discarded does not ask again', async () => {
    const confirmed = guard.confirmLeave()
    await settle()
    answer!(true)
    expect(await confirmed).toBe(true)

    await router.push('/c')
    await settle()
    expect(asks).toBe(1)
    expect(path()).toBe('/c')
  })

  it('a second prompt is refused while one is open', async () => {
    void guard.confirmLeave()
    await settle()
    expect(await guard.confirmLeave()).toBe(false)
    expect(asks).toBe(1)
  })
})
