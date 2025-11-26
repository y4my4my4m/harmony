import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getFullAvatarUrl, getFullBannerUrl } from '../../utils/urlUtils.js';

/**
 * Convert internal post format to ActivityPub Note
 * Supports quote posts via quoteUrl (Fediverse) and _misskey_quote (Misskey)
 */
export function postToNote(post: any, author: any, quoteUrl?: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;

  const note: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'quoteUrl': 'as:quoteUrl',
        'misskey': 'https://misskey-hub.net/ns#',
        '_misskey_quote': 'misskey:_misskey_quote',
      }
    ],
    id: postUrl,
    type: 'Note',
    attributedTo: authorUrl,
    published: post.created_at,
    content: extractContentAsHtml(post.content),
    to: getToAddresses(post.visibility, authorUrl),
    cc: getCcAddresses(post.visibility, authorUrl),
  };

  // Add content warning (ActivityPub uses 'summary' for CW)
  if (post.content_warning) {
    note.summary = post.content_warning;
  }

  // Add sensitive flag
  if (post.is_sensitive) {
    note.sensitive = true;
  }

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
    // in_reply_to is a UUID - need to get the ap_id of the parent post
    // For federated posts, this is their original ActivityPub URL
    // For local posts, this is our generated URL
    note.inReplyTo = post.in_reply_to; // Will be resolved in createPostActivity
  }

  // Add quote post URL if this is a quote post
  if (quoteUrl) {
    note.quoteUrl = quoteUrl;
    note._misskey_quote = quoteUrl; // Misskey compatibility
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

  // Add icon (avatar) - convert to full URL if relative path
  const avatarUrl = getFullAvatarUrl(profile.avatar_url);
  if (avatarUrl) {
    actor.icon = {
      type: 'Image',
      url: avatarUrl,
    };
  }

  // Add banner - convert to full URL if relative path
  const bannerUrl = getFullBannerUrl(profile.banner_url);
  if (bannerUrl) {
    actor.image = {
      type: 'Image',
      url: bannerUrl,
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
export function createLikeActivity(
  user: any, 
  objectUrl: string, 
  emojiContent?: string,
  emojiData?: { name: string; url: string }
): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/likes/${Date.now()}`;

  const activity: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'toot': 'http://joinmastodon.org/ns#',
        'Emoji': 'toot:Emoji'
      }
    ],
    id: activityId,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
  };

  // Add emoji for Misskey-style reactions
  if (emojiContent) {
    activity.content = emojiContent;
    activity._misskey_reaction = emojiContent;
    
    // Add custom emoji tag for proper federation
    if (emojiData) {
      activity.tag = [{
        type: 'Emoji',
        name: emojiContent,
        icon: {
          type: 'Image',
          url: emojiData.url
        }
      }];
    }
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
 * Create an Update activity (for profile updates)
 */
export function createUpdateActivity(profile: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${profile.username}`;
  const activityId = `${userUrl}/updates/${Date.now()}`;

  // Create the updated Actor object
  const actor = profileToActor(profile);

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Update',
    actor: userUrl,
    published: new Date().toISOString(),
    to: ['https://www.w3.org/ns/activitystreams#Public'],
    cc: [`${userUrl}/followers`],
    object: actor,
  };
}

/**
 * Helper: Extract HTML content from JSONB content (MessagePart[])
 * Converts to ActivityPub-compatible HTML with mentions, hashtags, and emojis
 */
function extractContentAsHtml(content: any): string {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return content
    .map((item) => {
      if (item.type === 'text') {
        // Escape HTML entities for safety (match SQL logic)
        let text = item.text || '';
        text = text.replace(/&/g, '&amp;');
        text = text.replace(/</g, '&lt;');
        text = text.replace(/>/g, '&gt;');
        return text;
      } 
      else if (item.type === 'mention') {
        // MessagePart format has username and domain
        const domain = item.domain || config.INSTANCE_DOMAIN;
        const username = item.username || 'unknown';
        const href = `https://${domain}/users/${username}`;
        const displayName = item.isLocal ? `@${username}` : `@${username}@${domain}`;
        // Match SQL: simple <a> tag without h-card wrapper
        return `<a href="${href}" class="mention">${displayName}</a>`;
      }
      else if (item.type === 'hashtag') {
        const href = `https://${config.INSTANCE_DOMAIN}/tags/${item.name}`;
        return `<a href="${href}" class="mention hashtag" rel="tag">#${item.name}</a>`;
      }
      else if (item.type === 'emoji') {
        // Custom emoji - use :name: syntax, actual emoji data in tags
        return `:${item.emoji?.name || 'emoji'}:`;
      }
      else if (item.type === 'url') {
        const url = item.url || '';
        // Escape URL
        const escapedUrl = url.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        return `<a href="${escapedUrl}" rel="noopener noreferrer" target="_blank">${escapedUrl}</a>`;
      }
      return '';
    })
    .join('');
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
    
    if (item.type === 'emoji' && item.emoji) {
      // Custom emoji tag for Misskey/Mastodon compatibility
      tags.push({
        type: 'Emoji',
        id: item.emoji.id || item.emoji.url,
        name: `:${item.emoji.name}:`,
        icon: {
          type: 'Image',
          mediaType: 'image/png',
          url: item.emoji.url
        }
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

