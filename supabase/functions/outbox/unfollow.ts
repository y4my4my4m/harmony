// Outbox unfollow handler
// Handles federation of Undo Follow activities

export interface UnfollowActivity {
  '@context': string
  id: string
  type: 'Undo'
  actor: string
  object: {
    id: string
    type: 'Follow'
    actor: string
    object: string
  }
  published: string
}

/**
 * Create ActivityPub Undo Follow activity
 */
export function createUnfollowActivity(
  followId: string,
  actorUrl: string,
  targetActorUrl: string,
  baseUrl: string
): UnfollowActivity {
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/activities/undo/${followId}`,
    type: 'Undo',
    actor: actorUrl,
    object: {
      id: `${baseUrl}/activities/follow/${followId}`,
      type: 'Follow',
      actor: actorUrl,
      object: targetActorUrl
    },
    published: new Date().toISOString()
  }
}

/**
 * Handle unfollow federation for outbox
 */
export async function handleUnfollowFederation(
  supabase: any,
  followId: string,
  actorUsername: string,
  targetActorUrl: string,
  baseUrl: string
): Promise<{ success: boolean; activity?: UnfollowActivity; error?: string }> {
  try {
    const actorUrl = `${baseUrl}/users/${actorUsername}`
    const activity = createUnfollowActivity(followId, actorUrl, targetActorUrl, baseUrl)

    return { success: true, activity }

  } catch (error) {
    console.error('Failed to handle unfollow federation:', error)
    return { success: false, error: error.message }
  }
}
