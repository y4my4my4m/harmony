<template>
  <div 
    class="markdown-content"
    :class="{ 'single-line': singleLine, 'reply-preview': isReplyPreview }"
    v-html="renderedHtml"
  />
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { debug } from '@/utils/debug'
import { renderMarkdownToHTML, type RenderOptions } from '@/utils/markdownRenderer';
import { findEmojiByName } from '@/services/emojiShortcodeResolver';

interface Props {
  content: string;
  singleLine?: boolean;
  isReplyPreview?: boolean;
  showMarkers?: boolean;
}

const props = withDefaults(defineProps<Props>(), {
  singleLine: false,
  isReplyPreview: false,
  showMarkers: false
});

// Resolves :shortcode: to URLs via the central emoji resolver
// (cache → DB fallback → unified pack, with ~N disambiguation).
const emojiResolver = (name: string) => {
  try {
    const emoji = findEmojiByName(name);
    if (emoji?.url) {
      return { url: emoji.url, id: emoji.id };
    }
    return null;
  } catch (error) {
    debug.warn('Error finding emoji by name:', error);
    return null;
  }
};

const renderedHtml = computed(() => {
  const options: RenderOptions = {
    showMarkers: props.showMarkers,
    singleLine: props.singleLine || props.isReplyPreview,
    allowImages: !props.isReplyPreview,
    allowVideos: !props.isReplyPreview,
    emojiResolver
  };

  return renderMarkdownToHTML(props.content, options);
});
</script>

<style scoped>
.markdown-content {
  line-height: 1.375;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.markdown-content.single-line {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.markdown-content.reply-preview {
  opacity: 0.7;
  font-size: 0.875rem;
}

/* Markdown styling */
.markdown-content :deep(.md-bold) {
  font-weight: bold;
  color: var(--text-primary);
}

.markdown-content :deep(.md-italic) {
  font-style: italic;
  color: var(--text-primary);
}

.markdown-content :deep(.md-underline) {
  text-decoration: underline;
  color: var(--text-primary);
}

.markdown-content :deep(.md-strikethrough) {
  text-decoration: line-through;
  color: var(--text-primary);
}

.markdown-content :deep(.md-code) {
  background: var(--background-tertiary);
  color: #f8f8f2;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.875em;
  padding: 0.125em 0.25em;
  border-radius: 3px;
  border: 1px solid #202225;
}

.markdown-content :deep(.md-codeblock) {
  background: var(--background-tertiary);
  border: 1px solid #202225;
  border-radius: 4px;
  margin: 6px 0;
  overflow: hidden;
}

.markdown-content :deep(.md-codeblock-header) {
  background: var(--background-secondary);
  padding: 4px 8px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.75em;
  border-bottom: 1px solid #202225;
}

.markdown-content :deep(.md-codeblock-lang) {
  color: var(--text-muted);
  font-weight: 500;
}

.markdown-content :deep(.md-codeblock-content) {
  padding: 8px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.875em;
  line-height: 1.125rem;
  color: #f8f8f2;
  overflow-x: auto;
}

.markdown-content :deep(.md-codeblock-footer) {
  background: var(--background-secondary);
  padding: 4px 8px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.75em;
  border-top: 1px solid #202225;
}

.markdown-content :deep(.md-emoji) {
  width: 1.375em;
  height: 1.375em;
  margin: 0 0.05em 0 0.1em;
  vertical-align: -0.2em;
  object-fit: contain;
}

.markdown-content :deep(.md-marker) {
  color: var(--text-muted);
  opacity: 0.6;
  font-weight: normal;
}

/* Syntax highlighting for code blocks */
.markdown-content :deep(.token.comment) { color: #6272a4; }
.markdown-content :deep(.token.prolog),
.markdown-content :deep(.token.doctype),
.markdown-content :deep(.token.cdata) { color: #6272a4; }
.markdown-content :deep(.token.punctuation) { color: #f8f8f2; }
.markdown-content :deep(.token.property),
.markdown-content :deep(.token.tag),
.markdown-content :deep(.token.constant),
.markdown-content :deep(.token.symbol),
.markdown-content :deep(.token.deleted) { color: #ff79c6; }
.markdown-content :deep(.token.boolean),
.markdown-content :deep(.token.number) { color: #bd93f9; }
.markdown-content :deep(.token.selector),
.markdown-content :deep(.token.attr-name),
.markdown-content :deep(.token.string),
.markdown-content :deep(.token.char),
.markdown-content :deep(.token.builtin),
.markdown-content :deep(.token.inserted) { color: #50fa7b; }
.markdown-content :deep(.token.operator),
.markdown-content :deep(.token.entity),
.markdown-content :deep(.token.url),
.markdown-content :deep(.language-css .token.string),
.markdown-content :deep(.style .token.string),
.markdown-content :deep(.token.variable) { color: #f8f8f2; }
.markdown-content :deep(.token.atrule),
.markdown-content :deep(.token.attr-value),
.markdown-content :deep(.token.function),
.markdown-content :deep(.token.class-name) { color: #f1fa8c; }
.markdown-content :deep(.token.keyword) { color: #8be9fd; }
.markdown-content :deep(.token.regex),
.markdown-content :deep(.token.important) { color: #ffb86c; }
.markdown-content :deep(.token.important),
.markdown-content :deep(.token.bold) { font-weight: bold; }
.markdown-content :deep(.token.italic) { font-style: italic; }
.markdown-content :deep(.token.entity) { cursor: help; }
</style>
