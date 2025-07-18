<!-- MonyContent - Render ActivityPub post content with rich formatting -->
<template>
  <div class="mony-content" v-html="formattedContent" @click="handleClick"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';

interface Props {
  content: string | any[] | any; // Can be string, JSONB array, or other format
  isPreview?: boolean; // For reply previews - truncate but preserve mentions
  previewLength?: number; // Maximum length for previews
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
}>();

// Initialize emoji cache store for emoji lookup
const emojiCacheStore = useEmojiCacheStore();

// Track if the emoji cache is ready
const isCacheReady = computed(() => emojiCacheStore.isInitialized);

// Get resolved emoji list (same as ChatComponent) - reactive to cache changes
const resolvedEmojiList = computed(() => {
  return emojiCacheStore.resolvedEmojis;
});

// Find emoji by name (exact same as ChatComponent) - now with cache readiness check
const findEmojiByName = (name: string) => {
  // If cache isn't ready, return undefined to prevent errors
  if (!isCacheReady.value) {
    return undefined;
  }
  
  for (const serverId in resolvedEmojiList.value) {
    const server = resolvedEmojiList.value[serverId];
    const emoji = server.emojis.find((e: any) => e.name === name);
    if (emoji) {
      return emoji;
    }
  }
  return undefined;
};

// Helper to handle both ActivityPub converted content and our internal JSON format  
const flattenContentToString = (content: any): string => {
  // Handle string content - could be JSON string or plain text
  if (typeof content === 'string') {
    // Try to parse as JSON first
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return flattenContentToString(parsed);
      }
    } catch {
      // If not JSON, treat as plain text
      return content;
    }
  }
  
  // Our internal format is JSON array - convert to text for processing
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part && typeof part === 'object' && part.text) return part.text;
        if (part && typeof part === 'object' && part.type === 'text') return part.text;
        if (part && typeof part === 'object' && part.type === 'mention') {
          // Handle mention objects from ActivityPub conversion
          if (part.username && part.domain && !part.isLocal) {
            return `@${part.username}@${part.domain}`;
          } else if (part.username) {
            return `@${part.username}`;
          }
          // Fallback to legacy format if needed
          return part.mention || `@${part.username || 'unknown'}`;
        }
        if (part && typeof part === 'object' && part.type === 'url') {
          return part.text || part.url || '';
        }
        return '';
      })
      .join('');
  }
  
  if (typeof content === 'object' && content !== null) {
    // Try to parse as JSON string if it looks like it
    try {
      const parsed = JSON.parse(JSON.stringify(content));
      if (Array.isArray(parsed)) {
        return flattenContentToString(parsed);
      }
    } catch {
      // Ignore JSON parsing errors
    }
    return content.toString();
  }
  
  return '';
};

// Check if content is a single emoji
const isSingleEmoji = computed(() => {
  const trimmedContent = flattenContentToString(props.content).trim();
  // Check if content matches the pattern of a single emoji (e.g., ":smile:")
  const singleEmojiMatch = trimmedContent.match(/^:([a-zA-Z0-9_+-]+):$/);
  if (singleEmojiMatch) {
    const emojiName = singleEmojiMatch[1];
    const emoji = findEmojiByName(emojiName);
    return !!emoji; // Return true if emoji exists
  }
  return false;
});

// Calculate visual length of content (counting emojis, mentions, URLs as 1 each)
const calculateVisualLength = (content: any): number => {
  if (Array.isArray(content)) {
    return content.reduce((total, item) => {
      if (!item || typeof item !== 'object') {
        return total + String(item || '').length;
      }
      
      switch (item.type) {
        case 'text':
          return total + (item.text || '').length;
        case 'emoji':
        case 'mention':
        case 'url':
          return total + 1; // Count non-text items as 1 character each
        default:
          return total + String(item.text || item || '').length;
      }
    }, 0);
  }
  
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return calculateVisualLength(parsed);
      }
    } catch {
      // If not JSON, count actual string length
      return content.length;
    }
  }
  
  return String(content || '').length;
};

