/**
 * Staff badges. On a profile card: this instance's staff where its flags apply, never inside a
 * server hosted elsewhere; a remote account's role on its own instance everywhere, naming that
 * instance. Next to a name: staff of the instance hosting the context only.
 */
import { describe, it, expect } from 'vitest'
import { contextStaffBadge, instanceStaffBadge } from '../instanceBadge'

const here = { is_local_server: true }
const copy = { is_local_server: false }

describe('instanceStaffBadge (profile card)', () => {
  it('shows this instance\'s staff on its own servers and outside servers', () => {
    expect(instanceStaffBadge({ is_admin: true, is_local: true }, here)).toEqual({ kind: 'admin', domain: null })
    expect(instanceStaffBadge({ is_moderator: true }, null)).toEqual({ kind: 'mod', domain: null })
    expect(instanceStaffBadge({ is_admin: true, is_moderator: true }, here)?.kind).toBe('admin')
  })

  it('hides this instance\'s staff inside a copy, where they are ordinary members', () => {
    expect(instanceStaffBadge({ is_admin: true, is_local: true }, copy)).toBeNull()
    expect(instanceStaffBadge({ is_admin: true, is_local: true }, copy, false)).toEqual({ kind: 'admin', domain: null })
  })

  it('shows a remote account\'s role on its own instance everywhere, naming that instance', () => {
    const ada = { is_local: false, instance_role: 'admin' as const, domain: 'roles.example' }
    expect(instanceStaffBadge(ada, copy)).toEqual({ kind: 'admin', domain: 'roles.example' })
    expect(instanceStaffBadge(ada, here)).toEqual({ kind: 'admin', domain: 'roles.example' })
    expect(instanceStaffBadge({ ...ada, instance_role: 'moderator' }, copy)).toEqual({ kind: 'mod', domain: 'roles.example' })
  })

  it('gives a remote account no badge from this instance\'s flags', () => {
    expect(instanceStaffBadge({ is_local: false, is_admin: true }, here)).toBeNull()
    expect(instanceStaffBadge({ is_local: false, instance_role: null }, here)).toBeNull()
    expect(instanceStaffBadge(null, here)).toBeNull()
  })
})

describe('contextStaffBadge', () => {
  const local = 'here.example'
  const copyOfHost = { is_local_server: false, federation_domain: 'host.example' }
  const localAdmin = { is_local: true, is_admin: true, domain: local }
  const localMod = { is_local: true, is_moderator: true, domain: local }
  const hostAdmin = { is_local: false, instance_role: 'admin' as const, domain: 'host.example' }
  const hostMod = { is_local: false, instance_role: 'moderator' as const, domain: 'host.example' }
  const thirdAdmin = { is_local: false, instance_role: 'admin' as const, domain: 'third.example' }

  it('in a server hosted here, shows this instance\'s staff, naming it', () => {
    expect(contextStaffBadge(localAdmin, here, local)).toEqual({ kind: 'admin', domain: local })
    expect(contextStaffBadge(localMod, here, local)).toEqual({ kind: 'mod', domain: local })
    expect(contextStaffBadge({ is_local: true, is_admin: true, is_moderator: true }, here, local)?.kind).toBe('admin')
    expect(contextStaffBadge({ is_local: true }, here, local)).toBeNull()
  })

  it('in a server hosted here, shows no remote account\'s role, the host of a copy\'s included', () => {
    expect(contextStaffBadge(hostAdmin, here, local)).toBeNull()
    expect(contextStaffBadge(thirdAdmin, here, local)).toBeNull()
    expect(contextStaffBadge({ ...thirdAdmin, is_admin: true }, here, local)).toBeNull()
  })

  it('in a copy, shows the host\'s staff only, naming the host', () => {
    expect(contextStaffBadge(hostAdmin, copyOfHost, local)).toEqual({ kind: 'admin', domain: 'host.example' })
    expect(contextStaffBadge(hostMod, copyOfHost, local)).toEqual({ kind: 'mod', domain: 'host.example' })
    expect(contextStaffBadge({ ...hostAdmin, domain: 'HOST.example' }, { ...copyOfHost, federation_domain: 'host.EXAMPLE ' }, local))
      .toEqual({ kind: 'admin', domain: 'host.EXAMPLE' })
    expect(contextStaffBadge({ ...hostAdmin, instance_role: null }, copyOfHost, local)).toBeNull()
  })

  it('in a copy, shows neither a third instance\'s staff nor this instance\'s', () => {
    expect(contextStaffBadge(thirdAdmin, copyOfHost, local)).toBeNull()
    expect(contextStaffBadge(localAdmin, copyOfHost, local)).toBeNull()
    expect(contextStaffBadge(localMod, copyOfHost, local)).toBeNull()
    expect(contextStaffBadge({ is_local: true, instance_role: 'admin', domain: 'host.example' }, copyOfHost, local)).toBeNull()
  })

  it('in a copy whose host is unknown, shows nobody', () => {
    expect(contextStaffBadge(hostAdmin, { is_local_server: false }, local)).toBeNull()
    expect(contextStaffBadge(hostAdmin, { is_local_server: false, federation_domain: ' ' }, local)).toBeNull()
  })

  it('outside a server (DMs, group DMs, posts), shows this instance\'s staff only', () => {
    expect(contextStaffBadge(localAdmin, null, local)).toEqual({ kind: 'admin', domain: local })
    expect(contextStaffBadge(localMod, undefined, local)).toEqual({ kind: 'mod', domain: local })
    expect(contextStaffBadge(hostAdmin, null, local)).toBeNull()
    expect(contextStaffBadge(thirdAdmin, null, local)).toBeNull()
  })

  it('leaves the instance unnamed without a local domain, and answers null for no profile', () => {
    expect(contextStaffBadge(localAdmin, null, undefined)).toEqual({ kind: 'admin', domain: null })
    expect(contextStaffBadge(null, here, local)).toBeNull()
  })
})
