import { describe, it, expect } from 'vitest'
import { defaultInstanceInput } from '@/services/instanceConfig'

describe('defaultInstanceInput', () => {
  it('is empty when unset or blank', () => {
    expect(defaultInstanceInput(undefined)).toBe('')
    expect(defaultInstanceInput('')).toBe('')
    expect(defaultInstanceInput('   ')).toBe('')
  })

  it('reduces an https URL to its host', () => {
    expect(defaultInstanceInput('https://har.mony.lol')).toBe('har.mony.lol')
    expect(defaultInstanceInput(' https://har.mony.lol/ ')).toBe('har.mony.lol')
    expect(defaultInstanceInput('https://har.mony.lol:8443/x')).toBe('har.mony.lol:8443')
  })

  it('accepts a bare domain', () => {
    expect(defaultInstanceInput('har.mony.lol')).toBe('har.mony.lol')
  })

  it('keeps the scheme for http', () => {
    expect(defaultInstanceInput('http://localhost:5173')).toBe('http://localhost:5173')
  })

  it('is empty for an unparseable value', () => {
    expect(defaultInstanceInput('https://')).toBe('')
  })
})
