/**
 * Instance staff (profiles.is_admin / is_moderator) acting on an account, as staff_remove_member
 * and instance_remove_member decide it: an admin acts on anyone, a moderator on accounts that
 * are not instance staff.
 */

export interface StaffFlags {
  is_admin?: boolean | null
  is_moderator?: boolean | null
}

export function isInstanceStaff(profile: StaffFlags | null | undefined): boolean {
  return profile?.is_admin === true || profile?.is_moderator === true
}

export function staffMayActOn(viewer: StaffFlags | null | undefined, targetIsStaff: boolean | null | undefined): boolean {
  if (viewer?.is_admin === true) return true
  return viewer?.is_moderator === true && targetIsStaff !== true
}
