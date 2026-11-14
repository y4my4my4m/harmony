import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import {
  applyPrivacy,
  channelPermissionsSynced,
  overrideState,
  privacyFromOverrides,
  rebaseTemplate,
  sameTemplate,
  setCategoryPermissions,
  targetMasks,
  withOverrideState,
  withTargetFrom,
  type CategoryOverride,
} from '@/services/categoryPermissions'

// The Private toggle edits VIEW_CHANNEL (bit 1, value 2) of a category's template and keeps
// every other bit.

const EVERYONE = 'role-everyone'
const role = (id: string, allow: number, deny = 0): CategoryOverride => ({
  target_type: 'role', role_id: id, user_id: null, allow_permissions: String(allow), deny_permissions: String(deny),
})
const user = (id: string, allow: number, deny = 0): CategoryOverride => ({
  target_type: 'user', role_id: null, user_id: id, allow_permissions: String(allow), deny_permissions: String(deny),
})
const byTarget = (rows: CategoryOverride[]) =>
  Object.fromEntries(rows.map(r => [r.role_id ?? r.user_id, `${r.allow_permissions}/${r.deny_permissions}`]))

describe('privacyFromOverrides', () => {
  it('reads @everyone denied VIEW_CHANNEL as private, with the roles and members allowed it', () => {
    expect(privacyFromOverrides(
      [role(EVERYONE, 0, 2), role('staff', 2), role('muted', 0, 4096), user('ann', 2 | 4096)],
      EVERYONE,
    )).toEqual({ isPrivate: true, roleIds: ['staff'], userIds: ['ann'] })
  })

  it('reads a template without the @everyone deny as public', () => {
    expect(privacyFromOverrides([role(EVERYONE, 0, 4096), role('staff', 2)], EVERYONE).isPrivate).toBe(false)
    expect(privacyFromOverrides([], EVERYONE).isPrivate).toBe(false)
  })
})

describe('applyPrivacy', () => {
  it('makes an empty template private for the chosen roles and members', () => {
    expect(byTarget(applyPrivacy([], EVERYONE, { isPrivate: true, roleIds: ['staff'], userIds: ['ann'] })))
      .toEqual({ [EVERYONE]: '0/2', staff: '2/0', ann: '2/0' })
  })

  it('keeps the other bits of every row', () => {
    const rows = [role(EVERYONE, 4096, 64), role('staff', 2097152), role('old', 2 | 4096)]
    expect(byTarget(applyPrivacy(rows, EVERYONE, { isPrivate: true, roleIds: ['staff'], userIds: [] })))
      .toEqual({ [EVERYONE]: '4096/66', staff: '2097154/0', old: '4096/0' })
  })

  it('drops a row left with no bit', () => {
    const rows = [role(EVERYONE, 0, 2), role('gone', 2), user('ann', 2)]
    expect(byTarget(applyPrivacy(rows, EVERYONE, { isPrivate: true, roleIds: [], userIds: [] })))
      .toEqual({ [EVERYONE]: '0/2' })
  })

  it('a public category clears the @everyone deny and keeps role and member rows', () => {
    const rows = [role(EVERYONE, 0, 2 | 4096), role('staff', 2), user('ann', 2)]
    expect(byTarget(applyPrivacy(rows, EVERYONE, { isPrivate: false, roleIds: [], userIds: [] })))
      .toEqual({ [EVERYONE]: '0/4096', staff: '2/0', ann: '2/0' })
  })

  it('an allow replaces a deny of VIEW_CHANNEL for a chosen role', () => {
    expect(byTarget(applyPrivacy([role('staff', 0, 2)], EVERYONE, { isPrivate: true, roleIds: ['staff'], userIds: [] })))
      .toEqual({ [EVERYONE]: '0/2', staff: '2/0' })
  })

  it('round-trips through privacyFromOverrides', () => {
    const privacy = { isPrivate: true, roleIds: ['a', 'b'], userIds: ['u'] }
    expect(privacyFromOverrides(applyPrivacy([], EVERYONE, privacy), EVERYONE)).toEqual(privacy)
  })

  it('handles masks beyond 2^53', () => {
    const high = (BigInt(1) << BigInt(60)).toString()
    const out = applyPrivacy([{ ...role('staff', 0), allow_permissions: high }], EVERYONE,
                             { isPrivate: true, roleIds: ['staff'], userIds: [] })
    expect(out.find(o => o.role_id === 'staff')!.allow_permissions).toBe(((BigInt(1) << BigInt(60)) | BigInt(2)).toString())
  })
})

// The role editor sets one bit of one row: SEND_MESSAGES is bit 12 (4096).
const SEND = BigInt(4096)

describe('overrideState', () => {
  it('reads a bit as allow, deny or inherit', () => {
    const rows = [role('staff', 4096), role('muted', 0, 4096 | 2)]
    expect(overrideState(rows, { role_id: 'staff', user_id: null }, SEND)).toBe('allow')
    expect(overrideState(rows, { role_id: 'muted', user_id: null }, SEND)).toBe('deny')
    expect(overrideState(rows, { role_id: 'muted', user_id: null }, BigInt(1024))).toBe('inherit')
    expect(overrideState(rows, { role_id: 'absent', user_id: null }, SEND)).toBe('inherit')
  })
})

