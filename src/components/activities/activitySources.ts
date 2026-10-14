import type { ActivitySource } from '@/services/activities/activityService'

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
