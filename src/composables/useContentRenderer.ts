/**
 * Unified Content Renderer Composable
 * 
 * This composable provides a DRY, unified approach to content rendering
 * across all components (ActivityPub, chat, DMs, etc.)
 * 
 * Features:
 * - Centralized emoji resolution using existing cache
 * - Consistent mention formatting and handling
 * - Unified URL detection and media preview
 * - Single source of truth for content styling
 * - Pluggable rendering modes (inline, display, edit)
 */

import { computed, type Ref } from 'vue';
import type { MessagePart } from '@/types';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { convertActivityPubHTMLToMessageParts } from '@/utils/unifiedContentProcessing';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';

export interface ContentRenderOptions {
  mode?: 'display' | 'preview' | 'edit';
  showImages?: boolean;
  showVideos?: boolean;
  maxPreviewLength?: number;
  singleLine?: boolean;
  enableMarkdown?: boolean;
  enableClickHandlers?: boolean;
}

export interface ContentRenderResult {
  // For Vue template rendering
  renderableContent: Ref<MessagePart[]>;
  
  // For HTML string rendering (like MonyContent)
  formattedHTML: Ref<string>;
  
  // Helper functions
  isSingleEmoji: Ref<boolean>;
  findEmojiByName: (name: string) => any;
  formatMentionDisplay: (mention: MessagePart) => string;
  isImageUrl: (url: string) => boolean;
  isVideoUrl: (url: string) => boolean;
  isAudioUrl: (url: string) => boolean;
  
  // Event handlers
  handleMentionClick: (userId: string, event: Event) => void;
  handleHashtagClick: (tag: string) => void;
  handleLinkClick: (url: string, event: Event) => void;
}

