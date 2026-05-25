/**
 * Display helpers for custom user status (activity type prefix, etc.)
 * Activity-only (e.g. "Playing" with no text) shows just the label; with text shows "Playing: myCustomStatus".
 */

import type { CustomUserStatus } from '@/types'

/** Label only when there is no custom text (e.g. "Playing", "Listening to") */
const ACTIVITY_LABELS: Record<NonNullable<CustomUserStatus['type']>, string> = {
  custom: '',
  playing: 'Playing',
  listening: 'Listening to',
  watching: 'Watching',
  competing: 'Competing in',
  streaming: 'Streaming',
}

/** Prefix when we have custom text – results in "Playing: myCustomStatus", etc. */
const ACTIVITY_PREFIXES_WITH_TEXT: Record<NonNullable<CustomUserStatus['type']>, string> = {
  custom: '',
  playing: 'Playing: ',
  listening: 'Listening to: ',
  watching: 'Watching: ',
  competing: 'Competing in: ',
  streaming: 'Streaming: ',
}

/**
 * Returns the display string for a custom status.
 * - Activity + text: "Playing: myCustomStatus", "Listening to: Song", etc.
 * - Activity only: "Playing", "Listening to", etc. (for SDK/game/stream detection later)
 * - Custom (no activity type): just the text or emoji.
 */
export function formatCustomStatusDisplay(status: CustomUserStatus | undefined | null): string {
  if (!status) return ''
  const type = status.type || 'custom'
  const text = (status.text || '').trim()
  if (type === 'custom') return text
  const label = ACTIVITY_LABELS[type]
  const prefixWithText = ACTIVITY_PREFIXES_WITH_TEXT[type]
  if (!label && !prefixWithText) return text
  return text ? `${prefixWithText}${text}` : label
}
