import { describe, it, expect, vi, beforeEach } from 'vitest'
import { supabase } from '@/supabase'
import {
  applyPrivacy,
  channelPermissionsSynced,
  privacyFromOverrides,
  setCategoryPermissions,
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