export function useContentRenderer(
  content: Ref<MessagePart[] | string | any>,
  options: ContentRenderOptions = {},
  emit?: (event: string, ...args: any[]) => void
): ContentRenderResult {
  
  const emojiCache = useEmojiCacheStore();
  
  // Unified emoji service for mutant pack rendering
  const { resolveEmoji, isNativePack, isLoaded: emojiServiceLoaded } = useUnifiedEmoji();
  
  // Default options
  const renderOptions = {
    mode: 'display',
    showImages: true,
    showVideos: true,
    maxPreviewLength: 500,
    singleLine: false,
    enableMarkdown: true,
    enableClickHandlers: true,
    ...options
  };

  // Emoji resolution function (unified across all components)
  const findEmojiByName = (name: string) => {
    if (!emojiCache.isInitialized) {
      return undefined;
    }
    
    const resolvedEmojis = emojiCache.resolvedEmojis;
    for (const serverId in resolvedEmojis) {
      const server = resolvedEmojis[serverId];
      const emoji = server.emojis.find((e: any) => e.name === name);
      if (emoji) {
        return emoji;
      }
    }
    return undefined;
  };

  // Convert any content format to MessagePart[]
  const normalizeContent = (rawContent: any): MessagePart[] => {
    if (!rawContent) return [];
    
    // Already MessagePart[]
    if (Array.isArray(rawContent)) {
      // No need to parse here anymore - backend does it
      return rawContent;
    }
    
    // String content - needs parsing
    if (typeof rawContent === 'string') {
      try {
        const parsed = JSON.parse(rawContent);
        if (Array.isArray(parsed)) {
          return normalizeContent(parsed); // Recursively normalize
        }
      } catch {
        // Plain text string
        return [{ type: 'text', text: rawContent }];
      }
    }
    
    // Other format - convert to string and treat as text
    return [{ type: 'text', text: String(rawContent) }];
  };

  // Normalized content as MessagePart[]
  const renderableContent = computed(() => {
    const normalized = normalizeContent(content.value);
    
    // Apply preview truncation if needed
    if (renderOptions.mode === 'preview' && renderOptions.maxPreviewLength) {
      return truncateContent(normalized, renderOptions.maxPreviewLength);
    }
    
    return normalized;
  });

  // Check if content is a single emoji (either emoji type or single unicode in text)
  const isSingleEmoji = computed(() => {
    const parts = renderableContent.value;
    if (parts.length !== 1) return false;
    
    const part = parts[0];
    
    // Traditional emoji type
    if (part && part.type === 'emoji') return true;
    
    // Check if single text part is just one emoji (with optional whitespace)
    if (part && part.type === 'text') {
      const trimmed = part.text?.trim() || '';
      // Unicode emoji regex - must be ONLY an emoji (or a few with zero-width joiners)
      const singleEmojiRegex = /^(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*$/u;
      return singleEmojiRegex.test(trimmed);
    }
    
    return false;
  });

  // Format mention display consistently
  const formatMentionDisplay = (mention: MessagePart): string => {
    if (mention.type !== 'mention') return '';
    
    // Use stored mention format if available (legacy support)
    if (mention.mention) {
      return mention.mention;
    }
    
    // Build mention display from parts
    const username = mention.username || 'unknown';
    const domain = mention.domain;
    const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
    
    // Determine if user is local
    // A user is local if:
    // 1. isLocal is explicitly true, OR
    // 2. domain is not set, OR
    // 3. domain matches the current instance domain
    const isLocal = mention.isLocal === true || !domain || domain === currentDomain;
    
    // For local users: show @username
    // For remote users: show @username@domain
    return isLocal ? `@${username}` : `@${username}@${domain}`;
  };

  // URL type detection
  const isImageUrl = (url: string): boolean => {
    return /\.(jpg|jpeg|png|gif|webp|svg|bmp|ico)(\?.*)?$/i.test(url);
  };

  const isVideoUrl = (url: string): boolean => {
    return /\.(mp4|webm|ogg|avi|mov|wmv|flv|m4v)(\?.*)?$/i.test(url);
  };

  const isAudioUrl = (url: string): boolean => {
    return /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)(\?.*)?$/i.test(url);
  };

  // Truncate content for previews
  const truncateContent = (parts: MessagePart[], maxLength: number): MessagePart[] => {
    const result: MessagePart[] = [];
    let currentLength = 0;
    
    for (const part of parts) {
      if (currentLength >= maxLength) break;
      
      if (part.type === 'text') {
        const remainingLength = maxLength - currentLength;
        if (part.text && part.text.length > remainingLength) {
          result.push({
            ...part,
            text: part.text.substring(0, remainingLength) + '...'
          });
          break;
        } else {
          result.push(part);
          currentLength += part.text?.length || 0;
        }
      } else {
        // Non-text parts: count as fixed length
        const partLength = part.type === 'mention' ? 10 : 5;
        if (currentLength + partLength > maxLength) break;
        
        result.push(part);
        currentLength += partLength;
      }
    }
    
    return result;
  };

  // Generate HTML string for v-html rendering (like MonyContent)
  const formattedHTML = computed(() => {
    const parts = renderableContent.value;
    
    return parts.map(part => {
      switch (part.type) {
        case 'text': {
          let text = part.text || '';
          
          // For mutant pack: Replace unicode emojis with SVG images
          // For native pack: Leave unicode as-is (browser renders them)
          if (!isNativePack.value && emojiServiceLoaded.value) {
            const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
            text = text.replace(emojiRegex, (match) => {
              const resolved = resolveEmoji(match);
              if (resolved.display.type === 'svg') {
                const sizeClass = isSingleEmoji.value ? 'inline-emoji single' : 'inline-emoji';
                return `<img class="${sizeClass}" src="${resolved.display.content}" alt="${resolved.shortcode || match}" draggable="false" />`;
              }
              return match;
            });
          } else if (isSingleEmoji.value) {
            // Native pack with single emoji - wrap for bigger styling
            const emojiRegex = /(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
            text = text.replace(emojiRegex, (match) => {
              return `<span class="native-emoji single">${match}</span>`;
            });
          }
          
          if (renderOptions.enableMarkdown) {
            // Basic markdown formatting
            text = text.replace(/\n/g, '<br>');
            text = text.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
            text = text.replace(/\*(.*?)\*/g, '<em>$1</em>');
            text = text.replace(/`(.*?)`/g, '<code>$1</code>');
          }
          
          // Format hashtags
          text = text.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
          
          return text;
        }
        
        case 'mention': {
          const displayText = formatMentionDisplay(part);
          // Escape HTML entities in the display text
          const escapedDisplayText = displayText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
          
          const dataAttrs = renderOptions.enableClickHandlers 
            ? `data-user-id="${part.userId || ''}" data-handle="${escapedDisplayText}"` 
            : '';
          
          return `<span class="mention" ${dataAttrs}>${escapedDisplayText}</span>`;
        }
        
        case 'hashtag': {
          const tagName = part.name || '';
          const dataAttrs = renderOptions.enableClickHandlers 
            ? `data-tag="${tagName}"` 
            : '';
          
          return `<span class="hashtag" ${dataAttrs}>#${tagName}</span>`;
        }
        
        case 'emoji': {
          const emoji = part.emoji;
          if (!emoji) {
            return `:emoji:`;
          }
          
          const sizeClass = isSingleEmoji.value ? 'single' : '';
          
          // Check if this is a native/unified emoji (has unicode but no server URL)
          const isServerEmoji = emoji.url && (emoji.url.includes('/storage/v1/') || emoji.url.includes('/object/public/emojis/'));
          
          if (isServerEmoji) {
            // Server custom emoji - use URL
            const url = getEmojiUrl(emoji.url, 96);
            return `<img src="${url}" alt=":${emoji.name}:" title=":${emoji.name}:" class="emoji-icon ${sizeClass}" draggable="false" />`;
          }
          
          // Native/unified emoji - check pack preference
          const unicode = emoji.native || emoji.unicode;
          if (unicode) {
            if (isNativePack.value) {
              // Native pack - render unicode
              return isSingleEmoji.value 
                ? `<span class="native-emoji single">${unicode}</span>`
                : unicode;
            } else if (emojiServiceLoaded.value) {
              // Mutant pack - try to get SVG
              const resolved = resolveEmoji(unicode);
              if (resolved.display.type === 'svg') {
                return `<img src="${resolved.display.content}" alt=":${emoji.name}:" title=":${emoji.name}:" class="emoji-icon ${sizeClass}" draggable="false" />`;
              }
            }
            // Fallback to unicode
            return unicode;
          }
          
          // Try to resolve by name
          if (emoji.name && emojiServiceLoaded.value) {
            const resolved = resolveEmoji(emoji.name);
            if (resolved.display.type === 'svg' && !isNativePack.value) {
              return `<img src="${resolved.display.content}" alt=":${emoji.name}:" title=":${emoji.name}:" class="emoji-icon ${sizeClass}" draggable="false" />`;
            } else if (resolved.unicode) {
              return isSingleEmoji.value 
                ? `<span class="native-emoji single">${resolved.unicode}</span>`
                : resolved.unicode;
            }
          }
          
          return `:${emoji.name || 'emoji'}:`;
        }
        
        case 'url': {
          const url = part.url || '';
          
          if (renderOptions.mode === 'preview') {
            return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="url-link">${url}</a>`;
          }
          
          // Check for media URLs
          if (renderOptions.showImages && isImageUrl(url)) {
            return `<div class="media-container image-container">
              <img src="${url}" alt="Image" class="content-image" draggable="false" />
            </div>`;
          }
          
          if (renderOptions.showVideos && isVideoUrl(url)) {
            return `<div class="media-container video-container">
              <video src="${url}" controls class="content-video"></video>
            </div>`;
          }
          
          if (renderOptions.showVideos && isAudioUrl(url)) {
            return `<div class="media-container audio-container">
              <audio src="${url}" controls preload="metadata" class="content-audio"></audio>
            </div>`;
          }
          
          return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="url-link">${url}</a>`;
        }
        
        case 'file': {
          const fileName = part.fileName || 'file';
          const fileSize = part.fileSize ? ` (${formatFileSize(part.fileSize)})` : '';
          
          if (renderOptions.mode === 'preview') {
            return `<span class="file-preview">[${part.fileType || 'file'}: ${fileName}${fileSize}]</span>`;
          }
          
          if (part.fileType === 'image' && renderOptions.showImages) {
            return `<div class="media-container image-container">
              <img src="${part.url}" alt="${fileName}" class="content-image" draggable="false" />
            </div>`;
          }
          
          return `<a href="${part.url}" target="_blank" rel="noopener noreferrer" class="file-link">
            <span class="file-icon">📎</span>${fileName}${fileSize}
          </a>`;
        }
        
        case 'system': {
          return `<span class="system-message">[${part.event_type}]</span>`;
        }
        
        default:
          return '';
      }
    }).join('');
  });

  // Event handlers
  const handleMentionClick = (userId: string, event: Event) => {
    if (renderOptions.enableClickHandlers && emit) {
      emit('user-mention-click', userId, event);
    }
  };

  const handleHashtagClick = (tag: string) => {
    if (renderOptions.enableClickHandlers && emit) {
      emit('hashtag-click', tag);
    }
  };

  const handleLinkClick = (url: string, event: Event) => {
    if (renderOptions.enableClickHandlers && emit) {
      emit('link-click', url, event);
    }
  };

  // Helper function for file sizes
  const formatFileSize = (bytes: number): string => {
    if (bytes === 0) return '0 Bytes';
    const k = 1024;
    const sizes = ['Bytes', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
  };

  return {
    renderableContent,
    formattedHTML,
    isSingleEmoji,
    findEmojiByName,
    formatMentionDisplay,
    isImageUrl,
    isVideoUrl,
    isAudioUrl,
    handleMentionClick,
    handleHashtagClick,
    handleLinkClick
  };
}
