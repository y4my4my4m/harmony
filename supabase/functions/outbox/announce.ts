// Handler for Announce activities (boosts/reblogs)

export interface AnnounceActivity {
  '@context': string | string[]
  id: string
  type: 'Announce'
  actor: string
  object: string
  published?: string
  to?: string[]
  cc?: string[]
}

export interface UndoAnnounceActivity {
  '@context': string | string[]
  id: string
  type: 'Undo'
  actor: string
  object: AnnounceActivity
  published?: string
}

/**
 * Create an Announce activity (boost/reblog)
 */
export function createAnnounceActivity(params: {
  actorUrl: string
  activityId: string
  objectUrl: string
  published?: string
  to?: string[]
  cc?: string[]
}): AnnounceActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Announce',
    actor: params.actorUrl,
    object: params.objectUrl,
    ...(params.published && { published: params.published }),
    ...(params.to && { to: params.to }),
    ...(params.cc && { cc: params.cc })
  }
}

/**
 * Create an Undo Announce activity
 */
export function createUndoAnnounceActivity(params: {
  actorUrl: string
  activityId: string
  announceActivity: AnnounceActivity
  published?: string
}): UndoAnnounceActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Undo',
    actor: params.actorUrl,
    object: params.announceActivity,
    ...(params.published && { published: params.published })
  }
}

/**
 * Validate an Announce activity
 */
export function validateAnnounceActivity(activity: any): activity is AnnounceActivity {
  return (
    activity &&
    activity.type === 'Announce' &&
    typeof activity.actor === 'string' &&
    typeof activity.object === 'string'
  )
}

/**
 * Validate an Undo Announce activity
 */
export function validateUndoAnnounceActivity(activity: any): activity is UndoAnnounceActivity {
  return (
    activity &&
    activity.type === 'Undo' &&
    typeof activity.actor === 'string' &&
    activity.object &&
    activity.object.type === 'Announce'
  )
}
