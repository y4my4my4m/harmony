/**
 * Unified content processing system for ALL text content in Harmony
 * Used by: chat messages, DMs, ActivityPub posts, and federation
 * 
 * This replaces the fragmented approach and uses the existing MessagePart types
 * for consistency across the entire application.
 */

import type { MessagePart } from '@/types';
import { getEmoji } from '@/services/emojiService';
import { supabase } from '@/supabase';

// Support both UUID-based emojis (legacy) and shortcode emojis (new)
const emojiUuidRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/g;
const emojiShortcodeRegex = /:([a-zA-Z0-9_+-]+):/g;

/**
 * Helper function to efficiently resolve mention user data in batch
 * This should be called before parseContentToMessageParts for optimal performance
 */
export async function resolveMentionsUserData(content: string): Promise<Record<string, { userId: string; isLocal: boolean; displayName?: string }>> {
  const mentionRegex = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
  const userDataMap: Record<string, { userId: string; isLocal: boolean; displayName?: string }> = {};
  
  let match;
  const uniqueUsernames = new Set<string>();
  
  // Extract all unique usernames from content
  while ((match = mentionRegex.exec(content)) !== null) {
    const username = match[1];
    const domain = match[2];
    const mentionKey = domain ? `${username}@${domain}` : username;
    uniqueUsernames.add(mentionKey);
  }
  
  // If no mentions, return empty map
  if (uniqueUsernames.size === 0) return userDataMap;
  
  try {
    // Build a single query to get all mentioned users at once
    const usernameList = Array.from(uniqueUsernames);
    const localUsernames = usernameList.filter(u => !u.includes('@'));
    const remoteUsernames = usernameList.filter(u => u.includes('@'));
    
    // Query for local users
    if (localUsernames.length > 0) {
      const { data: localUsers } = await supabase
        .from('profiles')
        .select('id, username, display_name, is_local')
        .in('username', localUsernames);
      
      if (localUsers) {
        localUsers.forEach(user => {
          userDataMap[user.username] = {
            userId: user.id,
            isLocal: user.is_local,
            displayName: user.display_name || user.username
          };
        });
      }
    }
    
    // Query for remote users (username@domain format)
    if (remoteUsernames.length > 0) {
      // For remote users, we need to query each username@domain pair individually
      // since PostgREST doesn't handle complex AND conditions well in OR clauses
      const remoteUserPromises = remoteUsernames.map(async (usernameDomain) => {
        try {
          const [username, domain] = usernameDomain.split('@');
          const { data, error } = await supabase
            .from('profiles')
            .select('id, username, domain, display_name, is_local')
            .eq('username', username)
            .eq('domain', domain)
            .single();
          
          if (error && error.code !== 'PGRST116') { // PGRST116 is "not found", which is ok
            console.warn(`Error fetching remote user ${usernameDomain}:`, error);
          }
          
          return data;
        } catch (error) {
          console.warn(`Error querying remote user ${usernameDomain}:`, error);
          return null;
        }
      });
      
      const remoteUsers = (await Promise.all(remoteUserPromises)).filter(Boolean);
      
      if (remoteUsers) {
        remoteUsers.forEach(user => {
          if (user) {
            const key = `${user.username}@${user.domain}`;
            userDataMap[key] = {
              userId: user.id,
              isLocal: user.is_local,
              displayName: user.display_name || user.username
            };
          }
        });
      }
    }
  } catch (error) {
    console.warn('Error resolving mention user data:', error);
  }
  
  return userDataMap;
}

/**
 * Helper function to efficiently resolve emoji data in batch
 * Supports both UUID-based emojis and shortcode emojis
 */
