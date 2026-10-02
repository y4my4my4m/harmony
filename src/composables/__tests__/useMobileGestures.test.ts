import { describe, it, expect, beforeEach } from 'vitest'
import { useMobileGestures } from '../useMobileGestures'

// 375 px phone; edge zones are the outer 80 px on each side.
const at = (x: number) => ({ touches: [{ clientX: x, clientY: 400 }] }) as unknown as TouchEvent
const move = (x: number) => ({ touches: [{ clientX: x, clientY: 400 }], preventDefault() {} }) as unknown as TouchEvent

describe('useMobileGestures drag direction', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'innerWidth', { value: 375, configurable: true })
  })

  it('takes the side from the edge when no drawer is open', () => {
    const g = useMobileGestures()
    g.handleTouchStart(at(350), true)
    expect(g.touchState.value.dragDirection).toBe('right')
    g.handleTouchStart(at(20), true)
    expect(g.touchState.value.dragDirection).toBe('left')
  })

  it('drives the open drawer from the opposite edge zone', () => {
    const g = useMobileGestures()
    // Peek beside an open channel drawer: inside the right edge zone.
    g.handleTouchStart(at(347), true, 'left')
    expect(g.touchState.value.dragDirection).toBe('left')
    const starts: string[] = []
    const moves: Array<[number, string]> = []
    for (const x of [340, 330, 300, 250]) {
      g.handleTouchMove(move(x), true, true, {
        onSwipeLeft: () => {},
        onSwipeRight: () => {},
        onDragStart: (d) => starts.push(d),
        onDragMove: (dx, d) => moves.push([dx, d]),
      })
    }
    expect(starts).toEqual(['left'])
    expect(moves.at(-1)).toEqual([-97, 'left'])
  })

  it('drives an open member list from the left edge zone', () => {
    const g = useMobileGestures()
    g.handleTouchStart(at(28), true, 'right')
    expect(g.touchState.value.dragDirection).toBe('right')
  })
})
