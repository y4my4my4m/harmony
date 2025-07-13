<!-- MonyContent - Render ActivityPub post content with rich formatting -->
<template>
  <div class="mony-content" v-html="formattedContent" @click="handleClick"></div>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';

interface Props {
  content: string | any[] | any; // Can be string, JSONB array, or other format
}

const props = defineProps<Props>();

const emit = defineEmits<{
  'user-mention-click': [handle: string];
  'hashtag-click': [tag: string];
}>();

// Initialize emoji cache store for emoji lookup
const emojiCacheStore = useEmojiCacheStore();

// Get resolved emoji list (same as ChatComponent)
const resolvedEmojiList = computed(() => {
  return emojiCacheStore.resolvedEmojis;
});

// Find emoji by name (exact same as ChatComponent)
const findEmojiByName = (name: string) => {
  for (const serverId in resolvedEmojiList.value) {
    const server = resolvedEmojiList.value[serverId];
    const emoji = server.emojis.find((e: any) => e.name === name);
    if (emoji) {
      return emoji;
    }
  }
  return undefined;
};

// Helper to flatten ActivityPub content to plain text
const flattenContentToString = (content: any): string => {
  if (typeof content === 'string') {
    return content;
  }
  
  if (Array.isArray(content)) {
    return content
      .map(part => {
        if (typeof part === 'string') return part;
        if (part.type === 'text') return part.text || '';
        if (part.type === 'mention') {
          // Handle new structured mention format
          if (part.username && part.domain) {
            return part.isLocal ? `@${part.username}` : `@${part.username}@${part.domain}`;
          }
          // Fallback to legacy format if needed
          return part.mention || `@${part.username || 'unknown'}`;
        }
        if (part.type === 'url') return part.url || '';
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

const formattedContent = computed(() => {
  let formatted = flattenContentToString(props.content);
  
  // Format hashtags FIRST
  formatted = formatted.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
  
  // Format mentions SECOND  
  formatted = formatted.replace(/@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g, (match, username, domain) => {
    // TODO: This should check user's is_local field from database instead of hardcoding domain
    // For now, assume no domain means local, domain means remote
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
      // Add 'single' class if this is a single emoji message
      const emojiClass = isSingleEmoji.value ? 'custom-emoji single' : 'custom-emoji';
      return `<img src="${emoji.url}" alt=":${emojiName}:" class="${emojiClass}" title=":${emojiName}:" draggable="false" />`;
    }
    // Fallback to styled shortcode if emoji not found
    return `<span class="emoji-shortcode" title="${emojiName}">${match}</span>`;
  });
  
  return formatted;
});

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
  padding: 1px 4px;
  border-radius: 3px;
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