export async function resolveEmojisData(content: string): Promise<Record<string, any>> {
  const emojiDataMap: Record<string, any> = {};
  
  let match;
  const uniqueEmojiIds = new Set<string>();
  const uniqueEmojiNames = new Set<string>();
  
  // Extract UUID-based emojis (legacy format)
  emojiUuidRegex.lastIndex = 0;
  while ((match = emojiUuidRegex.exec(content)) !== null) {
    const emojiId = match[1];
    if (emojiId) {
      uniqueEmojiIds.add(emojiId);
    }
  }
  
  // Extract shortcode emojis (current format)
  emojiShortcodeRegex.lastIndex = 0;
  while ((match = emojiShortcodeRegex.exec(content)) !== null) {
    const emojiName = match[1];
    if (emojiName) {
      uniqueEmojiNames.add(emojiName);
    }
  }
  
  // If no emojis, return empty map
  if (uniqueEmojiIds.size === 0 && uniqueEmojiNames.size === 0) return emojiDataMap;
  
  try {
    // Query emojis by ID (UUID-based)
    if (uniqueEmojiIds.size > 0) {
      const { data: emojisByIds } = await supabase
        .from('emojis')
        .select('*')
        .in('id', Array.from(uniqueEmojiIds));
      
      if (emojisByIds) {
        emojisByIds.forEach(emoji => {
          emojiDataMap[emoji.id] = emoji;
        });
      }
    }
    
    // Query emojis by name (shortcode-based)
    if (uniqueEmojiNames.size > 0) {
      const { data: emojisByNames } = await supabase
        .from('emojis')
        .select('*')
        .in('name', Array.from(uniqueEmojiNames));
      
      if (emojisByNames) {
        emojisByNames.forEach(emoji => {
          emojiDataMap[emoji.name] = emoji;
        });
      }
    }
  } catch (error) {
    console.warn('Error resolving emoji data:', error);
  }
  
  return emojiDataMap;
}

/**
 * Helper function to efficiently resolve hashtag data in batch
 * This should be called before parseContentToMessageParts for optimal performance
 */
export async function resolveHashtagsData(content: string): Promise<Record<string, { id: string; count: number; last_updated: string; normalized: string }>> {
  const hashtagRegex = /#([a-zA-Z0-9_-]+)/g;
  const hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {};
  
  let match;
  const uniqueHashtags = new Set<string>();
  
  // Extract all unique hashtags from content
  while ((match = hashtagRegex.exec(content)) !== null) {
    const hashtag = match[1].toLowerCase(); // normalize to lowercase
    uniqueHashtags.add(hashtag);
  }
  
  if (uniqueHashtags.size === 0) {
    return hashtagDataMap;
  }
  
  // Batch query for all hashtags
  const { data, error } = await supabase
    .from('hashtags')
    .select('id, tag, normalized_tag, total_uses, last_used_at')
    .in('normalized_tag', Array.from(uniqueHashtags));
    
  if (error) {
    console.warn('Error fetching hashtag data:', error);
    return hashtagDataMap;
  }
  
  // Map results by normalized name for quick lookup
  data?.forEach(hashtag => {
    hashtagDataMap[hashtag.normalized_tag] = {
      id: hashtag.id,
      count: hashtag.total_uses || 0,
      last_updated: hashtag.last_used_at || new Date().toISOString(),
      normalized: hashtag.normalized_tag
    };
  });
  
  return hashtagDataMap;
}

/**
 * Parse content string into unified MessagePart format
 * This is the SINGLE source of truth for all content parsing
 * Used by: chat, DMs, ActivityPub posts, and any text input
 */
export async function parseContentToMessageParts(
  content: string,
  usernameToUserDataMap: Record<string, { userId: string; isLocal: boolean; displayName?: string }> = {},
  emojiDataMap: Record<string, any> = {},
  hashtagDataMap: Record<string, { id: string; count: number; last_updated: string; normalized: string }> = {}
): Promise<MessagePart[]> {
  if (!content) return [{ type: 'text', text: '' }];

  // Parse mentions, hashtags, URLs, and emojis in order of appearance
  // Combined regex to match mentions, hashtags in one pass
  const combinedRegex = /(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)|#([a-zA-Z0-9_-]+)/g;
  const parts: MessagePart[] = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = combinedRegex.exec(content)) !== null) {
    // Add text before current match (if any)
    if (match.index > lastIndex) {
      const textBefore = content.substring(lastIndex, match.index);
      parts.push(...await parseTextForUrls(textBefore, emojiDataMap));
    }
    
    if (match[1]) {
      // This is a mention (@username or @username@domain)
      const username = match[2];
      const domain = match[3];
      
      // Look up user data from provided map (efficient batch lookup)
      const mentionKey = domain ? `${username}@${domain}` : username;
      const userData = usernameToUserDataMap[mentionKey] || usernameToUserDataMap[username];
      
      // Fall back to domain-based logic if user data not available
      const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
      const isLocal = userData?.isLocal ?? (!domain || domain === currentDomain);
      const userId = userData?.userId ?? `unresolved-${username}${domain ? '@' + domain : ''}`;
      const displayName = userData?.displayName ?? username;
      
      // Always include domain for federation - use current domain for local users
      const finalDomain = domain || currentDomain;
      
      parts.push({
        type: 'mention',
        userId: userId,
        username: username,
        domain: finalDomain,
        isLocal: isLocal,
        displayName: displayName
      });
    } else if (match[4]) {
      // This is a hashtag (#tagname)
      const hashtagName = match[4];
      const normalizedName = hashtagName.toLowerCase();
      
      // Look up hashtag data from provided map
      const hashtagData = hashtagDataMap[normalizedName];
      
      if (hashtagData) {
        parts.push({
          type: 'hashtag',
          name: hashtagName, // preserve original case
          id: hashtagData.id,
          count: hashtagData.count,
          last_updated: hashtagData.last_updated,
          normalized: hashtagData.normalized
        });
      } else {
        // Hashtag not in database yet, create placeholder (will be created on post save)
        parts.push({
          type: 'hashtag',
          name: hashtagName,
          id: 'new', // placeholder for new hashtags
          normalized: normalizedName
        });
      }
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text (if any)
  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    parts.push(...await parseTextForUrls(remainingText, emojiDataMap));
  }
  
  return parts;
}

