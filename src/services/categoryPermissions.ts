import { supabase } from '@/supabase'

/**
 * A category's permission template (channel_category_permission_overrides). Masks travel as
 * decimal strings: bigint columns exceed 2^53.
 */
export interface CategoryOverride {
  target_type: 'role' | 'user'
  role_id: string | null
  user_id: string | null
  allow_permissions: string
  deny_permissions: string
}

/** Who sees a private category: @everyone denied VIEW_CHANNEL, these roles and members allowed. */
export interface CategoryPrivacy {
  isPrivate: boolean
  roleIds: string[]
  userIds: string[]
}

// VIEW_CHANNEL is bit 1.
const VIEW_CHANNEL = BigInt(2)
const ZERO = BigInt(0)

const mask = (value: string | number | null | undefined): bigint => BigInt(value ?? 0)

function targetKey(o: Pick<CategoryOverride, 'role_id' | 'user_id'>): string {
  return o.role_id ? `role:${o.role_id}` : `user:${o.user_id}`
}

/** Privacy as the template states it. */
export function privacyFromOverrides(rows: CategoryOverride[], everyoneRoleId: string | null): CategoryPrivacy {
  const everyone = rows.find(o => o.role_id && o.role_id === everyoneRoleId)
  const allowsView = (o: CategoryOverride) => (mask(o.allow_permissions) & VIEW_CHANNEL) !== ZERO
  return {
    isPrivate: !!everyone && (mask(everyone.deny_permissions) & VIEW_CHANNEL) !== ZERO,
    roleIds: rows.filter(o => o.role_id && o.role_id !== everyoneRoleId && allowsView(o)).map(o => o.role_id!),
    userIds: rows.filter(o => o.user_id && allowsView(o)).map(o => o.user_id!),
  }
}

/**
 * The template with VIEW_CHANNEL set from `privacy`; every other bit of every row is kept.
 * Private: @everyone denied, the listed roles and members allowed, any other role or member
 * allow cleared. Public: the @everyone deny cleared, role and member rows kept, as Discord's
 * Private toggle does. Rows left with no bit are dropped.
 */
export function applyPrivacy(
  rows: CategoryOverride[],
  everyoneRoleId: string,
  privacy: CategoryPrivacy,
): CategoryOverride[] {
  const byTarget = new Map<string, CategoryOverride>()
  for (const row of rows) byTarget.set(targetKey(row), { ...row })

  const edit = (target: Pick<CategoryOverride, 'target_type' | 'role_id' | 'user_id'>,
                fn: (allow: bigint, deny: bigint) => [bigint, bigint]) => {
    const key = targetKey(target)
    const row = byTarget.get(key) ?? { ...target, allow_permissions: '0', deny_permissions: '0' }
    const [allow, deny] = fn(mask(row.allow_permissions), mask(row.deny_permissions))
    byTarget.set(key, { ...row, allow_permissions: allow.toString(), deny_permissions: deny.toString() })
  }

  edit({ target_type: 'role', role_id: everyoneRoleId, user_id: null }, (allow, deny) =>
    privacy.isPrivate ? [allow & ~VIEW_CHANNEL, deny | VIEW_CHANNEL] : [allow, deny & ~VIEW_CHANNEL])

  if (privacy.isPrivate) {
    const roles = new Set(privacy.roleIds)
    const users = new Set(privacy.userIds)
    for (const row of [...byTarget.values()]) {
      if (row.role_id === everyoneRoleId) continue
      const keep = row.role_id ? roles.has(row.role_id) : users.has(row.user_id!)
      if (!keep) edit(row, (allow, deny) => [allow & ~VIEW_CHANNEL, deny])
    }
    const grant = (allow: bigint, deny: bigint): [bigint, bigint] => [allow | VIEW_CHANNEL, deny & ~VIEW_CHANNEL]
    for (const id of roles) edit({ target_type: 'role', role_id: id, user_id: null }, grant)
    for (const id of users) edit({ target_type: 'user', role_id: null, user_id: id }, grant)
  }

  return [...byTarget.values()].filter(o => mask(o.allow_permissions) !== ZERO || mask(o.deny_permissions) !== ZERO)
}

export async function getCategoryOverrides(categoryId: string): Promise<CategoryOverride[]> {
  const { data, error } = await supabase
    .from('channel_category_permission_overrides')
    .select('target_type, role_id, user_id, allow_permissions, deny_permissions')
    .eq('category_id', categoryId)
  if (error) throw error
  return (data ?? []).map((o: any) => ({
    target_type: o.target_type,
    role_id: o.role_id ?? null,
    user_id: o.user_id ?? null,
    allow_permissions: String(o.allow_permissions ?? 0),
    deny_permissions: String(o.deny_permissions ?? 0),
  }))
}

/** Replaces the template; returns the channels that were synced and now carry it. */
export async function setCategoryPermissions(categoryId: string, overrides: CategoryOverride[]): Promise<string[]> {
  const { data, error } = await supabase.rpc('set_category_permissions', {
    p_category_id: categoryId,
    p_overrides: overrides,
  })
  if (error) throw error
  return ((data as { synced_channel_ids?: string[] } | null)?.synced_channel_ids) ?? []
}

export async function syncChannelPermissions(channelId: string): Promise<void> {
  const { error } = await supabase.rpc('sync_channel_permissions', { p_channel_id: channelId })
  if (error) throw error
}

/** True or false for a channel in a category; null for one in none. */
export async function channelPermissionsSynced(channelId: string): Promise<boolean | null> {
  const { data, error } = await supabase.rpc('channel_permissions_synced', { p_channel_id: channelId })
  if (error) throw error
  return typeof data === 'boolean' ? data : null
}
