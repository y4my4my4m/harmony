/**
 * Unified content processing system for ALL text content in Harmony
 * Used by: chat messages, DMs, ActivityPub posts, and federation
 * 
 * This replaces the fragmented approach and uses the existing MessagePart types
 * for consistency across the entire application.
 */

import type { MessagePart } from '@/types';
import { getEmoji } from '@/services/emojiService';
const emojiRegex = /:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/g;

/**
 * Parse content string into unified MessagePart format
 * This is the SINGLE source of truth for all content parsing
 * Used by: chat, DMs, ActivityPub posts, and any text input
 */
export async function parseContentToMessageParts(
  content: string,
  _usernameToUserIdMap: any = {}
): Promise<MessagePart[]> {
  if (!content) return [{ type: 'text', text: '' }];

  // Simple approach: split on mentions first, then handle URLs and emojis within each part
  const mentionRegex = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
  const parts: MessagePart[] = [];
  
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(content)) !== null) {
    // Add text before mention (if any)
    if (match.index > lastIndex) {
      const textBefore = content.substring(lastIndex, match.index);
      parts.push(...await parseTextForUrls(textBefore));
    }
    
    // Process the mention
    const username = match[1];
    const domain = match[2];
    
    // Create mention object
    const isLocal = !domain || domain === 'har.mony.lol';
    
    parts.push({
      type: 'mention',
      userId: `unresolved-${username}${domain ? '@' + domain : ''}`,
      username: username,
      domain: domain || 'har.mony.lol',
      isLocal: isLocal,
      displayName: username
    });
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text (if any)
  if (lastIndex < content.length) {
    const remainingText = content.substring(lastIndex);
    parts.push(...await parseTextForUrls(remainingText));
  }
  
  return parts;
}

/**
 * Parse text for URLs and emojis
 */
async function parseTextForUrls(text: string): Promise<MessagePart[]> {
  if (!text) return [];
  
  const urlRegex = /(\bhttps?:\/\/\S+)/g;
  const parts: MessagePart[] = [];
  let lastIndex = 0;
  let match;
  
  while ((match = urlRegex.exec(text)) !== null) {
    // Add text before URL
    if (match.index > lastIndex) {
      const textBefore = text.substring(lastIndex, match.index);
      parts.push(...await parseTextForEmojis(textBefore));
    }
    
    // Add URL
    parts.push({ type: 'url', url: match[0], preview: true });
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    parts.push(...await parseTextForEmojis(remainingText));
  }
  
  // If no URLs found, just parse for emojis
  if (parts.length === 0) {
    return await parseTextForEmojis(text);
  }
  
  return parts;
}

/**
 * Parse text for emoji shortcodes and return MessageParts
 */
async function parseTextForEmojis(text: string): Promise<MessagePart[]> {
  if (!text) return [];

  const parts: MessagePart[] = [];
  let lastIndex = 0;

  emojiRegex.lastIndex = 0;
  let emojiMatch;
  while ((emojiMatch = emojiRegex.exec(text)) !== null) {
    const emojiIndex = emojiMatch.index;
    
    // Add text before emoji
    if (emojiIndex > lastIndex) {
      const textPart = text.substring(lastIndex, emojiIndex);
      if (textPart) {
        parts.push({ type: 'text', text: textPart });
      }
    }
    
    // Add emoji
    const emojiId = emojiMatch[1];
    const emojiData = emojiId ? await getEmoji(emojiId) : undefined;
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
        const domain = part.domain || 'har.mony.lol';
        const href = `https://${domain}/@${part.username}`;
        const displayName = part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
        return `<span class="h-card"><a href="${href}" class="u-url mention">${displayName}</a></span>`;
      }
      
      case 'url':
        return `<a href="${part.url}" target="_blank" rel="noopener">${part.url}</a>`;
        
      case 'emoji': {
        // Convert emoji to ActivityPub format
        if (part.emoji.url) {
          return `<img src="${part.emoji.url}" alt=":${part.emoji.name}:" class="custom-emoji" title=":${part.emoji.name}:" draggable="false" />`;
        }
        return `:${part.emoji.name}:`;
      }
      
      case 'file': {
        // Files are typically handled as media attachments, not inline content
        return `<a href="${part.url}" target="_blank" rel="noopener">📎 ${part.fileType} attachment</a>`;
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
      const domain = part.domain || 'har.mony.lol';
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

// Re-export for backward compatibility (during transition)
export const parseContentToUnifiedFormat = parseContentToMessageParts;
export const convertUnifiedToActivityPubHTML = convertMessagePartsToActivityPubHTML;
export const reconstructContentToText = convertMessagePartsToText;
