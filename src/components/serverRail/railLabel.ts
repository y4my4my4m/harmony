/**
 * Accessible names for server rail entries: the visible badge and pill carry
 * mentions, unread and mute, so the name says them in words.
 *
 *   "Harmony, 3 mentions, muted"     "Games, folder, 4 servers, unread"
 *
 * A mention implies unread; "unread" is said only without mentions.
 */

type Translate = (key: string, named?: Record<string, unknown>, plural?: number) => string

export interface RailLabelState {
  mentions: number
  unread: boolean
  muted?: boolean
  /** Folders only: member server count. */
  servers?: number
}

export function railStateParts(t: Translate, state: RailLabelState): string[] {
  const parts: string[] = []
  if (state.servers !== undefined) {
    parts.push(t('chatNav.rail.folder'), t('chatNav.rail.servers', { count: state.servers }, state.servers))
  }
  if (state.mentions > 0) parts.push(t('chatNav.channel.mentions', { count: state.mentions }, state.mentions))
  else if (state.unread) parts.push(t('chatNav.channel.unread'))
  if (state.muted) parts.push(t('chatNav.channel.muted'))
  return parts
}

export function railLabel(t: Translate, name: string, state: RailLabelState): string {
  return [name, ...railStateParts(t, state)].join(', ')
}
