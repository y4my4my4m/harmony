import { config } from '../../config/index.js';
import { decodeHtmlEntities } from '../../utils/contentUtils.js';

/**
 * Convert ActivityPub Note to internal MessagePart[] format
 * Uses the same logic as the SQL convert_ap_to_jsonb function
 */
export function noteToContent(note: any): any[] {
  const parts: any[] = [];
  
  if (!note.content) {
    return [{ type: 'text', text: '' }];
  }
  
  // Step 1: Clean HTML to get plain text
  let cleanText = note.content;
  cleanText = cleanText.replace(/<br\s*\/?>/gi, '\n');
  // Block-level closing tags: <p>, <blockquote>, <h1>-<h6> imply paragraph breaks (double newline)
  cleanText = cleanText.replace(/<\/(?:p|blockquote|h[1-6])>/gi, '\n\n');
  // <div>, <li> closing tags imply simple line breaks
  cleanText = cleanText.replace(/<\/(?:div|li)>/gi, '\n');
  // Remove opening block-level tags (the closing tag already handles the break)
  cleanText = cleanText.replace(/<(?:p|div|li|blockquote|h[1-6])(?:\s[^>]*)?>/gi, '');
  // Remove inline tags WITHOUT adding spaces so @<span>user</span> → @user (not "@ user")
  cleanText = cleanText.replace(/<\/?(?:span|a|strong|b|em|i|u|s|del|code|sub|sup|mark|small|big|abbr)[^>]*>/gi, '');
  cleanText = cleanText.replace(/<[^>]*>/g, ' ');
  cleanText = cleanText.replace(/[ \t]+/g, ' ');
  cleanText = cleanText.replace(/&nbsp;/g, ' ');
  cleanText = cleanText.replace(/&amp;/g, '&');
  cleanText = cleanText.replace(/&lt;/g, '<');
  cleanText = cleanText.replace(/&gt;/g, '>');
  cleanText = cleanText.replace(/&quot;/g, '"');
  cleanText = cleanText.replace(/&apos;/g, "'");
  cleanText = cleanText.replace(/&#x([\da-fA-F]+);/g, (match, hex) => {
    const cp = parseInt(hex, 16);
    return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  cleanText = cleanText.replace(/&#(\d+);/g, (match, n) => {
    const cp = parseInt(n, 10);
    return cp >= 0 && cp <= 0x10FFFF ? String.fromCodePoint(cp) : match;
  });
  // Collapse horizontal whitespace but preserve newlines from <br>/<p> replacements
  cleanText = cleanText.replace(/[^\S\n]+/g, ' ');
  cleanText = cleanText.replace(/\n{3,}/g, '\n\n');
  cleanText = cleanText.trim();
  
  // Build combined tags array (includes both standard AP tags and Misskey-style emojis)
  let allTags = note.tag && Array.isArray(note.tag) ? [...note.tag] : [];
  
  // Handle Misskey-style emojis object: { emojiName: url, ... }
  // This is common in outbox items where emoji definitions aren't in the tag array
  if (note.emojis && typeof note.emojis === 'object' && !Array.isArray(note.emojis)) {
    for (const [name, url] of Object.entries(note.emojis)) {
      // Only add if not already in tags
      const alreadyInTags = allTags.some(t => 
        t.type === 'Emoji' && t.name?.replace(/:/g, '') === name
      );
      if (!alreadyInTags && url) {
        allTags.push({
          type: 'Emoji',
          name: `:${name}:`,
          icon: { url }
        });
      }
    }
  }
  
  // If no tags, parse URLs from the text and return
  if (allTags.length === 0) {
    if (cleanText) {
      splitTextWithUrls(parts, cleanText);
    }
    
    // Still check for attachments
    addAttachments(parts, note.attachment);
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }
  
  // Step 2: Find positions of all tags in the clean text
  const tagPositions: Array<{position: number, length: number, tag: any, text: string}> = [];
  
  for (const tag of allTags) {
    let searchText = '';
    let position = -1;
    
    if (tag.type === 'Emoji') {
      // Find :emojiname: in text
      let emojiName = tag.name || '';
      if (emojiName.startsWith(':')) emojiName = emojiName.slice(1);
      if (emojiName.endsWith(':')) emojiName = emojiName.slice(0, -1);
      searchText = `:${emojiName}:`;
      position = cleanText.indexOf(searchText);
    }
    else if (tag.type === 'Mention') {
      // Try different mention formats
      let username = tag.name || '';
      if (username.startsWith('@')) username = username.slice(1);
      
      // Try @username@domain first
      searchText = `@${username}`;
      position = cleanText.indexOf(searchText);
      
      // If not found, try just username
      if (position === -1) {
        searchText = username.split('@')[0];
        position = cleanText.indexOf(searchText);
      }
    }
    else if (tag.type === 'Hashtag') {
      const hashtagName = tag.name?.startsWith('#') ? tag.name : `#${tag.name}`;
      searchText = hashtagName;
      position = cleanText.indexOf(searchText);
    }
    
    if (position >= 0) {
      tagPositions.push({ position, length: searchText.length, tag, text: searchText });
    }
  }
  
  // Step 3: Sort tags by position
  tagPositions.sort((a, b) => a.position - b.position);
  
  // Step 4: Build MessageParts in order
  let currentIndex = 0;
  
  for (const tagPos of tagPositions) {
    // Add text before this tag (with URL detection)
    if (tagPos.position > currentIndex) {
      const textBefore = cleanText.substring(currentIndex, tagPos.position);
      if (textBefore.trim()) {
        splitTextWithUrls(parts, textBefore);
      }
    }
    
    // Add the tag as a MessagePart
    if (tagPos.tag.type === 'Emoji') {
      let emojiName = tagPos.tag.name || '';
      if (emojiName.startsWith(':')) emojiName = emojiName.slice(1);
      if (emojiName.endsWith(':')) emojiName = emojiName.slice(0, -1);
      
      parts.push({
        type: 'emoji',
        emoji: {
          id: tagPos.tag.id || `remote-${emojiName}`,
          name: emojiName,
          url: tagPos.tag.icon?.url || tagPos.tag.icon,
          server_id: 'remote'
        }
      });
    }
    else if (tagPos.tag.type === 'Mention') {
      let username = tagPos.tag.name || '';
      if (username.startsWith('@')) username = username.slice(1);
      
      const usernameParts = username.split('@');
      let actualUsername = usernameParts[0];
      let domain = usernameParts[1] || null;
      const currentDomain = config.INSTANCE_DOMAIN;

      // Mastodon/Pleroma often send name as "@username" without domain; extract from href
      const href = tagPos.tag.href;
      if (href && typeof href === 'string') {
        try {
          const url = new URL(href);
          const hrefDomain = url.hostname;
          const hrefPath = url.pathname || '';
          // Mastodon/Pleroma: /users/username
          const usersMatch = hrefPath.match(/\/users\/([^/]+)\/?$/);
          // GoToSocial/Misskey: /@username
          const atMatch = !usersMatch && hrefPath.match(/^\/@([^/]+)\/?$/);
          if (usersMatch) {
            actualUsername = usersMatch[1];
            if (!domain) domain = hrefDomain;
          } else if (atMatch) {
            actualUsername = atMatch[1];
            if (!domain) domain = hrefDomain;
          }
        } catch { /* href not a valid URL */ }
      }
      
      const isLocal = !domain || domain === currentDomain;
      // Ensure username never has leading @ (prevents @@ in display)
      const cleanUsername = actualUsername.replace(/^@+/, '');
      
      parts.push({
        type: 'mention',
        username: cleanUsername,
        domain: domain || currentDomain,
        isLocal,
        userId: href || `remote-${cleanUsername}`,
        displayName: cleanUsername
      });
    }
    else if (tagPos.tag.type === 'Hashtag') {
      let tagName = tagPos.tag.name || '';
      if (tagName.startsWith('#')) tagName = tagName.slice(1);
      
      parts.push({
        type: 'hashtag',
        name: tagName
      });
    }
    
    currentIndex = tagPos.position + tagPos.length;
  }
  
  // Add remaining text after all tags (with URL detection)
  if (currentIndex < cleanText.length) {
    const remaining = cleanText.substring(currentIndex);
    if (remaining.trim()) {
      splitTextWithUrls(parts, remaining);
    }
  }
  
  // Handle media attachments
  addAttachments(parts, note.attachment);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/**
 * Helper: Split text on URLs, emitting alternating text and url parts.
 * Bare https?:// URLs found in the cleaned plain-text become clickable
 * `{ type: 'url', url, preview: true }` parts.
 */
function splitTextWithUrls(parts: any[], text: string): void {
  const urlRegex = /\bhttps?:\/\/\S+/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = urlRegex.exec(text)) !== null) {
    if (match.index > lastIndex) {
      const before = text.substring(lastIndex, match.index);
      if (before.trim()) parts.push({ type: 'text', text: before });
    }

    let url = match[0];
    url = url.replace(/[.,;:!?)>\]]+$/, '');

    parts.push({ type: 'url', url, preview: true });
    lastIndex = match.index + match[0].length;
  }

  if (lastIndex < text.length) {
    const remaining = text.substring(lastIndex);
    if (remaining.trim()) parts.push({ type: 'text', text: remaining });
  }
}

