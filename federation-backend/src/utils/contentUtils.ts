/**
 * Content Utilities
 * 
 * Shared utilities for converting Harmony's JSONB content format
 * to ActivityPub-compatible HTML.
 * 
 * Used by: DMs, Channel Messages, Posts, etc.
 */

import config from '../config/index.js';

/**
 * Escape HTML entities to prevent XSS
 */
export function escapeHtml(text: string): string {
  if (!text) return '';
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Convert Harmony's JSONB content format to HTML for ActivityPub
 * 
 * Handles:
 * - Plain text strings
 * - Array of content parts (text, mentions, urls, emojis, code)
 * - Objects with text property
 * 
 * @param content - The content to convert (string, array, or object)
 * @returns HTML string for ActivityPub
 */
export function convertContentToHTML(content: any): string {
  // Plain string
  if (typeof content === 'string') {
    return escapeHtml(content);
  }
  
  // Array of content parts
  if (Array.isArray(content)) {
    return content.map(part => {
      switch (part.type) {
        case 'text':
          return escapeHtml(part.text || '');
          
        case 'mention':
          const mentionDomain = part.domain || config.INSTANCE_DOMAIN;
          return `<a href="https://${mentionDomain}/users/${part.username}" class="mention">@${part.username}</a>`;
          
        case 'url':
          const url = escapeHtml(part.url || '');
          return `<a href="${url}">${url}</a>`;
          
        case 'emoji':
          // Handle custom emoji objects (Harmony's format)
          if (part.emoji && typeof part.emoji === 'object') {
            const emoji = part.emoji;
            // Render as img tag for ActivityPub compatibility
            if (emoji.url) {
              const emojiName = escapeHtml(emoji.name || emoji.display_name || 'emoji');
              return `<img src="${emoji.url}" alt=":${emojiName}:" title=":${emojiName}:" class="custom-emoji" style="height: 1.5em; vertical-align: middle;" />`;
            }
            // Fallback to shortcode
            return `:${escapeHtml(emoji.name || emoji.display_name || 'emoji')}:`;
          }
          // Handle simple string emoji (unicode)
          if (typeof part.emoji === 'string') {
            return part.emoji;
          }
          return '';
          
        case 'code':
          return `<code>${escapeHtml(part.text || '')}</code>`;
          
        case 'codeblock':
          const lang = part.language ? ` class="language-${escapeHtml(part.language)}"` : '';
          return `<pre><code${lang}>${escapeHtml(part.text || '')}</code></pre>`;
          
        case 'bold':
          return `<strong>${escapeHtml(part.text || '')}</strong>`;
          
        case 'italic':
          return `<em>${escapeHtml(part.text || '')}</em>`;
          
        case 'strikethrough':
          return `<del>${escapeHtml(part.text || '')}</del>`;
          
        case 'link':
          const href = escapeHtml(part.url || part.href || '');
          const linkText = escapeHtml(part.text || part.url || '');
          return `<a href="${href}">${linkText}</a>`;
          
        case 'linebreak':
          return '<br />';
          
        default:
          return '';
      }
    }).join('');
  }
  
  // Object with text property (simple format)
  if (content?.text) {
    return escapeHtml(content.text);
  }
  
  return '';
}

/**
 * Extract ActivityPub tags (mentions, hashtags, emojis) from content
 * 
 * These tags are used by Mastodon/Misskey to properly render
 * mentions, hashtags, and custom emojis.
 * 
 * @param content - The content to extract tags from
 * @returns Array of ActivityPub tag objects
 */
export function extractActivityPubTags(content: any): any[] {
  if (!Array.isArray(content)) return [];
  
  const tags: any[] = [];
  
  for (const part of content) {
    if (part.type === 'mention' && part.username) {
      const mentionDomain = part.domain || config.INSTANCE_DOMAIN;
      tags.push({
        type: 'Mention',
        href: `https://${mentionDomain}/users/${part.username}`,
        name: part.domain ? `@${part.username}@${part.domain}` : `@${part.username}`
      });
    } else if (part.type === 'hashtag' && part.tag) {
      tags.push({
        type: 'Hashtag',
        href: `https://${config.INSTANCE_DOMAIN}/tags/${part.tag}`,
        name: `#${part.tag}`
      });
    } else if (part.type === 'emoji' && part.emoji && typeof part.emoji === 'object') {
      // Add custom emoji as ActivityPub Emoji tag
      // This allows Mastodon/Misskey to render the custom emoji
      const emoji = part.emoji;
      if (emoji.url && emoji.name) {
        tags.push({
          type: 'Emoji',
          id: emoji.url,
          name: `:${emoji.name}:`,
          icon: {
            type: 'Image',
            mediaType: 'image/png',
            url: emoji.url
          }
        });
      }
    }
  }
  
  return tags;
}

/**
 * Extract attachments from content
 * 
 * @param content - The content to extract attachments from
 * @returns Array of ActivityPub attachment objects
 */
export function extractAttachments(content: any): any[] {
  if (!Array.isArray(content)) return [];
  
  return content
    .filter((part: any) => part.type === 'attachment' || part.type === 'image')
    .map((part: any) => ({
      type: 'Document',
      mediaType: part.mediaType || part.mime_type || 'application/octet-stream',
      url: part.url,
      name: part.name || part.filename || null
    }));
}

