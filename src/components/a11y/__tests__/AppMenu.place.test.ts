/**
 * AppMenu at a point (a context menu): below the point when it fits, above it when it does
 * not, measured by its layout size: an entrance animation that scales it (Flux starts at
 * 0.6) shrinks its bounding box while the menu is placed.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { h, nextTick } from 'vue'
import AppMenu from '../AppMenu.vue'

enableAutoUnmount(afterEach)

const MENU = { width: 200, height: 240 }
let restore: Array<() => void> = []

beforeEach(() => {
  const proto = HTMLElement.prototype
  for (const [key, value] of [['offsetWidth', MENU.width], ['offsetHeight', MENU.height]] as const) {
    const original = Object.getOwnPropertyDescriptor(proto, key)!
    Object.defineProperty(proto, key, { configurable: true, get() { return this.classList?.contains('app-menu') ? value : 0 } })
    restore.push(() => Object.defineProperty(proto, key, original))
  }
  // A bounding box at 0.6 scale, as mid-animation.
  const originalRect = proto.getBoundingClientRect
  proto.getBoundingClientRect = function () {
    if (!this.classList?.contains('app-menu')) return originalRect.call(this)
    return { x: 0, y: 0, top: 0, left: 0, right: MENU.width * 0.6, bottom: MENU.height * 0.6, width: MENU.width * 0.6, height: MENU.height * 0.6, toJSON: () => ({}) } as DOMRect
  }
  restore.push(() => { proto.getBoundingClientRect = originalRect })
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 })
})

afterEach(() => {
  restore.forEach((fn) => fn())
  restore = []
})

const open = (x: number, y: number) =>
  mount(AppMenu, {
    props: { x, y, label: 'Channel' },
    slots: { default: () => h('button', { type: 'button', role: 'menuitem' }, 'Copy channel ID') },
    attachTo: document.body,
  })

const position = () => {
  const el = document.querySelector<HTMLElement>('.app-menu')!
  return { left: el.style.left, top: el.style.top }
}

describe('AppMenu at a point', () => {
  it('opens below the point when it fits', async () => {
    open(300, 100)
    await nextTick()
    expect(position()).toEqual({ left: '300px', top: '100px' })
  })

  it('opens upward from the point when it would overflow below, by its full height', async () => {
    open(300, 700)
    await nextTick()
    expect(position()).toEqual({ left: '300px', top: `${700 - MENU.height}px` })
  })

  it('keeps its bottom 8px inside the window when neither side of the point fits', async () => {
    Object.defineProperty(window, 'innerHeight', { configurable: true, value: 300 })
    open(300, 150)
    await nextTick()
    expect(position()).toEqual({ left: '300px', top: `${300 - MENU.height - 8}px` })
  })
})
