// Handler for Like activities (reactions)

export interface LikeActivity {
  '@context': string | string[]
  id: string
  type: 'Like'
  actor: string
  object: string
  published?: string
}

export interface UndoLikeActivity {
  '@context': string | string[]
  id: string
  type: 'Undo'
  actor: string
  object: LikeActivity
  published?: string
}

/**
 * Create a Like activity
 */
export function createLikeActivity(params: {
  actorUrl: string
  activityId: string
  objectUrl: string
  published?: string
}): LikeActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Like',
    actor: params.actorUrl,
    object: params.objectUrl,
    ...(params.published && { published: params.published })
  }
}

/**
 * Create an Undo Like activity
 */
export function createUndoLikeActivity(params: {
  actorUrl: string
  activityId: string
  likeActivity: LikeActivity
  published?: string
}): UndoLikeActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Undo',
    actor: params.actorUrl,
    object: params.likeActivity,
    ...(params.published && { published: params.published })
  }
}

/**
 * Validate a Like activity
 */
export function validateLikeActivity(activity: any): activity is LikeActivity {
  return (
    activity &&
    activity.type === 'Like' &&
    typeof activity.actor === 'string' &&
    typeof activity.object === 'string'
  )
}

/**
 * Validate an Undo Like activity
 */
export function validateUndoLikeActivity(activity: any): activity is UndoLikeActivity {
  return (
    activity &&
    activity.type === 'Undo' &&
    typeof activity.actor === 'string' &&
    activity.object &&
    activity.object.type === 'Like'
  )
}
