import { describe, it, expect } from 'vitest'
import { acct, formatHandle, handleParts, isRemoteAccount } from '../handles'

// tests/setup.ts: VITE_DOMAIN harmony.test.
const alice = { username: 'alice', domain: 'harmony.test', is_local: true }
const bob = { username: 'bob', domain: 'remote.example', is_local: false }

describe('handles', () => {
  it('gives a local account its short and full forms', () => {
    expect(formatHandle(alice)).toBe('@alice')
    expect(formatHandle(alice, { full: true })).toBe('@alice@harmony.test')
    expect(acct(alice)).toBe('alice@harmony.test')
    expect(formatHandle({ username: 'alice' }, { full: true })).toBe('@alice@harmony.test')
  })

  it('gives a remote account its domain in both forms', () => {
    expect(formatHandle(bob)).toBe('@bob@remote.example')
    expect(formatHandle(bob, { full: true })).toBe('@bob@remote.example')
    expect(acct(bob)).toBe('bob@remote.example')
  })

  it('reads the domain without is_local: this instance local, any other remote', () => {
    expect(isRemoteAccount({ username: 'alice', domain: 'Harmony.Test' })).toBe(false)
    expect(isRemoteAccount({ username: 'bob', domain: 'remote.example' })).toBe(true)
    expect(isRemoteAccount({ username: 'carol', domain: 'remote.example', is_local: true })).toBe(false)
    expect(isRemoteAccount({ username: 'dan', is_local: false })).toBe(false)
  })

  it('fills username and domain from a handle string', () => {
    expect(formatHandle({ handle: '@bob@remote.example' })).toBe('@bob@remote.example')
    expect(formatHandle({ handle: 'bob@remote.example', is_local: false })).toBe('@bob@remote.example')
    expect(formatHandle({ username: 'bob', handle: '@bob@remote.example' })).toBe('@bob@remote.example')
    expect(handleParts({ handle: '@alice' })).toEqual({ username: 'alice', domain: null })
  })

  it('is empty without a username', () => {
    expect(formatHandle(null)).toBe('')
    expect(formatHandle({ domain: 'remote.example' }, { full: true })).toBe('')
    expect(acct({})).toBeNull()
  })
})
