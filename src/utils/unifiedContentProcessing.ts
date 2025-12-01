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
import { debug } from '@/utils/debug'
import { resolveEmoji, loadEmojiData, isLoaded as unifiedEmojiLoaded } from '@/services/unifiedEmojiService'

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
            debug.warn(`Error fetching remote user ${usernameDomain}:`, error);
          }
          
          return data;
        } catch (error) {
          debug.warn(`Error querying remote user ${usernameDomain}:`, error);
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
    debug.warn('Error resolving mention user data:', error);
  }
  
  return userDataMap;
}

/**
 * Helper function to efficiently resolve emoji data in batch
 * Supports both UUID-based emojis, shortcode emojis, and unified emoji pack
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
    // Query emojis by ID (UUID-based) from database
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
    
    // Query emojis by name (shortcode-based) from database
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
      
      // For emojis not found in database, check unified emoji pack
      // This supports Mutant Standard and other emoji packs
      await loadEmojiData(); // Ensure emoji data is loaded
      
      for (const emojiName of uniqueEmojiNames) {
        if (!emojiDataMap[emojiName]) {
          // Try to resolve from unified emoji service
          const resolved = resolveEmoji(emojiName);
          
          // Check if we got a valid resolution:
          // 1. SVG path exists (mutant pack has it), OR
          // 2. Unicode is different from input (we found a real unicode mapping), OR
          // 3. resolved.shortcode exists and differs from input (case-insensitive match found it)
          const hasValidSvg = resolved.display.type === 'svg' && resolved.display.content;
          const hasValidUnicode = resolved.unicode && resolved.unicode !== emojiName;
          const hasShortcodeMatch = resolved.shortcode && resolved.shortcode.toLowerCase() === emojiName.toLowerCase();
          
          if (hasValidUnicode || (hasShortcodeMatch && hasValidSvg)) {
            emojiDataMap[emojiName] = {
              id: resolved.unicode || emojiName,
              name: emojiName,
              unicode: resolved.unicode || null,
              // Mark as inline so parser outputs as text, not emoji object
              _inlineAsText: !!resolved.unicode,
              source: 'unified'
            };
          }
          // If no valid resolution, don't add to map - will render as :shortcode: text
        }
      }
    }
  } catch (error) {
    debug.warn('Error resolving emoji data:', error);
  }
  
  return emojiDataMap;
}

/**
 * Helper function to efficiently resolve hashtag data in batch
 * This should be called before parseContentToMessageParts for optimal performance
 */
