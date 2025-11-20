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
  return part && typeof part === 'object' && part.type === 'emoji';
}