/**
 * Parse text for URLs and emojis
 */
async function parseTextForUrls(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];
  
  const urlRegex = /(\bhttps?:\/\/\S+)/g;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match;
  
  while ((match = urlRegex.exec(text)) !== null) {
    // Add text before URL
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index);
      parts.push(...await parseTextForEmojis(textBefore, emojiDataMap));
    }
    
    // Add URL
    parts.push({ type: 'url', url: match[0], preview: true });
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    parts.push(...await parseTextForEmojis(remainingText, emojiDataMap));
  }
  
  // If no URLs found, just parse for emojis
  if (parts.length === 0) {
    return await parseTextForEmojis(text, emojiDataMap);
  }
  
  return parts;
}

/**
 * Parse text for emoji shortcodes and return MessageParts
 * Handles both UUID-based emojis and shortcode emojis
 */
async function parseTextForEmojis(text: string, emojiDataMap: Record<string, any> = {}): Promise<MessagePart[]> {
  if (!text) return [];

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  // Create a combined regex to match both UUID and shortcode patterns
  const combinedEmojiRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-zA-Z0-9_+-]+):/g;
  
  let emojiMatch;
  while ((emojiMatch = combinedEmojiRegex.exec(text)) !== null) {
    const emojiIndex = emojiMatch.index;
    
    // Add text before emoji
    if (emojiIndex > lastIndex) {
      const textPart = text.substring(lastIndex, emojiIndex);
      if (textPart) {
        parts.push({ type: 'text', text: textPart });
      }
    }
    
    // Add emoji
    const emojiIdentifier = emojiMatch[1];
    
    // Try to get emoji from data map (by ID or name)
    let emojiData = emojiDataMap[emojiIdentifier];
    
    // If not in map, try to fetch directly (fallback)
    if (!emojiData) {
      // Check if it's a UUID or shortcode
      if (emojiIdentifier.match(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)) {
        emojiData = await getEmoji(emojiIdentifier);
      } else {
        // For shortcode, we need to query by name
        try {
          const { data } = await supabase
            .from('emojis')
            .select('*')
            .eq('name', emojiIdentifier)
            .single();
          emojiData = data;
        } catch (error) {
          console.warn('Failed to fetch emoji by shortcode:', emojiIdentifier, error);
        }
      }
    }
    
    if (emojiData) {
      parts.push({ type: 'emoji', emoji: emojiData });
    } else {
      parts.push({ type: 'text', text: emojiMatch[0] });
    }
    
    lastIndex = emojiIndex + emojiMatch[0].length;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    if (remainingText) {
      parts.push({ type: 'text', text: remainingText });
    }
  }

  // If no emojis found, return as single text part
  if (parts.length === 0 && text) {
    return [{ type: 'text', text: text }];
  }

  return parts;
}

/**
 * Convert MessagePart[] to ActivityPub HTML for federation
 * This is used when sending posts/messages to remote instances
 */
export function convertMessagePartsToActivityPubHTML(parts: MessagePart[]): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text':
        return part.text || '';
        
      case 'mention': {
        // Build proper ActivityPub mention with h-card structure
        const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
        const domain = part.domain || currentDomain;
        const href = `https://${domain}/@${part.username}`;
        const displayName = part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
        return `<span class="h-card"><a href="${href}" class="u-url mention">${displayName}</a></span>`;
      }
      
      case 'url':
        return `<a href="${part.url}" target="_blank" rel="noopener">${part.url}</a>`;
        
      case 'hashtag': {
        // Convert hashtag to ActivityPub-compatible format
        // ActivityPub hashtags are usually rendered as clickable links
        const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
        const href = `https://${currentDomain}/tags/${part.name}`;
        return `<a href="${href}" class="mention hashtag" rel="tag">#<span>${part.name}</span></a>`;
      }
        
      case 'emoji': {
        // Convert emoji to Misskey-compatible format (shortcode only in content)
        // The actual emoji data will be in the ActivityPub tag array
        if (part.emoji && part.emoji.name) {
          return `:${part.emoji.name}:`;
        }
        return `:emoji:`;
      }
      
      case 'file': {
        // Files are handled as ActivityPub attachments, not inline content
        // Return empty string as files are added to the attachment array separately
        return '';
      }
      
      case 'system':
        // System messages shouldn't be federated
        return '';
        
      default:
        return '';
    }
  }).join('');
}

