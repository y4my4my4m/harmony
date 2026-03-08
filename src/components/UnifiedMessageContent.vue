<template>
  <div class="unified-content">
    <!-- Edit mode -->
    <div v-if="editableMessageId === messageId" class="edit-container">
      <textarea 
        :id="`edit-input-${messageId}`"
        v-model="localEditableContent" 
        @keydown="handleKeyDown"
        @input="handleInput"
        class="edit-textarea"
        placeholder="Edit message"
        ref="editTextarea"
        rows="1"
        @dragstart.prevent
      ></textarea>
      <div class="edit-actions">
        <span class="edit-hint">
          escape to <span class="edit-action" @click="handleCancelEdit">cancel</span> • 
          enter to <span class="edit-action" @click="handleSaveEdit">save</span>
        </span>
      </div>
      <!-- Auto-suggest component -->
      <AutoSuggest
        :isVisible="autoSuggest.state.value.isActive"
        :suggestions="autoSuggest.suggestions.value"
        :position="autoSuggest.state.value.position"
        :selectedIndex="autoSuggest.state.value.selectedIndex"
        :headerText="autoSuggest.headerText.value"
        @select="handleSuggestionSelect"
      >
        <template #default="{ suggestion }">
          <div class="suggest-item-content">
            <img 
              v-if="suggestion.url || suggestion.avatar" 
              :src="getEmojiUrl(suggestion.url, 64) || suggestion.avatar" 
              :alt="suggestion.name || suggestion.display_name"
              class="suggest-icon"
            />
            <div class="suggest-text">
              <span class="suggest-name">{{ suggestion.display_name || suggestion.name }}</span>
              <span v-if="suggestion.username" class="suggest-username">{{ suggestion.username }}</span>
              <span v-if="suggestion.server_name" class="suggest-server">{{ suggestion.server_name }}</span>
            </div>
          </div>
        </template>
      </AutoSuggest>
    </div>
    
    <!-- Display mode -->
    <div v-else class="content-display" :class="{ 'system-message-content': isSystem, 'encrypted-glyphs': encrypted && !decrypted }">
      <template v-for="(part, partIndex) in content" :key="partIndex">
        <!-- Text content with markdown-style formatting and code blocks -->
        <template 
          v-if="part && typeof part === 'object' && part.type === 'text'"
        >
          <!-- Encrypted glyphs -->
          <template v-if="encrypted && !decrypted">
            <!-- Clickable version (user has encryption set up) -->
            <span 
              v-if="canDecrypt"
              class="encrypted-click-target"
              @click="handleDecryptClick"
              :title="decrypting ? 'Decrypting...' : 'Click to decrypt'"
            >
              <span v-if="decrypting" class="decrypt-loading">
                <span class="decrypt-spinner">🔓</span>
              </span>
              <span 
                v-for="(char, charIdx) in generateGlyphs(part.text || 'encrypted')" 
                :key="`${partIndex}-${charIdx}`"
                class="glyph-char"
                :class="{ 'decrypting': decrypting }"
                :style="{ animationDelay: `${charIdx * 0.05}s` }"
              >{{ char }}</span>
            </span>
            <!-- Non-clickable version (user doesn't have encryption) -->
            <span v-else class="encrypted-no-decrypt">
              <span 
                v-for="(char, charIdx) in generateGlyphs(part.text || 'encrypted')" 
                :key="`${partIndex}-${charIdx}`"
                class="glyph-char"
                :style="{ animationDelay: `${charIdx * 0.05}s` }"
              >{{ char }}</span>
            </span>
          </template>
          <!-- Normal text -->
          <template v-else v-for="(segment, segmentIndex) in renderTextSegments(part.text)" :key="`${partIndex}-${segmentIndex}`">
            <span 
              v-if="segment.type === 'text'" 
              class="text-content"
              v-html="segment.content"
            ></span>
            <CodeBlock 
              v-else-if="segment.type === 'codeblock'"
              :code="segment.code!"
              :language="segment.language!"
            />
          </template>
        </template>
        
        <!-- User mentions -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'mention'" 
          class="mention" 
          :class="{ 'bridged-mention': isBridgedMention(part), 'discord-mention': part.domain === 'discord.com' }"
          @click="handleMentionClick(part, $event)"
          :title="getMentionTooltip(part)"
        >{{ formatMentionDisplay(part) }}</span>

        <!-- Role mentions -->
        <span
          v-else-if="part && typeof part === 'object' && part.type === 'role_mention'"
          class="mention role-mention"
          :style="part.roleColor ? { color: part.roleColor, backgroundColor: part.roleColor + '1a' } : {}"
        >@{{ (part.roleName || 'Unknown Role').replace(/^@/, '') }}</span>
        
        <!-- Hashtags -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'hashtag'" 
          class="hashtag" 
          @click="handleHashtagClick(part.name, $event)"
          :title="`Used ${part.count || 0} times`"
        >#{{ part.name }}</span>
        
        <!-- Custom emojis -->
        <img 
          v-else-if="part && typeof part === 'object' && part.type === 'emoji'"
          class="emoji-icon"
          :class="{ 'single': isSingleEmoji }"
          :src="getEmojiUrl(part.emoji.url, 96)"
          :alt="`:${part.emoji?.name || '?'}:`"
          :title="`:${part.emoji?.name}:`"
          draggable="false"
          @error="handleEmojiLoadError"
        />
        
        <!-- URLs (with special handling for images and videos) -->
        <template v-else-if="part && typeof part === 'object' && part.type === 'url'">
          <!-- Image URLs -->
          <div 
            v-if="isImageUrl(part.url)" 
            class="media-container image-container"
          >
            <div v-if="!imageLoadedState[part.url]" class="media-skeleton image-skeleton"></div>
            <img
              :src="part.url"
              @load="handleImageLoad(part.url)"
              @click="$emit('open-lightbox', part.url)"
              v-show="imageLoadedState[part.url]"
              draggable="false"
              class="content-image"
            />
          </div>

          <!-- Video URLs -->
          <div 
            v-else-if="isVideoUrl(part.url)" 
            class="media-container video-container"
            :ref="el => { if (el) videoContainers[partIndex] = el as HTMLElement }"
          >
            <video
              :src="part.url"
              controls
              class="content-video"
              preload="metadata"
              :data-video-index="partIndex"
              @play="handleVideoPlay"
              @pause="handleVideoPause"
            ></video>
          </div>

          <!-- Audio URLs -->
          <div 
            v-else-if="isAudioUrl(part.url)" 
            class="media-container audio-container"
          >
            <audio
              :src="part.url"
              controls
              preload="metadata"
              class="content-audio"
            ></audio>
          </div>

          <!-- Regular URL links -->
          <a 
            v-else
            :href="part.url" 
            target="_blank" 
            rel="noopener noreferrer"
            class="url-link"
          >{{ part.url }}</a>
          <ProviderEmbedSwitch
            v-if="resolveEmbedPayload(part) && !isImageUrl(part.url) && !isVideoUrl(part.url) && !isAudioUrl(part.url)"
            :payload="resolveEmbedPayload(part)!"
            :message-id="messageId"
            :key="`${messageId}-embed-${part.embedId || part.url}`"
            @embed-loaded="handleEmbedLoad"
          />
        </template>
        
        <template v-else-if="part && typeof part === 'object' && part.type === 'embed'">
          <ProviderEmbedSwitch
            v-if="resolveEmbedPayload(part)"
            :payload="resolveEmbedPayload(part)!"
            :message-id="messageId"
            :key="`${messageId}-embed-${part.previewId || part.url}`"
            @embed-loaded="handleEmbedLoad"
          />
        </template>
        
        <!-- Image files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'image'" 
          class="media-container image-container"
          @mouseenter="hoveredImageUrl = part.url"
          @mouseleave="hoveredImageUrl = null"
        >
          <div v-if="!imageLoadedState[part.url]" class="media-skeleton image-skeleton"></div>
          <img
            :src="part.url"
            @load="handleImageLoad(part.url)"
            @click="$emit('open-lightbox', part.url)"
            v-show="imageLoadedState[part.url]"
            draggable="false"
            class="content-image"
          />
          <!-- GIF Favorite Button -->
          <button 
            v-if="isAnimatedImage(part.url)"
            class="gif-favorite-button"
            :class="{ 'favorited': isGifFavorited(part.url), 'visible': hoveredImageUrl === part.url || isGifFavorited(part.url) }"
            @click.stop="toggleGifFavorite(part.url)"
            :title="isGifFavorited(part.url) ? 'Remove from favorites' : 'Add to favorites'"
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
              <path v-if="isGifFavorited(part.url)" d="M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z"/>
              <path v-else d="M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z"/>
            </svg>
          </button>
        </div>

        <!-- Video files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'video'" 
          class="media-container video-container"
          :ref="el => { if (el) videoContainers[partIndex] = el as HTMLElement }"
        >
          <video
            :src="part.url"
            controls
            class="content-video"
            preload="metadata"
            :data-video-index="partIndex"
            @play="handleVideoPlay"
            @pause="handleVideoPause"
          ></video>
        </div>
        
        <!-- Audio files -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && part.fileType === 'audio'" 
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
        
        <!-- Other file attachments -->
        <div 
          v-else-if="part && typeof part === 'object' && part.type === 'file' && !['image', 'video'].includes(part.fileType)"
          class="file-attachment"
        >
          <div class="file-icon">📎</div>
          <a :href="part.url" target="_blank" rel="noopener noreferrer" class="file-name">
            {{ getFileName(part.url) }}
          </a>
        </div>
        
        <!-- System messages (join/leave announcements) -->
        <span 
          v-else-if="part && typeof part === 'object' && part.type === 'system'"
          class="system-message-text"
        >
          <template v-if="part.event_type === 'join'">
            Everyone welcome 
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            >{{ part.user.display_name || part.user.username }}</span>!
            <template v-if="part.initiated_by">
              They were invited by 
              <span 
                class="system-username" 
                @click="$emit('show-user-profile', part.initiated_by.id, $event)"
              >{{ part.initiated_by.display_name || part.initiated_by.username }}</span>.
            </template>
          </template>
          <template v-else-if="part.event_type === 'leave'">
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            >{{ part.user.display_name || part.user.username }}</span> has left the server.
          </template>
          <template v-else>
            <span 
              class="system-username" 
              @click="$emit('show-user-profile', part.user.id, $event)"
            >{{ part.user.display_name || part.user.username }}</span> {{ part.event_type }}
          </template>
        </span>
      </template>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, watch, ref, nextTick, reactive, onMounted } from 'vue';
