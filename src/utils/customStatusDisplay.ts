/**
 * Display helpers for custom user status (activity type prefix, etc.)
 */

import type { CustomUserStatus } from '@/types'

const ACTIVITY_PREFIXES: Record<NonNullable<CustomUserStatus['type']>, string> = {
  custom: '',
  playing: 'Playing ',
  listening: 'Listening to ',
  watching: 'Watching ',
  competing: 'Competing in ',
  streaming: 'Streaming ',
}

/**
 * Returns the display string for a custom status, including the activity prefix
 * when type is not "custom" (e.g. "Playing Game Name", "Listening to Song").
 */
export function formatCustomStatusDisplay(status: CustomUserStatus | undefined | null): string {
  if (!status) return ''
  const type = status.type || 'custom'
  const prefix = ACTIVITY_PREFIXES[type]
  const text = (status.text || '').trim()
  if (!prefix) return text
  return text ? `${prefix}${text}` : prefix.trim()
}
