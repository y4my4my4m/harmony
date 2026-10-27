/**
 * Staff badges: this instance's staff where its flags apply, never inside a server hosted
 * elsewhere; a remote account's role on its own instance everywhere, naming that instance.
 */
import { describe, it, expect } from 'vitest'
import { instanceStaffBadge } from '../instanceBadge'

const here = { is_local_server: true }
const copy = { is_local_server: false }

describe('instanceStaffBadge', () => {
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
