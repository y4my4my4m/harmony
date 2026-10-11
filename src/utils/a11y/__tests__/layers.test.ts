import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  hasOpenLayer,
  holdInert,
  inertOthers,
  isTopLayerElement,
  lockScroll,
  pushLayer,
  resetLayersForTests,
  resolveFocusOrigin,
  setMenuTrigger,
} from '../layers'

function el(html: string): HTMLElement {
  const host = document.createElement('div')
  host.innerHTML = html.trim()
  return host.firstElementChild as HTMLElement
}

function escape(target: EventTarget, init: KeyboardEventInit = {}) {
  const event = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

beforeEach(() => {
  document.body.innerHTML = ''
  resetLayersForTests()
})

afterEach(() => resetLayersForTests())

describe('Escape stack', () => {
  it('hands Escape to the topmost layer only', () => {
    const lower = el('<div><button>a</button></div>')
    const upper = el('<div><button>b</button></div>')
    document.body.append(lower, upper)
    const onLower = vi.fn()
    const onUpper = vi.fn()
    const removeLower = pushLayer({ kind: 'dialog', element: () => lower, onEscape: onLower })
    const removeUpper = pushLayer({ kind: 'dialog', element: () => upper, onEscape: onUpper })

    const event = escape(upper.querySelector('button')!)
    expect(onUpper).toHaveBeenCalledTimes(1)
    expect(onLower).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)

    removeUpper()
    escape(lower.querySelector('button')!)
    expect(onLower).toHaveBeenCalledTimes(1)
    removeLower()
    expect(hasOpenLayer()).toBe(false)
  })

  it('leaves Escape alone when a widget inside already consumed it', () => {
    const layer = el('<div><input /></div>')
    document.body.append(layer)
    const onEscape = vi.fn()
    pushLayer({ kind: 'dialog', element: () => layer, onEscape })
    const input = layer.querySelector('input')!
    input.addEventListener('keydown', (e) => e.preventDefault())
    escape(input)
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('ignores Escape from focus outside the topmost layer', () => {
    const layer = el('<div><button>in</button></div>')
    const popup = el('<div><button>popup</button></div>')
    document.body.append(layer, popup)
    const onEscape = vi.fn()
    pushLayer({ kind: 'dialog', element: () => layer, onEscape })
    escape(popup.querySelector('button')!)
    expect(onEscape).not.toHaveBeenCalled()
    escape(document.body)
    expect(onEscape).toHaveBeenCalledTimes(1)
  })

  it('lets an expanded combobox close its listbox first', () => {
    const layer = el('<div><input role="combobox" aria-expanded="true" /></div>')
    document.body.append(layer)
    const onEscape = vi.fn()
    pushLayer({ kind: 'dialog', element: () => layer, onEscape })
    escape(layer.querySelector('input')!)
    expect(onEscape).not.toHaveBeenCalled()
  })

  it('reports the topmost element', () => {
    const a = el('<div></div>')
    const b = el('<div></div>')
    pushLayer({ kind: 'dialog', element: () => a, onEscape: () => {} })
    const remove = pushLayer({ kind: 'menu', element: () => b, onEscape: () => {} })
    expect(isTopLayerElement(b)).toBe(true)
    expect(isTopLayerElement(a)).toBe(false)
    expect(hasOpenLayer('menu')).toBe(true)
    remove()
    expect(isTopLayerElement(a)).toBe(true)
  })
})

describe('inertOthers', () => {
  it('makes every sibling along the path inert and releases it', () => {
    document.body.innerHTML = '<div id="app"><nav id="nav"></nav><main id="main"><div id="dialog"></div><p id="p"></p></main></div><div id="other"></div>'
    const release = inertOthers([document.getElementById('dialog')!])
    expect(document.getElementById('nav')!.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('p')!.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('other')!.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('main')!.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
    release()
    expect(document.querySelectorAll('[inert]').length).toBe(0)
  })

  it('never touches persistent regions or elements that were inert before', () => {
    document.body.innerHTML = '<div id="app"></div><div id="live" data-a11y-persistent></div><div id="pre" inert></div><div id="dialog"></div>'
    const release = inertOthers([document.getElementById('dialog')!])
    expect(document.getElementById('live')!.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(true)
    release()
    expect(document.getElementById('pre')!.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('app')!.hasAttribute('inert')).toBe(false)
  })

  it('counts stacked holds so releasing in any order is safe', () => {
    document.body.innerHTML = '<div id="app"></div><div id="d1"></div><div id="d2"></div>'
    const app = document.getElementById('app')!
    const r1 = inertOthers([document.getElementById('d1')!])
    const r2 = inertOthers([document.getElementById('d2')!])
    expect(document.getElementById('d1')!.hasAttribute('inert')).toBe(true)
    r1()
    expect(app.hasAttribute('inert')).toBe(true)
    r2()
    expect(app.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('d1')!.hasAttribute('inert')).toBe(false)
  })

  it('keeps several roots interactive together', () => {
    document.body.innerHTML = '<div id="app"><nav id="rail"></nav><div id="layout"><nav id="channels"></nav><main id="main"></main></div><div id="backdrop"></div></div>'
    const release = inertOthers(['rail', 'channels', 'backdrop'].map((id) => document.getElementById(id)!))
    expect(document.getElementById('main')!.hasAttribute('inert')).toBe(true)
    expect(document.getElementById('rail')!.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('channels')!.hasAttribute('inert')).toBe(false)
    expect(document.getElementById('backdrop')!.hasAttribute('inert')).toBe(false)
    release()
  })

  it('holdInert shares the counts', () => {
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = document.getElementById('a')!
    const releaseHold = holdInert(a)
    const releaseOthers = inertOthers([document.getElementById('b')!])
    releaseHold()
    expect(a.hasAttribute('inert')).toBe(true)
    releaseOthers()
    expect(a.hasAttribute('inert')).toBe(false)
  })
})

describe('lockScroll', () => {
  it('restores the original overflow after the last release', () => {
    document.body.style.overflow = 'auto'
    const r1 = lockScroll()
    const r2 = lockScroll()
    expect(document.body.style.overflow).toBe('hidden')
    r1()
    expect(document.body.style.overflow).toBe('hidden')
    r2()
    expect(document.body.style.overflow).toBe('auto')
  })
})

describe('resolveFocusOrigin', () => {
  it('maps an item of an open menu to the menu trigger', () => {
    document.body.innerHTML = '<button id="trigger">t</button><div role="menu" id="menu"><button role="menuitem" id="item">i</button></div>'
    const trigger = document.getElementById('trigger') as HTMLElement
    setMenuTrigger(document.getElementById('menu')!, trigger)
    expect(resolveFocusOrigin(document.getElementById('item') as HTMLElement)).toBe(trigger)
    expect(resolveFocusOrigin(trigger)).toBe(trigger)
  })
})