describe('withOverrideState', () => {
  const staff = { target_type: 'role' as const, role_id: 'staff', user_id: null }

  it('adds a row for a role the template does not name', () => {
    expect(byTarget(withOverrideState([], staff, SEND, 'deny'))).toEqual({ staff: '0/4096' })
  })

  it('moves the bit between allow and deny and keeps every other bit and row', () => {
    const rows = [role('staff', 2 | 4096, 64), user('ann', 2)]
    expect(byTarget(withOverrideState(rows, staff, SEND, 'deny'))).toEqual({ staff: '2/4160', ann: '2/0' })
    expect(byTarget(withOverrideState(rows, staff, SEND, 'inherit'))).toEqual({ staff: '2/64', ann: '2/0' })
  })

  it('drops a row left with no bit', () => {
    expect(withOverrideState([role('staff', 4096)], staff, SEND, 'inherit')).toEqual([])
  })

  it('leaves its input unchanged', () => {
    const rows = [role('staff', 4096)]
    withOverrideState(rows, staff, SEND, 'deny')
    expect(byTarget(rows)).toEqual({ staff: '4096/0' })
  })
})

describe('withTargetFrom', () => {
  it('restores one row from the saved template and leaves the others as edited', () => {
    const saved = [role('staff', 2), role('mods', 4096)]
    const edited = [role('staff', 0, 2), role('mods', 0, 4096), role('new', 2)]
    expect(byTarget(withTargetFrom(edited, saved, { role_id: 'staff', user_id: null })))
      .toEqual({ staff: '2/0', mods: '0/4096', new: '2/0' })
    expect(byTarget(withTargetFrom(edited, saved, { role_id: 'new', user_id: null })))
      .toEqual({ staff: '0/2', mods: '0/4096' })
  })
})

describe('sameTemplate and targetMasks', () => {
  it('compares rows in any order and ignores empty ones', () => {
    expect(sameTemplate([role('a', 2), role('b', 0, 4096)], [role('b', 0, 4096), role('a', 2), role('c', 0)])).toBe(true)
    expect(sameTemplate([role('a', 2)], [role('a', 0, 2)])).toBe(false)
    expect(sameTemplate([role('a', 2)], [user('a', 2)])).toBe(false)
  })

  it('reads a row without one as 0/0', () => {
    expect(targetMasks([role('a', 2, 4096)], { role_id: 'a', user_id: null })).toBe('2/4096')
    expect(targetMasks([], { role_id: 'a', user_id: null })).toBe('0/0')
  })
})

describe('rebaseTemplate', () => {
  const roles = new Set([EVERYONE, 'a', 'b'])

  it('applies the bits the dialog changed onto the template as it stands, and keeps the rest', () => {
    // Opened: a allowed VIEW_CHANNEL (2). Edited: a denied SEND_MESSAGES (4096).
    // Meanwhile: a allowed ATTACH_FILES (32768), b added, @everyone denied VIEW_CHANNEL.
    const saved = [role('a', 2)]
    const edited = [role('a', 2, 4096)]
    const latest = [role('a', 2 | 32768), role('b', 8), role(EVERYONE, 0, 2)]
    expect(byTarget(rebaseTemplate(latest, saved, edited, roles))).toEqual({
      a: `${2 | 32768}/4096`, b: '8/0', [EVERYONE]: '0/2',
    })
  })

  it('a bit the dialog changed takes the dialog\'s state, even one changed meanwhile', () => {
    // Opened: a allowed VIEW_CHANNEL. Edited: inherit. Meanwhile: denied.
    expect(rebaseTemplate([role('a', 0, 2)], [role('a', 2)], [], roles)).toEqual([])
    expect(byTarget(rebaseTemplate([role('a', 0, 2)], [], [role('a', 2)], roles))).toEqual({ a: '2/0' })
  })

  it('drops a row removed meanwhile that the dialog left alone, and rows of deleted roles', () => {
    expect(byTarget(rebaseTemplate([], [role('a', 2), user('u', 2)], [role('a', 2), user('u', 2)], roles))).toEqual({})
    expect(byTarget(rebaseTemplate([], [], [role('gone', 2), user('u', 2)], roles))).toEqual({ u: '2/0' })
  })
})

describe('category permission RPCs', () => {
  beforeEach(() => vi.mocked(supabase.rpc).mockReset())

  it('set_category_permissions returns the channels it synced', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: { category_id: 'k', synced_channel_ids: ['c1'] }, error: null } as any)
    await expect(setCategoryPermissions('k', [role(EVERYONE, 0, 2)])).resolves.toEqual(['c1'])
    expect(supabase.rpc).toHaveBeenCalledWith('set_category_permissions', {
      p_category_id: 'k',
      p_overrides: [role(EVERYONE, 0, 2)],
    })
  })

  it('a refusal throws', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: { code: '42501', message: 'no' } } as any)
    await expect(setCategoryPermissions('k', [])).rejects.toMatchObject({ code: '42501' })
  })

  it('channel_permissions_synced answers null for a channel in no category', async () => {
    vi.mocked(supabase.rpc).mockResolvedValue({ data: null, error: null } as any)
    await expect(channelPermissionsSynced('c')).resolves.toBeNull()
    vi.mocked(supabase.rpc).mockResolvedValue({ data: false, error: null } as any)
    await expect(channelPermissionsSynced('c')).resolves.toBe(false)
  })
})
