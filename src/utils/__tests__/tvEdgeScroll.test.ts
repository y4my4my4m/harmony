import { describe, it, expect, afterEach, vi } from 'vitest'
import { EDGE_BAND_PX, EDGE_MAX_STEP_PX, edgeScrollStep, installTvEdgeScroll, isFireTvUserAgent } from '../tvEdgeScroll'

describe('isFireTvUserAgent', () => {
  it.each([
    ['Silk, tablet view, Fire TV Stick 4K',
      'Mozilla/5.0 (Linux; Android 9; AFTMM Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.4.1 like Chrome/120.0.6099.230 Safari/537.36'],
    ['Silk, mobile view, Fire TV Stick 3rd gen',
      'Mozilla/5.0 (Linux; Android 9; AFTSSS Build/PS7633) AppleWebKit/537.36 (KHTML, like Gecko) Silk/120.4.1 like Chrome/120.0.6099.230 Mobile Safari/537.36'],
    ['the WebView of a Fire TV app',
      'Mozilla/5.0 (Linux; Android 7.1.2; AFTMM Build/NS6289; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.4896.127 Mobile Safari/537.36'],
    ['a first Fire TV, locale before the model',
      'Mozilla/5.0 (Linux; U; Android 4.2.2; en-us; AFTB Build/JDQ39) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30'],
  ])('is true for %s', (_name, ua) => {
    expect(isFireTvUserAgent(ua)).toBe(true)
  })

  it.each([
    ['Silk on a Fire tablet',
      'Mozilla/5.0 (Linux; Android 4.4.3; KFTHWI Build/KTU84M) AppleWebKit/537.36 (KHTML, like Gecko) Silk/44.1.54 like Chrome/44.0.2403.63 Safari/537.36'],
    ['Silk in desktop view',
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Silk/44.1.54 like Chrome/44.0.2403.63 Safari/537.36'],
    ['Chrome on an Android phone',
      'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36'],
    ['Firefox on a desktop', 'Mozilla/5.0 (X11; Linux x86_64; rv:140.0) Gecko/20100101 Firefox/140.0'],
    ['a model merely containing AFT', 'Mozilla/5.0 (Linux; Android 13; SM-AFT1) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'],
    ['nothing', ''],
  ])('is false for %s', (_name, ua) => {
    expect(isFireTvUserAgent(ua)).toBe(false)
  })
})

describe('edgeScrollStep', () => {
  const box = { top: 100, bottom: 500 }

  it('scrolls up in the top band and down in the bottom band, fastest at the edge', () => {
    expect(edgeScrollStep(100, box)).toBe(-EDGE_MAX_STEP_PX)
    expect(edgeScrollStep(500, box)).toBe(EDGE_MAX_STEP_PX)
    expect(edgeScrollStep(100 + EDGE_BAND_PX / 2, box)).toBe(-EDGE_MAX_STEP_PX / 2)
    expect(edgeScrollStep(500 - EDGE_BAND_PX / 2, box)).toBe(EDGE_MAX_STEP_PX / 2)
  })

  it('moves at least a pixel just inside a band and nothing past it', () => {
    expect(edgeScrollStep(100 + EDGE_BAND_PX - 0.5, box)).toBe(-1)
    expect(edgeScrollStep(100 + EDGE_BAND_PX, box)).toBe(0)
    expect(edgeScrollStep(300, box)).toBe(0)
    expect(edgeScrollStep(500 - EDGE_BAND_PX, box)).toBe(0)
  })

  it('is 0 outside the container or for an empty one', () => {
    expect(edgeScrollStep(99, box)).toBe(0)
    expect(edgeScrollStep(501, box)).toBe(0)
    expect(edgeScrollStep(10, { top: 10, bottom: 10 })).toBe(0)
  })

  it('splits a container shorter than two bands between them', () => {
    const short = { top: 0, bottom: 60 }
    expect(edgeScrollStep(0, short)).toBe(-EDGE_MAX_STEP_PX)
    expect(edgeScrollStep(29, short)).toBeLessThan(0)
    expect(edgeScrollStep(31, short)).toBeGreaterThan(0)
    expect(edgeScrollStep(60, short)).toBe(EDGE_MAX_STEP_PX)
  })
})

describe('installTvEdgeScroll', () => {
  let uninstall: (() => void) | null = null
  afterEach(() => {
    uninstall?.()
    uninstall = null
    document.body.innerHTML = ''
    vi.restoreAllMocks()
  })

  function scroller(): HTMLElement {
    const el = document.createElement('div')
    el.className = 'message-display'
    el.style.overflowY = 'auto'
    Object.defineProperty(el, 'scrollHeight', { configurable: true, value: 2000 })
    Object.defineProperty(el, 'clientHeight', { configurable: true, value: 400 })
    el.getBoundingClientRect = () => ({ top: 100, bottom: 500, left: 0, right: 300, width: 300, height: 400, x: 0, y: 100, toJSON: () => ({}) })
    const row = document.createElement('p')
    el.appendChild(row)
    document.body.appendChild(el)
    return el
  }

  function pointerAt(target: Element, y: number) {
    const event = new MouseEvent('pointermove', { bubbles: true, clientX: 150, clientY: y })
    Object.defineProperty(event, 'pointerType', { value: 'mouse' })
    target.dispatchEvent(event)
  }

  it('gives the column scroll areas tabindex 0, keeping one already set', async () => {
    const kept = document.createElement('div')
    kept.className = 'conversations-list'
    kept.setAttribute('tabindex', '-1')
    document.body.appendChild(kept)
    uninstall = installTvEdgeScroll()
    const list = scroller()
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    expect(list.getAttribute('tabindex')).toBe('0')
    expect(kept.getAttribute('tabindex')).toBe('-1')
  })

  it('scrolls the container under a pointer resting in its bottom band, and stops in its middle', async () => {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb: FrameRequestCallback) => frames.push(cb))
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {})
    const runFrame = () => frames.splice(0).forEach((cb) => cb(0))
    const list = scroller()
    list.scrollTop = 500
    uninstall = installTvEdgeScroll()
    frames.length = 0

    pointerAt(list.firstElementChild!, 500)
    runFrame()
    expect(list.scrollTop).toBe(500 + EDGE_MAX_STEP_PX)
    runFrame()
    expect(list.scrollTop).toBe(500 + 2 * EDGE_MAX_STEP_PX)

    pointerAt(list.firstElementChild!, 100)
    runFrame()
    expect(list.scrollTop).toBe(500 + EDGE_MAX_STEP_PX)

    pointerAt(list.firstElementChild!, 300)
    runFrame()
    const resting = list.scrollTop
    runFrame()
    expect(list.scrollTop).toBe(resting)
    expect(frames).toHaveLength(0)
  })
})
