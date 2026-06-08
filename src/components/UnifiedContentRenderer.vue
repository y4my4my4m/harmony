<template>
  <div 
    class="unified-content-renderer"
    :class="{
      'preview-mode': mode === 'preview',
      'single-line': singleLine,
      'single-emoji': renderer.isSingleEmoji.value
    }"
  >
    <!-- HTML rendering mode (for ActivityPub content like MonyContent) -->
    <div 
      v-if="renderMode === 'html'"
      class="content-html"
      :class="{ 'selectable': selectable }"
      v-html="renderer.formattedHTML.value"
      @click="handleContentClick"
    ></div>
    
    <!-- Component rendering mode (for structured chat content) -->
    <template v-else-if="renderMode === 'components'">
      <template v-for="(part, partIndex) in renderer.renderableContent.value" :key="partIndex">
        <!-- Text content -->
        <span 
          v-if="part && part.type === 'text'" 
          class="text-content"
          :class="{ 
            'selectable': selectable,
            'encrypted-glyphs': props.encrypted
          }"
        >
          <template v-if="props.encrypted">
            <span 
              v-for="(char, idx) in part.text.split('')" 
              :key="idx"
              class="glyph-char"
              :style="{ animationDelay: `${idx * 0.05}s` }"
            >{{ char }}</span>
          </template>
          <template v-else>
            <span v-html="renderTextWithMarkdown(part.text)"></span>
          </template>
        </span>
        
        <!-- User mentions -->
        <span 
          v-else-if="part && part.type === 'mention'" 
          class="mention"
          :class="{ 'federated-mention': isFederatedMention(part) }"
          :title="getMentionTooltip(part)"
          @click="handleMentionClick(part)"
        >
          <template v-if="part.userId">
            <span class="mention-at">@</span>
            <DisplayName :userId="part.userId" :fallback="part.displayName || part.username" :truncate="false" />
            <!-- Show @domain suffix for federated users so the handle is unambiguous -->
            <span v-if="isFederatedMention(part)" class="mention-domain">@{{ part.domain }}</span>
          </template>
          <template v-else>{{ renderer.formatMentionDisplay(part) }}</template>
        </span>

        <!-- Role mentions -->
        <span
          v-else-if="part && part.type === 'role_mention'"
          class="mention role-mention"
          :style="part.roleColor ? { '--role-color': part.roleColor, color: part.roleColor, background: part.roleColor + '1a' } : {}"
        >@{{ part.roleName?.replace(/^@/, '') }}</span>
        
        <!-- Emojis (custom server or unified pack) -->
        <template v-else-if="part && part.type === 'emoji'">
          <!-- Native unicode rendering (when native pack selected) -->
          <span 
            v-if="shouldRenderNativeEmoji(part.emoji)"
            class="native-emoji"
            :class="{ 'single': renderer.isSingleEmoji.value }"
            :title="`:${part.emoji?.name}:`"
          >{{ getNativeEmojiChar(part.emoji) }}</span>
          <!-- SVG/Image rendering (custom emojis or twemoji pack) -->
          <img 
            v-else
            class="emoji-icon"
            :class="{ 'single': renderer.isSingleEmoji.value }"
            :src="getEmojiDisplayUrl(part.emoji)"
            :alt="`:${part.emoji?.name || '?'}:`"
            :title="`:${part.emoji?.name}:`"
            draggable="false"
            @error="(e) => handleEmojiError(e)"
          />
        </template>
        
        <!-- URLs with media preview -->
        <template v-else-if="part && part.type === 'url'">
          <!-- Image URLs -->
          <div 
            v-if="!isPreviewMode && showImages && renderer.isImageUrl(part.url)" 
            class="media-container image-container"
          >
            <div v-if="!imageLoaded[part.url]" class="media-skeleton image-skeleton"></div>
            <img
              :src="part.url"
              @load="handleImageLoad(part.url)"
              @click="handleImageClick(part.url)"
              v-show="imageLoaded[part.url]"
              draggable="false"
              class="content-image"
            />
          </div>
          
          <!-- Video URLs -->
          <div 
            v-else-if="!isPreviewMode && showVideos && renderer.isVideoUrl(part.url)" 
            class="media-container video-container"
          >
            <video
              :src="part.url"
              controls
              class="content-video"
            ></video>
          </div>
          
          <!-- Regular URL links -->
          <a 
            v-else
            :href="part.url" 
            target="_blank" 
            rel="noopener noreferrer"
            class="url-link"
            @click="handleLinkClick(part.url, $event)"
          >
            {{ part.url }}
          </a>
        </template>
        
        <!-- File attachments -->
        <template v-else-if="part && part.type === 'file'">
          <!-- Image files -->
          <div 
            v-if="!isPreviewMode && showImages && part.fileType === 'image'" 
            class="media-container image-container"
          >
            <div v-if="!imageLoaded[part.url]" class="media-skeleton image-skeleton"></div>
            <img
              :src="part.url"
              @load="handleImageLoad(part.url)"
              @click="handleImageClick(part.url)"
              v-show="imageLoaded[part.url]"
              draggable="false"
              class="content-image"
            />
          </div>
          
          <!-- Video files -->
          <div 
            v-else-if="!isPreviewMode && showVideos && part.fileType === 'video'" 
            class="media-container video-container"
          >
            <video
              :src="part.url"
              controls
              class="content-video"
            ></video>
          </div>
          
          <!-- Audio files -->
          <div 
            v-else-if="!isPreviewMode && part.fileType === 'audio'" 
            class="media-container audio-container"
          >
            <div v-if="part.fileName" class="audio-filename">
              {{ part.fileName }}
            </div>
            <audio
              :src="part.url"
              controls
              preload="metadata"
              class="content-audio"
            ></audio>
          </div>
          
          <!-- Other file types or preview mode -->
          <a 
            v-else
            :href="part.url" 
            target="_blank" 
            rel="noopener noreferrer"
            class="file-link"
          >
            <span class="file-icon">📎</span>
            {{ part.fileName || 'file' }}
            <span v-if="part.fileSize" class="file-size">({{ formatFileSize(part.fileSize) }})</span>
          </a>
        </template>
        
        <!-- System messages -->
        <span 
          v-else-if="part && part.type === 'system'" 
          class="system-message"
        >[{{ part.event_type }}]</span>
        
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, onMounted } from 'vue';
import type { MessagePart } from '@/types';
import { useContentRenderer, type ContentRenderOptions } from '@/composables/useContentRenderer';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { escapeHtml, sanitizeMessageHtml } from '@/utils/sanitize';
import DisplayName from '@/components/DisplayName.vue';

