import { afterEach, describe, expect, it } from 'vitest'
import { suspendGlass } from '@/composables/useVisualTheme'

const blurOff = () => document.documentElement.getAttribute('data-disable-blur')

afterEach(() => {
  suspendGlass('a', false)
  suspendGlass('b', false)
})

describe('suspendGlass', () => {
  it('turns blur off while any reason holds and back on when the last one lifts', () => {
    expect(blurOff()).toBeNull()
    suspendGlass('a', true)
    suspendGlass('b', true)
    expect(blurOff()).toBe('true')
    suspendGlass('a', false)
    expect(blurOff()).toBe('true')
    suspendGlass('b', false)
    expect(blurOff()).toBeNull()
  })

  it('lifting an unknown reason changes nothing', () => {
    suspendGlass('a', true)
    suspendGlass('never-set', false)
    expect(blurOff()).toBe('true')
  })
})
