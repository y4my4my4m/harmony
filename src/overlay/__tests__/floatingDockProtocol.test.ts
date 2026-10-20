import { describe, expect, it } from 'vitest'
import { clientPointFor, landsOn, releasedOutside } from '../floatingDockProtocol'

describe('floating dock geometry', () => {
  const app = { x: 100, y: 50, width: 1200, height: 800 }

  it('lands on the app when the dock centre is inside the app window', () => {
    expect(landsOn({ x: 400, y: 400, width: 360, height: 56 }, app)).toBe(true)
    // Overlapping the left edge with its centre outside: still floating.
    expect(landsOn({ x: -200, y: 400, width: 360, height: 56 }, app)).toBe(false)
    expect(landsOn({ x: 1250, y: 400, width: 360, height: 56 }, app)).toBe(false)
    expect(landsOn({ x: 400, y: 400, width: 360, height: 56 }, { ...app, width: 0 })).toBe(false)
  })

  it('maps physical screen px to logical px from the app content origin', () => {
    expect(clientPointFor({ x: 700, y: 400 }, { x: 100, y: 100 }, 2)).toEqual({ x: 300, y: 150 })
    expect(clientPointFor({ x: 700, y: 400 }, { x: 100, y: 100 }, 0)).toEqual({ x: 600, y: 300 })
  })

  it('reads a release outside the viewport', () => {
    expect(releasedOutside(10, 10, 800, 600)).toBe(false)
    expect(releasedOutside(-1, 10, 800, 600)).toBe(true)
    expect(releasedOutside(10, 600, 800, 600)).toBe(true)
    expect(releasedOutside(800, 10, 800, 600)).toBe(true)
  })
})
