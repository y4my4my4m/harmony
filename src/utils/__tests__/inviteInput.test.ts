import { describe, it, expect } from 'vitest'
import { parseInviteInput } from '@/utils/inviteInput'

const ORIGIN = 'https://har.mony.lol'

describe('parseInviteInput', () => {
  it('treats a bare code as a local invite', () => {
    expect(parseInviteInput('  aB3-x_9  ', ORIGIN)).toEqual({ kind: 'local', code: 'aB3-x_9' })
  })

  it('extracts the code from a link on this origin, with or without a trailing slash', () => {
    expect(parseInviteInput('https://har.mony.lol/invite/abc123/', ORIGIN)).toEqual({ kind: 'local', code: 'abc123' })
  })

  it('hands links on other hosts to federated discovery', () => {
    expect(parseInviteInput('other.example/invite/xyz', ORIGIN)).toEqual({
      kind: 'remote',
      url: 'https://other.example/invite/xyz',
    })
  })

  it('rejects other paths on this origin and non-http schemes', () => {
    expect(parseInviteInput('https://har.mony.lol/settings', ORIGIN)).toEqual({ kind: 'invalid' })
    expect(parseInviteInput('javascript://alert(1)', ORIGIN)).toEqual({ kind: 'invalid' })
    expect(parseInviteInput('', ORIGIN)).toEqual({ kind: 'invalid' })
  })
})