interface Props {
  content: MessagePart[] | string | any;
  mode?: 'display' | 'preview';
  renderMode?: 'html' | 'components';
  showImages?: boolean;
  showVideos?: boolean;
  maxPreviewLength?: number;
  singleLine?: boolean;
  enableMarkdown?: boolean;
  selectable?: boolean;
  imageLoaded?: Record<string, boolean>;
  encrypted?: boolean; // Is this message encrypted?
}

const props = withDefaults(defineProps<Props>(), {
  mode: 'display',
  renderMode: 'components',
  showImages: true,
  showVideos: true,
  maxPreviewLength: 500,
  singleLine: false,
  enableMarkdown: true,
  selectable: true,
  imageLoaded: () => ({}),
  encrypted: false
});

const emit = defineEmits<{
  /**
   * Fired when a user mention is clicked.
   * `userIdOrHandle` is the local profile UUID when known, otherwise a
   * `username@domain` handle so the parent can fetch the federated profile.
   */
  'user-mention-click': [userIdOrHandle: string, event: Event];
  'hashtag-click': [tag: string];
  'link-click': [url: string, event: Event];
  'image-load': [url: string];
  'image-click': [url: string];
}>();

// Content renderer setup
const contentOptions: ContentRenderOptions = {
  mode: props.mode,
  showImages: props.showImages,
  showVideos: props.showVideos,
  maxPreviewLength: props.maxPreviewLength,
  singleLine: props.singleLine,
  enableMarkdown: props.enableMarkdown,
  enableClickHandlers: true
};

