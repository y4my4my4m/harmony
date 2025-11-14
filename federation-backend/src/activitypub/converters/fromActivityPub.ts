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
  cleanText = cleanText.replace(/<[^>]*>/g, ''); // Remove all HTML tags
  cleanText = cleanText.replace(/&nbsp;/g, ' ');
  cleanText = cleanText.replace(/&amp;/g, '&');
  cleanText = cleanText.replace(/&lt;/g, '<');
  cleanText = cleanText.replace(/&gt;/g, '>');
  cleanText = cleanText.replace(/&quot;/g, '"');
  cleanText = cleanText.replace(/&#039;/g, "'");
  cleanText = cleanText.replace(/\s+/g, ' ').trim();
  
  // If no tags, just return the text
  if (!note.tag || !Array.isArray(note.tag) || note.tag.length === 0) {
    if (cleanText) {
      parts.push({ type: 'text', text: cleanText });
    }
    
    // Still check for attachments
    addAttachments(parts, note.attachment);
    return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
  }
  
  // Step 2: Find positions of all tags in the clean text
  const tagPositions: Array<{position: number, length: number, tag: any, text: string}> = [];
  
  for (const tag of note.tag) {
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
    // Add text before this tag
    if (tagPos.position > currentIndex) {
      const textBefore = cleanText.substring(currentIndex, tagPos.position).trim();
      if (textBefore) {
        parts.push({ type: 'text', text: textBefore });
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
      const actualUsername = usernameParts[0];
      const domain = usernameParts[1] || null;
      const currentDomain = 'har.mony.lol';
      
      parts.push({
        type: 'mention',
        username: actualUsername,
        domain: domain || currentDomain,
        isLocal: !domain || domain === currentDomain,
        userId: tagPos.tag.href || `remote-${username}`,
        displayName: actualUsername
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
  
  // Add remaining text after all tags
  if (currentIndex < cleanText.length) {
    const remaining = cleanText.substring(currentIndex).trim();
    if (remaining) {
      parts.push({ type: 'text', text: remaining });
    }
  }
  
  // Handle media attachments
  addAttachments(parts, note.attachment);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/**
 * Helper: Add media attachments to parts array
 */
function addAttachments(parts: any[], attachments: any): void {
  if (attachments && Array.isArray(attachments)) {
    attachments.forEach((attachment: any) => {
      const mediaType = attachment.mediaType || '';
      let fileType = 'file';
      
      if (mediaType.startsWith('image/')) fileType = 'image';
      else if (mediaType.startsWith('video/')) fileType = 'video';
      else if (mediaType.startsWith('audio/')) fileType = 'audio';
      
      parts.push({
        type: 'file',
        url: attachment.url,
        fileType: fileType,
        fileName: attachment.name
      });
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

