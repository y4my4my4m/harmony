import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'

// The call pop-out controller: the second window's document mirrors the
// app's stylesheets and <html> attributes, its input reaches the app's
// document listeners, the call view's containers follow the window, and the
// view comes back when the window closes.

const h = vi.hoisted(() => ({ tauri: false, mobile: false }))
vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => h.tauri }))
vi.mock('@/utils/platform', () => ({ isMobileUserAgent: () => h.mobile }))

import {
  CALL_POPOUT_IDS,
  callPopout,
  callPopoutActive,
  callPopoutSupported,
  closeCallPopout,
  forwardEvents,
  mirrorDocument,
  observeResize,
  openCallPopout,
  setCallPopoutTitle,
} from '../callPopout'
import { adaptiveStreamSettings } from '@/services/voice/adaptiveStreamSettings'

/** A second window as window.open returns it: its own document, close and focus. */
class FakeWindow extends EventTarget {
  document: Document
  closed = false
  focus = vi.fn()
  constructor() {
    super()
    this.document = document.implementation.createHTMLDocument('')
  }
  close = vi.fn(() => {
    this.closed = true
    this.dispatchEvent(new Event('pagehide'))
  })
}

const flush = async () => {
  await Promise.resolve()
  await nextTick()
}

let added: Node[] = []
const addToHead = (node: Node, before: Node | null = null) => {
  document.head.insertBefore(node, before)
  added.push(node)
  return node
}

beforeEach(() => {
  h.tauri = false
  h.mobile = false
  delete (window as { documentPictureInPicture?: unknown }).documentPictureInPicture
})

