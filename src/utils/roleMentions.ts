/** Colour of a role pill or card whose role has none: the default role's grey. */
export const ROLE_FALLBACK_COLOR = '#99AAB5'

export function roleMentionColor(color: string | null | undefined): string {
  return color || ROLE_FALLBACK_COLOR
}