const contentRef = computed(() => props.content);
// Vue's typed `emit` is a tuple-of-overloads function; useContentRenderer
// expects the simpler `(event, ...args) => void` shape. The runtime call
// signature matches; cast to bridge the type-level mismatch.
const renderer = useContentRenderer(contentRef, contentOptions, emit as unknown as (event: string, ...args: any[]) => void);

// Computed helpers
const isPreviewMode = computed(() => props.mode === 'preview');

// Image loading state
const imageLoaded = ref(props.imageLoaded);


// Event handlers
const handleContentClick = (event: Event) => {
  const target = event.target as HTMLElement;
  
  // Handle image clicks in HTML mode
  if (target.tagName === 'IMG' && target.classList.contains('content-image')) {
    const src = target.getAttribute('src');
    if (src) {
      event.preventDefault();
      event.stopPropagation();
      emit('image-click', src);
    }
    return;
  }
  
  // Handle mention clicks in HTML mode - always navigate locally
  if (target.classList.contains('mention')) {
    event.preventDefault();
    event.stopPropagation();
    const userId = target.getAttribute('data-user-id');
    if (userId) {
      emit('user-mention-click', userId, event);
    }
    return;
  }
  
  // Handle hashtag clicks in HTML mode
  if (target.classList.contains('hashtag')) {
    const tag = target.getAttribute('data-tag');
    if (tag) {
      emit('hashtag-click', tag);
    }
    return;
  }
  
  // Handle link clicks in HTML mode
  if (target.tagName === 'A' && target.classList.contains('url-link')) {
    const url = target.getAttribute('href');
    if (url) {
      emit('link-click', url, event);
    }
    return;
  }
};

const handleMentionClick = (mention: MessagePart) => {
  if (mention.type !== 'mention') return;
  if (mention.userId) {
    emit('user-mention-click', mention.userId, new Event('click'));
    return;
  }
  // Federated user we haven't resolved locally - pass the handle so the parent
  // can fetch via activityPubService.getUserByHandle.
  if (mention.username) {
    const handle = mention.domain
      ? `${mention.username}@${mention.domain}`
      : mention.username;
    emit('user-mention-click', handle, new Event('click'));
  }
};

const currentDomain = import.meta.env.VITE_DOMAIN as string;

const isFederatedMention = (part: MessagePart): boolean => {
  if (part.type !== 'mention') return false;
  return !part.isLocal && !!part.domain && part.domain !== currentDomain && part.domain !== 'discord.com';
};

const getMentionTooltip = (part: MessagePart): string => {
  if (part.type !== 'mention') return '';
  if (part.domain === 'discord.com') {
    return `Discord user: ${part.displayName || part.username}`;
  }
  if (!part.isLocal && part.domain) {
    return `@${part.username}@${part.domain}`;
  }
  return part.displayName || part.username || '';
};

const handleImageLoad = (url: string) => {
  imageLoaded.value[url] = true;
  emit('image-load', url);
};

const handleImageClick = (url: string) => {
  emit('image-click', url);
};

const handleEmojiError = (e: Event) => {
  const img = e.target as HTMLImageElement;
  if (!img) return;
  img.onerror = null;
  img.style.display = 'none';
  const fallback = document.createElement('span');
  fallback.className = 'emoji-icon emoji-fallback';
  fallback.title = img.alt || 'Broken emoji';
  fallback.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="2" y1="2" x2="22" y2="22"/><path d="M10.41 10.41a2 2 0 1 1-2.83-2.83"/><path d="M21 15V5a2 2 0 0 0-2-2H9"/><path d="M3.59 3.59A1.99 1.99 0 0 0 3 5v14a2 2 0 0 0 2 2h14c.55 0 1.052-.22 1.41-.59"/></svg>';
  img.parentNode?.insertBefore(fallback, img);
};