export async function resolveHashtagsData(content: string): Promise<Record<string, { id: string; count: number; last_updated: string; normalized: string }>> {
  // Unicode-aware hashtag regex: supports Japanese, Chinese, Korean, etc.
  // \p{L} = any letter, \p{N} = any number, includes CJK characters
  const hashtagRegex = /#([\p{L}\p{N}_-]+)/gu;
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
    debug.warn('Error fetching hashtag data:', error);
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
  // Includes compact Discord mention format: @d!ID:username
  // Unicode-aware: \p{L} = any letter, \p{N} = any number (includes CJK, etc.)
  const combinedRegex = /(@d!(\d+):([a-zA-Z0-9_.-]+))|(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)|#([\p{L}\p{N}_-]+)/gu;
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
      // This is a Discord bridged mention: @d!ID:username (compact format)
      const discordId = match[2];
      const discordUsername = match[3];
      
      parts.push({
        type: 'mention',
        userId: discordId, // Store Discord ID directly for translation to <@ID>
        username: discordUsername,
        domain: 'discord.com',
        isLocal: false,
        displayName: discordUsername,
        isBridged: true,
        bridgeSource: 'discord'
      } as MessagePart);
    } else if (match[4]) {
      // This is a regular mention (@username or @username@domain)
      const username = match[5];
      const domain = match[6];
      
      // Look up user data from provided map (efficient batch lookup)
      const mentionKey = domain ? `${username}@${domain}` : username;
      const userData = usernameToUserDataMap[mentionKey] || usernameToUserDataMap[username];
      
      // Fall back to domain-based logic if user data not available
      const currentDomain = import.meta.env.VITE_DOMAIN as string;
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
    } else if (match[7]) {
      // This is a hashtag (#tagname)
      const hashtagName = match[7];
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
          const { data, error } = await supabase
            .from('emojis')
            .select('*')
            .eq('name', emojiIdentifier)
            .maybeSingle();
          
          if (error) {
            debug.warn('⚠️ Error fetching emoji by shortcode:', emojiIdentifier, error.message);
          } else if (data) {
            emojiData = data;
            debug.log('✅ Fetched emoji by shortcode:', emojiIdentifier, data);
          } else {
            debug.warn('⚠️ Emoji not found by shortcode:', emojiIdentifier);
          }
        } catch (error) {
          debug.warn('❌ Exception fetching emoji by shortcode:', emojiIdentifier, error);
        }
      }
    }
    
    if (emojiData) {
      // SIMPLIFIED: If emoji is from unified pack (has unicode), just output as text!
      // This makes emojis portable and pack-agnostic in storage
      if (emojiData._inlineAsText && emojiData.unicode) {
        debug.log('✅ Inlining unified emoji as text:', emojiData.unicode);
        parts.push({ type: 'text', text: emojiData.unicode });
      } else {
        // Server custom emoji - needs the full object for URL lookup
        parts.push({ type: 'emoji', emoji: emojiData });
      }
    } else {
      debug.warn('⚠️ Emoji not resolved, showing as text:', emojiMatch[0]);
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
        const currentDomain = import.meta.env.VITE_DOMAIN as string;
        const domain = part.domain || currentDomain;
        const href = `https://${domain}/users/${part.username}`;  // ✅ FIX: Use /users/ format
        const displayName = part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
        return `<span class="h-card"><a href="${href}" class="u-url mention">${displayName}</a></span>`;
      }
      
      case 'url':
        return `<a href="${part.url}" target="_blank" rel="noopener">${part.url}</a>`;
        
      case 'hashtag': {
        // Convert hashtag to ActivityPub-compatible format
        // ActivityPub hashtags are usually rendered as clickable links
        const currentDomain = import.meta.env.VITE_DOMAIN as string;
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
      const currentDomain = import.meta.env.VITE_DOMAIN as string;
      const domain = part.domain || currentDomain;
      const href = `https://${domain}/users/${part.username}`;  // ✅ FIX: Use /users/ format
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
 * Properly parses ActivityPub HTML with mentions, hashtags, and text
 */
export function convertActivityPubHTMLToMessageParts(html: string): MessagePart[] {
  if (!html) return [{ type: 'text', text: '' }];
  
  // Create a DOM parser to extract structured content
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');
  const parts: MessagePart[] = [];
  
  // Walk through the DOM and extract parts
  const walkNode = (node: Node): void => {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.textContent || '';
      if (text.trim()) {
        // Don't parse mentions in plain text - they should be in <a> tags
        // If they're not in tags, it means the sender didn't properly format them
        // Just pass through as text
        parts.push({ type: 'text', text });
      }
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const element = node as HTMLElement;
      
      // Skip h-card wrapper - process its children directly
      if (element.classList.contains('h-card')) {
        node.childNodes.forEach(walkNode);
        return;
      }
      
      // Check if this is a mention link (ActivityPub format: <span class="h-card"><a class="u-url mention">@user@domain</a></span>)
      if (element.tagName === 'A' && element.classList.contains('mention')) {
        const href = element.getAttribute('href') || '';
        const text = element.textContent || '';
        
        // Parse @username@domain format
        const mentionMatch = text.match(/^@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?$/);
        if (mentionMatch) {
          const username = mentionMatch[1];
          const domain = mentionMatch[2];
          const currentDomain = import.meta.env.VITE_DOMAIN as string;
          
          parts.push({
            type: 'mention',
            userId: href, // Use href as fallback ID
            username: username,
            domain: domain || currentDomain,
            isLocal: !domain || domain === currentDomain,
            displayName: username
          });
          return; // Don't process children
        }
      }
      
      // Check if this is a hashtag
      if (element.tagName === 'A' && element.classList.contains('hashtag')) {
        const text = element.textContent || '';
        // Unicode-aware hashtag regex for CJK and other scripts
        const tagMatch = text.match(/^#([\p{L}\p{N}_-]+)$/u);
        if (tagMatch) {
          parts.push({
            type: 'hashtag',
            name: tagMatch[1]
          });
          return;
        }
      }
      
      // Handle line breaks
      if (element.tagName === 'BR') {
        parts.push({ type: 'text', text: '\n' });
        return;
      }
      
      // Handle paragraphs
      if (element.tagName === 'P') {
        node.childNodes.forEach(walkNode);
        // Add newline after paragraph if not the last element
        if (element.nextSibling) {
          parts.push({ type: 'text', text: '\n' });
        }
        return;
      }
      
      // Process children recursively for other elements
      node.childNodes.forEach(walkNode);
    }
  };
  
  walkNode(doc.body);
  
  return parts.length > 0 ? parts : [{ type: 'text', text: html }];
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
  const currentDomain = import.meta.env.VITE_DOMAIN as string;
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
