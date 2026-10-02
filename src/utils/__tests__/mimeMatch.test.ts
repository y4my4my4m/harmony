import { describe, expect, it } from 'vitest'
import { mimeAllowed } from '../mimeMatch'

describe('mimeAllowed', () => {
  const userMedia = ['image/png', 'image/jpeg', 'video/*', 'audio/*', 'application/pdf']

  it('matches exact types', () => {
    expect(mimeAllowed(userMedia, 'image/png')).toBe(true)
    expect(mimeAllowed(userMedia, 'application/pdf')).toBe(true)
  })

  it('matches type/* wildcards', () => {
    expect(mimeAllowed(userMedia, 'video/mp4')).toBe(true)
    expect(mimeAllowed(userMedia, 'audio/mpeg')).toBe(true)
  })

  it('ignores parameters and case', () => {
    expect(mimeAllowed(userMedia, 'audio/webm;codecs=opus')).toBe(true)
    expect(mimeAllowed(userMedia, 'Image/PNG')).toBe(true)
  })

  it('refuses types outside the list', () => {
    expect(mimeAllowed(userMedia, 'image/svg+xml')).toBe(false)
    expect(mimeAllowed(userMedia, 'text/html')).toBe(false)
    expect(mimeAllowed(userMedia, '')).toBe(false)
  })

  it('a wildcard does not cross major types', () => {
    expect(mimeAllowed(['video/*'], 'videox/mp4')).toBe(false)
    expect(mimeAllowed(['video/*'], 'audio/mp4')).toBe(false)
  })

  it('an empty or missing list allows everything', () => {
    expect(mimeAllowed(null, 'image/svg+xml')).toBe(true)
    expect(mimeAllowed([], 'text/html')).toBe(true)
  })
})
