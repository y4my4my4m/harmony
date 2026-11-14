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

type Target = Pick<CategoryOverride, 'target_type' | 'role_id' | 'user_id'>

function targetKey(o: Pick<CategoryOverride, 'role_id' | 'user_id'>): string {
  return o.role_id ? `role:${o.role_id}` : `user:${o.user_id}`
}

const hasBits = (o: CategoryOverride) => mask(o.allow_permissions) !== ZERO || mask(o.deny_permissions) !== ZERO

export type OverrideState = 'allow' | 'deny' | 'inherit'

/** The state of `bit` (a mask of one bit) for a role or member in the template. */
export function overrideState(rows: CategoryOverride[], target: Pick<CategoryOverride, 'role_id' | 'user_id'>, bit: bigint): OverrideState {
  const key = targetKey(target)
  const row = rows.find(o => targetKey(o) === key)
  if (!row) return 'inherit'
  if ((mask(row.allow_permissions) & bit) !== ZERO) return 'allow'
  if ((mask(row.deny_permissions) & bit) !== ZERO) return 'deny'
  return 'inherit'
}

/** The template with `bit` of one role or member set to `state`; every other bit and row kept. */
export function withOverrideState(rows: CategoryOverride[], target: Target, bit: bigint, state: OverrideState): CategoryOverride[] {
  const key = targetKey(target)
  const out = rows.map(o => ({ ...o }))
  let row = out.find(o => targetKey(o) === key)
  if (!row) {
    row = { ...target, allow_permissions: '0', deny_permissions: '0' }
    out.push(row)
  }
  const allow = mask(row.allow_permissions) & ~bit
  const deny = mask(row.deny_permissions) & ~bit
  row.allow_permissions = (state === 'allow' ? allow | bit : allow).toString()
  row.deny_permissions = (state === 'deny' ? deny | bit : deny).toString()
  return out.filter(hasBits)
}

/** One role or member's row restored from `saved`, or removed when `saved` has none. */
export function withTargetFrom(rows: CategoryOverride[], saved: CategoryOverride[], target: Pick<CategoryOverride, 'role_id' | 'user_id'>): CategoryOverride[] {
  const key = targetKey(target)
  const original = saved.find(o => targetKey(o) === key)
  const rest = rows.filter(o => targetKey(o) !== key)
  return original ? [...rest, { ...original }] : rest
}

/** A role or member's masks as "allow/deny"; "0/0" without a row. */
export function targetMasks(rows: CategoryOverride[], target: Pick<CategoryOverride, 'role_id' | 'user_id'>): string {
  const key = targetKey(target)
  const row = rows.find(o => targetKey(o) === key)
  return row ? `${mask(row.allow_permissions)}/${mask(row.deny_permissions)}` : '0/0'
}

/** Equal templates: the same rows with the same masks, in any order, empty rows ignored. */
export function sameTemplate(a: CategoryOverride[], b: CategoryOverride[]): boolean {
  const flat = (rows: CategoryOverride[]) => rows.filter(hasBits)
    .map(o => `${targetKey(o)}=${mask(o.allow_permissions)}/${mask(o.deny_permissions)}`)
    .sort()
    .join()
  return flat(a) === flat(b)
}

/**
 * The edits made from `saved` to `edited`, applied onto `latest`: per role or member, the bits
 * whose state the dialog changed come from `edited`, every other bit from `latest`. Rows the
 * dialog left alone are `latest`'s; rows of roles absent from `roleIds` are dropped.
 */
export function rebaseTemplate(
  latest: CategoryOverride[],
  saved: CategoryOverride[],
  edited: CategoryOverride[],
  roleIds: ReadonlySet<string>,
): CategoryOverride[] {
  const byKey = (rows: CategoryOverride[]) => new Map(rows.map(o => [targetKey(o), o]))
  const savedRows = byKey(saved)
  const editedRows = byKey(edited)
  const out = byKey(latest.map(o => ({ ...o })))
  for (const key of new Set([...savedRows.keys(), ...editedRows.keys()])) {
    const before = savedRows.get(key)
    const after = editedRows.get(key)
    const target = (after ?? before)!
    const [ba, bd] = [mask(before?.allow_permissions), mask(before?.deny_permissions)]
    const [ea, ed] = [mask(after?.allow_permissions), mask(after?.deny_permissions)]
    const changed = (ba ^ ea) | (bd ^ ed)
    if (changed === ZERO) continue
    const base = out.get(key)
    const [la, ld] = [mask(base?.allow_permissions), mask(base?.deny_permissions)]
    out.set(key, {
      target_type: target.target_type,
      role_id: target.role_id,
      user_id: target.user_id,
      allow_permissions: ((la & ~changed) | (ea & changed)).toString(),
      deny_permissions: ((ld & ~changed) | (ed & changed)).toString(),
    })
  }
  return [...out.values()].filter(o => hasBits(o) && (!o.role_id || roleIds.has(o.role_id)))
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

  return [...byTarget.values()].filter(hasBits)
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