import type { PropType } from 'vue';
import type { EmbedPayload, MessagePart } from '@/types';
import AutoSuggest from '@/components/AutoSuggest.vue';
import CodeBlock from '@/components/common/CodeBlock.vue';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { useAutoSuggest } from '@/composables/useAutoSuggest';
import { useFloatingVideo } from '@/composables/useFloatingVideo';
import { userDataService } from '@/services/userDataService';
import { getEmojiUrl } from '@/utils/emojiUtils';
import ProviderEmbedSwitch from '@/components/embeds/ProviderEmbedSwitch.vue';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { gifService } from '@/services/GifService';
import { debug } from '@/utils/debug';

export default defineComponent({
  name: 'UnifiedMessageContent',
  components: {
    AutoSuggest,
    CodeBlock,
    ProviderEmbedSwitch,
  },
  props: {
    content: {
      type: Array as PropType<MessagePart[]>,
      required: true
    },
    editableMessageId: {
      type: String as PropType<string | null>,
      default: null
    },
    messageId: {
      type: String,
      required: true
    },
    imageLoaded: {
      type: Object as PropType<Record<string, boolean>>,
      default: () => ({})
    },
    isSingleEmoji: {
      type: Boolean,
      default: false
    },
    editableContent: {
      type: String,
      default: ''
    },
    isSystem: {
      type: Boolean,
      default: false
    },
    embedPayloads: {
      type: Object as PropType<Record<string, EmbedPayload> | null>,
      default: null
    },
    encrypted: {
      type: Boolean,
      default: false
    },
    decrypted: {
      type: Boolean,
      default: false
    },
    canDecrypt: {
      type: Boolean,
      default: false
    }
  },
  emits: ['update:message', 'update:content', 'cancel-edit', 'image-loaded', 'embed-loaded', 'open-lightbox', 'show-user-profile', 'hashtag-click', 'decrypt-message'],
  setup(props, { emit }) {
    const localEditableContent = ref(props.editableContent);
    const editTextarea = ref<HTMLTextAreaElement | null>(null);
    const videoContainers = ref<HTMLElement[]>([]);
    const decrypting = ref(false);
    
    // GIF favorites state
    const hoveredImageUrl = ref<string | null>(null);
    const favoriteGifUrls = ref<Set<string>>(new Set());
    
    // Unified emoji service for mutant pack rendering
    const { resolveEmoji, isNativePack, isLoaded: emojiServiceLoaded } = useUnifiedEmoji();
    
    // Internal reactive state for image loading (use prop if provided, otherwise create new)
    const imageLoadedState = reactive<Record<string, boolean>>({ ...props.imageLoaded });
    
    // Floating video
    const { registerVideo, returnToOriginalPosition, hasFloatingVideo, getFloatingVideoMessageId } = useFloatingVideo();
    
    // Watch for prop changes and merge with internal state
    watch(() => props.imageLoaded, (newValue) => {
      Object.assign(imageLoadedState, newValue);
    }, { deep: true });
    
    // Handle image load events
    const handleImageLoad = (url: string) => {
      imageLoadedState[url] = true;
      emit('image-loaded', url);
    };

    const handleEmojiLoadError = (e: Event) => {
      const img = e.target as HTMLImageElement;
      if (!img) return;
      img.onerror = null;
      img.style.display = 'none';
      const fallback = document.createElement('span');
      fallback.className = 'emoji-icon emoji-fallback';
      fallback.textContent = '?';
      fallback.title = img.alt || '?';
      img.parentNode?.insertBefore(fallback, img);
    };
    
    // Handle embed load events
    const handleEmbedLoad = () => {
      emit('embed-loaded');
    };
    
    // Handle native video play/pause
    const handleVideoPlay = (event: Event) => {
      const video = event.target as HTMLVideoElement;
      const videoIndex = parseInt(video.dataset.videoIndex || '0', 10);
      const container = videoContainers.value[videoIndex];
      
      if (container) {
        container.dataset.isPlaying = 'true';
        
        // Check if a different video is floating
        const thisVideoId = `${props.messageId}-video-${videoIndex}`;
        const floatingVideoId = getFloatingVideoMessageId();
        
        // If another video is floating and it's not this one, return it to its original position
        if (floatingVideoId && floatingVideoId !== thisVideoId) {
          returnToOriginalPosition();
        }
      }
    };
    
    const handleVideoPause = (event: Event) => {
      const video = event.target as HTMLVideoElement;
      const videoIndex = parseInt(video.dataset.videoIndex || '0', 10);
      const container = videoContainers.value[videoIndex];
      
      if (container) {
        container.dataset.isPlaying = 'false';
      }
    };
    
    // GIF favorites helpers
    const isAnimatedImage = (url: string): boolean => {
      if (!url) return false;
      const lowerUrl = url.toLowerCase();
      // Check for GIF, animated WebP, or animated PNG
      return lowerUrl.includes('.gif') || 
             lowerUrl.includes('tenor.com') || 
             lowerUrl.includes('giphy.com') ||
             lowerUrl.includes('/gif') ||
             // Could also check for webp/apng but harder to detect animation
             false;
    };
    
    const isGifFavorited = (url: string): boolean => {
      return favoriteGifUrls.value.has(url);
    };
    
    const toggleGifFavorite = async (url: string) => {
      const result = await gifService.toggleFavoriteByUrl(url, url, null);
      if (!result.error) {
        if (result.isFavorite) {
          favoriteGifUrls.value.add(url);
        } else {
          favoriteGifUrls.value.delete(url);
        }
        // Trigger reactivity
        favoriteGifUrls.value = new Set(favoriteGifUrls.value);
      }
    };
    
    const loadGifFavorites = async () => {
      const favorites = await gifService.getFavorites();
      favoriteGifUrls.value = new Set(favorites.map(f => f.gif_url));
    };
    
    // Register videos for floating on mount and load GIF favorites
    onMounted(() => {
      // Load GIF favorites
      loadGifFavorites();
      
      nextTick(() => {
        // Register all video containers
        videoContainers.value.forEach((container, index) => {
          if (container && props.messageId) {
            const originalParent = container.parentElement as HTMLElement;
            if (originalParent) {
              registerVideo(container, originalParent, `${props.messageId}-video-${index}`, 'video');
            }
          }
        });
      });
    });
    
    // Auto-suggest setup
    const autoSuggest = useAutoSuggest(editTextarea);

    // Helper functions
    const isImageUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(jpg|jpeg|png|gif|webp|bmp|svg)$/i.test(url);
    };

    const isVideoUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(mp4|webm|ogg|avi|mov|wmv|flv)$/i.test(url);
    };

    const isAudioUrl = (url: string): boolean => {
      if (!url) return false;
      return /\.(mp3|wav|ogg|flac|aac|m4a|opus|webm)$/i.test(url);
    };

    const getFileName = (url: string): string => {
      if (!url) return 'Unknown file';
      const urlParts = url.split('/');
      const filename = urlParts[urlParts.length - 1];
      return decodeURIComponent(filename) || 'Unknown file';
    };

    const formatFileSize = (bytes: number): string => {
      if (bytes === 0) return '0 Bytes';
      const k = 1024;
      const sizes = ['Bytes', 'KB', 'MB', 'GB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
    };

    const resolveEmbedPayload = (part: MessagePart): EmbedPayload | null => {
      const embeds = props.embedPayloads;
      if (!embeds || !part || typeof part !== 'object') {
        return null;
      }

      if (part.type === 'embed' && part.previewId) {
        return embeds[part.previewId] || null;
      }

      if (part.type === 'url' && part.embedId) {
        return embeds[part.embedId] || null;
      }

      return null;
    };

    // Format mention display based on structured mention data
    const formatMentionDisplay = (mentionPart: any): string => {
      try {
        // Use the structured data from the new MentionContent format
        if (mentionPart.isLocal) {
          return `@${mentionPart.username}`;
        } else if (mentionPart.domain === 'discord.com' || mentionPart.isBridged) {
          // For Discord bridged users, just show @username (icon is added via CSS)
          return `@${mentionPart.username}`;
        } else {
          // For federated users, show full @username@domain
          return `@${mentionPart.username}@${mentionPart.domain}`;
        }
      } catch (error) {
        debug.error('Error formatting mention display:', error, { mentionPart });
        // Fallback to legacy format handling if needed
        if (mentionPart.mention) {
          return formatLegacyMentionDisplay(mentionPart.mention, mentionPart.userId);
        }
        return '@unknown';
      }
    };

    // Legacy mention format handler (for backwards compatibility)
    const formatLegacyMentionDisplay = (storedMention: string, userId: string): string => {
      // storedMention is in format @uuid@domain
      // We need to display as @username for local users or @username@domain for remote users
      
      try {
        // Parse the stored mention @uuid@domain
        const mentionMatch = storedMention.match(/^@([^@]+)@(.+)$/);
        if (!mentionMatch) {
          // Fallback: if not in expected format, return as-is
          return storedMention;
        }
        
        const [, , domain] = mentionMatch;
        
        // Get user profile from userDataService
        const userProfile = userDataService.getUserProfile(userId);
        
        if (userProfile) {
          // If user is local, display as @username
          // If user is remote, display as @username@domain
          if (userProfile.isLocal) {
            return `@${userProfile.username}`;
          } else {
            return `@${userProfile.username}@${userProfile.domain || domain}`;
          }
        } else {
          // Fallback: if we can't find the user, try to extract username from stored format
          // This shouldn't happen but provides graceful degradation
          return storedMention;
        }
      } catch (error) {
        debug.error('Error formatting legacy mention display:', error, { storedMention, userId });
        return storedMention; // Fallback to stored format
      }
    };

    // Simple markdown-style text rendering with extracted code blocks
    const renderTextContent = (text: string): { renderedText: string; codeBlocks: Array<{id: string; code: string; language: string}> } => {
      if (!text) return { renderedText: '', codeBlocks: [] };
      
      let rendered = text;
      const codeBlocks: Array<{id: string; code: string; language: string}> = [];
      
      // Extract code blocks first and replace with placeholders
      // Updated regex to handle code blocks with or without newlines and with optional language
      rendered = rendered.replace(/```(\w+)?(?:\n)?([\s\S]*?)```/g, (match, language, code) => {
        const lang = language || 'text';
        const blockId = `\uE000CODEBLOCK_${codeBlocks.length}\uE001`;
        // Clean up the code content more thoroughly
        const cleanCode = code.replace(/^\n+/, '').replace(/\n+$/, '');
        codeBlocks.push({
          id: blockId,
          code: cleanCode,
          language: lang
        });
        return blockId;
      });
      
      // For mutant/twemoji pack: Replace unicode emojis with SVG images
      // For native pack: Leave unicode as-is (browser renders them)
      // OPTIMIZED: Only resolve emojis if data is already loaded (prevents 823KB load on initial render)
      if (!isNativePack.value && emojiServiceLoaded.value) {
        // Unicode emoji regex - matches flags (Regional Indicators), ZWJ sequences, and standard emojis
        const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
        rendered = rendered.replace(emojiRegex, (match) => {
          // Only resolve if emoji data is loaded - don't trigger lazy load here
          // If data not loaded, emoji will render as native unicode (browser default)
          if (emojiServiceLoaded.value) {
            const resolved = resolveEmoji(match);
            if (resolved.display.type === 'svg') {
              const sizeClass = props.isSingleEmoji ? 'inline-emoji single' : 'inline-emoji';
              return `<img class="${sizeClass}" src="${resolved.display.content}" alt="${resolved.shortcode || match}" draggable="false" />`;
            }
          }
          return match; // Fallback to native unicode if no SVG or data not loaded
        });
      } else if (props.isSingleEmoji) {
        // Native pack with single emoji - wrap for bigger styling
        const emojiRegex = /[\u{1F1E6}-\u{1F1FF}]{2}|(\p{Emoji_Presentation}|\p{Emoji}\uFE0F)(\u200D(\p{Emoji_Presentation}|\p{Emoji}\uFE0F))*/gu;
        rendered = rendered.replace(emojiRegex, (match) => {
          return `<span class="native-emoji single">${match}</span>`;
        });
      }
      
      // Process other markdown after extracting code blocks
      // Inline code: `text`
      rendered = rendered.replace(/`([^`]+)`/g, '<code class="md-code">$1</code>');
      
      // Bold: **text** or __text__
      rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong class="md-bold">$1</strong>');
      rendered = rendered.replace(/__(.*?)__/g, '<strong class="md-bold">$1</strong>');
      
      // Italic: *text* or _text_ (but not in URLs or other contexts)
      rendered = rendered.replace(/(?<![\w/:])_([^_]+)_(?![\w])/g, '<em class="md-italic">$1</em>');
      rendered = rendered.replace(/(?<![\w*])\*([^*]+)\*(?![\w*])/g, '<em class="md-italic">$1</em>');
      
      // Strikethrough: ~~text~~
      rendered = rendered.replace(/~~(.*?)~~/g, '<del class="md-strikethrough">$1</del>');
      
      // Underline: __text__ (alternative, not conflicting with bold)
      rendered = rendered.replace(/\+\+(.*?)\+\+/g, '<u class="md-underline">$1</u>');
      
      // Line breaks (this won't affect code blocks since they're already extracted)
      rendered = rendered.replace(/\n/g, '<br>');
      
      return { renderedText: rendered, codeBlocks };
    };

    // Function to render text content with code blocks as components
    const renderTextSegments = (text: string) => {
      const { renderedText, codeBlocks } = renderTextContent(text);
      const segments: Array<{type: 'text' | 'codeblock'; content?: string; code?: string; language?: string}> = [];
      
      if (codeBlocks.length === 0) {
        // No code blocks, just return the rendered text
        segments.push({ type: 'text', content: renderedText });
        return segments;
      }
      
      // Split the rendered text by code block placeholders and interleave with code blocks
      let remainingText = renderedText;
      
      codeBlocks.forEach((codeBlock) => {
        const placeholder = codeBlock.id;
        const placeholderIndex = remainingText.indexOf(placeholder);
        
        if (placeholderIndex !== -1) {
          // Add text before the placeholder
          const beforeText = remainingText.substring(0, placeholderIndex);
          if (beforeText) {
            segments.push({ type: 'text', content: beforeText });
          }
          
          // Add the code block
          segments.push({ 
            type: 'codeblock', 
            code: codeBlock.code, 
            language: codeBlock.language 
          });
          
          // Update remaining text to everything after the placeholder
          remainingText = remainingText.substring(placeholderIndex + placeholder.length);
        }
      });
      
      // Add any remaining text after the last code block
      if (remainingText) {
        segments.push({ type: 'text', content: remainingText });
      }
      
      return segments;
    };

    // Watch for changes to the prop and update the local copy accordingly
    watch(() => props.editableContent, (newVal) => {
      // Only update if the value is different to avoid infinite loops
      if (newVal !== localEditableContent.value) {
        localEditableContent.value = newVal;
      }
      nextTick(() => {
        if (editTextarea.value && props.editableMessageId === props.messageId) {
          autoResizeTextarea();
          editTextarea.value.focus();
          const textLength = editTextarea.value.value.length;
          editTextarea.value.setSelectionRange(textLength, textLength);
        }
      });
    });

    // Watch for edit mode changes
    watch(() => props.editableMessageId, (newVal) => {
      if (newVal === props.messageId) {
        nextTick(() => {
          if (editTextarea.value) {
            autoResizeTextarea();
            editTextarea.value.focus();
            const textLength = editTextarea.value.value.length;
            editTextarea.value.setSelectionRange(textLength, textLength);
          }
        });
      }
    });

    // Auto-resize textarea based on content
    const autoResizeTextarea = () => {
      if (editTextarea.value) {
        editTextarea.value.style.height = 'auto';
        editTextarea.value.style.height = Math.min(editTextarea.value.scrollHeight, 200) + 'px';
      }
    };

    const handleInput = (event: Event) => {
      const target = event.target as HTMLTextAreaElement;
      const value = target.value;
      const cursorPosition = target.selectionStart || 0;
      
      // Update local content
      localEditableContent.value = value;
      
      // Emit the content update
      emit('update:content', value);
      
      // Handle auto-suggest
      autoSuggest.handleInput(value, cursorPosition);
      
      autoResizeTextarea();
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      // Check if auto-suggest handled the key event first
      if (autoSuggest.handleKeyDown(event)) {
        return;
      }
      
      if (event.key === 'Enter' && !event.shiftKey) {
        // Only save if auto-suggest is not active
        if (!autoSuggest.state.value.isActive) {
          event.preventDefault();
          handleSaveEdit();
        }
        return;
      }
      
      if (event.key === 'Escape') {
        event.preventDefault();
        handleCancelEdit();
        return;
      }
    };

    const handleSuggestionSelect = (suggestion: SuggestionItem) => {
      if (!editTextarea.value) return;
      
      // Use the autoSuggest system's built-in selection method
      const newValue = autoSuggest.selectSuggestion(suggestion);
      if (newValue !== localEditableContent.value) {
        localEditableContent.value = newValue;
        emit('update:content', newValue);
        
        nextTick(() => {
          autoResizeTextarea();
          // Keep focus on the textarea after suggestion selection
          if (editTextarea.value) {
            editTextarea.value.focus();
          }
        });
      }
    };

    const handleSaveEdit = () => {
      // debug.log('handleSaveEdit called');
      autoSuggest.closeSuggestions();
      
      const content = localEditableContent.value.trim();
      // debug.log('handleSaveEdit called with content:', content);
      // debug.log('messageId:', props.messageId);
      // debug.log('editableMessageId:', props.editableMessageId);
      
      if (!content) {
        // debug.log('Content is empty, canceling edit');
        handleCancelEdit();
        return;
      }
      
      try {
        // debug.log('Emitting update:message with messageId:', props.messageId, 'content:', content);
        emit('update:message', props.messageId, content);
        // debug.log('update:message emitted successfully');
      } catch (e) {
        debug.error('Error in handleSaveEdit:', e);
      }
    };

    const handleCancelEdit = () => {
      autoSuggest.closeSuggestions();
      emit('cancel-edit');
    };

    const handleHashtagClick = (hashtag: string, event: MouseEvent) => {
      event.stopPropagation();
      // Emit an event or handle the hashtag click as needed
      debug.log('Hashtag clicked:', hashtag);
      // For example, you might want to emit an event to notify the parent component
      emit('hashtag-click', hashtag);
    };
    
    // Check if a mention is from a bridged platform (e.g., Discord)
    const isBridgedMention = (part: any): boolean => {
      return part?.isBridged || part?.domain === 'discord.com';
    };
    
    // Get tooltip text for a mention
    const getMentionTooltip = (part: any): string => {
      if (part?.domain === 'discord.com') {
        return `Discord user: ${part.displayName || part.username}`;
      }
      return part?.displayName || part?.username || '';
    };
    
    // Handle mention click - only open profile for local Harmony users
    const handleMentionClick = (part: any, event: MouseEvent) => {
      event.stopPropagation();
      
      // Don't try to open profile for bridged/Discord users
      if (isBridgedMention(part)) {
        debug.log('Bridged mention clicked (Discord user):', part.username);
        // Could show a tooltip or mini-popup with Discord user info in the future
        return;
      }
      
      // For Harmony users, emit event to show profile
      emit('show-user-profile', part.userId, event);
    };

    // Generate cool glyph characters for encrypted messages
    // Uses message content hash for consistent but unique glyphs per message
    const GLYPH_CHARS = '█▓▒░▄▀■□▪▫●○◘◙▬¤§¶ƒαßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■';
    
    // Simple hash function for seeding
    const hashString = (str: string): number => {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash = hash & hash;
      }
      return Math.abs(hash);
    };
    
    const generateGlyphs = (content: string): string[] => {
      const displayLength = Math.min(Math.max(Math.floor(content.length / 4), 12), 64);
      const seed = hashString(content + props.messageId);
      const glyphs: string[] = [];
      
      for (let i = 0; i < displayLength; i++) {
        // Pseudo-random based on seed and position
        const charIndex = ((seed * (i + 1) * 31) % GLYPH_CHARS.length);
        glyphs.push(GLYPH_CHARS[charIndex]);
      }
      return glyphs;
    };

    const handleDecryptClick = (event: MouseEvent) => {
      event.stopPropagation();
      if (decrypting.value) return;
      
      debug.log('🔓 Click to decrypt message:', props.messageId);
      decrypting.value = true;
      
      // Emit event to parent to handle decryption
      emit('decrypt-message', props.messageId);
      
      // Reset decrypting state after a timeout (in case decryption fails silently)
      setTimeout(() => {
        decrypting.value = false;
      }, 5000);
    };

    return {
      getEmojiUrl,
      localEditableContent,
      editTextarea,
      videoContainers,
      handleSaveEdit, 
      handleCancelEdit,
      handleKeyDown,
      handleInput,
      autoResizeTextarea,
      autoSuggest,
      handleSuggestionSelect,
      imageLoadedState,
      handleImageLoad,
      handleEmojiLoadError,
      handleEmbedLoad,
      handleVideoPlay,
      handleVideoPause,
      isImageUrl,
      isVideoUrl,
      isAudioUrl,
      formatFileSize,
      formatMentionDisplay,
      renderTextContent,
      renderTextSegments,
      getFileName,
      handleHashtagClick,
      handleMentionClick,
      isBridgedMention,
      getMentionTooltip,
      resolveEmbedPayload,
      decrypting,
      handleDecryptClick,
      generateGlyphs,
      // GIF favorites
      hoveredImageUrl,
      isAnimatedImage,
      isGifFavorited,
      toggleGifFavorite
    };
  }
});
</script>

<style scoped>
.unified-content {
  line-height: 1.375;
  word-wrap: break-word;
  overflow-wrap: break-word;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  display: inline;
}

/* Display mode container */
.content-display {
  display: inline;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

/* Text content styling */
.text-content {
  /* color: var(--text-secondary); */
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.text-content :deep(.md-bold) {
  font-weight: bold;
  color: #ffffff;
}

.text-content :deep(.md-italic) {
  font-style: italic;
}

.text-content :deep(.md-strikethrough) {
  text-decoration: line-through;
  opacity: 0.6;
}

.text-content :deep(.md-underline) {
  text-decoration: underline;
}

.text-content :deep(.md-code) {
  background-color: #2f3136;
  border-radius: 3px;
  padding: 2px 4px;
  font-family: 'Monaco', 'Consolas', 'Courier New', monospace;
  font-size: 0.85em;
}

/* Code blocks are now handled by the CodeBlock component */

/* URL links */
.url-link {
  color: #00aff4;
  text-decoration: none;
  word-break: break-all;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.url-link:hover {
  text-decoration: underline;
}

/* User mentions */
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

.mention:hover {
  background-color: var(--harmony-primary);
  color: rgba(255,255,255,0.9);
}

.role-mention {
  font-weight: 600;
  cursor: default;
}

.role-mention:hover {
  filter: brightness(1.15);
  background-color: unset;
}

/* Hashtag styling */
.hashtag {
  background-color: #3c4270;
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  color: #c9c9ee;
  display: inline-block;
  transition: background-color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.hashtag:hover {
  background-color: var(--harmony-primary);
  color: rgba(255,255,255,0.9);
}

/* Emoji styling */
.emoji-icon,
:deep(.inline-emoji) {
  width: auto;
  max-width: 120px;
  height: 24px;
  vertical-align: middle;
  margin: 0 1px;
}

.emoji-icon.single,
:deep(.inline-emoji.single) {
  height: 64px;
  max-width: 64px;
}

:deep(.native-emoji.single) {
  font-size: 3em;
  line-height: 3.5rem;
}

/* Media containers */
.media-container {
  margin: 4px 0;
  max-width: 100%;
}

.image-container {
  max-width: 400px;
  position: relative;
}

.content-image {
  max-width: 100%;
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  cursor: pointer;
  transition: transform 0.2s ease-in-out;
}

.content-image:hover {
  transform: scale(1.02);
}

/* GIF Favorite Button */
.gif-favorite-button {
  position: absolute;
  top: 8px;
  right: 8px;
  background: rgba(0, 0, 0, 0.5);
  border: none;
  padding: 6px;
  border-radius: 4px;
  cursor: pointer;
  opacity: 0;
  transition: all 0.15s ease;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10;
  pointer-events: none;
}

.gif-favorite-button.visible {
  opacity: 1;
  pointer-events: auto;
}

.gif-favorite-button:hover {
  background: rgba(0, 0, 0, 0.9);
  transform: scale(1.1);
}

.gif-favorite-button.favorited {
  color: var(--color-warning, #faa61a);
}

.video-container {
  max-width: 400px;
}

.content-video {
  max-width: 100%;
  height: auto;
  max-height: 300px;
  border-radius: 8px;
  background-color: #000;
}

/* Media skeletons */
.media-skeleton {
  border-radius: 8px;
  background-color: #2b2d31;
  background-image: linear-gradient(
    90deg,
    transparent 0%,
    rgba(255, 255, 255, 0.04) 50%,
    transparent 100%
  );
  background-size: 200% 100%;
  animation: skeleton-shimmer 1.8s ease-in-out infinite;
}

.image-skeleton {
  width: 200px;
  height: 150px;
}

@keyframes skeleton-shimmer {
  0% {
    background-position: 100% 0;
  }
  100% {
    background-position: -100% 0;
  }
}

/* File attachments */
.file-attachment {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  background-color: #2f3136;
  border-radius: 8px;
  margin: 4px 0;
  max-width: 400px;
}

.file-icon {
  font-size: 20px;
}

.file-name {
  color: #00aff4;
  text-decoration: none;
  font-weight: 500;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.file-name:hover {
  text-decoration: underline;
}

.file-size {
  color: var(--text-secondary);
  font-size: 0.875rem;
  white-space: nowrap;
}

/* Edit interface styles */
.edit-container {
  width: 100%;
}

.edit-textarea {
  width: 100%;
  min-height: 40px;
  max-height: 200px;
  padding: 8px 12px;
  border: 1px solid var(--border-color);  
  border-radius: 8px;
  background-color: var(--background-secondary-alpha);
  color: var(--text-secondary);
  font-family: inherit;
  font-size: 14px;
  line-height: 1.375;
  resize: none;
  outline: none;
  box-sizing: border-box;
  overflow-y: auto;
  transition: border-color 0.15s ease-in-out;
}

.edit-textarea:focus {
  border-color: var(--harmony-primary);
  background-color: var(--background-tertiary-alpha);
}

.edit-textarea::placeholder {
  color: var(--text-secondary);
}

.edit-actions {
  margin-top: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.edit-hint {
  font-size: 12px;
  color: var(--text-secondary);
}

.edit-action {
  color: var(--harmony-primary);
  cursor: pointer;
  font-weight: 500;
}

.edit-action:hover {
  text-decoration: underline;
}

@media (max-width: 768px) {
  .image-container,
  .video-container {
    max-width: 100%;
  }
  
  .content-video {
    max-width: 100%;
  }
}

/* System message specific styling */
.system-message-text {
  color: var(--text-secondary);
  font-style: italic;
  font-size: 14px;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.system-message-content .system-message-text {
  color: inherit;
}

.system-username {
  font-weight: bold;
  color: #ffffff;
  cursor: pointer;
  transition: color 0.2s ease;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
}

.system-username:hover {
  color: #5865f2;
  text-decoration: underline;
}

/* Mention styling */
.mention {
  color: #5865f2;
  background-color: rgba(88, 101, 242, 0.15);
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  user-select: text;
  -webkit-user-select: text;
  -moz-user-select: text;
  -ms-user-select: text;
  transition: background-color 0.2s ease;
}

.mention:hover {
  background-color: rgba(88, 101, 242, 0.3);
  text-decoration: underline;
}

/* Discord bridged mentions */
.mention.discord-mention {
  background-color: rgba(88, 101, 242, 0.2);
  padding: 0 4px;
}

.mention.discord-mention::after {
  content: '';
  display: inline-block;
  width: 12px;
  height: 12px;
  margin-left: 3px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 127.14 96.36'%3E%3Cpath fill='%235865f2' d='M107.7,8.07A105.15,105.15,0,0,0,81.47,0a72.06,72.06,0,0,0-3.36,6.83A97.68,97.68,0,0,0,49,6.83,72.37,72.37,0,0,0,45.64,0,105.89,105.89,0,0,0,19.39,8.09C2.79,32.65-1.71,56.6.54,80.21h0A105.73,105.73,0,0,0,32.71,96.36,77.7,77.7,0,0,0,39.6,85.25a68.42,68.42,0,0,1-10.85-5.18c.91-.66,1.8-1.34,2.66-2a75.57,75.57,0,0,0,64.32,0c.87.71,1.76,1.39,2.66,2a68.68,68.68,0,0,1-10.87,5.19,77,77,0,0,0,6.89,11.1A105.25,105.25,0,0,0,126.6,80.22h0C129.24,52.84,122.09,29.11,107.7,8.07ZM42.45,65.69C36.18,65.69,31,60,31,53s5-12.74,11.43-12.74S54,46,53.89,53,48.84,65.69,42.45,65.69Zm42.24,0C78.41,65.69,73.25,60,73.25,53s5-12.74,11.44-12.74S96.23,46,96.12,53,91.08,65.69,84.69,65.69Z'/%3E%3C/svg%3E");
  background-size: contain;
  background-repeat: no-repeat;
  vertical-align: middle;
}

.mention.bridged-mention:not(.discord-mention) {
  background-color: rgba(150, 100, 200, 0.2);
  border-left: 2px solid #9664c8;
  padding-left: 4px;
}

/* Encrypted glyphs styling - uses global styles from design-system.css */

.audio-filename {
  font-size: 0.875rem;
  color: var(--text-secondary);
  margin-bottom: 6px;
  font-weight: 500;
}

/* Encrypted message styles now use global design-system.css */
</style>
