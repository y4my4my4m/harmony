import { describe, it, expect } from 'vitest'
import { authErrorMessage } from '@/utils/authErrorMessage'

describe('authErrorMessage', () => {
  it('keeps a readable GoTrue message', () => {
    expect(authErrorMessage({ message: 'Invalid login credentials', status: 400 }))
      .toBe('Invalid login credentials')
  })

  it('replaces an empty-body 5xx ("{}") with status text', () => {
    expect(authErrorMessage({ message: '{}', status: 503 }))
      .toBe('The server is unavailable right now. Try again in a moment.')
  })

  it('maps 429 to a rate-limit message', () => {
    expect(authErrorMessage({ message: '', status: 429 }))
      .toBe('Too many attempts. Wait a moment and try again.')
  })

  it('maps a network TypeError to a connectivity message', () => {
    expect(authErrorMessage(new TypeError('')))
      .toBe('Could not reach the server. Check your connection and try again.')
  })

  it('falls back when nothing is usable', () => {
    expect(authErrorMessage(null, 'Failed to update password')).toBe('Failed to update password')
  })
})
