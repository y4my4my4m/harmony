import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';

/**
 * Convert internal post format to ActivityPub Note
 */
export function postToNote(post: any, author: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;

  const note: any = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: postUrl,
    type: 'Note',
    attributedTo: authorUrl,
    published: post.created_at,
    content: extractContentAsHtml(post.content),
    to: getToAddresses(post.visibility, authorUrl),
    cc: getCcAddresses(post.visibility, authorUrl),
  };

  // Add attachments if present
  const attachments = extractAttachments(post.content);
  if (attachments.length > 0) {
    note.attachment = attachments;
  }

  // Add tags (mentions, hashtags)
  const tags = extractTags(post.content);
  if (tags.length > 0) {
    note.tag = tags;
  }

  // Add reply info
  if (post.in_reply_to) {
    note.inReplyTo = post.in_reply_to;
  }

  return note;
}

/**
 * Convert internal message format to ActivityPub Note (for DMs)
 */
export function messageToNote(message: any, author: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const messageUrl = `https://${domain}/messages/${message.id}`;

  const note: any = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: messageUrl,
    type: 'Note',
    attributedTo: authorUrl,
    published: message.created_at,
    content: extractContentAsHtml(message.content),
    to: [], // Will be filled with conversation participants
    cc: [],
  };

  return note;
}

/**
 * Convert user profile to ActivityPub Actor
 */
export function profileToActor(profile: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${profile.username}`;

  const actor: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: userUrl,
    type: 'Person',
    preferredUsername: profile.username,
    name: profile.display_name || profile.username,
    summary: profile.bio || '',
    inbox: `${userUrl}/inbox`,
    outbox: `${userUrl}/outbox`,
    followers: `${userUrl}/followers`,
    following: `${userUrl}/following`,
    url: userUrl,
    published: profile.created_at,
    endpoints: {
      sharedInbox: `https://${domain}/inbox`,
      sharedOutbox: `https://${domain}/outbox`,
    },
  };

  // Add icon (avatar)
  if (profile.avatar) {
    actor.icon = {
      type: 'Image',
      mediaType: 'image/png',
      url: profile.avatar,
    };
  }

  // Add banner
  if (profile.banner) {
    actor.image = {
      type: 'Image',
      mediaType: 'image/png',
      url: profile.banner,
    };
  }

  // Add public key
  if (profile.public_key) {
    actor.publicKey = {
      id: `${userUrl}#main-key`,
      owner: userUrl,
      publicKeyPem: profile.public_key,
    };
  }

  return actor;
}

/**
 * Create a Follow activity
 */
export function createFollowActivity(follower: any, following: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const followerUrl = `https://${domain}/users/${follower.username}`;
  const activityId = `${followerUrl}/follows/${following.id}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Follow',
    actor: followerUrl,
    object: following.federated_id || following.id,
  };
}

/**
 * Create an Accept activity (for follow requests)
 */
export function createAcceptActivity(actor: any, followActivity: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const actorUrl = `https://${domain}/users/${actor.username}`;
  const activityId = `${actorUrl}/accepts/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Accept',
    actor: actorUrl,
    object: followActivity,
  };
}

/**
 * Create a Like activity (for reactions)
 */
export function createLikeActivity(user: any, objectUrl: string, emoji?: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/likes/${Date.now()}`;

  const activity: any = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
  };

  // Add emoji for Misskey-style reactions
  if (emoji) {
    activity.content = emoji;
    activity._misskey_reaction = emoji;
  }

  return activity;
}

/**
 * Create an Announce activity (for reblogs/boosts)
 */
export function createAnnounceActivity(user: any, objectUrl: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/announces/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Announce',
    actor: userUrl,
    object: objectUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
  };
}

/**
 * Create a Delete activity
 */
export function createDeleteActivity(user: any, objectUrl: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/deletes/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Delete',
    actor: userUrl,
    object: objectUrl,
  };
}

/**
 * Helper: Extract HTML content from JSONB content
 */
function extractContentAsHtml(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (item.type === 'text') {
          return item.text;
        } else if (item.type === 'mention') {
          return `<a href="${item.url || '#'}" class="mention">@${item.mention}</a>`;
        } else if (item.type === 'url') {
          return `<a href="${item.url}">${item.url}</a>`;
        }
        return '';
      })
      .join('');
  }

  return '';
}

/**
 * Helper: Extract attachments from JSONB content
 */
function extractAttachments(content: any): any[] {
  if (!Array.isArray(content)) {
    return [];
  }

  return content
    .filter((item) => item.type === 'file')
    .map((item) => ({
      type: 'Document',
      mediaType: item.fileType || 'application/octet-stream',
      url: item.url,
      name: item.name || null,
    }));
}

/**
 * Helper: Extract tags (mentions, hashtags) from JSONB content
 */
function extractTags(content: any): any[] {
  if (!Array.isArray(content)) {
    return [];
  }

  const tags: any[] = [];

  content.forEach((item) => {
    if (item.type === 'mention') {
      // Debug logging
      logger.info('🏷️ Processing mention tag: ' + JSON.stringify({
        username: item.username,
        domain: item.domain,
        isLocal: item.isLocal,
        userId: item.userId,
        fullItem: item
      }));
      
      // MessagePart format uses username and domain, not mention string
      const domain = item.domain || config.INSTANCE_DOMAIN;
      const username = item.username || 'unknown';
      const href = `https://${domain}/users/${username}`;
      const name = item.isLocal ? `@${username}` : `@${username}@${domain}`;
      
      tags.push({
        type: 'Mention',
        href: href,
        name: name,
      });
    }
    
    if (item.type === 'hashtag') {
      const href = `https://${config.INSTANCE_DOMAIN}/tags/${item.name}`;
      tags.push({
        type: 'Hashtag',
        href: href,
        name: `#${item.name}`,
      });
    }
  });

  return tags;
}

/**
 * Helper: Get 'to' addresses based on visibility
 */
function getToAddresses(visibility: string, authorUrl: string): string[] {
  switch (visibility) {
    case 'public':
      return ['https://www.w3.org/ns/activitystreams#Public'];
    case 'unlisted':
      return [`${authorUrl}/followers`];
    case 'followers':
      return [`${authorUrl}/followers`];
    case 'private':
      return []; // Direct messages, will be filled separately
    default:
      return ['https://www.w3.org/ns/activitystreams#Public'];
  }
}

/**
 * Helper: Get 'cc' addresses based on visibility
 */
function getCcAddresses(visibility: string, authorUrl: string): string[] {
  switch (visibility) {
    case 'public':
      return [`${authorUrl}/followers`];
    case 'unlisted':
      return [];
    case 'followers':
      return [];
    case 'private':
      return [];
    default:
      return [];
  }
}

