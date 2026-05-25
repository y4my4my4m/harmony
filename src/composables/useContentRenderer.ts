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
import { getEmojiUrl } from '@/utils/emojiUtils';
import { convertActivityPubHTMLToMessageParts } from '@/utils/unifiedContentProcessing';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { isYouTubeUrl, buildYouTubeEmbedUrl, parseEmbedUrl } from '@/utils/embedDetection';
import { escapeHtml, sanitizeUrl } from '@/utils/sanitize';
import { findEmojiByName as resolveEmojiByShortcode } from '@/services/emojiShortcodeResolver';

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

  const findEmojiByName = (name: string) => resolveEmojiByShortcode(name) ?? undefined;

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

  // Remove stray "@" text parts that precede mention parts (ActivityPub HTML parsing artifact)
  const cleanStrayMentionPrefixes = (parts: MessagePart[]): MessagePart[] => {
    const result: MessagePart[] = [];
    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const next = parts[i + 1];
      if (
        part.type === 'text' &&
        next?.type === 'mention' &&
        /^@\s*$/.test(part.text || '')
      ) {
        continue;
      }
      if (
        part.type === 'text' &&
        next?.type === 'mention' &&
        part.text?.endsWith('@ ')
      ) {
        result.push({ ...part, text: part.text.slice(0, -2) });
        continue;
      }
      if (
        part.type === 'text' &&
        next?.type === 'mention' &&
        part.text?.endsWith('@')
      ) {
        result.push({ ...part, text: part.text.slice(0, -1) });
        continue;
      }
      result.push(part);
    }
    return result;
  };

  // Normalized content as MessagePart[]
  const renderableContent = computed(() => {
    let normalized = normalizeContent(content.value);
    normalized = cleanStrayMentionPrefixes(normalized);
    
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
      // Unicode emoji regex - must be ONLY an emoji (flags, ZWJ sequences, or standard emojis)
      // Includes Regional Indicator Symbol pairs for flags (U+1F1E6-U+1F1FF)
      const singleEmojiRegex = /^([\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*)$/u;
      return singleEmojiRegex.test(trimmed);
    }
    
    return false;
  });

  // Format mention display consistently
  const formatMentionDisplay = (mention: MessagePart): string => {
    if (mention.type !== 'mention') return '';
    
    // Use stored mention format if available (legacy support) - normalize to avoid @@.
    // The `mention` field is a legacy property not declared on MentionContent;
    // cast to access it without breaking existing data.
    const legacyMention = (mention as any).mention as string | undefined;
    if (legacyMention) {
      const m = String(legacyMention).replace(/^@+/, '@');
      return m.startsWith('@') ? m : `@${m}`;
    }
    
    // Build mention display from parts - strip stray @ from username to prevent @@
    const username = (mention.username || 'unknown').replace(/^@+/, '');
    const domain = mention.domain;
    const currentDomain = import.meta.env.VITE_DOMAIN as string;
    
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

  // Helper: get file type from part (handles both camelCase and snake_case, mimeType, and type)
  const getPartFileType = (p: any): string => {
    const ft = p?.fileType || p?.file_type || '';
    if (ft) return ft;
    const mt = (p?.mimeType || p?.mime_type || p?.mediaType || p?.media_type || '').toLowerCase();
    if (mt.startsWith('image/')) return 'image';
    if (mt.startsWith('video/') || mt.includes('gif')) return 'video';
    const url = p?.url || '';
    if (isImageUrl(url)) return 'image';
    if (isVideoUrl(url)) return 'video';
    return ft;
  };

  // Check if part is viewable media (image/video) for grid grouping
  const isViewableMediaPart = (p: MessagePart): boolean => {
    if (renderOptions.mode === 'preview') return false;
    const partType = String((p as any).type || '').toLowerCase();
    if (partType === 'file') {
      const ft = getPartFileType(p);
      return (ft === 'image' && renderOptions.showImages) ||
        (ft === 'video' && renderOptions.showVideos);
    }
    // Some formats use type: 'image' or type: 'video' directly (e.g. contentUtils, Fedi embeds)
    if (partType === 'image' && renderOptions.showImages) return true;
    if (partType === 'video' && renderOptions.showVideos) return true;
    if (partType === 'gifv' && renderOptions.showVideos) return true;
    if (partType === 'url') {
      const url = (p as any).url || '';
      return (renderOptions.showImages && isImageUrl(url)) ||
        (renderOptions.showVideos && isVideoUrl(url));
    }
    return false;
  };

  // Render a single media item's HTML (for grid)
  const renderMediaItemHtml = (p: MessagePart): string => {
    const partType = String((p as any).type || '').toLowerCase();
    if (partType === 'file') {
      const fileName = escapeHtml((p as any).fileName || (p as any).filename || 'file');
      const safeUrl = escapeHtml(sanitizeUrl((p as any).url || ''));
      const ft = getPartFileType(p);
      if (ft === 'image') {
        return `<div class="media-gallery__item"><img src="${safeUrl}" alt="${fileName}" class="content-image" loading="lazy" draggable="false" /></div>`;
      }
      if (ft === 'video') {
        return `<div class="media-gallery__item"><video src="${safeUrl}" controls class="content-video"></video></div>`;
      }
    }
    // Some formats use type: 'image' or type: 'video' directly
    if (partType === 'image' || partType === 'gifv') {
      const safeUrl = escapeHtml(sanitizeUrl((p as any).url || ''));
      const alt = escapeHtml((p as any).description || (p as any).alt || 'Image');
      return `<div class="media-gallery__item"><img src="${safeUrl}" alt="${alt}" class="content-image" loading="lazy" draggable="false" /></div>`;
    }
    if (partType === 'video') {
      const safeUrl = escapeHtml(sanitizeUrl((p as any).url || ''));
      return `<div class="media-gallery__item"><video src="${safeUrl}" controls class="content-video"></video></div>`;
    }
    if (partType === 'url') {
      const url = (p as any).url || '';
      const safeUrl = escapeHtml(sanitizeUrl(url));
      if (isImageUrl(url)) {
        return `<div class="media-gallery__item"><img src="${safeUrl}" alt="Image" class="content-image" loading="lazy" draggable="false" /></div>`;
      }
      if (isVideoUrl(url)) {
        return `<div class="media-gallery__item"><video src="${safeUrl}" controls class="content-video"></video></div>`;
      }
    }
    // Direct type: 'image' or type: 'video' (e.g. some Fedi/API formats)
    if ((partType === 'image' || partType === 'gifv') && renderOptions.showImages) {
      const safeUrl = escapeHtml(sanitizeUrl((p as any).url || (p as any).preview_url || ''));
      const alt = escapeHtml((p as any).description || (p as any).alt || 'Image');
      return `<div class="media-gallery__item"><img src="${safeUrl}" alt="${alt}" class="content-image" loading="lazy" draggable="false" /></div>`;
    }
    if ((partType === 'video') && renderOptions.showVideos) {
      const safeUrl = escapeHtml(sanitizeUrl((p as any).url || ''));
      return `<div class="media-gallery__item"><video src="${safeUrl}" controls class="content-video"></video></div>`;
    }
    return '';
  };

  // Generate HTML string for v-html rendering (like MonyContent)
  const formattedHTML = computed(() => {
    const parts = renderableContent.value;
    const chunks: string[] = [];
    let i = 0;

    // Group consecutive image/video parts into a single media grid (Misskey/federated inline media)
    const renderPart = (part: MessagePart): string => {
      switch (part.type) {
        case 'text': {
          let text = escapeHtml(part.text || '');

          // For mutant/twemoji pack: Replace unicode emojis with SVG images
          // For native pack: Leave unicode as-is (browser renders them)
          if (!isNativePack.value && emojiServiceLoaded.value) {
            // Emoji regex that captures:
            // 1. Flag pairs (Regional Indicator Symbols U+1F1E6-U+1F1FF)
            // 2. ZWJ sequences (emoji + zero-width joiner + emoji)
            // 3. Standard emojis with presentation selector
            const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
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
            // Same regex to capture flags properly
            const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
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
          text = text.replace(/(?<![&\w])#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
          
          return text;
        }
        
        case 'mention': {
          const displayText = formatMentionDisplay(part);
          const escapedDisplayText = displayText
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
          
          // Build a local handle for navigation (e.g. "@bob@mastodon.social")
          const mentionHandle = part.domain
            ? `@${part.username || ''}@${part.domain}`
            : `@${part.username || ''}`;
          const dataAttrs = renderOptions.enableClickHandlers 
            ? `data-user-id="${escapeHtml(String(part.userId || ''))}" data-handle="${escapeHtml(mentionHandle)}"` 
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
          
          // Check if this is a custom emoji with a URL (server-local or federated remote)
          const hasCustomUrl = emoji.url && (
            emoji.url.startsWith('http://') ||
            emoji.url.startsWith('https://') ||
            emoji.url.includes('/storage/v1/') ||
            emoji.url.includes('/object/public/emojis/')
          );
          
          if (hasCustomUrl) {
            const url = getEmojiUrl(emoji.url, 96);
            return `<img src="${url}" alt=":${emoji.name}:" title=":${emoji.name}:" class="emoji-icon ${sizeClass}" draggable="false" onerror="this.style.display='none';var s=document.createElement('span');s.className='emoji-icon emoji-fallback ${sizeClass}';s.title=':${emoji.name}:';s.innerHTML='<svg viewBox=&quot;0 0 24 24&quot; fill=&quot;none&quot; stroke=&quot;currentColor&quot; stroke-width=&quot;2&quot;><line x1=&quot;2&quot; y1=&quot;2&quot; x2=&quot;22&quot; y2=&quot;22&quot;/><path d=&quot;M10.41 10.41a2 2 0 1 1-2.83-2.83&quot;/><path d=&quot;M21 15V5a2 2 0 0 0-2-2H9&quot;/><path d=&quot;M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59&quot;/></svg>';this.parentNode.insertBefore(s,this)" />`;
          }
          
          // Native/unified emoji - check pack preference.
          // `native`/`unicode` are legacy fields on emoji payloads not modelled in the
          // Emoji type; cast through any so legacy data still works.
          const emojiAny = emoji as any;
          const unicode = emojiAny.native || emojiAny.unicode;
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
          // sanitizeUrl rejects javascript:/data:/etc.; escapeHtml prevents
          // attribute-context HTML injection.
          const cleanUrl = sanitizeUrl(url);
          const safeUrl = escapeHtml(cleanUrl);
          // Display text uses the raw (escaped) URL so the user sees what they typed
          // even if the scheme is unsafe - we just don't make it a live link.
          const safeDisplayText = escapeHtml(url);

          // If the URL was rejected by sanitizeUrl, render it as inert text instead
          // of a clickable anchor (a `href=""` link would navigate to the current page).
          if (!cleanUrl) {
            return `<span class="url-link url-link--unsafe">${safeDisplayText}</span>`;
          }

          if (renderOptions.mode === 'preview') {
            return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="url-link">${safeDisplayText}</a>`;
          }
          
          // Check for media URLs
          if (renderOptions.showImages && isImageUrl(url)) {
            return `<div class="media-container image-container">
              <img src="${safeUrl}" alt="Image" class="content-image" loading="lazy" draggable="false" />
            </div>`;
          }
          
          if (renderOptions.showVideos && isVideoUrl(url)) {
            return `<div class="media-container video-container">
              <video src="${safeUrl}" controls class="content-video"></video>
            </div>`;
          }
          
          if (renderOptions.showVideos && isAudioUrl(url)) {
            return `<div class="media-container audio-container">
              <audio src="${safeUrl}" controls preload="metadata" class="content-audio"></audio>
            </div>`;
          }
          
          // YouTube embeds
          if (renderOptions.showVideos) {
            const parsed = parseEmbedUrl(url);
            if (parsed && isYouTubeUrl(parsed)) {
              const embedUrl = buildYouTubeEmbedUrl(parsed);
              if (embedUrl) {
                const separator = embedUrl.includes('?') ? '&' : '?';
                const fullEmbedUrl = `${embedUrl}${separator}enablejsapi=1&origin=${encodeURIComponent(typeof window !== 'undefined' ? window.location.origin : '')}`;
                const safeEmbedUrl = escapeHtml(sanitizeUrl(fullEmbedUrl));
                return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="url-link">${safeDisplayText}</a>
                  <div class="media-container video-container youtube-embed">
                    <iframe src="${safeEmbedUrl}" frameborder="0" allowfullscreen
                      allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                      loading="lazy"></iframe>
                  </div>`;
              }
            }
          }
          
          return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer" class="url-link">${safeDisplayText}</a>`;
        }
        
        case 'file': {
          const fileName = escapeHtml(part.fileName || 'file');
          const fileSize = part.fileSize ? ` (${formatFileSize(part.fileSize)})` : '';
          const safeFileUrl = escapeHtml(sanitizeUrl(part.url || ''));
          
          if (renderOptions.mode === 'preview') {
            return `<span class="file-preview">[${escapeHtml(part.fileType || 'file')}: ${fileName}${fileSize}]</span>`;
          }

          if (!safeFileUrl) {
            return `<span class="file-link file-link--unsafe">
              <span class="file-icon">📎</span>${fileName}${fileSize}
            </span>`;
          }

          if (part.fileType === 'image' && renderOptions.showImages) {
            return `<div class="media-container image-container">
              <img src="${safeFileUrl}" alt="${fileName}" class="content-image" loading="lazy" draggable="false" />
            </div>`;
          }
          
          if (part.fileType === 'video' && renderOptions.showVideos) {
            return `<div class="media-container video-container">
              <video src="${safeFileUrl}" controls class="content-video"></video>
            </div>`;
          }
          
          if (part.fileType === 'audio') {
            return `<div class="media-container audio-container">
              <audio src="${safeFileUrl}" controls preload="metadata" class="content-audio"></audio>
            </div>`;
          }
          
          return `<a href="${safeFileUrl}" target="_blank" rel="noopener noreferrer" class="file-link">
            <span class="file-icon">📎</span>${fileName}${fileSize}
          </a>`;
        }
        
        case 'system': {
          return `<span class="system-message">[${part.event_type}]</span>`;
        }
        
        default:
          return '';
      }
    };

    // Loop: group consecutive viewable media into a single grid, or render other parts
    while (i < parts.length) {
      const part = parts[i];
      if (isViewableMediaPart(part)) {
        const mediaGroup: MessagePart[] = [];
        while (i < parts.length && isViewableMediaPart(parts[i])) {
          mediaGroup.push(parts[i]);
          i++;
        }
        const count = Math.min(mediaGroup.length, 4);
        const gridClass = `media-gallery media-gallery-count-${count}`;
        const itemsHtml = mediaGroup.map(p => renderMediaItemHtml(p)).join('');
        chunks.push(`<div class="${gridClass}">${itemsHtml}</div>`);
      } else {
        chunks.push(renderPart(part));
        i++;
      }
    }
    return chunks.join('');
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
