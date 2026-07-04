import config from '../../config/index.js';
import { logger } from '../../utils/logger.js';
import { getFullAvatarUrl, getFullBannerUrl } from '../../utils/urlUtils.js';
import { getSupabaseClient } from '../../config/supabase.js';

/**
 * Insert zero-width spaces around :shortcode: patterns so parsers like
 * Misskey MFM can detect word boundaries (e.g. `:fire:y4my4m:fire:` →
 * `\u200b:fire:\u200by4my4m\u200b:fire:\u200b`).
 */
function normalizeShortcodeBoundaries(text: string): string {
  if (!text || !text.includes(':')) return text;
  return text.replace(/:([a-zA-Z0-9_+-]+):/g, '\u200b:$1:\u200b');
}

/**
 * Media type from a URL's file extension. Storage may serve uploads as
 * application/octet-stream, so remotes need this hint on icon/image.
 */
function imageMediaTypeFromUrl(url: string): string | undefined {
  const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg': return 'image/jpeg';
    case 'png': return 'image/png';
    case 'gif': return 'image/gif';
    case 'webp': return 'image/webp';
    case 'avif': return 'image/avif';
    case 'svg': return 'image/svg+xml';
    default: return undefined;
  }
}

/**
 * Convert internal post format to ActivityPub Note
 * Supports quote posts via quoteUrl (Fediverse) and _misskey_quote (Misskey)
 */
