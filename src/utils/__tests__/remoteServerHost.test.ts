import { describe, it, expect, vi } from 'vitest'

vi.mock('@/supabase', () => ({ supabase: {} }))

import { remoteServerHost, serverDisplayLabel } from '@/utils/serverUtils'

describe('remoteServerHost', () => {
  it('is null for a local server and for a row without the flag', () => {
    expect(remoteServerHost({ is_local_server: true })).toBeNull()
    expect(remoteServerHost({})).toBeNull()
    expect(remoteServerHost(null)).toBeNull()
  })

  it('prefers federation_domain, then the inbox host', () => {
    expect(remoteServerHost({ is_local_server: false, federation_domain: 'mony.dev' })).toBe('mony.dev')
    expect(
      remoteServerHost({ is_local_server: false, federation_inbox_url: 'https://other.example:8443/servers/x/inbox' }),
    ).toBe('other.example:8443')
  })

  it('is empty for a remote server with no known host', () => {
    expect(remoteServerHost({ is_local_server: false })).toBe('')
  })
})

describe('serverDisplayLabel', () => {
  it('suffixes the host only for remote servers', () => {
    expect(serverDisplayLabel({ name: 'SSS', is_local_server: true })).toBe('SSS')
    expect(serverDisplayLabel({ name: 'Far', is_local_server: false, federation_domain: 'mony.dev' })).toBe('Far · mony.dev')
    expect(serverDisplayLabel({ name: 'Far', is_local_server: false })).toBe('Far')
  })
})
