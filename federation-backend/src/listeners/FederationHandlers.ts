/**
 * Federation Handlers - Create ActivityPub activities from database events
 */

import { 
  postToNote, 
  createFollowActivity as createFollow,
  createLikeActivity as createLike,
  createAnnounceActivity as createAnnounce,
} from '../activitypub/converters/toActivityPub.js';
import config from '../config/index.js';

/**
 * Create a Create activity for a new post
 */
export async function createPostActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/${post.id}`;

  const note = postToNote(post, author);

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Create',
    actor: authorUrl,
    published: post.created_at,
    to: note.to || ['https://www.w3.org/ns/activitystreams#Public'],
    cc: note.cc || [`${authorUrl}/followers`],
    object: note,
  };
}

/**
 * Create a Follow activity
 */
export function createFollowActivity(follower: any, following: any): any {
  return createFollow(follower, following);
}

/**
 * Create a Like activity (with emoji support)
 */
export async function createLikeActivity(
  user: any,
  objectUrl: string,
  emojiId: string
): Promise<any> {
  // Get emoji details if it's a custom emoji
  // For now, just use the emoji_id as emoji
  return createLike(user, objectUrl, emojiId);
}

/**
 * Create an Announce activity (reblog)
 */
export async function createReblogActivity(user: any, post: any): Promise<any> {
  const objectUrl = post.federated_id || post.id;
  return createAnnounce(user, objectUrl);
}

