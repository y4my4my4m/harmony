import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { GIF_DOCK_ENTER_MS, GIF_DOCK_LONG_PRESS_MS, useGifDock } from '../useGifDock'

const pointer = (pointerType: string, extra: Record<string, unknown> = {}) =>
  ({ pointerType, isPrimary: true, pointerId: 1, clientX: 0, clientY: 0, ...extra }) as unknown as PointerEvent

/** A strip tile as InlineGifPicker renders it: the tile, its pick button and the image in it. */
function tile(id: string) {
  const root = document.createElement('div')
  root.className = 'inline-gif-item'
  const button = document.createElement('button')
  button.setAttribute('data-gif-tile', id)
  const img = document.createElement('img')
  button.appendChild(img)
  root.appendChild(button)
  document.body.appendChild(root)
  return { root, button, img }
}

describe('useGifDock', () => {
  let scope: ReturnType<typeof effectScope>
  let dock: ReturnType<typeof useGifDock>
  let hovering: boolean
  let keyboardTile: string | null

  beforeEach(() => {
    vi.useFakeTimers()
    hovering = false
    keyboardTile = null
    scope = effectScope()
    dock = scope.run(() => useGifDock({ hovering: () => hovering, keyboardTile: () => keyboardTile }))!
  })

  afterEach(() => {
    scope.stop()
    vi.useRealTimers()
    document.body.innerHTML = ''
  })

  const strip = () => dock.stripListeners

  it('magnifies after the pointer rests on the strip, at its latest x', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    strip().onPointermove(pointer('mouse', { clientX: 140 }))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS - 1)
    expect(dock.state.value).toBeNull()
    vi.advanceTimersByTime(1)
    expect(dock.state.value).toEqual({ mode: 'pointer', x: 140, focusId: null })
  })

  it('does nothing for a pointer crossing the strip', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    vi.advanceTimersByTime(60)
    hovering = false
    strip().onPointerleave(pointer('mouse'))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS * 2)
    expect(dock.state.value).toBeNull()
  })

  it('follows the pointer at once while magnified, over the strip or a magnified tile', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS)
    strip().onPointermove(pointer('mouse', { clientX: 260 }))
    expect(dock.state.value?.x).toBe(260)
    dock.tileListeners.onPointermove(pointer('mouse', { clientX: 300 }))
    expect(dock.state.value?.x).toBe(300)
  })

  it('ends when the pointer leaves, or hands over to keyboard focus', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS)
    hovering = false
    keyboardTile = 'g2'
    strip().onPointerleave(pointer('mouse'))
    vi.advanceTimersByTime(100)
    expect(dock.state.value).toEqual({ mode: 'focus', x: null, focusId: 'g2' })
    keyboardTile = null
    vi.advanceTimersByTime(300)
    expect(dock.state.value).toBeNull()
  })

  it('centres on a result focused from the keyboard, not on one a click focused', () => {
    const t = tile('g3')
    const visible = vi.fn(() => false)
    t.button.matches = visible as unknown as typeof t.button.matches
    strip().onFocusin({ target: t.button } as unknown as FocusEvent)
    expect(visible).toHaveBeenCalledWith(':focus-visible')
    expect(dock.state.value).toBeNull()

    visible.mockReturnValue(true)
    strip().onFocusin({ target: t.button } as unknown as FocusEvent)
    expect(dock.state.value).toEqual({ mode: 'focus', x: null, focusId: 'g3' })
  })

  it('magnifies on a touch long-press, ends on release and swallows the release click', () => {
    const t = tile('g4')
    hovering = true
    strip().onPointerdown(pointer('touch', { target: t.img }))
    vi.advanceTimersByTime(GIF_DOCK_LONG_PRESS_MS - 1)
    expect(dock.state.value).toBeNull()
    vi.advanceTimersByTime(1)
    expect(dock.state.value).toEqual({ mode: 'press', x: null, focusId: 'g4' })

    const menu = { preventDefault: vi.fn() } as unknown as MouseEvent
    strip().onContextmenu(menu)
    expect(menu.preventDefault).toHaveBeenCalled()

    // A tapped element keeps :hover on touch browsers; it does not hold the magnification.
    strip().onPointerup(pointer('touch'))
    expect(dock.state.value).toBeNull()

    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
    strip().onClickCapture(click)
    expect(click.preventDefault).toHaveBeenCalled()
    expect(click.stopPropagation).toHaveBeenCalled()
    const later = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
    strip().onClickCapture(later)
    expect(later.preventDefault).not.toHaveBeenCalled()
  })

  it('leaves a short tap as a pick and a dragging finger as a scroll', () => {
    const t = tile('g1')
    strip().onPointerdown(pointer('touch', { target: t.img }))
    vi.advanceTimersByTime(120)
    strip().onPointerup(pointer('touch'))
    vi.advanceTimersByTime(GIF_DOCK_LONG_PRESS_MS)
    expect(dock.state.value).toBeNull()
    const click = { preventDefault: vi.fn(), stopPropagation: vi.fn() } as unknown as MouseEvent
    strip().onClickCapture(click)
    expect(click.preventDefault).not.toHaveBeenCalled()

    strip().onPointerdown(pointer('touch', { target: t.img, clientX: 10, clientY: 10 }))
    strip().onPointermove(pointer('touch', { clientX: 40, clientY: 12 }))
    vi.advanceTimersByTime(GIF_DOCK_LONG_PRESS_MS * 2)
    expect(dock.state.value).toBeNull()
  })

  it('ends when nothing holds it any more, without a leave event', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS)
    expect(dock.state.value).not.toBeNull()
    hovering = false
    vi.advanceTimersByTime(300)
    expect(dock.state.value).toBeNull()
  })

  it('ends when the window loses focus', () => {
    hovering = true
    strip().onPointerenter(pointer('mouse', { clientX: 100 }))
    vi.advanceTimersByTime(GIF_DOCK_ENTER_MS)
    window.dispatchEvent(new Event('blur'))
    expect(dock.state.value).toBeNull()
  })
})
