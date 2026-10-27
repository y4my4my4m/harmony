import { describe, it, expect } from 'vitest'
import { horizontalWheelDelta } from '../wheelToHorizontal'

const strip = (scrollLeft: number, scrollWidth = 1000, clientWidth = 400) => ({ scrollLeft, scrollWidth, clientWidth })
const wheel = (deltaY: number, deltaX = 0, deltaMode = 0) => ({ deltaX, deltaY, deltaMode })

describe('horizontalWheelDelta', () => {
  it('turns a vertical wheel into sideways pixels', () => {
    expect(horizontalWheelDelta(wheel(100), strip(50))).toBe(100)
    expect(horizontalWheelDelta(wheel(-100), strip(50))).toBe(-100)
  })

  it('scales line and page deltas', () => {
    expect(horizontalWheelDelta(wheel(3, 0, 1), strip(0))).toBe(120)
    expect(horizontalWheelDelta(wheel(1, 0, 2), strip(0))).toBe(400)
  })

  it('leaves a mostly horizontal gesture to the browser', () => {
    expect(horizontalWheelDelta(wheel(10, 40), strip(50))).toBeNull()
    expect(horizontalWheelDelta(wheel(40, 40), strip(50))).toBeNull()
  })

  it('passes the wheel through at either end', () => {
    expect(horizontalWheelDelta(wheel(-100), strip(0))).toBeNull()
    expect(horizontalWheelDelta(wheel(100), strip(600))).toBeNull()
    expect(horizontalWheelDelta(wheel(100), strip(599.5))).toBeNull()
    expect(horizontalWheelDelta(wheel(-100), strip(600))).toBe(-100)
  })

  it('leaves a strip that does not overflow alone', () => {
    expect(horizontalWheelDelta(wheel(100), strip(0, 400, 400))).toBeNull()
  })
})
