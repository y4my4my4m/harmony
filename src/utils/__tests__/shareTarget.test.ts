import { describe, it, expect, vi, afterEach } from 'vitest'
import type { Router } from 'vue-router'
import {
  appendToDraft,
  composeSharedText,
  installShareLaunchConsumer,
  orderTextChannels,
  sharedPayloadFromQuery,
} from '@/utils/shareTarget'

describe('sharedPayloadFromQuery', () => {
  it('reads and trims title, text and url', () => {
    expect(sharedPayloadFromQuery({ title: ' T ', text: 'body\n', url: 'https://a.example/x' }))
      .toEqual({ title: 'T', text: 'body', url: 'https://a.example/x' })
  })

  it('takes the first of repeated params and blanks missing ones', () => {
    expect(sharedPayloadFromQuery({ text: ['one', 'two'], url: [null] }))
      .toEqual({ title: '', text: 'one', url: '' })
  })
})

describe('composeSharedText', () => {
  it('puts title, text and url on their own lines', () => {
    expect(composeSharedText({ title: 'Page', text: 'look at this', url: 'https://a.example/x' }))
      .toBe('Page\nlook at this\nhttps://a.example/x')
  })

  it('drops a url the text already carries (Android)', () => {
    expect(composeSharedText({ title: 'Page', text: 'https://a.example/x', url: 'https://a.example/x' }))
      .toBe('Page\nhttps://a.example/x')
    expect(composeSharedText({ title: '', text: 'see https://a.example/x', url: 'https://a.example/x' }))
      .toBe('see https://a.example/x')
  })

  it('drops a title the text already carries, or that equals the url', () => {
    expect(composeSharedText({ title: 'Page', text: 'Page - a.example', url: '' })).toBe('Page - a.example')
    expect(composeSharedText({ title: 'https://a.example/x', text: '', url: 'https://a.example/x' }))
      .toBe('https://a.example/x')
  })

  it('is empty when nothing was shared', () => {
    expect(composeSharedText({ title: '', text: '', url: '' })).toBe('')
  })
})

describe('appendToDraft', () => {
  it('replaces an empty or blank draft', () => {
    expect(appendToDraft('', 'shared')).toBe('shared')
    expect(appendToDraft('  \n', 'shared')).toBe('shared')
  })

  it('keeps an existing draft and adds the share on a new line', () => {
    expect(appendToDraft('half a thought  \n', 'shared')).toBe('half a thought\nshared')
  })
})

describe('orderTextChannels', () => {
  it('lists uncategorised text channels first, then categories in order', () => {
    const channels = [
      { id: 'b2', name: 'b2', type: 0, order: 2, category: 'B' },
      { id: 'voice', name: 'voice', type: 1, order: 0, category: null },
      { id: 'a1', name: 'a1', type: 0, order: 1, category: 'A' },
      { id: 'top', name: 'top', type: 0, order: 5, category: null },
      { id: 'b1', name: 'b1', type: 0, order: 1, category: 'B' },
      { id: 'lost', name: 'lost', type: 0, order: 0, category: 'gone' },
    ]
    const categories = [{ id: 'B', order: 2 }, { id: 'A', order: 1 }]
    expect(orderTextChannels(channels, categories).map((c) => c.id)).toEqual(['top', 'a1', 'b1', 'b2', 'lost'])
  })
})

describe('installShareLaunchConsumer', () => {
  afterEach(() => {
    delete (window as unknown as { launchQueue?: unknown }).launchQueue
  })

  function install() {
    let consumer: ((p: { targetURL?: string }) => void) | null = null
    ;(window as unknown as { launchQueue: unknown }).launchQueue = { setConsumer: (fn: typeof consumer) => { consumer = fn } }
    const push = vi.fn().mockResolvedValue(undefined)
    installShareLaunchConsumer({ push } as unknown as Router)
    return { push, launch: (targetURL?: string) => consumer!({ targetURL }) }
  }

  it('routes a same-origin /share launch into the open window', () => {
    const { push, launch } = install()
    launch(`${window.location.origin}/share?text=hi&url=https%3A%2F%2Fa.example`)
    expect(push).toHaveBeenCalledWith('/share?text=hi&url=https%3A%2F%2Fa.example')
  })

  it('ignores other paths, other origins and unparsable urls', () => {
    const { push, launch } = install()
    launch(`${window.location.origin}/chat`)
    launch('https://evil.example/share?text=x')
    launch(undefined)
    launch('not a url')
    expect(push).not.toHaveBeenCalled()
  })

  it('ignores the launch that opened the window on the share url', () => {
    const before = window.location.pathname + window.location.search
    window.history.pushState({}, '', '/share?text=hi')
    try {
      const { push, launch } = install()
      launch(window.location.href)
      expect(push).not.toHaveBeenCalled()
    } finally {
      window.history.pushState({}, '', before)
    }
  })

  it('does nothing without launchQueue', () => {
    const push = vi.fn()
    installShareLaunchConsumer({ push } as unknown as Router)
    expect(push).not.toHaveBeenCalled()
  })
})