/**
 * Helper: Add media attachments to parts array
 */
function addAttachments(parts: any[], attachments: any): void {
  if (attachments && Array.isArray(attachments)) {
    attachments.forEach((attachment: any) => {
      const mediaType = attachment.mediaType || '';
      const url = attachment.url || '';
      let fileType = 'file';
      
      // Check MIME type first
      if (mediaType.startsWith('image/')) fileType = 'image';
      else if (mediaType.startsWith('video/')) fileType = 'video';
      else if (mediaType.startsWith('audio/')) fileType = 'audio';
      // Fallback to URL extension if MIME type not provided
      else if (url) {
        const ext = url.split('?')[0].split('.').pop()?.toLowerCase();
        if (['jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp'].includes(ext || '')) {
          fileType = 'image';
        } else if (['mp4', 'webm', 'mov', 'avi', 'mkv', 'm4v', 'ogv', 'quicktime'].includes(ext || '')) {
          fileType = 'video';
        } else if (['mp3', 'wav', 'ogg', 'flac', 'm4a', 'aac', 'opus'].includes(ext || '')) {
          fileType = 'audio';
        }
      }
      
      const filePart: any = {
        type: 'file',
        url: attachment.url,
        fileType: fileType,
        mimeType: mediaType, // Store the full MIME type
        fileName: attachment.name,
        altText: attachment.name, // Alt text for accessibility
      };
      
      // Store dimensions if available
      if (attachment.width) filePart.width = attachment.width;
      if (attachment.height) filePart.height = attachment.height;
      
      // Store blurhash if available (for placeholder images)
      if (attachment.blurhash) filePart.blurhash = attachment.blurhash;
      
      // Store focal point if available (for image cropping)
      if (attachment.focalPoint) filePart.focalPoint = attachment.focalPoint;
      
      parts.push(filePart);
    });
  }
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
  color?: string;
  custom_status?: any;
  public_key?: string;
  federated_id: string;
  inbox_url: string;
  outbox_url?: string;
  followers_url?: string;
  following_url?: string;
  bio_emojis?: Array<{ name: string; url: string }>;
  display_name_emojis?: Array<{ name: string; url: string }>;
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
    let bio = actor.summary;
    bio = bio.replace(/<br\s*\/?>/gi, '\n');
    bio = bio.replace(/<\/p>\s*<p>/gi, '\n\n');
    bio = bio.replace(/<[^>]*>/g, ' ');
    bio = bio.replace(/[ \t]+/g, ' ');
    bio = decodeHtmlEntities(bio);
    profile.bio = bio.trim();
  }

  if (typeof actor.icon === 'string') {
    profile.avatar = actor.icon;
  } else if (actor.icon?.url) {
    profile.avatar = actor.icon.url;
  }

  if (typeof actor.image === 'string') {
    profile.banner = actor.image;
  } else if (actor.image?.url) {
    profile.banner = actor.image.url;
  }

  // Harmony extension: profile color
  if (actor['harmony:profileColor']) {
    profile.color = actor['harmony:profileColor'];
  }

  // Harmony extension: custom status (Discord-style status)
  if (actor['harmony:customStatus']) {
    profile.custom_status = actor['harmony:customStatus'];
  }

  if (actor.publicKey?.publicKeyPem) {
    profile.public_key = actor.publicKey.publicKeyPem;
  }

  // Extract profile fields (PropertyValue attachments)
  if (actor.attachment && Array.isArray(actor.attachment)) {
    const profileFields = actor.attachment
      .filter((att: any) => att.type === 'PropertyValue')
      .map((att: any) => ({
        name: att.name || '',
        value: att.value || '',
      }));
    
    if (profileFields.length > 0) {
      profile.profile_fields = profileFields;
    }
  }

  // Extract discoverable flag
  if (actor.discoverable !== undefined) {
    profile.federation_discoverable = actor.discoverable;
  }

  // Extract manually approves followers flag
  if (actor.manuallyApprovesFollowers !== undefined) {
    profile.manually_approves_followers = actor.manuallyApprovesFollowers;
  }

  // Extract custom emojis from actor tags and split into display_name vs bio
  const allEmojis: Array<{ name: string; url: string }> = [];

  if (actor.tag && Array.isArray(actor.tag)) {
    actor.tag
      .filter((tag: any) => tag.type === 'Emoji')
      .forEach((tag: any) => {
        const name = tag.name?.replace(/:/g, '') || '';
        const url = tag.icon?.url || tag.icon;
        if (name && url) allEmojis.push({ name, url });
      });
  }

  // Also handle Misskey-style emojis object on the actor
  if (actor.emojis && typeof actor.emojis === 'object' && !Array.isArray(actor.emojis)) {
    for (const [name, url] of Object.entries(actor.emojis)) {
      if (name && url && !allEmojis.some(e => e.name === name)) {
        allEmojis.push({ name, url: url as string });
      }
    }
  }

  if (allEmojis.length > 0) {
    const displayName = actor.name || '';
    const bioText = actor.summary || '';
    const displayNameEmojis: typeof allEmojis = [];
    const bioEmojis: typeof allEmojis = [];

    for (const emoji of allEmojis) {
      const shortcode = `:${emoji.name}:`;
      const inDisplayName = displayName.includes(shortcode);
      const inBio = bioText.includes(shortcode) || bioText.includes(emoji.name);

      if (inDisplayName) displayNameEmojis.push(emoji);
      if (inBio) bioEmojis.push(emoji);
      // If not found in either, still put in bio_emojis as fallback
      if (!inDisplayName && !inBio) bioEmojis.push(emoji);
    }

    if (bioEmojis.length > 0) {
      profile.bio_emojis = bioEmojis;
    }
    if (displayNameEmojis.length > 0) {
      profile.display_name_emojis = displayNameEmojis;
    }
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
  emojiUrl?: string;
  emojiName?: string;
} {
  const data: any = {
    actorUrl: typeof activity.actor === 'string' ? activity.actor : activity.actor.id,
    objectUrl: typeof activity.object === 'string' ? activity.object : activity.object.id,
  };

  // Misskey-style reaction
  if (activity._misskey_reaction || activity.content) {
    data.emoji = activity._misskey_reaction || activity.content;
    data.emojiName = data.emoji;
  }
  
  // Extract emoji URL from tag (for custom emojis)
  if (Array.isArray(activity.tag)) {
    const emojiTag = activity.tag.find((t: any) => t.type === 'Emoji');
    if (emojiTag) {
      data.emojiUrl = emojiTag.icon?.url;
      data.emojiName = emojiTag.name || data.emoji;
    }
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

