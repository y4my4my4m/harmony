import { describe, expect, it } from 'vitest'
import { nameNode, withNode } from '../src/dom'

describe('nameNode', () => {
  it('draws custom emojis as images in the name, one without an image as :name:', () => {
    const el = nameNode([{ text: 'Spartzy ' }, { emoji: 'cat', src: 'blob:1' }, { text: ' ' }, { emoji: 'dog', src: null }, { text: ' !' }], 'Spartzy !')
    const img = el.querySelector('img.name-emoji')!
    expect(img.getAttribute('src')).toBe('blob:1')
    expect(img.getAttribute('alt')).toBe(':cat:')
    expect(el.textContent).toBe('Spartzy  :dog: !')
  })

  it('shows the plain name when there are no parts', () => {
    expect(nameNode(undefined, 'Bob').textContent).toBe('Bob')
    expect(nameNode([], 'Bob').textContent).toBe('Bob')
  })
})

describe('withNode', () => {
  it('puts the node where the format places the name', () => {
    const p = document.createElement('p')
    p.append(withNode((name) => `Waiting for ${name} to start`, nameNode([{ text: 'Al ' }, { emoji: 'cat', src: 'blob:2' }], 'Al')))
    expect(p.textContent).toBe('Waiting for Al  to start')
    expect(p.querySelector('img')?.getAttribute('alt')).toBe(':cat:')
    expect(p.innerHTML).not.toContain('\u0000')
  })

  it('keeps the text alone when the format leaves the name out', () => {
    const p = document.createElement('p')
    p.append(withNode(() => 'Waiting', nameNode([], 'Al')))
    expect(p.textContent).toBe('Waiting')
  })
})