export function postToNote(post: any, author: any, quoteUrl?: string): any {
  const domain = config.INSTANCE_DOMAIN;
  const authorUrl = `https://${domain}/users/${author.username}`;
  const postUrl = post.ap_id || `https://${domain}/posts/${post.id}`;

  let toAddresses = getToAddresses(post.visibility, authorUrl);
  const ccAddresses = getCcAddresses(post.visibility, authorUrl);

  // For direct messages, populate 'to' with mentioned users' AP URLs
  if (post.visibility === 'direct' && Array.isArray(post.content)) {
    const mentionUrls = post.content
      .filter((part: any) => part.type === 'mention')
      .map((m: any) => {
        const mentionDomain = m.domain || config.INSTANCE_DOMAIN;
        return `https://${mentionDomain}/users/${m.username || 'unknown'}`;
      });
    toAddresses = [...toAddresses, ...mentionUrls];
  }

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
    to: toAddresses,
    cc: ccAddresses,
    likes: `${postUrl}/likes`,
    replies: `${postUrl}/replies`,
  };

  // Add content warning (ActivityPub uses 'summary' for CW)
  if (post.content_warning) {
    note.summary = post.content_warning;
  }

  if (post.is_sensitive) {
    note.sensitive = true;
  }

  const attachments = extractAttachments(post.content);
  if (attachments.length > 0) {
    note.attachment = attachments;
  }

  const tags = extractTags(post.content);
  if (tags.length > 0) {
    note.tag = tags;
  }

  if (post.in_reply_to) {
    // in_reply_to is a UUID - need to get the ap_id of the parent post
    // For federated posts, this is their original ActivityPub URL
    // For local posts, this is our generated URL
    note.inReplyTo = post.in_reply_to; // Will be resolved in createPostActivity
  }

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

  let customStatusData = null;
  if (profile.custom_status) {
    try {
      customStatusData = typeof profile.custom_status === 'string' 
        ? JSON.parse(profile.custom_status) 
        : profile.custom_status;
    } catch (e) {
      // Ignore parse errors
    }
  }

  const actor: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1',
    ],
    id: userUrl,
    type: 'Person',
    preferredUsername: profile.username,
    name: normalizeShortcodeBoundaries(profile.display_name || profile.username),
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

  const avatarUrl = getFullAvatarUrl(profile.avatar_url);
  if (avatarUrl) {
    actor.icon = {
      type: 'Image',
      mediaType: imageMediaTypeFromUrl(avatarUrl),
      url: avatarUrl,
    };
  }

  const bannerUrl = getFullBannerUrl(profile.banner_url);
  if (bannerUrl) {
    actor.image = {
      type: 'Image',
      mediaType: imageMediaTypeFromUrl(bannerUrl),
      url: bannerUrl,
    };
  }

  if (profile.public_key) {
    actor.publicKey = {
      id: `${userUrl}#main-key`,
      owner: userUrl,
      publicKeyPem: profile.public_key,
    };
  }

  actor.featured = `${userUrl}/featured`;

  if (profile.profile_fields && Array.isArray(profile.profile_fields)) {
    actor.attachment = profile.profile_fields.map((field: any) => ({
      type: 'PropertyValue',
      name: field.name,
      value: field.value,
    }));
  }

  if (profile.manually_approves_followers) {
    actor.manuallyApprovesFollowers = true;
  }

  if (profile.federation_discoverable !== undefined) {
    actor.discoverable = profile.federation_discoverable;
  }

  // Custom emojis in display name and bio (AP Emoji tags + Misskey-style emojis object)
  const emojiTags: any[] = [];
  const misskeyEmojis: Record<string, string> = {};

  const addProfileEmojis = (emojis: Array<{ name: string; url: string; id?: string }>) => {
    for (const emoji of emojis) {
      if (!emoji.name || !emoji.url) continue;
      const shortcode = emoji.name.includes(':') ? emoji.name : `:${emoji.name}:`;
      const emojiUrl = emoji.url.startsWith('http') ? emoji.url : `https://${domain}${emoji.url}`;
      const ext = emojiUrl.split('.').pop()?.toLowerCase().split('?')[0] || '';
      const mediaType = ext === 'gif' ? 'image/gif'
        : ext === 'webp' ? 'image/webp'
        : ext === 'svg' ? 'image/svg+xml'
        : 'image/png';
      emojiTags.push({
        type: 'Emoji',
        id: emoji.id ? `https://${domain}/emojis/${emoji.id}` : emojiUrl,
        name: shortcode,
        icon: {
          type: 'Image',
          mediaType,
          url: emojiUrl,
        },
      });
      misskeyEmojis[emoji.name.replace(/:/g, '')] = emojiUrl;
    }
  };

  // Read pre-resolved emojis from federation_metadata
  if (profile.federation_metadata) {
    const meta = typeof profile.federation_metadata === 'string'
      ? JSON.parse(profile.federation_metadata)
      : profile.federation_metadata;
    if (meta.display_name_emojis && Array.isArray(meta.display_name_emojis)) {
      addProfileEmojis(meta.display_name_emojis);
    }
    if (meta.bio_emojis && Array.isArray(meta.bio_emojis)) {
      addProfileEmojis(meta.bio_emojis);
    }
  }

  if (emojiTags.length > 0) {
    actor.tag = [...(actor.tag || []), ...emojiTags];
    actor.emojis = misskeyEmojis;
  }

  // Harmony extension: profile color
  if (profile.color) {
    actor['harmony:profileColor'] = profile.color;
  }

  // Harmony extension: custom status (Discord-style status)
  if (customStatusData) {
    // Ensure emoji_url is absolute for federation
    if (customStatusData.emoji_url && typeof customStatusData.emoji_url === 'string') {
      // If it's already absolute, keep it; otherwise convert to absolute
      if (!customStatusData.emoji_url.startsWith('http://') && !customStatusData.emoji_url.startsWith('https://')) {
        // Relative path - convert to full Supabase URL
        const supabase = getSupabaseClient();
        const { data } = supabase.storage
          .from('emojis')
          .getPublicUrl(customStatusData.emoji_url);
        customStatusData.emoji_url = data.publicUrl;
      }
    }
    actor['harmony:customStatus'] = customStatusData;
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
 * Create a Reject activity (for follow requests)
 */
export function createRejectActivity(actor: any, followActivity: any): any {
  const domain = config.INSTANCE_DOMAIN;
  const actorUrl = `https://${domain}/users/${actor.username}`;
  const activityId = `${actorUrl}/rejects/${Date.now()}`;

  return {
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: activityId,
    type: 'Reject',
    actor: actorUrl,
    object: followActivity,
  };
}

/**
 * Create a Like activity (for reactions).
 *
 * @param recipientUrls - ActivityPub actor URLs to address the activity to.
 *   For post reactions pass the post author URL; for DM reactions pass all
 *   remote conversation participants. Omit for backwards-compat (no `to`).
 */
export function createLikeActivity(
  user: any, 
  objectUrl: string, 
  emojiContent?: string,
  emojiData?: { name: string; url: string },
  recipientUrls?: string[],
): any {
  const domain = config.INSTANCE_DOMAIN;
  const userUrl = `https://${domain}/users/${user.username}`;
  const activityId = `${userUrl}/likes/${Date.now()}`;

  const rawReaction = emojiContent || '❤';

  // Misskey's isCustomEmojiRegexp /^:([\w+-]+)(?:@\.)?:$/ only matches
  // `:name:` or `:name@.:` - NOT `:name@domain:`.  Sending the qualified
  // form causes Misskey to fall back to a generic ❤.  Strip @domain here;
  // Misskey infers the origin domain from the actor's host and the tag data
  // provides the icon URL.
  const reactionValue = emojiData
    ? rawReaction.replace(/@[\w.-]+(?=:$)/, '')
    : rawReaction;

  const activity: any = {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      {
        'toot': 'http://joinmastodon.org/ns#',
        'Emoji': 'toot:Emoji',
        'misskey': 'https://misskey-hub.net/ns#',
        '_misskey_reaction': 'misskey:_misskey_reaction',
      }
    ],
    id: activityId,
    type: 'Like',
    actor: userUrl,
    object: objectUrl,
    content: reactionValue,
    _misskey_reaction: reactionValue,
  };

  if (recipientUrls && recipientUrls.length > 0) {
    activity.to = recipientUrls;
  }

  if (emojiData?.url) {
    const ext = emojiData.url.split('.').pop()?.toLowerCase().split('?')[0] || '';
    const mediaType = ext === 'gif' ? 'image/gif'
      : ext === 'webp' ? 'image/webp'
      : ext === 'svg' ? 'image/svg+xml'
      : 'image/png';
    // Tag name uses base shortcode `:name:` (without @domain).
    // Misskey matches by stripping @domain from _misskey_reaction.
    const tagName = `:${emojiData.name}:`;
    activity.tag = [{
      type: 'Emoji',
      id: emojiData.url,
      name: tagName,
      icon: {
        type: 'Image',
        mediaType,
        url: emojiData.url,
      }
    }];
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
/**
 * Full HTML attribute / text escape. Covers the five characters that
 * have special meaning in HTML (`& < > " '`). Anything we splice into
 * outbound ActivityPub `content` HTML - including mention `href`,
 * displayed labels, hashtag names, and URL anchors - runs through this.
 */
function escapeHtmlAttr(str: string): string {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Safe-scheme URL allowlist for outbound federation. Same list as the
 * frontend `sanitizeUrl` in `src/utils/sanitize.ts`. `javascript:`,
 * `data:`, `vbscript:`, etc. all reject.
 */
const SAFE_URL_SCHEMES_OUTBOUND = new Set(['http:', 'https:', 'mailto:', 'tel:']);

function safeAttrUrlOutbound(url: string | null | undefined): string {
  if (url == null) return '';
  // eslint-disable-next-line no-control-regex
  const cleaned = String(url).replace(/[\x00-\x1F\x7F]/g, '').trim();
  if (!cleaned) return '';
  const schemeMatch = /^([a-z][a-z0-9+.-]*):/i.exec(cleaned);
  if (!schemeMatch) return cleaned;
  const scheme = schemeMatch[1].toLowerCase() + ':';
  if (!SAFE_URL_SCHEMES_OUTBOUND.has(scheme)) return '';
  return cleaned;
}

function extractContentAsHtml(content: any): string {
  // Defensive: the DB constraint `posts_content_is_array` /
  // `messages_content_is_array` makes this path unreachable, but if a
  // raw string ever slipped through (an early migration, an unconverted
  // federation import, ...) we'd be shipping it straight to Mastodon /
  // Misskey / etc. as our outbound HTML. Receiving servers run their
  // own sanitizers but we shouldn't rely on theirs - escape so user
  // content can never go out as live HTML markup.
  if (typeof content === 'string') {
    return escapeHtmlAttr(content);
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
        // `username` / `domain` originate in a (possibly federated)
        // MessagePart, so escape both before splicing them into the URL
        // and the visible label. Receiving servers do further sanitisation,
        // but we shouldn't emit broken HTML in the first place.
        const domain = item.domain || config.INSTANCE_DOMAIN;
        const username = item.username || 'unknown';
        const href = safeAttrUrlOutbound(`https://${domain}/users/${username}`);
        const displayName = item.isLocal ? `@${username}` : `@${username}@${domain}`;
        return `<a href="${escapeHtmlAttr(href)}" class="mention">${escapeHtmlAttr(displayName)}</a>`;
      }
      else if (item.type === 'hashtag') {
        const name = item.name || '';
        const href = safeAttrUrlOutbound(`https://${config.INSTANCE_DOMAIN}/tags/${name}`);
        return `<a href="${escapeHtmlAttr(href)}" class="mention hashtag" rel="tag">#${escapeHtmlAttr(name)}</a>`;
      }
      else if (item.type === 'emoji') {
        // Custom emoji - use :name: syntax, actual emoji data in tags.
        // The name is plain text here (no HTML context), but receiving
        // parsers might still treat it as inline content, so escape.
        return escapeHtmlAttr(`:${item.emoji?.name || 'emoji'}:`);
      }
      else if (item.type === 'url') {
        // Scheme-validate first; only http(s)/mailto/tel get a live
        // anchor. Anything else (`javascript:`, `data:`, ...) renders as
        // escaped text so a malicious payload can't propagate through
        // federation as a clickable XSS link.
        const safeUrl = safeAttrUrlOutbound(item.url || '');
        if (!safeUrl) {
          return escapeHtmlAttr(item.url || '');
        }
        return `<a href="${escapeHtmlAttr(safeUrl)}" rel="noopener noreferrer" target="_blank">${escapeHtmlAttr(safeUrl)}</a>`;
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
    .map((item) => {
      const mediaType = getMediaType(item.fileType, item.mimeType, item.url);
      
      const attachment: any = {
        type: 'Document',
        mediaType,
        url: item.url,
        name: item.altText || item.description || item.name || null, // Alt text for accessibility
      };

      // Add dimensions if available (important for image layout)
      if (item.width) attachment.width = item.width;
      if (item.height) attachment.height = item.height;
      
      if (item.blurhash) attachment.blurhash = item.blurhash;
      
      if (item.focalPoint) attachment.focalPoint = item.focalPoint;
      
      return attachment;
    });
}

/**
 * Helper: Get proper MIME type from fileType or URL
 */
function getMediaType(fileType?: string, mimeType?: string, url?: string): string {
  // If we already have a proper MIME type, use it
  if (mimeType && mimeType.includes('/')) {
    return mimeType;
  }
  
  // If fileType is already a MIME type, use it
  if (fileType && fileType.includes('/')) {
    return fileType;
  }
  
  // Try to infer from URL extension
  if (url) {
    const extension = url.split('.').pop()?.toLowerCase().split('?')[0];
    const extensionMap: Record<string, string> = {
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'png': 'image/png',
      'gif': 'image/gif',
      'webp': 'image/webp',
      'svg': 'image/svg+xml',
      'mp4': 'video/mp4',
      'webm': 'video/webm',
      'mov': 'video/quicktime',
      'mp3': 'audio/mpeg',
      'ogg': 'audio/ogg',
      'wav': 'audio/wav',
      'pdf': 'application/pdf',
    };
    if (extension && extensionMap[extension]) {
      return extensionMap[extension];
    }
  }
  
  // Fallback based on simple fileType
  if (fileType) {
    const typeMap: Record<string, string> = {
      'image': 'image/jpeg', // Default image type
      'video': 'video/mp4',  // Default video type
      'audio': 'audio/mpeg', // Default audio type
    };
    if (typeMap[fileType]) {
      return typeMap[fileType];
    }
  }
  
  return 'application/octet-stream';
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
    case 'direct':
    case 'private':
      return [];
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
    case 'followers':
    case 'direct':
    case 'private':
      return [];
    default:
      return [];
  }
}

