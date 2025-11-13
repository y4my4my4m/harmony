/**
 * Convert ActivityPub Note to internal MessagePart[] format
 * Parses HTML content and ActivityPub tags to create structured content
 */
export function noteToContent(note: any): any[] {
  const parts: any[] = [];
  
  if (!note.content) {
    return [{ type: 'text', text: '' }];
  }
  
  // Build maps from ActivityPub tags
  const mentionMap = new Map<string, any>();
  const hashtagMap = new Map<string, any>();
  const emojiMap = new Map<string, any>();
  
  if (note.tag && Array.isArray(note.tag)) {
    note.tag.forEach((tag: any) => {
      if (tag.type === 'Mention') {
        mentionMap.set(tag.name, tag);
      } else if (tag.type === 'Hashtag') {
        hashtagMap.set(tag.name || `#${tag.href.split('/').pop()}`, tag);
      } else if (tag.type === 'Emoji') {
        // Misskey/Mastodon custom emojis
        emojiMap.set(tag.name || tag.id, tag);
      }
    });
  }
  
  const html = note.content;
  
  // Parse HTML and extract structured parts
  const mentionRegex = /<a[^>]*class="[^"]*mention[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>/g;
  const hashtagRegex = /<a[^>]*class="[^"]*hashtag[^"]*"[^>]*href="([^"]+)"[^>]*>#?([^<]+)<\/a>/g;
  const emojiRegex = /:([a-zA-Z0-9_+-]+):/g;
  
  let processedHtml = html;
  const replacements: Array<{start: number, end: number, part: any}> = [];
  
  // Find all mentions
  let match;
  while ((match = mentionRegex.exec(html)) !== null) {
    const mentionText = match[2];
    const href = match[1];
    const mentionMatch = mentionText.match(/^@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?$/);
    
    if (mentionMatch) {
      replacements.push({
        start: match.index,
        end: match.index + match[0].length,
        part: {
          type: 'mention',
          username: mentionMatch[1],
          domain: mentionMatch[2] || 'har.mony.lol',
          isLocal: !mentionMatch[2],
          userId: href,
          displayName: mentionMatch[1]
        }
      });
    }
  }
  
  // Find all hashtags
  hashtagRegex.lastIndex = 0;
  while ((match = hashtagRegex.exec(html)) !== null) {
    replacements.push({
      start: match.index,
      end: match.index + match[0].length,
      part: {
        type: 'hashtag',
        name: match[2]
      }
    });
  }
  
  // Sort replacements by position
  replacements.sort((a, b) => a.start - b.start);
  
  // Build parts array
  let lastIndex = 0;
  replacements.forEach(replacement => {
    // Add text before this replacement
    if (replacement.start > lastIndex) {
      const textBefore = html.substring(lastIndex, replacement.start).replace(/<[^>]*>/g, '').trim();
      if (textBefore) {
        parts.push({ type: 'text', text: textBefore });
      }
    }
    
    // Add the replacement part
    parts.push(replacement.part);
    lastIndex = replacement.end;
  });
  
  // Add remaining text
  if (lastIndex < html.length) {
    const remaining = html.substring(lastIndex).replace(/<[^>]*>/g, '').trim();
    if (remaining) {
      // Check for custom emojis in remaining text
      const textParts = parseCustomEmojis(remaining, emojiMap);
      parts.push(...textParts);
    }
  }
  
  // Handle media attachments
  if (note.attachment && Array.isArray(note.attachment)) {
    note.attachment.forEach((attachment: any) => {
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
  
  return parts.length > 0 ? parts : [{ type: 'text', text: '' }];
}

/**
 * Parse custom emojis from text (Misskey format :emojiname:)
 */
function parseCustomEmojis(text: string, emojiMap: Map<string, any>): any[] {
  const parts: any[] = [];
  const emojiRegex = /:([a-zA-Z0-9_+-]+):/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = emojiRegex.exec(text)) !== null) {
    // Add text before emoji
    if (match.index > lastIndex) {
      parts.push({ type: 'text', text: text.substring(lastIndex, match.index) });
    }
    
    // Check if this is a custom emoji from tags
    const emojiName = match[1];
    const emojiTag = emojiMap.get(emojiName) || emojiMap.get(`:${emojiName}:`);
    
    if (emojiTag && emojiTag.icon) {
      parts.push({
        type: 'emoji',
        emoji: {
          id: emojiTag.id,
          name: emojiName,
          url: emojiTag.icon.url,
          server_id: 'remote'
        }
      });
    } else {
      // Not a custom emoji, keep as text
      parts.push({ type: 'text', text: match[0] });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ type: 'text', text: text.substring(lastIndex) });
  }
  
  return parts.length > 0 ? parts : [{ type: 'text', text }];
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