const handleLinkClick = (url: string, event: Event) => {
  emit('link-click', url, event);
};

// Initialize unified emoji service
const { resolveEmoji, isNativePack, isLoaded: emojiServiceLoaded } = useUnifiedEmoji();

onMounted(() => {
  // Emoji service auto-loads
});

// Utility functions
const getEmojiDisplayUrl = (emoji: any) => {
  if (!emoji) return '';
  
  // If emoji has native/unicode and no URL, it should render as native
  // Return empty to let the template use the native span
  if ((emoji.native || emoji.unicode) && !emoji.url) {
    return '';
  }
  
  // If native pack is selected and emoji has unicode, prefer native rendering
  if (isNativePack.value && (emoji.native || emoji.unicode)) {
    return '';
  }
  
  // If emoji has a URL (server custom emoji or unified pack SVG), use it
  if (emoji.url) {
    return getEmojiUrl(emoji.url, 96);
  }
  
  // If emoji has a name, try to resolve via unified service
  if (emoji.name && emojiServiceLoaded.value) {
    const resolved = resolveEmoji(emoji.name);
    if (resolved.display.type === 'svg') {
      return resolved.display.content;
    }
  }
  
  return '';
};

// Check if emoji should render as native unicode
const shouldRenderNativeEmoji = (emoji: any): boolean => {
  if (!emoji) return false;
  
  // Server custom emojis (uploaded to Supabase storage) always use URL
  if (emoji.url) {
    // Check if this is a Supabase storage emoji (server custom emoji)
    const isSupabaseStorage = emoji.url.includes('/storage/v1/') || 
                               emoji.url.includes('/object/public/emojis/');
    if (isSupabaseStorage) {
      return false; // Server emoji - use URL
    }
    
    // If it's a unified pack SVG URL but native pack is selected, prefer native
    if (emoji.url.includes('/assets/emojis/') && isNativePack.value) {
      if (emoji.native || emoji.unicode) {
        return true; // Has native, show that
      }
    }
  }
  
  // If emoji has native/unicode and NO valid URL, always show native
  // This handles the case where emoji comes from unified content parsing
  if ((emoji.native || emoji.unicode) && !emoji.url) {
    return true;
  }
  
  // If native pack selected and we can resolve unicode
  if (isNativePack.value) {
    // Check if we have unicode available directly
    if (emoji.native || emoji.unicode) return true;
    
    // Try to resolve via unified service when name is available
    if (emoji.name && emojiServiceLoaded.value) {
      const resolved = resolveEmoji(emoji.name);
      if (resolved.unicode && resolved.unicode !== emoji.name) {
        return true;
      }
      if (resolved.display.type === 'native' && resolved.display.content !== emoji.name) {
        return true;
      }
    }
  }
  
  return false;
};

// Get unicode for native emoji rendering
const getNativeEmojiChar = (emoji: any): string => {
  if (!emoji) return '';
  
  // If emoji already has native/unicode property set
  if (emoji.native) return emoji.native;
  if (emoji.unicode) return emoji.unicode;
  
  // Try to resolve via unified service when name is available
  if (emoji.name && emojiServiceLoaded.value) {
    const resolved = resolveEmoji(emoji.name);
    if (resolved.unicode && resolved.unicode !== emoji.name) {
      return resolved.unicode;
    }
    // If display is native, use the content (might be the actual unicode)
    if (resolved.display.type === 'native' && resolved.display.content !== emoji.name) {
      return resolved.display.content;
    }
  }
  
  // Fallback: show as :shortcode: format so it's clear it's an emoji
  return emoji.name ? `:${emoji.name}:` : '';
};

