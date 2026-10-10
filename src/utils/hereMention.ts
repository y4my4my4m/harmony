/**
 * @here: a role_mention part whose roleId is `here` (20261011600001_here_mention.sql). Role ids
 * are UUIDs, so no role carries it. The composer writes it as `@role:here`, beside
 * `@role:UUID` for a role.
 */
import type { MessagePart, RoleMentionContent } from '@/types'

export const HERE_ROLE_ID = 'here'
export const HERE_MENTION_TOKEN = `@role:${HERE_ROLE_ID}`

export function hereMentionPart(): RoleMentionContent {
  return { type: 'role_mention', roleId: HERE_ROLE_ID, roleName: HERE_ROLE_ID, roleColor: null }
}

export function isHereMention(part: unknown): boolean {
  const p = part as { type?: unknown; roleId?: unknown } | null
  return !!p && p.type === 'role_mention' && p.roleId === HERE_ROLE_ID
}

export interface MentionViewer {
  profileId: string | null | undefined
  /** Roles the viewer holds in the message's server; the default role (@everyone) included. */
  roleIds: ReadonlySet<string>
}

/**
 * A channel message names the viewer: a mention of their profile, @here, or a role they hold,
 * @everyone included. @here and @everyone reach the members who can view the channel, which a
 * viewer of the message can; who is notified is decided by handle_role_mention_notifications.
 */
export function mentionsViewer(content: readonly MessagePart[] | null | undefined, viewer: MentionViewer): boolean {
  if (!Array.isArray(content)) return false
  for (const part of content as any[]) {
    if (!part || typeof part !== 'object') continue
    if (part.type === 'mention') {
      if (viewer.profileId && part.userId === viewer.profileId) return true
    } else if (part.type === 'role_mention') {
      if (part.roleId === HERE_ROLE_ID) return true
      if (typeof part.roleId === 'string' && viewer.roleIds.has(part.roleId)) return true
    }
  }
  return false
}