/**
 * Convert MessagePart[] to plain text for display/reconstruction
 * This ensures proper ordering and clean text output
 */
export function convertMessagePartsToText(parts: MessagePart[]): string {
  return parts.map(part => {
    switch (part.type) {
      case 'text':
        return part.text;
        
      case 'mention':
        return part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
        
      case 'hashtag':
        return `#${part.name}`;
        
      case 'url':
        return part.url;
        
      case 'emoji':
        return `:${part.emoji.name}:`;
        
      case 'file':
        return `[${part.fileType} file]`;
        
      case 'system':
        return `[${part.event_type}]`;
        
      default:
        return '';
    }
  }).join('');
}

/**
 * Extract mentions from MessagePart[] for federation processing
 * Returns mention data needed for ActivityPub tag generation
 */
export function extractMentionsFromMessageParts(parts: MessagePart[]): Array<{
  username: string;
  domain: string;
  isLocal: boolean;
  userId?: string;
  href: string;
  name: string;
}> {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'mention' }> => part.type === 'mention')
    .map(part => {
      const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
      const domain = part.domain || currentDomain;
      const href = `https://${domain}/@${part.username}`;
      const name = part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
      
      return {
        username: part.username,
        domain: domain,
        isLocal: part.isLocal,
        userId: part.userId,
        href: href,
        name: name
      };
    });
}

/**
 * Convert ActivityPub HTML content back to MessagePart[] format
 * This is used when receiving federated content from remote instances
 * Note: This is a simplified version - the inbox function handles complex parsing
 */
export function convertActivityPubHTMLToMessageParts(html: string): MessagePart[] {
  // For now, return as text - the inbox function handles proper HTML parsing
  // This can be enhanced later for more sophisticated parsing
  return [{ type: 'text', text: html }];
}

/**
 * Extract ActivityPub attachments from MessagePart content
 * Returns properly formatted ActivityPub attachment objects
 */
export function extractActivityPubAttachments(parts: MessagePart[]): any[] {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'file' }> => part.type === 'file')
    .map(part => ({
      type: 'Document',
      url: part.url,
      mediaType: part.fileType === 'image' ? 'image/jpeg' : 
                part.fileType === 'video' ? 'video/mp4' : 
                part.fileType === 'audio' ? 'audio/mpeg' : 'application/octet-stream',
      ...(part.fileName && { name: part.fileName })
    }));
}

/**
 * Extract emoji tags for ActivityPub federation (Misskey compatibility)
 * Returns properly formatted emoji tag objects
 */
export function extractActivityPubEmojiTags(parts: MessagePart[], baseUrl?: string): any[] {
  const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
  const defaultBaseUrl = `https://${currentDomain}`;
  const finalBaseUrl = baseUrl || defaultBaseUrl;
  
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'emoji' }> => part.type === 'emoji')
    .map(part => ({
      id: part.emoji.url || `${finalBaseUrl}/emojis/${part.emoji.id}`,
      type: 'Emoji',
      name: `:${part.emoji.name}:`,
      icon: {
        type: 'Image',
        url: part.emoji.url || `${finalBaseUrl}/emojis/${part.emoji.id}.png`
      }
    }));
}

// Re-export for backward compatibility (during transition)
export const parseContentToUnifiedFormat = parseContentToMessageParts;
export const convertUnifiedToActivityPubHTML = convertMessagePartsToActivityPubHTML;
export const reconstructContentToText = convertMessagePartsToText;

/**
 * Extract hashtags from MessagePart[] for database processing
 * Returns hashtag data needed for post_hashtags table insertion
 */
export function extractHashtagsFromMessageParts(parts: MessagePart[]): Array<{
  name: string;
  normalized: string;
  id?: string;
}> {
  return parts
    .filter((part): part is Extract<MessagePart, { type: 'hashtag' }> => part.type === 'hashtag')
    .map(part => ({
      name: part.name,
      normalized: part.normalized || part.name.toLowerCase(),
      id: part.id !== 'new' ? part.id : undefined, // exclude placeholder IDs
    }));
}
