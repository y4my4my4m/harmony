import { describe, it, expect, beforeEach } from 'vitest'
import {
  isSafeRedirect,
  rememberPostAuthRedirect,
  consumePostAuthRedirect,
} from '@/utils/postAuthRedirect'

describe('postAuthRedirect', () => {
  beforeEach(() => sessionStorage.clear())

  it('accepts in-app paths only', () => {
    expect(isSafeRedirect('/invite/abc')).toBe(true)
    expect(isSafeRedirect('//evil.example')).toBe(false)
    expect(isSafeRedirect('https://evil.example')).toBe(false)
    expect(isSafeRedirect('/\\evil.example')).toBe(false)
  })

  it('returns the remembered path once, then the fallback', () => {
    rememberPostAuthRedirect('/invite/abc')
    expect(consumePostAuthRedirect()).toBe('/invite/abc')
    expect(consumePostAuthRedirect()).toBe('/chat')
  })

  it('ignores auth pages as destinations', () => {
    rememberPostAuthRedirect('/login?redirect=/x')
    rememberPostAuthRedirect('/new-profile')
    expect(consumePostAuthRedirect('/home')).toBe('/home')
  })
})