const renderTextWithMarkdown = (text: string | undefined): string => {
  if (!text) return '';

  const isSingle = renderer.isSingleEmoji.value;

  // ESCAPE the raw user text FIRST. Every transform below operates on
  // already-escaped text, so it can safely splice in trusted tags without
  // letting user-supplied HTML (e.g. `<style>`, `<img onerror=...>`) survive.
  // The previous implementation "protected" user HTML tags from the escape
  // pass which let arbitrary tags through verbatim - see the XSS audit issue.
  let rendered = escapeHtml(text);

  // Now splice in our own emoji <img>/<span> markup using sources we own.
  if (!isNativePack.value && emojiServiceLoaded.value) {
    const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
    rendered = rendered.replace(emojiRegex, (match) => {
      const resolved = resolveEmoji(match);
      if (resolved.display.type === 'svg') {
        const sizeClass = isSingle ? 'inline-emoji single' : 'inline-emoji';
        const altRaw = resolved.shortcode || match;
        return `<img class="${sizeClass}" src="${escapeHtml(resolved.display.content)}" alt="${escapeHtml(altRaw)}" draggable="false" />`;
      }
      return match;
    });
  } else if (isSingle) {
    const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
    rendered = rendered.replace(emojiRegex, (match) => {
      return `<span class="native-emoji single">${match}</span>`;
    });
  }

  if (!props.enableMarkdown) {
    // Even with markdown disabled, run DOMPurify so any malformed input that
    // sneaks past our escape (e.g. via emoji SVG content) is stripped.
    return sanitizeMessageHtml(rendered);
  }

  rendered = rendered.replace(/\n/g, '<br>');
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/\*(.*?)\*/g, '<em>$1</em>');
  rendered = rendered.replace(/`(.*?)`/g, '<code>$1</code>');

  rendered = rendered.replace(/(?<![&\w])#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');

  // Final defense-in-depth pass: strip any tag not on the message allowlist.
  return sanitizeMessageHtml(rendered);
};

const formatFileSize = (bytes: number): string => {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
};
</script>

