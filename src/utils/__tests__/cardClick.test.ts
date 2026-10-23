import { describe, it, expect, afterEach } from 'vitest'
import { cardClickIgnored } from '../cardClick'

const card = () => {
  const el = document.createElement('div')
  el.innerHTML = '<p class="text">words <span class="hashtag">#tag</span></p><a href="/x">link</a><button>b</button><a class="bare">bare</a>'
  document.body.appendChild(el)
  return el
}

/** Result of cardClickIgnored for a click dispatched on `target`, heard by `el`. */
const ignored = (el: HTMLElement, target: Element, init: MouseEventInit = {}) => {
  let result: boolean | null = null
  const listener = (event: Event) => { result = cardClickIgnored(event as MouseEvent) }
  el.addEventListener('click', listener)
  target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init }))
  el.removeEventListener('click', listener)
  return result
}

describe('cardClickIgnored', () => {
  afterEach(() => {
    document.body.innerHTML = ''
    window.getSelection()?.removeAllRanges()
  })

  it('takes a plain click on the card body', () => {
    const el = card()
    expect(ignored(el, el.querySelector('.text')!)).toBe(false)
    expect(ignored(el, el.querySelector('.bare')!)).toBe(false)
  })

  it('leaves links, buttons and hashtags their own clicks', () => {
    const el = card()
    expect(ignored(el, el.querySelector('a[href]')!)).toBe(true)
    expect(ignored(el, el.querySelector('button')!)).toBe(true)
    expect(ignored(el, el.querySelector('.hashtag')!)).toBe(true)
  })

  it('ignores modified, secondary and handled clicks', () => {
    const el = card()
    const text = el.querySelector('.text')!
    expect(ignored(el, text, { ctrlKey: true })).toBe(true)
    expect(ignored(el, text, { metaKey: true })).toBe(true)
    expect(ignored(el, text, { button: 1 })).toBe(true)
    text.addEventListener('click', (e) => e.preventDefault(), { once: true })
    expect(ignored(el, text)).toBe(true)
  })

  it('ignores the click that ends a text selection in the card', () => {
    const el = card()
    const text = el.querySelector('.text')!
    const range = document.createRange()
    range.setStart(text.firstChild!, 0)
    range.setEnd(text.firstChild!, 5)
    window.getSelection()!.addRange(range)
    expect(ignored(el, text)).toBe(true)
  })
})
