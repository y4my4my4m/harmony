import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { pushLayer, resetLayersForTests, type LayerKind } from '@/utils/a11y/layers'
import { installOverlayHistory, OVERLAY_STATE_KEY } from '@/utils/overlayHistory'

const Page = { render: () => null }

let router: Router
let uninstall: () => void
let enabled = true

// history.go() resolves on a later task in happy-dom, as in browsers.
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))

interface Overlay {
  close: () => void
  isOpen: () => boolean
  /** Number of Escape/Back closes requested. */
  closeRequests: () => number
}

function open(kind: LayerKind, opts: { refuseClose?: boolean } = {}): Overlay {
  let remove: (() => void) | null = null
  let requests = 0
  const close = () => {
    remove?.()
    remove = null
  }
  remove = pushLayer({
    kind,
    element: () => document.body,
    onEscape: () => {
      requests++
      if (!opts.refuseClose) close()
    },
  })
  return { close, isOpen: () => remove !== null, closeRequests: () => requests }
}

const overlayKey = () => (window.history.state as Record<string, unknown> | null)?.[OVERLAY_STATE_KEY]
const path = () => router.currentRoute.value.fullPath

async function back() {
  window.history.back()
  await settle()
}

beforeEach(async () => {
  enabled = true
  resetLayersForTests()
  router = createRouter({
    history: createWebHistory(),
    routes: ['/a', '/b', '/c'].map((p) => ({ path: p, component: Page })),
  })
  uninstall = installOverlayHistory(router, () => enabled)
  await router.push('/b')
  await router.push('/a')
  await settle()
})

afterEach(() => {
  uninstall()
  router.options.history.destroy()
  resetLayersForTests()
})

describe('overlay history', () => {
  it('gives an open dialog a Back entry at the same URL and closes it on Back', async () => {
    const before = window.history.length
    const dialog = open('dialog')
    await settle()
    expect(window.history.length).toBe(before + 1)
    expect(overlayKey()).toEqual(expect.any(String))
    expect(window.location.pathname).toBe('/a')

    await back()
    expect(dialog.isOpen()).toBe(false)
    expect(path()).toBe('/a')
    expect(overlayKey()).toBeUndefined()

    await back()
    expect(path()).toBe('/b')
  })

  it('drops the entry of an overlay closed another way, so Back then leaves the page', async () => {
    const dialog = open('dialog')
    await settle()
    dialog.close()
    await settle()
    expect(overlayKey()).toBeUndefined()
    expect(path()).toBe('/a')

    await back()
    expect(path()).toBe('/b')
  })

  it('closes stacked overlays one per Back, topmost first', async () => {
    const drawer = open('drawer')
    await settle()
    const dialog = open('dialog')
    await settle()

    await back()
    expect(dialog.isOpen()).toBe(false)
    expect(drawer.isOpen()).toBe(true)
    expect(path()).toBe('/a')

    await back()
    expect(drawer.isOpen()).toBe(false)
    expect(path()).toBe('/a')

    await back()
    expect(path()).toBe('/b')
  })

  it('a navigation from an open drawer takes the drawer entry\'s place in history', async () => {
    const drawer = open('drawer')
    await settle()
    await router.push('/c')
    drawer.close() // the drawer closes on the route change
    await settle()
    expect(path()).toBe('/c')
    expect(overlayKey()).toBeUndefined()

    await back()
    expect(path()).toBe('/a')
    expect(overlayKey()).toBeUndefined()

    await back()
    expect(path()).toBe('/b')
  })

  it('an overlay still open after a navigation gets an entry on the new route', async () => {
    const dialog = open('dialog')
    await settle()
    await router.push('/c')
    await settle()
    expect(dialog.isOpen()).toBe(true)
    expect(overlayKey()).toEqual(expect.any(String))

    await back()
    expect(dialog.isOpen()).toBe(false)
    expect(path()).toBe('/c')

    await back()
    expect(path()).toBe('/a')
  })

  it('an overlay that refuses Back keeps a Back entry', async () => {
    const guarded = open('dialog', { refuseClose: true })
    await settle()

    await back()
    expect(guarded.closeRequests()).toBe(1)
    expect(guarded.isOpen()).toBe(true)
    expect(overlayKey()).toEqual(expect.any(String))
    expect(path()).toBe('/a')

    guarded.close()
    await settle()
    expect(overlayKey()).toBeUndefined()
    await back()
    expect(path()).toBe('/b')
  })

  it('a dialog closed into another leaves only the second dialog\'s entry', async () => {
    const first = open('dialog')
    await settle()
    first.close()
    const dialog = open('dialog') // pushed once the first entry is gone
    await settle()
    expect(overlayKey()).toEqual(expect.any(String))

    await back()
    expect(dialog.isOpen()).toBe(false)
    expect(path()).toBe('/a')

    await back()
    expect(path()).toBe('/b')
  })

  it('keeps a URL replaced while the overlay was open', async () => {
    const dialog = open('dialog')
    await settle()
    await router.replace('/a?messageId=1')
    dialog.close()
    await settle()
    expect(path()).toBe('/a?messageId=1')
    expect(`${window.location.pathname}${window.location.search}`).toBe('/a?messageId=1')
    expect(overlayKey()).toBeUndefined()

    await back()
    expect(path()).toBe('/b')
  })

  it('pushes nothing while disabled (desktop layout)', async () => {
    enabled = false
    const before = window.history.length
    const dialog = open('dialog')
    await settle()
    expect(window.history.length).toBe(before)

    await back()
    expect(dialog.isOpen()).toBe(true)
    expect(path()).toBe('/b')
  })

  it('leaves menus and popovers alone', async () => {
    const before = window.history.length
    open('menu')
    open('popover')
    await settle()
    expect(window.history.length).toBe(before)
  })
})
