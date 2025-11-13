/**
 * Convert ActivityPub Note to internal post/message format (JSONB)
 * Returns the HTML as-is for frontend parsing with convertActivityPubHTMLToMessageParts
 */
export function noteToContent(note: any): any[] {
  // Don't parse here - just return the HTML content
  // The frontend will parse it properly with convertActivityPubHTMLToMessageParts
  // which handles mentions, hashtags, and formatting correctly
  
  if (note.content) {
    return [{
      type: 'text',
      text: note.content
    }];
  }
  
  return [{ type: 'text', text: '' }];
}

/**
 * Extract user profile data from ActivityPub Actor
 */
export function actorToProfile(actor: any): {
  username: string;
  domain: string;
  display_name?: string;
  bio?: string;
  avatar?: string;
  banner?: string;
  public_key?: string;
  federated_id: string;
  inbox_url: string;
  outbox_url?: string;
  followers_url?: string;
  following_url?: string;
} {
  // Extract username and domain from actor ID
  const actorUrl = new URL(actor.id);
  const domain = actorUrl.hostname;
  const username = actor.preferredUsername || actorUrl.pathname.split('/').pop() || 'unknown';

  const profile: any = {
    username,
    domain,
    federated_id: actor.id,
    inbox_url: actor.inbox,
    outbox_url: actor.outbox,
    followers_url: actor.followers,
    following_url: actor.following,
    is_local: false,
  };

  if (actor.name) {
    profile.display_name = actor.name;
  }

  if (actor.summary) {
    profile.bio = actor.summary.replace(/<[^>]*>/g, ''); // Strip HTML
  }

  if (actor.icon?.url) {
    profile.avatar = actor.icon.url;
  }

  if (actor.image?.url) {
    profile.banner = actor.image.url;
  }

  if (actor.publicKey?.publicKeyPem) {
    profile.public_key = actor.publicKey.publicKeyPem;
  }

  return profile;
}

/**
 * Extract data from Follow activity
 */
export function extractFollowData(activity: any): {
  followerUrl: string;
  followingUrl: string;
  activityId: string;
} {
  return {
    followerUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    followingUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
    activityId: activity.id,
  };
}

/**
 * Extract data from Like activity
 */
export function extractLikeData(activity: any): {
  actorUrl: string;
  objectUrl: string;
  emoji?: string;
} {
  const data: any = {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
  };

  // Misskey-style reaction
  if (activity._misskey_reaction || activity.content) {
    data.emoji = activity._misskey_reaction || activity.content;
  }

  return data;
}

/**
 * Extract data from Announce activity (reblog/boost)
 */
export function extractAnnounceData(activity: any): {
  actorUrl: string;
  objectUrl: string;
  published?: string;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
    published: activity.published,
  };
}

/**
 * Extract data from Delete activity
 */
export function extractDeleteData(activity: any): {
  actorUrl: string;
  objectUrl: string;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
  };
}

/**
 * Extract data from Update activity
 */
export function extractUpdateData(activity: any): {
  actorUrl: string;
  object: any;
} {
  return {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    object: activity.object,
  };
}

/**
 * Normalize ActivityPub object (handle both URL strings and embedded objects)
 */
export function normalizeObject(obj: any): any {
  if (typeof obj === 'string') {
    return { id: obj };
  }
  return obj;
}

/**
 * Normalize actor (handle both URL strings and embedded actor objects)
 */
export function normalizeActor(actor: any): string {
  if (typeof actor === 'string') {
    return actor;
  }
  return actor.id;
}