afterEach(() => {
  closeCallPopout()
  added.forEach((node) => (node as ChildNode).remove())
  added = []
  document.documentElement.removeAttribute('data-theme')
  document.documentElement.removeAttribute('data-skin')
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('mirrorDocument', () => {
  it('copies stylesheets in order and follows additions, edits and removals', async () => {
    const first = addToHead(Object.assign(document.createElement('style'), { textContent: '.a{color:red}' }))
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = 'data:text/css,.app{}'
    addToHead(link)
    addToHead(document.createElement('meta'))

    const dst = document.implementation.createHTMLDocument('')
    const stop = mirrorDocument(document, dst)
    const sheets = () => Array.from(dst.head.querySelectorAll('style, link')).map((n) => n.textContent || (n as HTMLLinkElement).getAttribute('href'))
    expect(sheets()).toEqual(['.a{color:red}', 'data:text/css,.app{}'])
    expect(dst.head.querySelector('meta')).toBeNull()

    // A sheet inserted between the two keeps its place.
    addToHead(Object.assign(document.createElement('style'), { textContent: '.b{}' }), link)
    await flush()
    expect(sheets()).toEqual(['.a{color:red}', '.b{}', 'data:text/css,.app{}'])

    first.textContent = '.a{color:blue}'
    link.setAttribute('href', 'data:text/css,.app2{}')
    await flush()
    expect(sheets()).toEqual(['.a{color:blue}', '.b{}', 'data:text/css,.app2{}'])

    ;(first as ChildNode).remove()
    await flush()
    expect(sheets()).toEqual(['.b{}', 'data:text/css,.app2{}'])

    stop()
    addToHead(Object.assign(document.createElement('style'), { textContent: '.late{}' }))
    await flush()
    expect(sheets()).toEqual(['.b{}', 'data:text/css,.app2{}'])
  })

  it('keeps the <html> attributes in step: theme, skin, zoom variables', async () => {
    document.documentElement.setAttribute('data-theme', 'dark')
    const dst = document.implementation.createHTMLDocument('')
    dst.documentElement.setAttribute('data-stale', '1')
    const stop = mirrorDocument(document, dst)
    expect(dst.documentElement.getAttribute('data-theme')).toBe('dark')
    expect(dst.documentElement.hasAttribute('data-stale')).toBe(false)

    document.documentElement.setAttribute('data-theme', 'light')
    document.documentElement.setAttribute('data-skin', 'paper')
    await flush()
    expect(dst.documentElement.getAttribute('data-theme')).toBe('light')
    expect(dst.documentElement.getAttribute('data-skin')).toBe('paper')

    document.documentElement.removeAttribute('data-skin')
    await flush()
    expect(dst.documentElement.hasAttribute('data-skin')).toBe(false)
    stop()
  })
})

describe('forwardEvents', () => {
  it('re-dispatches input on the app document with the original target', () => {
    const popup = new FakeWindow()
    const button = popup.document.createElement('button')
    popup.document.body.append(button)
    const stop = forwardEvents(popup as unknown as Window, document)

    const heard: Array<{ type: string; target: EventTarget | null; key?: string }> = []
    const listener = (e: Event) => heard.push({ type: e.type, target: e.target, key: (e as KeyboardEvent).key })
    document.addEventListener('keydown', listener)
    document.addEventListener('click', listener)
    try {
      const click = new MouseEvent('click', { bubbles: true, cancelable: true })
      Object.defineProperty(click, 'target', { value: button })
      popup.dispatchEvent(click)
      const key = new KeyboardEvent('keydown', { key: 'M', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true })
      Object.defineProperty(key, 'target', { value: button })
      popup.dispatchEvent(key)
      expect(heard).toEqual([
        { type: 'click', target: button, key: undefined },
        { type: 'keydown', target: button, key: 'M' },
      ])
    } finally {
      document.removeEventListener('keydown', listener)
      document.removeEventListener('click', listener)
      stop()
    }
  })

  it('carries a prevented default back to the original event', () => {
    const popup = new FakeWindow()
    const stop = forwardEvents(popup as unknown as Window, document)
    const prevent = (e: Event) => e.preventDefault()
    document.addEventListener('keydown', prevent)
    try {
      const key = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
      popup.dispatchEvent(key)
      expect(key.defaultPrevented).toBe(true)
    } finally {
      document.removeEventListener('keydown', prevent)
      stop()
    }
    const after = new KeyboardEvent('keydown', { key: 'Escape', cancelable: true })
    popup.dispatchEvent(after)
    expect(after.defaultPrevented).toBe(false)
  })

  it('keeps a stray file drop from navigating the pop-out', () => {
    const popup = new FakeWindow()
    const stop = forwardEvents(popup as unknown as Window, document)
    const drop = new Event('drop', { cancelable: true })
    popup.dispatchEvent(drop)
    expect(drop.defaultPrevented).toBe(true)
    stop()
  })
})

describe('observeResize', () => {
  it("observes through the ResizeObserver of the element's own window", () => {
    const observe = vi.fn()
    const OwnObserver = vi.fn(() => ({ observe, disconnect: vi.fn() }))
    const el = document.createElement('div')
    const doc = document.implementation.createHTMLDocument('')
    doc.body.append(doc.adoptNode(el))
    vi.spyOn(doc, 'defaultView', 'get').mockReturnValue({ ResizeObserver: OwnObserver } as unknown as Window & typeof globalThis)
    observeResize(el, () => {})
    expect(OwnObserver).toHaveBeenCalledTimes(1)
    expect(observe).toHaveBeenCalledWith(el)
  })
})

describe('openCallPopout', () => {
  it('opens a window, moves the containers there, and returns the view when the window closes', async () => {
    const popup = new FakeWindow()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const generation = callPopout.generation

    await expect(openCallPopout({ title: 'Harmony — lounge' })).resolves.toBe(true)
    expect(open).toHaveBeenCalledWith('about:blank', 'harmony-call', 'popup,width=1024,height=640')
    expect(callPopoutActive.value).toBe(true)
    expect(callPopout.kind).toBe('window')
    expect(callPopout.root).toBe(popup.document.getElementById(CALL_POPOUT_IDS.root))
    expect(callPopout.activity).toBe(popup.document.getElementById(CALL_POPOUT_IDS.activity))
    expect(callPopout.generation).toBe(generation + 1)
    expect(popup.document.title).toBe('Harmony — lounge')
    // A plain window does not count as visible to LiveKit's adaptive stream.
    expect(adaptiveStreamSettings.pauseVideoInBackground).toBe(false)

    setCallPopoutTitle('Harmony — stage')
    expect(popup.document.title).toBe('Harmony — stage')

    // A second request focuses the open window.
    await openCallPopout({ title: 'x' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(popup.focus).toHaveBeenCalled()

    popup.closed = true
    popup.dispatchEvent(new Event('pagehide'))
    expect(callPopoutActive.value).toBe(false)
    expect(callPopout.root).toBeNull()
    expect(callPopout.generation).toBe(generation + 2)
    expect('pauseVideoInBackground' in adaptiveStreamSettings).toBe(false)
  })

  it('closes the window after the view has moved back', async () => {
    const popup = new FakeWindow()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await openCallPopout({ title: 't' })
    closeCallPopout()
    expect(callPopoutActive.value).toBe(false)
    expect(popup.close).not.toHaveBeenCalled()
    await nextTick()
    expect(popup.close).toHaveBeenCalledTimes(1)
  })

  it('notices a window closed without pagehide', async () => {
    vi.useFakeTimers()
    const popup = new FakeWindow()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await openCallPopout({ title: 't' })
    popup.closed = true
    vi.advanceTimersByTime(600)
    expect(callPopoutActive.value).toBe(false)
  })

  it('follows a replaced document into the new one', async () => {
    vi.useFakeTimers()
    const popup = new FakeWindow()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await openCallPopout({ title: 'Harmony — lounge' })
    const generation = callPopout.generation
    popup.document = document.implementation.createHTMLDocument('')
    vi.advanceTimersByTime(600)
    expect(callPopout.root?.ownerDocument).toBe(popup.document)
    expect(popup.document.title).toBe('Harmony — lounge')
    expect(callPopout.generation).toBe(generation + 1)
  })

  it('resolves false when the window is blocked', async () => {
    vi.spyOn(window, 'open').mockReturnValue(null)
    await expect(openCallPopout({ title: 't' })).resolves.toBe(false)
    expect(callPopoutActive.value).toBe(false)
  })

  it('prefers Document Picture-in-Picture in a browser', async () => {
    const pipWindow = new FakeWindow()
    const requestWindow = vi.fn(async () => pipWindow as unknown as Window)
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow }
    const open = vi.spyOn(window, 'open')
    await expect(openCallPopout({ title: 't', width: 900, height: 500 })).resolves.toBe(true)
    expect(requestWindow).toHaveBeenCalledWith({ width: 900, height: 500 })
    expect(open).not.toHaveBeenCalled()
    expect(callPopout.kind).toBe('pip')
    expect(callPopout.root?.ownerDocument).toBe(pipWindow.document)
    // LiveKit counts elements in the PiP window as visible on its own.
    expect('pauseVideoInBackground' in adaptiveStreamSettings).toBe(false)
  })

  it('falls back to a window when Document Picture-in-Picture refuses', async () => {
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = {
      requestWindow: vi.fn(async () => { throw new DOMException('no activation', 'NotAllowedError') }),
    }
    const popup = new FakeWindow()
    const open = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await expect(openCallPopout({ title: 't' })).resolves.toBe(true)
    expect(open).toHaveBeenCalledTimes(1)
    expect(callPopout.kind).toBe('window')
  })

  it('opens a native window in the desktop app even where Document PiP exists', async () => {
    h.tauri = true
    const requestWindow = vi.fn()
    ;(window as { documentPictureInPicture?: unknown }).documentPictureInPicture = { requestWindow }
    const popup = new FakeWindow()
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    await openCallPopout({ title: 't' })
    expect(requestWindow).not.toHaveBeenCalled()
    expect(callPopout.kind).toBe('window')
  })
})

describe('callPopoutSupported', () => {
  it('is false on phones and tablets', () => {
    expect(callPopoutSupported()).toBe(true)
    h.mobile = true
    expect(callPopoutSupported()).toBe(false)
  })
})
