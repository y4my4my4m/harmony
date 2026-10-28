import { beforeEach, describe, expect, it } from 'vitest'
import { isProviderManagedError, knownProviderManaged, rememberProviderManaged } from '../providerManagedAccount'

describe('providerManagedAccount', () => {
  beforeEach(() => localStorage.clear())

  it('recognises GoTrue refusing a change of a provider-managed account', () => {
    expect(isProviderManagedError({ code: 'user_sso_managed', status: 422 })).toBe(true)
    expect(isProviderManagedError({ error_code: 'user_sso_managed' })).toBe(true)
    expect(isProviderManagedError({ code: 'weak_password', status: 422 })).toBe(false)
    expect(isProviderManagedError(null)).toBe(false)
  })

  it('remembers the account it was told about, and only that one', () => {
    expect(knownProviderManaged('user-a')).toBe(false)
    rememberProviderManaged('user-a')
    rememberProviderManaged('user-a')
    expect(knownProviderManaged('user-a')).toBe(true)
    expect(knownProviderManaged('user-b')).toBe(false)
    expect(JSON.parse(localStorage.getItem('harmony.security.providerManaged')!)).toEqual(['user-a'])
  })

  it('knows nothing without an account or with unreadable storage', () => {
    rememberProviderManaged(null)
    expect(knownProviderManaged(null)).toBe(false)
    localStorage.setItem('harmony.security.providerManaged', '{not json')
    expect(knownProviderManaged('user-a')).toBe(false)
    rememberProviderManaged('user-a')
    expect(knownProviderManaged('user-a')).toBe(true)
  })
})
