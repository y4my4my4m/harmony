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
          :class="{ 'selectable': selectable }"
          v-html="renderTextWithMarkdown(part.text)"
        ></span>
        
        <!-- User mentions -->
        <span 
          v-else-if="part && part.type === 'mention'" 
          class="mention" 
          @click="handleMentionClick(part)"
        >{{ renderer.formatMentionDisplay(part) }}</span>
        
        <!-- Custom emojis -->
        <img 
          v-else-if="part && part.type === 'emoji'"
          class="emoji-icon"
          :class="{ 'single': renderer.isSingleEmoji.value }"
          :src="getEmojiDisplayUrl(part.emoji)"
          :alt="part.emoji?.name"
          :title="`:${part.emoji?.name}:`"
          draggable="false"
        />
        
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
          >{{ part.url }}</a>
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
        
        <!-- Encrypted messages (cannot be decrypted) -->
        <div 
          v-else-if="part && part.type === 'encrypted'"
          class="encrypted-message-container"
        >
          <div class="encrypted-message">
            <div class="encrypted-header">
              <span class="encrypted-icon">🔐</span>
              <span class="encrypted-label">Encrypted Message</span>
            </div>
            <div class="encrypted-content">
              <div class="encrypted-visual-effect">
                <span class="encrypted-char" v-for="i in 50" :key="i">{{ getRandomChar() }}</span>
              </div>
              <div class="encrypted-hint">
                You need encryption keys to view this message
              </div>
            </div>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import type { MessagePart } from '@/types';
import { useContentRenderer, type ContentRenderOptions } from '@/composables/useContentRenderer';
import { getEmojiUrl } from '@/utils/emojiUtils';

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
  imageLoaded: () => ({})
});

const emit = defineEmits<{
  'user-mention-click': [userId: string, event: Event];
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
const renderer = useContentRenderer(contentRef, contentOptions, emit);

// Computed helpers
const isPreviewMode = computed(() => props.mode === 'preview');

// Image loading state
const imageLoaded = ref(props.imageLoaded);

// Random character generator for encrypted message effect
const getRandomChar = () => {
  const chars = '█▓▒░▄▀■□▪▫●○◘◙▬¤§¶ƒαßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■'
  return chars[Math.floor(Math.random() * chars.length)]
}

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
  
  // Handle mention clicks in HTML mode
  if (target.classList.contains('mention')) {
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
  if (mention.type === 'mention' && mention.userId) {
    emit('user-mention-click', mention.userId, new Event('click'));
  }
};

const handleImageLoad = (url: string) => {
  imageLoaded.value[url] = true;
  emit('image-load', url);
};

const handleImageClick = (url: string) => {
  emit('image-click', url);
};

const handleLinkClick = (url: string, event: Event) => {
  emit('link-click', url, event);
};

// Utility functions
const getEmojiDisplayUrl = (emoji: any) => {
  if (!emoji || !emoji.url) return '';
  return getEmojiUrl(emoji.url, 96);
};

const renderTextWithMarkdown = (text: string | undefined): string => {
  if (!text) return '';
  if (!props.enableMarkdown) return text;
  
  let rendered = text;
  
  // Basic markdown support
  rendered = rendered.replace(/\n/g, '<br>');
  rendered = rendered.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>');
  rendered = rendered.replace(/\*(.*?)\*/g, '<em>$1</em>');
  rendered = rendered.replace(/`(.*?)`/g, '<code>$1</code>');
  
  // Hashtags
  rendered = rendered.replace(/#(\w+)/g, '<span class="hashtag" data-tag="$1">#$1</span>');
  
  return rendered;
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
  color: #dcddde;
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

.mention:hover {
  background-color: #5865f2;
  color: rgba(255,255,255,0.9);
}

/* HTML mode mentions (for ActivityPub content) */
.content-html :deep(.mention) {
  background-color: rgba(16, 185, 129, 0.1);
  color: #10b981;
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
  color: #60a5fa;
  cursor: pointer;
  font-weight: 500;
  text-decoration: none;
  transition: color 0.2s ease;
}

.content-html :deep(.hashtag:hover),
:deep(.hashtag:hover) {
  color: #93c5fd;
  text-decoration: underline;
}

/* Emojis */
.emoji-icon {
  width: auto;
  max-width: 120px;
  height: 24px;
  vertical-align: middle;
  margin: 0 1px;
}

.emoji-icon.single {
  height: 64px;
}

.content-html :deep(.emoji-icon) {
  width: 20px;
  height: 20px;
  vertical-align: middle;
  margin: 0 1px;
  object-fit: contain;
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
.content-html :deep(.content-image),
.content-html :deep(.content-video) {
  max-width: 100%;
  max-height: 480px;
  border-radius: 4px;
  cursor: pointer;
}

.content-html :deep(.content-video) {
  cursor: default;
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
  margin: 4px 0 8px 0;
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
  color: #dcddde;
  margin-bottom: 6px;
  font-weight: 500;
}

/* Media loading skeletons */
.media-skeleton {
  background: linear-gradient(90deg, #36393f 25%, #40444b 50%, #36393f 75%);
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
  color: #dcddde;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: color 0.2s ease;
}

.file-link:hover {
  color: #ffffff;
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
  color: #72767d;
  font-style: italic;
  opacity: 0.8;
}

/* Encrypted messages */
.encrypted-message-container {
  width: 100%;
  margin: 4px 0;
}

.encrypted-message {
  background: linear-gradient(135deg, #1a1d21 0%, #252932 100%);
  border: 1px solid #3c4049;
  border-radius: 8px;
  padding: 12px;
  position: relative;
  overflow: hidden;
}

.encrypted-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 8px;
  color: #b9bbbe;
  font-size: 0.9em;
  font-weight: 500;
}

.encrypted-icon {
  font-size: 1.2em;
}

.encrypted-label {
  text-transform: uppercase;
  letter-spacing: 0.5px;
  font-size: 0.85em;
}

.encrypted-content {
  position: relative;
}

.encrypted-visual-effect {
  font-family: monospace;
  font-size: 11px;
  line-height: 1.4;
  color: #4a5161;
  white-space: pre-wrap;
  word-break: break-all;
  user-select: none;
  opacity: 0.6;
  animation: encrypted-glitch 3s infinite;
}

.encrypted-char {
  display: inline-block;
  animation: flicker 4s infinite;
  animation-delay: calc(var(--i, 0) * 0.1s);
}

@keyframes encrypted-glitch {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 0.4; }
}

@keyframes flicker {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.3; }
}

.encrypted-hint {
  margin-top: 8px;
  padding: 8px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 4px;
  color: #8e9297;
  font-size: 0.85em;
  text-align: center;
  font-style: italic;
}

/* Typography */
.content-html :deep(strong),
:deep(strong) {
  font-weight: 600;
  color: #ffffff;
}

.content-html :deep(em),
:deep(em) {
  font-style: italic;
  color: #e3e5e8;
}

.content-html :deep(code),
:deep(code) {
  background-color: #2f3136;
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
