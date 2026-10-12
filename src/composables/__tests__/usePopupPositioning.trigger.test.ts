import { describe, expect, it } from 'vitest'
import { ref } from 'vue'
import { usePopupPositioning } from '../usePopupPositioning'

function trigger(rect: { left: number; top: number; width: number; height: number }) {
  const el = document.createElement('button')
  document.body.appendChild(el)
  el.getBoundingClientRect = () => ({
    ...rect, x: rect.left, y: rect.top, right: rect.left + rect.width, bottom: rect.top + rect.height, toJSON() {},
  }) as DOMRect
  return el
}

describe('usePopupPositioning', () => {
  it('keeps the position it took when the trigger later leaves the layout', () => {
    const el = trigger({ left: 900, top: 400, width: 32, height: 32 })
    const { positionResult, updatePosition } = usePopupPositioning(ref(el), { width: 320, height: 400 }, { position: 'left' })
    updatePosition()
    const first = { ...positionResult.value }
    expect(first.x).toBeGreaterThan(500)

    el.getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, x: 0, y: 0, right: 0, bottom: 0, toJSON() {} }) as DOMRect
    updatePosition()
    expect(positionResult.value).toEqual(first)

    el.remove()
    updatePosition()
    expect(positionResult.value).toEqual(first)
  })

  it('follows a trigger that moved and is still laid out', () => {
    const el = trigger({ left: 900, top: 400, width: 32, height: 32 })
    const { positionResult, updatePosition } = usePopupPositioning(ref(el), { width: 320, height: 400 }, { position: 'left' })
    updatePosition()
    const before = positionResult.value!.y
    el.getBoundingClientRect = () => ({ left: 900, top: 450, width: 32, height: 32, x: 900, y: 450, right: 932, bottom: 482, toJSON() {} }) as DOMRect
    updatePosition()
    expect(positionResult.value!.y).not.toBe(before)
  })
})
