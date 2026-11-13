import { describe, expect, it } from 'vitest'
import { Permission } from '@/services/RoleService'
import { CATEGORY_PERMISSION_GROUPS, channelPermissionGroups } from '@/services/channelPermissionGroups'

const keys = (groups: ReturnType<typeof channelPermissionGroups>) => groups.flatMap(g => g.permissions.map(p => p.key))

describe('channelPermissionGroups', () => {
  it('a voice channel adds the voice group and drops Manage Webhooks', () => {
    const text = keys(channelPermissionGroups(0))
    const voice = keys(channelPermissionGroups(1))
    expect(text).toContain(Permission.MANAGE_WEBHOOKS)
    expect(text).not.toContain(Permission.CONNECT)
    expect(voice).not.toContain(Permission.MANAGE_WEBHOOKS)
    expect(voice).toContain(Permission.CONNECT)
    expect(channelPermissionGroups(1).map(g => g.id)).toEqual(['general', 'messages', 'threads', 'voice'])
  })

  it('a category offers every permission of either channel type, once', () => {
    const category = keys(CATEGORY_PERMISSION_GROUPS)
    expect(new Set(category).size).toBe(category.length)
    expect([...category].sort()).toEqual([...new Set([...keys(channelPermissionGroups(0)), ...keys(channelPermissionGroups(1))])].sort())
  })
})
