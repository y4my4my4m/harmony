import { describe, it, expect, vi } from 'vitest'

vi.mock('../../config/supabase.js', () => ({ supabase: {}, config: {} }))

import {
  ADMINISTRATOR,
  ALL_BITS,
  VIEW_CHANNEL,
  botCanReadChannel,
  botChannelMask,
  grantableRoleBits,
  installMask,
  isAdminRole,
  overrideGrants,
  parseMask,
  permissionMask,
  rolePositionCap,
} from '../botPermissions.js'

const CHANNEL = '00000000-0000-0000-0000-0000000000c1'
const OTHER_CHANNEL = '00000000-0000-0000-0000-0000000000c2'

// create_default_server_role(): @everyone's default mask.
const EVERYONE_DEFAULT = 122646786n

const READER = { read_messages: true, send_messages: true }
const open = { permissions: EVERYONE_DEFAULT, allow: 0n, deny: 0n }

describe('installMask', () => {
  it('maps install flags onto role-permission bits', () => {
    expect(installMask({ read_messages: true, manage_channels: true, manage_roles: true })).toBe(
      permissionMask('VIEW_CHANNEL', 'READ_MESSAGE_HISTORY', 'MANAGE_CHANNELS', 'MANAGE_ROLES'),
    )
  })

  it('reads absent or non-true flags as not granted', () => {
    expect(installMask({ kick_members: false, ban_members: null, manage_roles: 'true' })).toBe(0n)
  })
})

describe('parseMask', () => {
  it('accepts decimal strings, safe integers and bigints in the signed 64-bit range', () => {
    expect(parseMask('4096')).toBe(4096n)
    expect(parseMask(4096)).toBe(4096n)
    expect(parseMask(-1n)).toBe(-1n)
    expect(parseMask('9223372036854775807')).toBe(9223372036854775807n)
  })

  it('rejects what a bigint column cannot hold or a JSON number cannot carry exactly', () => {
    expect(parseMask('9223372036854775808')).toBeNull()
    expect(parseMask(2 ** 60)).toBeNull()
    expect(parseMask('0x10')).toBeNull()
    expect(parseMask(1.5)).toBeNull()
    expect(parseMask(undefined)).toBeNull()
  })
})

describe('channel visibility', () => {
  it('follows a VIEW_CHANNEL deny on @everyone', () => {
    const hidden = { ...open, deny: VIEW_CHANNEL }
    expect(botCanReadChannel(READER, open, CHANNEL)).toBe(true)
    expect(botCanReadChannel(READER, hidden, CHANNEL)).toBe(false)
  })

  it('lets an @everyone allow win over its own deny, as get_user_permissions() does', () => {
    expect(botCanReadChannel(READER, { ...open, allow: VIEW_CHANNEL, deny: VIEW_CHANNEL }, CHANNEL)).toBe(true)
  })

  it('reads read_messages as the install\'s VIEW_CHANNEL where @everyone lacks it', () => {
    expect(botCanReadChannel(READER, { permissions: 0n, allow: 0n, deny: 0n }, CHANNEL)).toBe(true)
  })

  it('ignores overrides when @everyone holds ADMINISTRATOR', () => {
    const layer = { permissions: ADMINISTRATOR, allow: 0n, deny: VIEW_CHANNEL }
    expect(botChannelMask(READER, layer, CHANNEL)).toBe(ALL_BITS)
  })

  it('requires read_messages', () => {
    expect(botCanReadChannel({ read_messages: false }, open, CHANNEL)).toBe(false)
  })

  it('restricts to allowed_channel_ids when the column is set, empty included', () => {
    expect(botCanReadChannel({ ...READER, allowed_channel_ids: null }, open, CHANNEL)).toBe(true)
    expect(botCanReadChannel({ ...READER, allowed_channel_ids: [CHANNEL] }, open, CHANNEL)).toBe(true)
    expect(botCanReadChannel({ ...READER, allowed_channel_ids: [OTHER_CHANNEL] }, open, CHANNEL)).toBe(false)
    expect(botCanReadChannel({ ...READER, allowed_channel_ids: [] }, open, CHANNEL)).toBe(false)
  })
})

describe('grantableRoleBits', () => {
  it('is the install bits and @everyone\'s, never ADMINISTRATOR', () => {
    const bits = grantableRoleBits({ manage_roles: true }, EVERYONE_DEFAULT | ADMINISTRATOR)
    expect(bits & ADMINISTRATOR).toBe(0n)
    expect(bits & permissionMask('MANAGE_ROLES')).not.toBe(0n)
    expect(bits & permissionMask('CREATE_INVITE')).not.toBe(0n)
    expect(bits & permissionMask('KICK_MEMBERS')).toBe(0n)
  })
})

describe('rolePositionCap', () => {
  const roles = [
    { id: 'everyone', position: 0, permissions: Number(EVERYONE_DEFAULT), is_default: true },
    { id: 'member', position: 1, permissions: 4096 },
    { id: 'mod', position: 5, permissions: Number(permissionMask('KICK_MEMBERS')) },
    { id: 'root', position: 50, permissions: '1' },
    { id: 'admin', position: 999, permissions: 2199023255551, is_admin: true },
  ]

  it('is the lowest administrator role for an owner installer', () => {
    expect(rolePositionCap(roles, true, new Set())).toBe(50)
  })

  it('is the installer\'s highest role otherwise', () => {
    expect(rolePositionCap(roles, false, new Set(['member', 'mod']))).toBe(5)
  })

  it('is 0 for an installer without roles', () => {
    expect(rolePositionCap(roles, false, new Set())).toBe(0)
  })

  it('counts a role with an unreadable mask as an administrator role', () => {
    expect(isAdminRole({ id: 'x', permissions: 2 ** 60 })).toBe(true)
    expect(rolePositionCap([...roles, { id: 'x', position: 3, permissions: 2 ** 60 }], true, new Set())).toBe(3)
  })
})

describe('overrideGrants', () => {
  it('counts added allows and lifted denies, not removed allows or added denies', () => {
    const before = { allow: permissionMask('SEND_MESSAGES'), deny: VIEW_CHANNEL }
    expect(overrideGrants(before, { allow: 0n, deny: VIEW_CHANNEL })).toBe(0n)
    expect(overrideGrants(before, { allow: 0n, deny: 0n })).toBe(VIEW_CHANNEL)
    expect(overrideGrants(null, { allow: permissionMask('ATTACH_FILES'), deny: ALL_BITS })).toBe(
      permissionMask('ATTACH_FILES'),
    )
  })
})
