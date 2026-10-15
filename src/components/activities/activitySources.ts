import type { ActivityItem, ActivitySource } from '@/services/activities/activityService'

export function activitySourceIcon(source: ActivitySource): string {
  switch (source) {
    case 'youtube': return 'tv'
    case 'soundcloud': return 'radio'
    case 'spotify': return 'disc'
    case 'file': return 'hard-drive'
    default: return 'film'
  }
}

export function activitySourceLabel(source: ActivitySource, t: (key: string) => string): string {
  switch (source) {
    case 'youtube': return 'YouTube'
    case 'soundcloud': return 'SoundCloud'
    case 'spotify': return 'Spotify'
    case 'file': return t('activities.source.drive')
    default: return t('activities.source.link')
  }
}

/** The item on its own service, for when the embedded player cannot play it. */
export function activitySourceUrl(source: ActivitySource, item: ActivityItem): string | null {
  if (source === 'youtube' && item.video_id) return `https://www.youtube.com/watch?v=${encodeURIComponent(item.video_id)}`
  if (source === 'soundcloud' && item.url) return item.url
  if (source === 'spotify' && item.uri) {
    const [, type, id] = item.uri.split(':')
    return type && id ? `https://open.spotify.com/${type}/${id}` : null
  }
  return null
}
