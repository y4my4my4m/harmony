// Handler for Follow activities

export interface FollowActivity {
  '@context': string | string[]
  id: string
  type: 'Follow'
  actor: string
  object: string
  published?: string
}

export interface AcceptActivity {
  '@context': string | string[]
  id: string
  type: 'Accept'
  actor: string
  object: FollowActivity | string
  published?: string
}

/**
 * Create a Follow activity
 */
export function createFollowActivity(params: {
  actorUrl: string
  activityId: string
  targetActorUrl: string
  published?: string
}): FollowActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Follow',
    actor: params.actorUrl,
    object: params.targetActorUrl,
    ...(params.published && { published: params.published })
  }
}

/**
 * Create an Accept activity (for accepting follow requests)
 */
export function createAcceptActivity(params: {
  actorUrl: string
  activityId: string
  followActivity: FollowActivity | string
  published?: string
}): AcceptActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: params.activityId,
    type: 'Accept',
    actor: params.actorUrl,
    object: params.followActivity,
    ...(params.published && { published: params.published })
  }
}

/**
 * Validate a Follow activity
 */
export function validateFollowActivity(activity: any): activity is FollowActivity {
  return (
    activity &&
    activity.type === 'Follow' &&
    typeof activity.actor === 'string' &&
    typeof activity.object === 'string'
  )
}

/**
 * Validate an Accept activity
 */
export function validateAcceptActivity(activity: any): activity is AcceptActivity {
  return (
    activity &&
    activity.type === 'Accept' &&
    typeof activity.actor === 'string' &&
    activity.object
  )
}
