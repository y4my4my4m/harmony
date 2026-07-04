/**
 * Federation Handlers - Create ActivityPub activities from database events
 */

import { 
  postToNote, 
  createFollowActivity as createFollow,
  createAnnounceActivity as createAnnounce,
  createUpdateActivity,
  createDeleteActivity as createDelete,
} from '../activitypub/converters/toActivityPub.js';
import config from '../config/index.js';
import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Create a Create activity for a new post
 * Handles quote posts by adding quoteUrl to the Note
 */
export async function createPostActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/${post.id}`;
  const supabase = getSupabaseClient();

  let quoteUrl: string | undefined;
  if (post.metadata?.is_quote && post.metadata?.reblog_of) {
    const { data: quotedPost } = await supabase
      .from('posts')
      .select('ap_id')
      .eq('id', post.metadata.reblog_of)
      .single();
    
    quoteUrl = quotedPost?.ap_id || `https://${domain}/posts/${post.metadata.reblog_of}`;
    logger.info(`📝 Creating quote post with quoteUrl: ${quoteUrl}`);
  }

  const note = postToNote(post, author, quoteUrl);
  
  // Fix in_reply_to: Convert UUID to ActivityPub URL
  if (post.in_reply_to) {
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
    '@context': note['@context'] || 'https://www.w3.org/ns/activitystreams',
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
 * Re-export for backward compatibility. Prefer importing from toActivityPub directly.
 */
export { createLikeActivity } from '../activitypub/converters/toActivityPub.js';

/**
 * Create an Announce activity (reblog)
 * Gets the original post's AP ID to properly federate the boost
 */
export async function createReblogActivity(user: any, reblogPost: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const supabase = getSupabaseClient();
  
  const originalPostId = reblogPost.metadata?.reblog_of;
  
  if (!originalPostId) {
    throw new Error('Reblog post missing original post reference');
  }
  
  const { data: originalPost } = await supabase
    .from('posts')
    .select('id, ap_id')
    .eq('id', originalPostId)
    .single();
  
  // Use the original post's AP ID, or construct one for local posts
  const objectUrl = originalPost?.ap_id || `https://${domain}/posts/${originalPostId}`;
  
  return createAnnounce(user, objectUrl);
}

/**
 * Create an Update activity (profile updates)
 */
export function createProfileUpdateActivity(profile: any): any {
  return createUpdateActivity(profile);
}

/**
 * Create a Delete activity for a post
 */
export function createDeleteActivity(author: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const objectUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  return createDelete(author, objectUrl);
}

/**
 * Create an Undo Announce activity (unreblog)
 */
export async function createUndoAnnounceActivity(user: any, reblogPost: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const supabase = getSupabaseClient();
  const userUrl = `https://${domain}/users/${user.username}`;
  
  const originalPostId = reblogPost.metadata?.reblog_of;
  
  if (!originalPostId) {
    throw new Error('Reblog post missing original post reference');
  }
  
  const { data: originalPost } = await supabase
    .from('posts')
    .select('id, ap_id')
    .eq('id', originalPostId)
    .single();
  
  const objectUrl = originalPost?.ap_id || `https://${domain}/posts/${originalPostId}`;
  
  const announceActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: reblogPost.ap_id || `${userUrl}/announces/${reblogPost.id}`,
    type: 'Announce',
    actor: userUrl,
    object: objectUrl,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: userUrl,
    object: announceActivity,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create an Undo Follow activity
 */
export function createUndoFollowActivity(follower: any, following: any, followRecord: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const followerUrl = `https://${domain}/users/${follower.username}`;
  
  const followActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: followRecord.ap_id || `${followerUrl}/follows/${following.id}`,
    type: 'Follow',
    actor: followerUrl,
    object: following.federated_id || following.id,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${followerUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: followerUrl,
    object: followActivity,
  };
}

/**
 * Create an Undo Like activity (remove reaction)
 */
export function createUndoLikeActivity(user: any, objectUrl: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  
  const likeActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/likes/${Date.now()}`,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: userUrl,
    object: likeActivity,
  };
}

/**
 * Create an Add activity (pin post to featured collection)
 */
export function createAddToFeaturedActivity(user: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  const featuredUrl = `${userUrl}/featured`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/add/${Date.now()}`,
    type: 'Add',
    actor: userUrl,
    object: postUrl,
    target: featuredUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Remove activity (unpin post from featured collection)
 */
export function createRemoveFromFeaturedActivity(user: any, post: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;
  const featuredUrl = `${userUrl}/featured`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${userUrl}/remove/${Date.now()}`,
    type: 'Remove',
    actor: userUrl,
    object: postUrl,
    target: featuredUrl,
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Block activity
 */
export function createBlockActivity(blocker: any, blocked: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const blockerUrl = `https://${domain}/users/${blocker.username}`;
  const blockedUrl = blocked.federated_id || `https://${blocked.domain}/users/${blocked.username}`;
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/blocks/${Date.now()}`,
    type: 'Block',
    actor: blockerUrl,
    object: blockedUrl,
  };
}

/**
 * Create an Undo Block activity (unblock)
 */
export function createUndoBlockActivity(blocker: any, blocked: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const blockerUrl = `https://${domain}/users/${blocker.username}`;
  const blockedUrl = blocked.federated_id || `https://${blocked.domain}/users/${blocked.username}`;
  
  const blockActivity = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/blocks/${blocked.id}`,
    type: 'Block',
    actor: blockerUrl,
    object: blockedUrl,
  };
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${blockerUrl}/undo/${Date.now()}`,
    type: 'Undo',
    actor: blockerUrl,
    object: blockActivity,
  };
}

/**
 * Create a Flag activity (report user/post to remote instance)
 */
export function createFlagActivity(
  reporter: any, 
  reportedUser: any, 
  reportedPost: any | null,
  reason: string
): any {
  const domain = config.INSTANCE_DOMAIN;
  const reporterUrl = `https://${domain}/users/${reporter.username}`;
  
  const objects: string[] = [];
  
  // Always include the user
  const userUrl = reportedUser.federated_id || `https://${reportedUser.domain}/users/${reportedUser.username}`;
  objects.push(userUrl);
  
  // Include the post if specified
  if (reportedPost?.ap_id) {
    objects.push(reportedPost.ap_id);
  }
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${reporterUrl}/flags/${Date.now()}`,
    type: 'Flag',
    actor: reporterUrl,
    object: objects,
    content: reason,
  };
}

/**
 * Create an Update activity for an edited post
 */
export async function createPostUpdateActivity(post: any, author: any): Promise<any> {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const activityId = `${authorUrl}/activities/update-${post.id}-${Date.now()}`;
  
  // Import postToNote to create the Note object
  const note = postToNote(post, author);
  
  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Update',
    actor: authorUrl,
    published: new Date().toISOString(),
    to: note.to || ['https://www.w3.org/ns/activitystreams#Public'],
    cc: note.cc || [`${authorUrl}/followers`],
    object: note,
  };
}

