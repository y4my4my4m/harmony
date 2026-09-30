import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  federationServerService,
  parseInviteUrl,
  remoteServerUuid,
} from '@/services/federation/FederationServerService'

describe('parseInviteUrl', () => {
  it('parses a bare invite link', () => {
    expect(parseInviteUrl('https://mony.dev/invite/ABCD1234')).toEqual({
      instance: 'mony.dev',
      code: 'ABCD1234',
    })
  })

  it.each([
    'https://mony.dev/invite/ABCD1234/',
    '  https://mony.dev/invite/ABCD1234  ',
    'https://mony.dev/invite/ABCD1234?utm_source=chat',
    'https://mony.dev/invite/ABCD1234#top',
    'https://MONY.dev/invite/ABCD1234/?x=1',
  ])('tolerates %j', (input) => {
    expect(parseInviteUrl(input)).toEqual({ instance: 'mony.dev', code: 'ABCD1234' })
  })

  it('keeps the port in the instance', () => {
    expect(parseInviteUrl('http://localhost:5173/invite/abc_12-x')).toEqual({
      instance: 'localhost:5173',
      code: 'abc_12-x',
    })
  })

  it.each([
    'mony.dev/invite/ABCD1234',
    'ftp://mony.dev/invite/ABCD1234',
    'https://mony.dev/invite/',
    'https://mony.dev/invite/ABCD/extra',
    'https://mony.dev/servers/0b6f7c1e-7d1a-4b8e-9c55-4a2b1f3e9d10',
    'server@mony.dev',
    '',
  ])('rejects %j', (input) => {
    expect(parseInviteUrl(input)).toBeNull()
  })
})

describe('remoteServerUuid', () => {
  it('extracts the actor UUID', () => {
    expect(remoteServerUuid('https://mony.dev/servers/0B6F7C1E-7D1A-4B8E-9C55-4A2B1F3E9D10')).toBe(
      '0b6f7c1e-7d1a-4b8e-9c55-4a2b1f3e9d10',
    )
  })

  it('returns null for non-server actors', () => {
    expect(remoteServerUuid('https://mony.dev/users/alice')).toBeNull()
    expect(remoteServerUuid('https://mony.dev/servers/not-a-uuid')).toBeNull()
  })
})

describe('discoverServer', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('routes a padded invite link with a query string to invite resolution', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        server: { serverId: 'abc', name: 'Remote', channels: [] },
      }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await federationServerService.discoverServer(
      '  https://mony.dev/invite/ABCD1234/?ref=x ',
    )

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0][0]).toBe('/api/federation/invites/resolve')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      instance: 'mony.dev',
      code: 'ABCD1234',
    })
    expect(result.isInvite).toBe(true)
    expect(result.invite?.code).toBe('ABCD1234')
  })
})
