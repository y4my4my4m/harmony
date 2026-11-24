import { isUnicodeEmoji } from '@/utils/emojiInfoTarget'

/** What an announcement's icon field shows: a named icon (Icon.vue) or the emoji typed into it. */
export type AnnouncementIcon = { name: string; emoji: null } | { name: null; emoji: string }

/** Names the admin form accepts (instance_announcements.icon) -> Icon.vue names. */
const NAMED: Readonly<Record<string, string>> = {
  info: 'info',
  warning: 'alert-triangle',
  megaphone: 'megaphone',
  celebration: 'megaphone',
  maintenance: 'wrench',
  update: 'refresh-cw',
  security: 'shield',
}

export const ANNOUNCEMENT_ICON_NAMES: readonly string[] = Object.keys(NAMED)

/** A known name, case-insensitive; else a Unicode emoji as typed; else the info icon. */
export function announcementIcon(icon: string | null | undefined): AnnouncementIcon {
  const value = (icon ?? '').trim()
  const named = NAMED[value.toLowerCase()]
  if (named) return { name: named, emoji: null }
  if (isUnicodeEmoji(value)) return { name: null, emoji: value }
  return { name: 'info', emoji: null }
}
