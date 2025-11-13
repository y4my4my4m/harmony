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
import { getSupabaseClient } from '../config/supabase.js';

/**
 * Create a Create activity for a new post
 */
export async function createPostActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/${post.id}`;

  const note = postToNote(post, author);
  
  // Fix in_reply_to: Convert UUID to ActivityPub URL
  if (post.in_reply_to) {
    const supabase = getSupabaseClient();
    const { data: parentPost } = await supabase
      .from('posts')
      .select('ap_id')
      .eq('id', post.in_reply_to)
      .single();
    
    if (parentPost?.ap_id) {
      note.inReplyTo = parentPost.ap_id;
    } else {
      // Parent post doesn't have ap_id (shouldn't happen with our trigger, but fallback)
      note.inReplyTo = `https://${domain}/posts/${post.in_reply_to}`;
    }
  }

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
  const objectUrl = post.ap_id || post.id;
  return createAnnounce(user, objectUrl);
}