<style scoped>
.unified-content-renderer {
  line-height: 1.375;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.unified-content-renderer.preview-mode {
  opacity: 0.7;
  font-size: 0.875rem;
}

.unified-content-renderer.single-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.unified-content-renderer.single-emoji {
  font-size: 1.2em;
}

/* Text content */
.text-content {
  /* color: var(--text-secondary); */
  color: var(--text-primary);
}

.text-content.selectable {
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

/* Mentions */
.mention {
  background-color: #3c4270;
  border-radius: 3px;
  padding: 0 2px;
  font-weight: 500;
  cursor: pointer;
  color: #c9c9ee;
  display: inline-block;
  transition: background-color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.mention .mention-at {
  opacity: 0.7;
}

.mention .mention-domain {
  opacity: 0.7;
  margin-left: 1px;
}

.mention:hover {
  background-color: var(--harmony-primary);
  color: rgba(255,255,255,0.9);
}

.mention.federated-mention::after {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-left: 3px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'%3E%3Cpath fill='%2310b981' d='M17.9%2C17.39C17.64%2C16.59 16.89%2C16 16%2C16H15V13A1%2C1 0 0%2C0 14%2C12H8V10H10A1%2C1 0 0%2C0 11%2C9V7H13A2%2C2 0 0%2C0 15%2C5V4.59C17.93%2C5.77 20%2C8.64 20%2C12C20%2C14.08 19.2%2C15.97 17.9%2C17.39M11%2C19.93C7.05%2C19.44 4%2C16.08 4%2C12C4%2C11.38 4.08%2C10.79 4.21%2C10.21L9%2C15V16A2%2C2 0 0%2C0 11%2C18M12%2C2A10%2C10 0 0%2C0 2%2C12A10%2C10 0 0%2C0 12%2C22A10%2C10 0 0%2C0 22%2C12A10%2C10 0 0%2C0 12%2C2Z'/%3E%3C/svg%3E");
  background-size: contain;
  background-repeat: no-repeat;
  vertical-align: middle;
}

.role-mention {
  cursor: default;
}
.role-mention:hover {
  filter: brightness(1.15);
}

/* Make HTML content selectable */
.content-html.selectable,
.content-html.selectable :deep(*) {
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  cursor: text;
}

/* Exclude interactive elements from text cursor */
.content-html.selectable :deep(a),
.content-html.selectable :deep(.mention),
.content-html.selectable :deep(.hashtag) {
  cursor: pointer;
}

/* HTML mode mentions (for ActivityPub content) */
.content-html :deep(.mention) {
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
  /* color: var(--harmony-accent); */
  cursor: pointer;
  padding: 1px 2px;
  border-radius: 3px;
  margin-right: 2px;
  transition: background 0.2s ease;
}

.content-html :deep(.mention:hover) {
  background: rgba(16, 185, 129, 0.2);
  text-decoration: underline;
}

/* Hashtags */
.content-html :deep(.hashtag),
:deep(.hashtag) {
  background-color: var(--harmony-primary);
  margin: 0 2px;
  border-radius: 3px;
  padding: 0 3px;
  cursor: pointer;
  font-weight: 500;
  color: var(--text-primary);
  display: inline-block;
  transition: background-color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  color: var(--text-primary);

}

.content-html :deep(.hashtag:hover),
:deep(.hashtag:hover) {
  background-color: var(--harmony-primary-hover);
  color: var(--text-primary);
}

/* Emojis */
.emoji-icon,
.emoji-fallback,
.inline-emoji {
  width: auto;
  max-width: 120px;
  height: 24px;
  vertical-align: middle;
  margin: 0 1px;
}

/* Inline emojis in text (via v-html) */
:deep(.inline-emoji) {
  height: 1.2em;
  width: auto;
  vertical-align: -0.2em;
  margin: 0 1px;
}

:deep(.inline-emoji.single) {
  height: 64px;
  max-width: 64px;
  vertical-align: middle;
}

:deep(.native-emoji.single) {
  font-size: 3em;
  line-height: 1;
}

.emoji-icon.single {
  height: 64px;
}

.native-emoji {
  font-size: 1.25em;
  line-height: 1;
  vertical-align: middle;
  margin: 0 1px;
}

.native-emoji.single {
  font-size: 3em;
}

.content-html :deep(.emoji-icon) {
  width: 20px;
  height: 20px;
  vertical-align: middle;
  margin: 0 1px;
  object-fit: contain;
}

.emoji-fallback {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  vertical-align: middle;
  color: var(--text-muted, #72767d);
  opacity: 0.5;
}

.emoji-fallback svg {
  width: 100%;
  height: 100%;
}

.content-html :deep(.emoji-icon.single) {
  width: 48px;
  height: 48px;
  margin: 0 2px;
}

/* URLs */
.url-link {
  color: #3b82f6;
  text-decoration: underline;
  transition: color 0.2s ease;
}

.url-link:hover {
  color: #2563eb;
}

.content-html :deep(.url-link) {
  color: #3b82f6;
  text-decoration: underline;
}

.content-html :deep(.url-link:hover) {
  color: #2563eb;
}

.content-html :deep(.media-container) {
  margin: 4px 0 8px 0;
  max-width: 100%;
}

/* Content-embedded media grid (Misskey/federated inline images) */
.content-html :deep(.media-gallery) {
  margin-top: 0.75rem;
  border-radius: 12px;
  overflow: hidden;
  display: block;
}

.content-html :deep(.media-gallery.media-gallery-count-1) {
  display: block;
}

.content-html :deep(.media-gallery.media-gallery-count-2) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}

.content-html :deep(.media-gallery.media-gallery-count-3) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
}

.content-html :deep(.media-gallery.media-gallery-count-3 .media-gallery__item:first-child) {
  grid-row: 1 / 3;
}

.content-html :deep(.media-gallery.media-gallery-count-4) {
  display: grid;
  grid-template-columns: 1fr 1fr;
  grid-template-rows: 1fr 1fr;
  gap: 2px;
}

.content-html :deep(.media-gallery__item) {
  overflow: hidden;
  background: var(--background-secondary, #313338);
}

.content-html :deep(.media-gallery__item img),
.content-html :deep(.media-gallery__item video) {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

.content-html :deep(.media-gallery.media-gallery-count-1 .media-gallery__item img),
.content-html :deep(.media-gallery.media-gallery-count-1 .media-gallery__item video) {
  max-height: 400px;
  object-fit: contain;
  background: black;
}

.content-html :deep(.content-image),
.content-html :deep(.content-video) {
  max-width: 100%;
  max-height: 480px;
  border-radius: 4px;
  cursor: pointer;
}

.content-html :deep(.content-video) {
  cursor: default;
  width: 100%;
}

.content-html :deep(.youtube-embed) {
  aspect-ratio: 16 / 9;
  max-width: 560px;
  border-radius: 8px;
  overflow: hidden;
  background: #000;
}

.content-html :deep(.youtube-embed iframe) {
  width: 100%;
  height: 100%;
  border: none;
  display: block;
}

.content-html :deep(.content-audio) {
  width: 100%;
  max-width: 450px;
}

.content-html :deep(.audio-container) {
  margin: 8px 0;
}

/* Media containers */
.media-container {
  margin: 14px 0 8px 0;
  max-width: 100%;
}

.content-image,
.content-video {
  max-width: 100%;
  border-radius: 4px;
  cursor: pointer;
}

.content-video {
  cursor: default;
}

.content-audio {
  width: 100%;
  max-width: 450px;
}

.audio-container {
  margin: 8px 0;
}

.audio-filename {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

/* Media loading skeletons */
.media-skeleton {
  background: linear-gradient(90deg, var(--background-secondary) 25%, var(--background-quinary) 50%, var(--background-secondary) 75%);
  background-size: 200% 100%;
  animation: loading 1.5s infinite;
  border-radius: 4px;
}

.image-skeleton {
  height: 200px;
  width: 100%;
}

@keyframes loading {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

/* Files */
.file-link {
  color: var(--text-secondary);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color 0.2s ease;
}

.file-link:hover {
  color: var(--text-primary);
  text-decoration: underline;
}

.file-icon {
  font-size: 1.1em;
}

.file-size {
  opacity: 0.7;
  font-size: 0.9em;
}

/* System messages */
.system-message {
  color: var(--text-muted);
  font-style: italic;
  opacity: 0.8;
}

/* Encrypted messages */
.encrypted-placeholder {
  font-family: 'IBM Plex Mono', 'SFMono-Regular', Menlo, Monaco, Consolas, 'Liberation Mono', monospace;
  letter-spacing: 0.05em;
  user-select: none;
  opacity: 0.7;
  background: rgba(255, 255, 255, 0.04);
  border-radius: 3px;
  padding: 0 4px;
  animation: encrypted-flicker 3s infinite;
}

/* Encrypted glyphs styles - uses global design-system.css */

/* Typography */
.content-html :deep(strong),
:deep(strong) {
  font-weight: 600;
  color: var(--text-primary);
}

.content-html :deep(em),
:deep(em) {
  font-style: italic;
  color: #e3e5e8;
}

.content-html :deep(code),
:deep(code) {
  background-color: var(--background-tertiary);
  color: #f8f8f2;
  padding: 2px 4px;
  border-radius: 3px;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 0.875em;
}

.content-html :deep(br) {
  line-height: 1.375;
}
</style>
