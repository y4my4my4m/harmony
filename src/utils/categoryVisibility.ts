import type { Category, Channel } from '@/types'

/**
 * Category headers a viewer is shown. channel_categories RLS already withholds a category
 * holding no channel the viewer sees, except from channel managers; this is the same rule for
 * rows still in memory (a realtime insert, a cached structure). Managers see every category so
 * they can add channels to empty ones and reorder the full list.
 */
export function visibleCategories<T extends Pick<Category, 'id'>>(
  categories: T[],
  categoryChannels: Record<string, Pick<Channel, 'id'>[] | undefined>,
  canManageChannels: boolean,
): T[] {
  if (canManageChannels) return categories
  return categories.filter(c => (categoryChannels[c.id]?.length ?? 0) > 0)
}

/**
 * Members without channel management do not see the category: it holds no channel, or only
 * channels hidden from @everyone.
 */
export function categoryHiddenFromMembers(
  channels: Pick<Channel, 'id'>[] | undefined,
  isPrivateChannel: (channelId: string) => boolean,
): boolean {
  return !channels || channels.length === 0 || channels.every(c => isPrivateChannel(c.id))
}
