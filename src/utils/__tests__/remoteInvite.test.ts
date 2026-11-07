import { describe, it, expect } from 'vitest'
import { readRemoteInvite, remoteInviteLink } from '../remoteInvite'

// A remote invite card holds another instance's answer and is read as untrusted.

const URL = 'https://peer.example/invite/GOODCODE'
const GROUP = 'https://peer.example/servers/0b0e0000-0000-4000-8000-0000000000a1'

const card = (server: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) => ({
  status: 'valid',
  code: 'GOODCODE',
  domain: 'peer.example',
  instance: { name: 'Peer Harmony', icon: 'https://peer.example/icon.png' },
  server: {
    name: 'Timbre', description: 'Alternative Har.mony client', icon: 'https://peer.example/a.png',
    memberCount: 6, onlineCount: 2, id: GROUP, ...server,
  },
  ...extra,
})

describe('remoteInviteLink', () => {
  it('reads an https invite link on another host', () => {
    expect(remoteInviteLink(URL)).toEqual({ href: URL, domain: 'peer.example', code: 'GOODCODE' })
  })

  it('reads nothing of other links', () => {
    expect(remoteInviteLink(`https://${window.location.host}/invite/GOODCODE`)).toBeNull()
    expect(remoteInviteLink('http://peer.example/invite/GOODCODE')).toBeNull()
    expect(remoteInviteLink('https://peer.example/invite/GOOD/CODE')).toBeNull()
    expect(remoteInviteLink('https://peer.example/about')).toBeNull()
    expect(remoteInviteLink(undefined)).toBeNull()
  })
})

describe('readRemoteInvite', () => {
  it('reads a valid card', () => {
    expect(readRemoteInvite(URL, card())).toEqual(card())
  })

  it('takes the host and code from the link, not the card', () => {
    const read = readRemoteInvite(URL, card({}, { domain: 'har.mony.lol', code: 'OTHER' }))
    expect(read?.domain).toBe('peer.example')
    expect(read?.code).toBe('GOODCODE')
  })

  it('caps text, drops bad counts and keeps images to https and the Group to the host', () => {
    const read = readRemoteInvite(URL, card({
      name: `‮${'N'.repeat(150)}`,
      description: `a\n\nb ${'d'.repeat(400)}`,
      icon: 'javascript:alert(1)',
      memberCount: -1,
      onlineCount: '2',
      id: 'https://har.mony.lol/servers/0b0e0000-0000-4000-8000-0000000000a1',
    }, { instance: { name: '   ', icon: 'http://peer.example/icon.png' } }))
    expect(Array.from(read!.server!.name)).toHaveLength(100)
    expect(Array.from(read!.server!.description!)).toHaveLength(300)
    expect(read!.server!.description!.startsWith('a b d')).toBe(true)
    expect(read!.server).toMatchObject({ icon: null, memberCount: null, onlineCount: null, id: null })
    expect(read!.instance).toEqual({ name: 'peer.example', icon: null })
  })

  it('reads invalid and closed cards without a server', () => {
    expect(readRemoteInvite(URL, { status: 'invalid', instance: { name: 'Peer Harmony' }, server: { name: 'kept out' } }))
      .toEqual({ status: 'invalid', code: 'GOODCODE', domain: 'peer.example', instance: { name: 'Peer Harmony', icon: null } })
    expect(readRemoteInvite(URL, { status: 'closed' })?.status).toBe('closed')
  })

  it('reads nothing of an unknown status, a valid card naming no server, or a local link', () => {
    expect(readRemoteInvite(URL, card({}, { status: 'pending' }))).toBeNull()
    expect(readRemoteInvite(URL, card({ name: ' ' }))).toBeNull()
    expect(readRemoteInvite(URL, 'valid')).toBeNull()
    expect(readRemoteInvite(`https://${window.location.host}/invite/GOODCODE`, card())).toBeNull()
  })
})
