import type { MessagePart } from '@/types';

/**
 * Convert MessagePart[] to markdown text for rendering with MarkdownContent
 */
export function messagePartsToMarkdown(parts: MessagePart[]): string {
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map(part => {
    if (!part || typeof part !== 'object') {
      return '';
    }

    switch (part.type) {
      case 'text':
        return part.text || '';
      
      case 'emoji':
        return part.emoji?.name ? `:${part.emoji.name}:` : '';
      
      case 'mention':
        return part.mention || '';
      
      case 'url':
        return part.url || '';

      case 'embed':
        return part.url || '';

      case 'file':
        // For files, return a placeholder that won't be parsed as markdown
        return `[${part.fileType || 'file'}: attachment]`;
      
      default:
        return '';
    }
  }).join('');
}

/**
 * Extract plain text from MessagePart[] for previews
 */
export function messagePartsToPlainText(parts: MessagePart[]): string {
  if (!Array.isArray(parts)) {
    return '';
  }

  return parts.map(part => {
    if (!part || typeof part !== 'object') {
      return '';
    }

    switch (part.type) {
      case 'text':
        return part.text || '';
      
      case 'emoji':
        return part.emoji?.name ? `:${part.emoji.name}:` : '';
      
      case 'mention':
        return part.mention || '';
      
      case 'url':
        return part.url || '';
      
      case 'file':
        return '[file]';
      
      default:
        return '';
    }
  }).join('').trim();
}

/**
 * Check if message content contains only a single emoji
 */
export function isSingleEmojiMessage(parts: MessagePart[]): boolean {
  if (!Array.isArray(parts) || parts.length !== 1) {
    return false;
  }

  const part = parts[0];
  if (!part || typeof part !== 'object') {
    return false;
  }
  
  // Traditional emoji type
  if (part.type === 'emoji') {
    return true;
  }
  
  // Check if single text part is just one emoji (with optional whitespace)
  if (part.type === 'text') {
    const trimmed = (part.text || '').trim();
    // Unicode emoji regex - must be ONLY an emoji (flags, ZWJ sequences, or standard emojis)
    // Includes Regional Indicator Symbol pairs for flags (U+1F1E6-U+1F1FF)
    const singleEmojiRegex = /^([\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*)$/u;
    return singleEmojiRegex.test(trimmed);
  }
  
  return false;
}
