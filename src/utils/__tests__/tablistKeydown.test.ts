import { beforeEach, describe, expect, it } from 'vitest'
import { tablistKeydown } from '@/utils/tablistKeydown'

function build() {
  document.body.innerHTML = `
    <div role="tablist" id="list">
      <button role="tab" id="a">Posts</button>
      <button role="tab" id="b" aria-disabled="true">Media</button>
      <button role="tab" id="c">Following</button>
      <button role="tab" id="d">Followers</button>
    </div>`
  const list = document.getElementById('list')!
  list.addEventListener('keydown', tablistKeydown)
  return list
}

function press(key: string) {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })
  document.activeElement!.dispatchEvent(event)
  return event
}

const focused = () => document.activeElement?.id

describe('tablistKeydown', () => {
  beforeEach(() => {
    build()
    document.getElementById('a')!.focus()
  })

  it('moves focus with the arrows, wrapping and skipping disabled tabs', () => {
    expect(press('ArrowRight').defaultPrevented).toBe(true)
    expect(focused()).toBe('c')
    press('ArrowRight')
    expect(focused()).toBe('d')
    press('ArrowRight')
    expect(focused()).toBe('a')
    press('ArrowLeft')
    expect(focused()).toBe('d')
  })

  it('goes to the ends with Home and End and leaves other keys alone', () => {
    press('End')
    expect(focused()).toBe('d')
    press('Home')
    expect(focused()).toBe('a')
    expect(press('Enter').defaultPrevented).toBe(false)
    expect(focused()).toBe('a')
  })
})
