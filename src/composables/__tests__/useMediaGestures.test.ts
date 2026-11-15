/**
 * useMediaGestures: a one-finger swipe steps or dismisses, two fingers pinch an image and
 * hold anything else, a double tap toggles zoom, a mouse drags an image at any scale past its
 * edges and never swipes, the wheel zooms an image only, in proportion to its travel and
 * below fit, a touch returns a shrunk image to fit, and a click beside the media closes
 * unless it ends a swipe.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useMediaGestures } from '../useMediaGestures'
import { useMediaZoom } from '../useMediaZoom'
import { DOUBLE_TAP_SCALE, PAN_KEEP, WHEEL_NOTCH, ZOOM_STEP } from '@/utils/lightboxGestures'

// Stage 400 x 800 at the origin: its centre is client (200, 400). The image covers it.
const STAGE = { left: 0, top: 0, width: 400, height: 800, right: 400, bottom: 800, x: 0, y: 0 } as DOMRect

function setup({ zoomable = true, hasPrevious = true, hasNext = true } = {}) {
  const stage = document.createElement('div')
  stage.getBoundingClientRect = () => STAGE
  const zoomer = useMediaZoom({ content: () => ({ width: 400, height: 300 }), stage: () => ({ width: 400, height: 800 }) })
  const calls = { previous: vi.fn(), next: vi.fn(), dismiss: vi.fn(), close: vi.fn() }
  const gestures = useMediaGestures({
    zoomer,
    zoomable: () => zoomable,
    stage: () => stage,
    onMedia: (x, y) => x >= 0 && x <= 400 && y >= 250 && y <= 550,
    view: () => window,
    hasPrevious: () => hasPrevious,
    hasNext: () => hasNext,
    ...calls,
  })
  return { zoomer, gestures, calls }
}

type Kind = 'touch' | 'mouse'
const event = (type: string, id: number, x: number, y: number, pointerType: Kind = 'touch') =>
  new PointerEvent(type, { bubbles: true, pointerId: id, pointerType, clientX: x, clientY: y, button: 0 })

function down(gestures: ReturnType<typeof setup>['gestures'], id: number, x: number, y: number, kind: Kind = 'touch') {
  gestures.onPointerDown(event('pointerdown', id, x, y, kind))
}
const move = (id: number, x: number, y: number, kind: Kind = 'touch') => window.dispatchEvent(event('pointermove', id, x, y, kind))
const up = (id: number, x: number, y: number, kind: Kind = 'touch') => window.dispatchEvent(event('pointerup', id, x, y, kind))

function swipe(gestures: ReturnType<typeof setup>['gestures'], from: [number, number], to: [number, number]) {
  down(gestures, 1, ...from)
  move(1, (from[0] + to[0]) / 2, (from[1] + to[1]) / 2)
  move(1, ...to)
  up(1, ...to)
}

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useMediaGestures', () => {
  it('steps to the next item on a swipe left and back on a swipe right', () => {
    const { gestures, calls } = setup()
    swipe(gestures, [320, 400], [80, 400])
    expect(calls.next).toHaveBeenCalledTimes(1)
    swipe(gestures, [80, 400], [320, 400])
    expect(calls.previous).toHaveBeenCalledTimes(1)
    expect(calls.dismiss).not.toHaveBeenCalled()
  })

  it('moves the slide with the finger and resists past the last item', () => {
    const { gestures, calls } = setup({ hasNext: false })
    down(gestures, 1, 320, 400)
    move(1, 120, 400)
    expect(gestures.dragging.value).toBe(true)
    expect(gestures.drag.x).toBe(-50)
    up(1, 120, 400)
    expect(calls.next).not.toHaveBeenCalled()
    expect(gestures.drag.x).toBe(0)
  })

  it('dismisses on a swipe down', () => {
    const { gestures, calls } = setup()
    swipe(gestures, [200, 200], [200, 500])
    expect(calls.dismiss).toHaveBeenCalledTimes(1)
  })

  it('pinches an image open', () => {
    const { gestures, zoomer, calls } = setup()
    down(gestures, 1, 170, 400)
    down(gestures, 2, 230, 400)
    move(1, 70, 400)
    move(2, 330, 400)
    expect(zoomer.zoom.scale).toBeGreaterThan(4)
    up(1, 70, 400)
    up(2, 330, 400)
    expect(calls.next).not.toHaveBeenCalled()
    expect(calls.previous).not.toHaveBeenCalled()
  })

  it('holds two fingers on media that does not zoom', () => {
    const { gestures, zoomer, calls } = setup({ zoomable: false })
    down(gestures, 1, 300, 400)
    down(gestures, 2, 330, 400)
    move(1, 60, 400)
    move(2, 90, 400)
    up(1, 60, 400)
    up(2, 90, 400)
    expect(zoomer.zoom.scale).toBe(1)
    expect(calls.next).not.toHaveBeenCalled()
  })

  it('toggles zoom on a double tap on the image', () => {
    const { gestures, zoomer } = setup()
    for (let i = 0; i < 2; i++) {
      down(gestures, 1, 200, 400)
      up(1, 200, 400)
    }
    expect(zoomer.zoom.scale).toBe(DOUBLE_TAP_SCALE)
    for (let i = 0; i < 2; i++) {
      down(gestures, 1, 200, 400)
      up(1, 200, 400)
    }
    expect(zoomer.zoom.scale).toBe(1)
  })

  it('pans a zoomed image with one finger instead of swiping', () => {
    const { gestures, zoomer, calls } = setup()
    zoomer.zoomBy(2)
    swipe(gestures, [200, 400], [100, 400])
    expect(calls.next).not.toHaveBeenCalled()
    expect(zoomer.zoom.x).toBe(-100)
  })

  it('drags an image with the mouse at any scale and never swipes with it', () => {
    const { gestures, zoomer, calls } = setup()
    down(gestures, 1, 320, 400, 'mouse')
    move(1, 80, 460, 'mouse')
    up(1, 80, 460, 'mouse')
    expect(calls.next).not.toHaveBeenCalled()
    expect(calls.dismiss).not.toHaveBeenCalled()
    // Unzoomed, and 300 px high in 800 px of stage: it still follows the mouse.
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: -240, y: 60 })

    // Zoom about the stage centre doubles the offset; nothing pulls the image back.
    zoomer.zoomBy(2)
    expect(zoomer.zoom).toMatchObject({ scale: 2, x: -480, y: 120 })
    down(gestures, 1, 200, 400, 'mouse')
    move(1, 150, 400, 'mouse')
    up(1, 150, 400, 'mouse')
    expect(zoomer.zoom.x).toBe(-530)
  })

  it('stops a mouse drag with part of the image left on the stage', () => {
    const { gestures, zoomer } = setup()
    down(gestures, 1, 200, 400, 'mouse')
    move(1, 5000, -5000, 'mouse')
    up(1, 5000, -5000, 'mouse')
    // 400 x 300 on a 400 x 800 stage: centre to centre less the part kept.
    expect(zoomer.zoom.x).toBe(400 - PAN_KEEP)
    expect(zoomer.zoom.y).toBe(-(550 - PAN_KEEP))
  })

  it('leaves a mouse press beside the image, or on media that does not zoom, alone', () => {
    const beside = setup()
    down(beside.gestures, 1, 200, 100, 'mouse')
    move(1, 260, 160, 'mouse')
    up(1, 260, 160, 'mouse')
    expect(beside.zoomer.zoom).toMatchObject({ x: 0, y: 0 })

    const video = setup({ zoomable: false })
    down(video.gestures, 1, 320, 400, 'mouse')
    move(1, 80, 400, 'mouse')
    up(1, 80, 400, 'mouse')
    expect(video.calls.next).not.toHaveBeenCalled()
    expect(video.zoomer.zoom).toMatchObject({ x: 0, y: 0 })
  })

  it('holds the image to its edges again on a touch, and centres it back at fit', () => {
    const { gestures, zoomer } = setup()
    zoomer.zoomBy(2)
    down(gestures, 1, 200, 400, 'mouse')
    move(1, 500, 400, 'mouse')
    up(1, 500, 400, 'mouse')
    expect(zoomer.zoom.x).toBe(300)
    // 800 px wide at scale 2 over a 400 px stage: 200 px either way.
    down(gestures, 2, 200, 400)
    up(2, 200, 400)
    expect(zoomer.zoom.x).toBe(200)

    down(gestures, 1, 200, 400, 'mouse')
    move(1, 500, 400, 'mouse')
    up(1, 500, 400, 'mouse')
    zoomer.zoomBy(1 / 2)
    expect(zoomer.zoom).toMatchObject({ scale: 1, x: 0, y: 0 })
    expect(zoomer.free.value).toBe(false)
  })

  it('zooms an image with the wheel and leaves other media alone', () => {
    const image = setup()
    const wheel = new WheelEvent('wheel', { deltaY: -100, clientX: 200, clientY: 400, cancelable: true })
    image.gestures.onWheel(wheel)
    expect(wheel.defaultPrevented).toBe(true)
    expect(image.zoomer.zoom.scale).toBe(ZOOM_STEP)

    const video = setup({ zoomable: false })
    const scroll = new WheelEvent('wheel', { deltaY: -100, cancelable: true })
    video.gestures.onWheel(scroll)
    expect(scroll.defaultPrevented).toBe(false)
    expect(video.zoomer.zoom.scale).toBe(1)
  })

  it('zooms by a part of a step for wheel travel short of a notch', () => {
    const { gestures, zoomer } = setup()
    const at = { clientX: 200, clientY: 400, cancelable: true }
    gestures.onWheel(new WheelEvent('wheel', { deltaY: -WHEEL_NOTCH / 4, ...at }))
    expect(zoomer.zoom.scale).toBeCloseTo(ZOOM_STEP ** 0.25)
    for (let i = 0; i < 3; i++) gestures.onWheel(new WheelEvent('wheel', { deltaY: -WHEEL_NOTCH / 4, ...at }))
    expect(zoomer.zoom.scale).toBeCloseTo(ZOOM_STEP)
    // A line-mode notch is one step whatever its count.
    gestures.onWheel(new WheelEvent('wheel', { deltaY: 3, deltaMode: 1, ...at }))
    expect(zoomer.zoom.scale).toBeCloseTo(1)
  })

  it('shrinks an image below fit with the wheel; a touch returns it to fit and swipes', () => {
    const { gestures, zoomer, calls } = setup()
    const out = () => gestures.onWheel(new WheelEvent('wheel', { deltaY: 100, clientX: 200, clientY: 400, cancelable: true }))
    out()
    out()
    expect(zoomer.zoom.scale).toBeCloseTo(0.64)
    swipe(gestures, [320, 400], [80, 400])
    expect(zoomer.zoom.scale).toBe(1)
    expect(calls.next).toHaveBeenCalledTimes(1)
  })

  it('ignores the wheel during a drag', () => {
    const { gestures, zoomer } = setup()
    down(gestures, 1, 200, 400, 'mouse')
    move(1, 260, 400, 'mouse')
    gestures.onWheel(new WheelEvent('wheel', { deltaY: -100, clientX: 260, clientY: 400, cancelable: true }))
    expect(zoomer.zoom.scale).toBe(1)
    up(1, 260, 400, 'mouse')
  })

  it('closes on a click beside the media, not on the click that ends a swipe', () => {
    const { gestures, calls } = setup()
    swipe(gestures, [320, 100], [80, 100])
    gestures.onStageClick(new MouseEvent('click', { clientX: 80, clientY: 100 }))
    expect(calls.close).not.toHaveBeenCalled()
    down(gestures, 1, 20, 100)
    up(1, 20, 100)
    gestures.onStageClick(new MouseEvent('click', { clientX: 20, clientY: 100 }))
    expect(calls.close).toHaveBeenCalledTimes(1)
    gestures.onStageClick(new MouseEvent('click', { clientX: 200, clientY: 400 }))
    expect(calls.close).toHaveBeenCalledTimes(1)
  })
})
