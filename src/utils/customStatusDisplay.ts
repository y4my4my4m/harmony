/**
 * Display helpers for custom user status.
 * Activity with no text renders the bare label ("Playing"); with text it renders
 * "Playing: <text>". Type `custom` renders the text alone.
 */

import type { CustomUserStatus } from '@/types'

/** Used when the status has no text. */
const ACTIVITY_LABELS: Record<NonNullable<CustomUserStatus['type']>, string> = {
  custom: '',
  playing: 'Playing',
  listening: 'Listening to',
  watching: 'Watching',
  competing: 'Competing in',
  streaming: 'Streaming',
}

/** Used when the status has text; trailing separator included. */
const ACTIVITY_PREFIXES_WITH_TEXT: Record<NonNullable<CustomUserStatus['type']>, string> = {
  custom: '',
  playing: 'Playing: ',
  listening: 'Listening to: ',
  watching: 'Watching: ',
  competing: 'Competing in: ',
  streaming: 'Streaming: ',
}

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