const formattedContent = computed(() => {
  // Standardized content processing: handle all JSONB content the same way
  const processedContent = processJsonbContent(props.content);
  
  // Apply preview truncation based on visual length, not raw HTML length
  if (props.isPreview) {
    const visualLength = calculateVisualLength(props.content);
    const maxLength = props.previewLength || 100;
    
    if (visualLength > maxLength) {
      const truncated = applyVisualTruncation(props.content, maxLength);
      return processJsonbContent(truncated);
    }
  }
  
  return processedContent;
});

// Standardized JSONB content processor - ONE function to rule them all!
const processJsonbContent = (content: any): string => {
  // Handle arrays (standard JSONB format)
  if (Array.isArray(content)) {
    return content.map(item => processContentItem(item)).join('');
  }
  
  // Handle string content (try to parse as JSON first)
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return processJsonbContent(parsed);
      }
    } catch {
      // If not JSON, process as plain text
      return processPlainText(content);
    }
  }
  
  // Fallback
  return String(content || '');
};

// Process individual content items from JSONB array
const processContentItem = (item: any): string => {
  if (!item || typeof item !== 'object') {
    return String(item || '');
  }

  switch (item.type) {
    case 'text': {
      let text = item.text || '';
      
      // Format hashtags
      text = text.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
      
      // Format line breaks
      text = text.replace(/\n/g, '<br>');
      
      // Format custom emojis
      text = text.replace(/:([a-zA-Z0-9_+-]+):/g, (match: string, emojiName: string) => {
        const emoji = findEmojiByName(emojiName);
        if (emoji && emoji.url) {
          const emojiClass = isSingleEmoji.value ? 'custom-emoji single' : 'custom-emoji';
          return `<img src="${emoji.url}" alt=":${emojiName}:" class="${emojiClass}" title=":${emojiName}:" draggable="false" />`;
        }
        return `<span class="emoji-shortcode" title="${emojiName}">${match}</span>`;
      });
      
      return text;
    }

    case 'mention': {
      const username = item.username || 'unknown';
      const isLocal = item.isLocal ?? true;
      
      // For local users, show just @username
      // For remote users, show @username@domain
      const handle = isLocal ? `@${username}` : `@${username}@${item.domain || ''}`;
      const displayHandle = isLocal ? `@${username}` : `@${username}@${item.domain || ''}`;
      
      return `<span class="mention" data-handle="${handle}">${displayHandle}</span>`;
    }

    case 'url': {
      const url = item.url || '';
      const linkText = item.text || url;
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="url-link">${linkText}</a>`;
    }

    case 'emoji': {
      // Handle emoji objects directly from structured content
      const emoji = item.emoji;
      
      if (emoji && emoji.url) {
        const emojiClass = isSingleEmoji.value ? 'custom-emoji single' : 'custom-emoji';
        return `<img src="${emoji.url}" alt=":${emoji.name}:" class="${emojiClass}" title=":${emoji.name}:" draggable="false" />`;
      }
      // Fallback to shortcode if emoji data is incomplete
      return `<span class="emoji-shortcode" title="${emoji?.name || 'emoji'}">${emoji?.name ? `:${emoji.name}:` : ':emoji:'}</span>`;
    }

    default:
      return String(item.text || item || '');
  }
};

// Process plain text content (fallback for non-JSONB content)
const processPlainText = (text: string): string => {
  let formatted = text;
  
  // Format hashtags FIRST
  formatted = formatted.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
  
  // Format mentions SECOND  
  formatted = formatted.replace(/@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g, (match, username, domain) => {
    const handle = domain ? `@${username}@${domain}` : `@${username}`;
    return `<span class="mention" data-handle="${handle}">${handle}</span>`;
  });
  
  // Format URLs THIRD (before emojis to avoid conflicts)
  formatted = formatted.replace(/(https?:\/\/[^\s]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer" class="url-link">$1</a>');
  
  // Format line breaks
  formatted = formatted.replace(/\n/g, '<br>');
  
  // Format custom emojis LAST to avoid URL conflicts
  formatted = formatted.replace(/:([a-zA-Z0-9_+-]+):/g, (match, emojiName) => {
    const emoji = findEmojiByName(emojiName);
    if (emoji && emoji.url) {
      const emojiClass = isSingleEmoji.value ? 'custom-emoji single' : 'custom-emoji';
      return `<img src="${emoji.url}" alt=":${emojiName}:" class="${emojiClass}" title=":${emojiName}:" draggable="false" />`;
    }
    return `<span class="emoji-shortcode" title="${emojiName}">${match}</span>`;
  });
  
  return formatted;
};

// Visual truncation that works on raw content before HTML processing
const applyVisualTruncation = (content: any, maxLength: number): any => {
  if (Array.isArray(content)) {
    const result = [];
    let currentLength = 0;
    
    for (const item of content) {
      if (currentLength >= maxLength) break;
      
      if (!item || typeof item !== 'object') {
        const str = String(item || '');
        const remainingLength = maxLength - currentLength;
        if (str.length <= remainingLength) {
          result.push(item);
          currentLength += str.length;
        } else {
          // Truncate text and add ellipsis
          result.push(str.substring(0, remainingLength) + '...');
          break;
        }
        continue;
      }
      
      switch (item.type) {
        case 'text': {
          const textLength = (item.text || '').length;
          const remainingLength = maxLength - currentLength;
          
          if (textLength <= remainingLength) {
            result.push(item);
            currentLength += textLength;
          } else {
            // Truncate text and add ellipsis
            result.push({
              ...item,
              text: (item.text || '').substring(0, remainingLength) + '...'
            });
            currentLength = maxLength;
            break;
          }
          break;
        }
        case 'emoji':
        case 'mention':
        case 'url':
          // These count as 1 character each
          if (currentLength < maxLength) {
            result.push(item);
            currentLength += 1;
          }
          break;
        default: {
          const defaultLength = String(item.text || item || '').length;
          const remainingLength = maxLength - currentLength;
          if (defaultLength <= remainingLength) {
            result.push(item);
            currentLength += defaultLength;
          } else {
            result.push(String(item.text || item || '').substring(0, remainingLength) + '...');
            currentLength = maxLength;
            break;
          }
          break;
        }
      }
      
      if (currentLength >= maxLength) break;
    }
    
    return result;
  }
  
  // For non-array content, fall back to string truncation
  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content);
      if (Array.isArray(parsed)) {
        return JSON.stringify(applyVisualTruncation(parsed, maxLength));
      }
    } catch {
      // Not JSON, truncate as string
      return content.length > maxLength ? content.substring(0, maxLength) + '...' : content;
    }
  }
  
  return content;
};

// Add click event handling for mentions and hashtags
const handleClick = (event: Event) => {
  const target = event.target as HTMLElement;
  
  if (target.classList.contains('mention')) {
    const handle = target.getAttribute('data-handle');
    if (handle) {
      emit('user-mention-click', handle);
    }
  } else if (target.classList.contains('hashtag')) {
    const tag = target.getAttribute('data-tag');
    if (tag) {
      emit('hashtag-click', tag);
    }
  }
};
</script>

<style scoped>
.mony-content {
  line-height: 1.6;
  word-wrap: break-word;
  flex-wrap: wrap;
  display: flex;
  user-select: text;
}

.mony-content :deep(.hashtag) {
  color: #3b82f6;
  font-weight: 500;
  cursor: pointer;
}

.mony-content :deep(.hashtag:hover) {
  text-decoration: underline;
}

.mony-content :deep(.mention) {
  color: #10b981;
  font-weight: 500;
  cursor: pointer;
  background: rgba(16, 185, 129, 0.1);
  padding: 1px 2px;
  border-radius: 3px;
  margin-right: 2px;
  transition: background 0.2s ease;
}

.mony-content :deep(.mention:hover) {
  background: rgba(16, 185, 129, 0.2);
  text-decoration: underline;
}

.mony-content :deep(.url-link) {
  color: #3b82f6;
  text-decoration: underline;
}

.mony-content :deep(.url-link:hover) {
  color: #2563eb;
}

.mony-content :deep(.custom-emoji) {
  width: 20px;
  height: 20px;
  vertical-align: middle;
  margin: 0 1px;
  object-fit: contain;
}

.mony-content :deep(.custom-emoji.single) {
  width: 48px;
  height: 48px;
  margin: 0 2px;
}

.mony-content :deep(.emoji-shortcode) {
  font-size: 0.9em;
  background: rgba(255, 255, 255, 0.1);
  padding: 1px 3px;
  border-radius: 3px;
  color: #fbbf24;
  font-weight: 500;
}
</style>
