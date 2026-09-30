import { describe, it, expect, beforeEach } from 'vitest'
import {
  isQuickReactDoubleClick,
  QUICK_REACT_MAX_DISTANCE_PX,
  QUICK_REACT_MAX_INTERVAL_MS,
  type PointerDown,
  type QuickReactDoubleClick,
} from '../quickReactGesture'

let row: HTMLElement

beforeEach(() => {
  document.body.innerHTML = `
    <div class="message-item">
      <div class="message-body"><span class="text">hello world</span></div>
      <a href="#" class="link">link</a>
      <span class="mention">@bob</span>
      <div class="message-reactions"><div class="reaction">👍 1</div></div>
      <div class="link-embed"><div class="embed-title">Title</div></div>
      <pre><code>code</code></pre>
    </div>`
  row = document.querySelector('.message-body') as HTMLElement
})

const firstDown: PointerDown = { x: 100, y: 100, time: 1000 }

function dblclick(overrides: Partial<QuickReactDoubleClick> = {}): QuickReactDoubleClick {
  return {
    button: 0,
    shiftKey: false,
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    clientX: 100,
    clientY: 100,
    timeStamp: 1250,
    target: row,
    ...overrides,
  }
}

describe('isQuickReactDoubleClick', () => {
  it('reacts to a quick, still double-click on empty space', () => {
    expect(isQuickReactDoubleClick(dblclick(), firstDown, false)).toBe(true)
  })

  it('leaves a double-click on text to word selection', () => {
    expect(isQuickReactDoubleClick(dblclick(), firstDown, true)).toBe(false)
  })

  it('rejects presses further apart than the interval', () => {
    const late = dblclick({ timeStamp: firstDown.time + QUICK_REACT_MAX_INTERVAL_MS + 1 })
    expect(isQuickReactDoubleClick(late, firstDown, false)).toBe(false)
    const edge = dblclick({ timeStamp: firstDown.time + QUICK_REACT_MAX_INTERVAL_MS })
    expect(isQuickReactDoubleClick(edge, firstDown, false)).toBe(true)
  })

  it('rejects a pointer that moved between presses', () => {
    const moved = dblclick({ clientX: firstDown.x + QUICK_REACT_MAX_DISTANCE_PX + 1 })
    expect(isQuickReactDoubleClick(moved, firstDown, false)).toBe(false)
  })

  it('requires a recorded first press', () => {
    expect(isQuickReactDoubleClick(dblclick(), null, false)).toBe(false)
  })

  it('ignores modifiers and non-primary buttons', () => {
    for (const mod of ['shiftKey', 'ctrlKey', 'metaKey', 'altKey'] as const) {
      expect(isQuickReactDoubleClick(dblclick({ [mod]: true }), firstDown, false)).toBe(false)
    }
    expect(isQuickReactDoubleClick(dblclick({ button: 1 }), firstDown, false)).toBe(false)
  })

  it('leaves interactive content alone', () => {
    for (const selector of ['.link', '.mention', '.reaction', '.embed-title', 'code']) {
      const target = document.querySelector(selector)
      expect(isQuickReactDoubleClick(dblclick({ target }), firstDown, false), selector).toBe(false)
    }
  })
})
