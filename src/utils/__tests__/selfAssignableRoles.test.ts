import { describe, it, expect } from 'vitest'
import { pickableRoleGroups, selfAssignGroupNames, selfAssignProblem } from '@/utils/selfAssignableRoles'
import type { ServerRole } from '@/services/RoleService'

const perms = (...names: string[]) => Object.fromEntries(names.map((n) => [n, true])) as ServerRole['permissions']

function role(id: string, position: number, extra: Partial<ServerRole> = {}): ServerRole {
  return {
    id, server_id: 's1', name: id, color: '#123456', hoist: false, mentionable: false, position,
    permissions: perms('VIEW_CHANNEL', 'SEND_MESSAGES'), created_at: '', updated_at: '', ...extra,
  }
}

const everyone = role('everyone', 0, { is_default: true })
const mod = role('mod', 5, { permissions: perms('VIEW_CHANNEL', 'SEND_MESSAGES', 'MANAGE_MESSAGES') })
const admin = role('admin', 999, { is_admin: true, self_assignable: true })
const red = role('red', 2, { self_assignable: true, self_assign_group: 'Colours' })
const blue = role('blue', 3, { self_assignable: true, self_assign_group: 'Colours', self_assign_note: 'Calm' })
const he = role('he', 1, { self_assignable: true, self_assign_group: 'Pronouns' })
const news = role('news', 1, { self_assignable: true })
const kicky = role('kicky', 4, { self_assignable: true, permissions: perms('VIEW_CHANNEL', 'KICK_MEMBERS') })
const above = role('above', 6, { self_assignable: true })
const plain = role('plain', 1)
const roles = [everyone, mod, admin, red, blue, he, news, kicky, above, plain]

describe('selfAssignProblem', () => {
  it('passes a role without extra permissions below every moderator role', () => {
    expect(selfAssignProblem(red, roles)).toBeNull()
    expect(selfAssignProblem(news, roles)).toBeNull()
  })

  it('names @everyone, administrator roles, extra permissions and a rank above a moderator role', () => {
    expect(selfAssignProblem(everyone, roles)).toBe('default')
    expect(selfAssignProblem(admin, roles)).toBe('admin')
    expect(selfAssignProblem(kicky, roles)).toBe('grants')
    expect(selfAssignProblem(above, roles)).toBe('rank')
  })

  it('counts a tie with a permission-granting role as too high', () => {
    expect(selfAssignProblem(role('tie', 5, { self_assignable: true }), [...roles])).toBe('rank')
  })
})

describe('pickableRoleGroups', () => {
  it('groups pickable roles by name, ungrouped last, highest first, and leaves out the rest', () => {
    const groups = pickableRoleGroups(roles)
    expect(groups.map((g) => [g.name, g.roles.map((r) => r.id)])).toEqual([
      ['Colours', ['blue', 'red']],
      ['Pronouns', ['he']],
      [null, ['news']],
    ])
  })

  it('limits the result to one group', () => {
    expect(pickableRoleGroups(roles, 'Pronouns').map((g) => g.name)).toEqual(['Pronouns'])
    expect(pickableRoleGroups(roles, 'Nope')).toEqual([])
  })

  it('lists the group names of self-assignable roles', () => {
    expect(selfAssignGroupNames(roles)).toEqual(['Colours', 'Pronouns'])
  })
})
