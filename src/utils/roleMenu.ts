import type { RoleMenuContent } from '@/types/chat'

const MAX_TITLE = 100

/** The message's role menu part, or null. */
export function roleMenuPartOf(content: readonly unknown[] | null | undefined): RoleMenuContent | null {
  if (!Array.isArray(content)) return null
  for (const part of content) {
    const p = part as Partial<RoleMenuContent> | null
    if (p && p.type === 'role_menu' && typeof p.serverId === 'string') {
      return {
        type: 'role_menu',
        serverId: p.serverId,
        group: typeof p.group === 'string' && p.group.trim() ? p.group : null,
        ...(typeof p.title === 'string' && p.title.trim() ? { title: p.title.trim().slice(0, MAX_TITLE) } : {}),
      }
    }
  }
  return null
}

/**
 * Parts of a role menu message: the card, then a text part listing the roles for readers that do
 * not draw it (search, previews, notifications, other instances).
 */
export function roleMenuMessageParts(
  serverId: string,
  group: string | null,
  title: string,
  roleNames: readonly string[],
): Array<RoleMenuContent | { type: 'text'; text: string }> {
  const heading = title.trim().slice(0, MAX_TITLE)
  const text = roleNames.length > 0 ? `${heading}: ${roleNames.join(' · ')}` : heading
  return [
    { type: 'role_menu', serverId, group, ...(heading ? { title: heading } : {}) },
    { type: 'text', text },
  ]
}
