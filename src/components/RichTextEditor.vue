<template>
  <div 
    ref="editorRef"
    class="rich-text-editor"
    :class="{ 
      'is-empty': !modelValue && !hasContent, 
      'is-focused': isFocused,
      'single-line': isSingleLine 
    }"
    role="textbox"
    aria-multiline="true"
    spellcheck="true"
    aria-haspopup="listbox"
    aria-invalid="false"
    aria-autocomplete="list"
    autocorrect="off"
    data-can-focus="true"
    :aria-label="placeholder"
    contenteditable="true"
    @input="handleInput"
    @keydown="handleKeyDown"
    @focus="handleFocus"
    @blur="handleBlur"
    @paste="handlePaste"
    :data-placeholder="placeholder"
    :style="{
      '--min-height': `${props.minHeight}px`,
      '--max-height': `${props.maxHeight}px`
    }"
  >
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, watch, nextTick, computed } from 'vue';
import { parseMarkdownWithMarkers, type MarkdownToken } from '@/utils/markdownParser';
import { highlightSyntax } from '@/utils/syntaxHighlighter';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { userDataService } from '@/services/userDataService';

interface Props {
  modelValue: string;
  placeholder?: string;
  maxHeight?: number;
  minHeight?: number;
}

interface Emits {
  (e: 'update:modelValue', value: string): void;
  (e: 'input', event: Event): void;
  (e: 'keydown', event: KeyboardEvent): void;
  (e: 'focus', event: FocusEvent): void;
  (e: 'blur', event: FocusEvent): void;
  (e: 'cursor-position-changed', position: number): void;
}

const props = withDefaults(defineProps<Props>(), {
  placeholder: 'Type a message...',
  maxHeight: 200,
  minHeight: 44
});

const emit = defineEmits<Emits>();

const editorRef = ref<HTMLDivElement>();
const isFocused = ref(false);
const emojiCache = useEmojiCacheStore();
const isRendering = ref(false);

const hasContent = computed(() => {
  if (!editorRef.value) return false;
  const text = getPlainText();
  return text.length > 0;
});

const isSingleLine = computed(() => {
  return !props.modelValue.includes('\n');
});

// Find emoji by name in cache
const findEmojiByName = (name: string) => {
  try {
    const allServerIds = Array.from(emojiCache.serverCaches.keys());
    for (const serverId of allServerIds) {
      const serverEmojis = emojiCache.getServerEmojis(serverId);
      if (serverEmojis && serverEmojis.length > 0) {
        const emoji = serverEmojis.find(e => e.name === name);
        if (emoji && emoji.url) {
          return emoji;
        }
      }
    }
    return null;
  } catch (error) {
    console.warn('Error finding emoji by name:', error);
    return null;
  }
};

// Extract plain text from the editor (preserving markdown)
const getPlainText = (): string => {
  if (!editorRef.value) return '';
  
  let text = '';
  
  const processNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      text += node.textContent || '';
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      
      if (el.classList.contains('editor-emoji')) {
        const emojiName = el.getAttribute('data-emoji');
        if (emojiName) {
          text += `:${emojiName}:`;
        }
      } else if (el.classList.contains('editor-mention')) {
        // Extract mention data from rich attributes
        const displayText = el.getAttribute('data-display-text');
        
        if (displayText) {
          // Use the display text (@username or @username@domain) for message parsing
          text += displayText;
        } else {
          // Fallback to element text content
          text += el.textContent || '';
        }
      } else if (el.tagName === 'BR') {
        text += '\n';
      } else {
        // For other elements, process their children
        for (const child of Array.from(node.childNodes)) {
          processNode(child);
        }
      }
    }
  };
  
  for (const child of Array.from(editorRef.value.childNodes)) {
    processNode(child);
  }
  
  return text;
};

// Get cursor position as text offset
const getCursorPosition = (): number => {
  if (!editorRef.value) return 0;
  
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;
  
  const range = selection.getRangeAt(0);
  let position = 0;
  
  const walker = document.createTreeWalker(
    editorRef.value,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.classList.contains('editor-emoji') || 
              el.classList.contains('editor-mention') || 
              el.tagName === 'BR') {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );
  
  let node = walker.nextNode();
  while (node) {
    if (node === range.startContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        position += range.startOffset;
      }
      break;
    } else if (range.startContainer.nodeType === Node.ELEMENT_NODE && 
               range.startContainer.contains(node)) {
      const nodesBeforeCursor = Array.from(range.startContainer.childNodes).slice(0, range.startOffset);
      if (!nodesBeforeCursor.includes(node as ChildNode)) {
        break;
      }
    }
    
    // Count this node
    if (node.nodeType === Node.TEXT_NODE) {
      position += (node.textContent || '').length;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      if (el.classList.contains('editor-emoji')) {
        const emojiName = el.getAttribute('data-emoji');
        if (emojiName) {
          position += `:${emojiName}:`.length;
        }
      } else if (el.classList.contains('editor-mention')) {
        const mentionData = el.getAttribute('data-mention');
        if (mentionData) {
          position += mentionData.length; // Count the full @uuid@domain length
        }
      } else if (el.tagName === 'BR') {
        position += 1; // newline
      }
    }
    
    node = walker.nextNode();
  }
  
  return position;
};

// Set cursor position from text offset
const setCursorPosition = (targetPosition: number) => {
  if (!editorRef.value) return;
  
  const selection = window.getSelection();
  if (!selection) return;
  
  let currentPos = 0;
  let targetNode: Node | null = null;
  let targetOffset = 0;
  
  const walker = document.createTreeWalker(
    editorRef.value,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (el.classList.contains('editor-emoji') || 
              el.classList.contains('editor-mention') || 
              el.tagName === 'BR') {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      }
    }
  );
  
  let node = walker.nextNode();
  while (node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const nodeLength = (node.textContent || '').length;
      if (currentPos + nodeLength >= targetPosition) {
        targetNode = node;
        targetOffset = targetPosition - currentPos;
        break;
      }
      currentPos += nodeLength;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;
      let nodeLength = 0;
      
      if (el.classList.contains('editor-emoji')) {
        const emojiName = el.getAttribute('data-emoji');
        if (emojiName) {
          nodeLength = `:${emojiName}:`.length;
        }
      } else if (el.classList.contains('editor-mention')) {
        const mentionData = el.getAttribute('data-mention');
        if (mentionData) {
          nodeLength = mentionData.length; // Count the full @uuid@domain length
        }
      } else if (el.tagName === 'BR') {
        nodeLength = 1;
      }
      
      if (currentPos + nodeLength >= targetPosition) {
        // Position cursor after this element
        targetNode = el.parentNode;
        targetOffset = Array.from(el.parentNode?.childNodes || []).indexOf(el) + 1;
        break;
      }
      currentPos += nodeLength;
    }
    node = walker.nextNode();
  }
  
  if (targetNode) {
    try {
      const range = document.createRange();
      if (targetNode.nodeType === Node.TEXT_NODE) {
        range.setStart(targetNode, Math.min(targetOffset, targetNode.textContent?.length || 0));
      } else {
        range.setStart(targetNode, Math.min(targetOffset, targetNode.childNodes.length));
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } catch (e) {
      console.warn('Error setting cursor position:', e);
    }
  }
};

// Process mentions in text and create visual elements
const processMentionsInText = (text: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  
  // Simple regex to match @username or @username@domain format (display format)
  const mentionRegex = /@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?/g;
  
  console.log('🔧 processMentionsInText called with:', text);
  
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(text)) !== null) {
    console.log('🔧 Found mention match:', match);
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    
    // Add text before the mention
    if (matchStart > lastIndex) {
      const textBefore = text.substring(lastIndex, matchStart);
      fragment.appendChild(document.createTextNode(textBefore));
    }
    
    // Create mention element with rich metadata
    const username = match[1];
    const domain = match[2];
    const mentionElement = createMentionElementFromDisplay(match[0], username, domain);
    fragment.appendChild(mentionElement);
    
    lastIndex = matchEnd;
  }
  
  // Add remaining text after last mention
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    fragment.appendChild(document.createTextNode(remainingText));
  }
  
  // If no mentions found, just return the text as a text node
  if (lastIndex === 0) {
    console.log('🔧 No mentions found in text, adding as plain text');
    fragment.appendChild(document.createTextNode(text));
  }
  
  return fragment;
};

// Create a mention element from display format (@username or @username@domain)
const createMentionElementFromDisplay = (displayText: string, username: string, domain?: string): HTMLElement => {
  const span = document.createElement('span');
  span.className = 'editor-mention';
  span.contentEditable = 'false'; // Prevent editing the mention element itself
  
  // Look up user information
  let userId: string | null = null;
  let userProfile: any = null;
  let isLocal = false;
  let actualDomain = domain;
  
  try {
    // Find user by username and domain
    userId = userDataService.findUserIdByUsername(username, domain);
    if (userId) {
      userProfile = userDataService.getUserProfile(userId);
      isLocal = userProfile?.is_local || false;
      actualDomain = userProfile?.domain || domain || 'har.mony.lol';
    }
  } catch (error) {
    console.error('Error looking up user for mention:', error);
  }
  
  // Store rich metadata in data attributes
  span.setAttribute('data-type', 'mention');
  span.setAttribute('data-username', username);
  span.setAttribute('data-display-text', displayText);
  
  if (userId) {
    span.setAttribute('data-userid', userId);
  }
  if (actualDomain) {
    span.setAttribute('data-domain', actualDomain);
  }
  span.setAttribute('data-islocal', isLocal.toString());
  
  // Display text (what the user sees)
  if (isLocal) {
    span.textContent = `@${username}`;
  } else {
    span.textContent = domain ? `@${username}@${domain}` : `@${username}`;
  }
  
  return span;
};

// Render content with Discord-like markdown styling
const renderContent = (text: string) => {
  console.log('🔧 renderContent called with:', text);
  if (!editorRef.value || isRendering.value) {
    console.log('🔧 renderContent early return:', { hasEditor: !!editorRef.value, isRendering: isRendering.value });
    return;
  }
  
  isRendering.value = true;
  const currentCursorPos = getCursorPosition();
  console.log('🔧 Current cursor position:', currentCursorPos);
  
  // Clear content
  editorRef.value.innerHTML = '';
  console.log('🔧 Cleared editor content');
  
  if (!text) {
    isRendering.value = false;
    return;
  }
  
  // Parse the entire text (not line-by-line to handle multiline tokens like code blocks)
  const tokens = parseMarkdownWithMarkers(text);
  const fragment = document.createDocumentFragment();
  
  // Process tokens and handle newlines properly
  tokens.forEach(token => {
    if (token.type === 'text') {
      // Handle text with potential newlines and mentions
      const lines = token.content.split('\n');
      lines.forEach((line, index) => {
        if (line) {
          // Process mentions in this line
          const processedFragment = processMentionsInText(line);
          fragment.appendChild(processedFragment);
        }
        // Add line break for all newlines except the last one if it's empty
        if (index < lines.length - 1) {
          fragment.appendChild(document.createElement('br'));
        }
      });
    } else {
      // For formatted tokens, handle newlines within them too
      const element = createElementFromToken(token);
      fragment.appendChild(element);
    }
  });
  
  // If the fragment is empty, add a single BR to maintain the editor height
  if (!fragment.hasChildNodes()) {
    fragment.appendChild(document.createElement('br'));
  }
  
  editorRef.value.appendChild(fragment);
  
  // Restore cursor position
  nextTick(() => {
    if (editorRef.value && (document.activeElement === editorRef.value || 
        editorRef.value.contains(document.activeElement))) {
      setCursorPosition(currentCursorPos);
    }
    isRendering.value = false;
  });
};

// Create DOM element from markdown token (keeping markers visible)
const createElementFromToken = (token: MarkdownToken): Node => {
  switch (token.type) {
    case 'text':
      return document.createTextNode(token.content);
      
    case 'bold': {
      const span = document.createElement('span');
      span.className = 'editor-bold-wrapper';
      
      const startMarker = document.createElement('span');
      startMarker.className = 'editor-marker';
      startMarker.textContent = '**';
      
      const content = document.createElement('span');
      content.className = 'editor-bold-content';
      content.textContent = token.content;
      
      const endMarker = document.createElement('span');
      endMarker.className = 'editor-marker';
      endMarker.textContent = '**';
      
      span.appendChild(startMarker);
      span.appendChild(content);
      span.appendChild(endMarker);
      return span;
    }
    
    case 'italic': {
      const span = document.createElement('span');
      span.className = 'editor-italic-wrapper';
      
      const startMarker = document.createElement('span');
      startMarker.className = 'editor-marker';
      startMarker.textContent = '*';
      
      const content = document.createElement('span');
      content.className = 'editor-italic-content';
      content.textContent = token.content;
      
      const endMarker = document.createElement('span');
      endMarker.className = 'editor-marker';
      endMarker.textContent = '*';
      
      span.appendChild(startMarker);
      span.appendChild(content);
      span.appendChild(endMarker);
      return span;
    }
    
    case 'underline': {
      const span = document.createElement('span');
      span.className = 'editor-underline-wrapper';
      
      const startMarker = document.createElement('span');
      startMarker.className = 'editor-marker';
      startMarker.textContent = '__';
      
      const content = document.createElement('span');
      content.className = 'editor-underline-content';
      content.textContent = token.content;
      
      const endMarker = document.createElement('span');
      endMarker.className = 'editor-marker';
      endMarker.textContent = '__';
      
      span.appendChild(startMarker);
      span.appendChild(content);
      span.appendChild(endMarker);
      return span;
    }
    
    case 'strikethrough': {
      const span = document.createElement('span');
      span.className = 'editor-strikethrough-wrapper';
      
      const startMarker = document.createElement('span');
      startMarker.className = 'editor-marker';
      startMarker.textContent = '~~';
      
      const content = document.createElement('span');
      content.className = 'editor-strikethrough-content';
      content.textContent = token.content;
      
      const endMarker = document.createElement('span');
      endMarker.className = 'editor-marker';
      endMarker.textContent = '~~';
      
      span.appendChild(startMarker);
      span.appendChild(content);
      span.appendChild(endMarker);
      return span;
    }
    
    case 'code': {
      const span = document.createElement('span');
      span.className = 'editor-code-wrapper';
      
      const startMarker = document.createElement('span');
      startMarker.className = 'editor-marker';
      startMarker.textContent = '`';
      
      const content = document.createElement('span');
      content.className = 'editor-code-content';
      content.textContent = token.content;
      
      const endMarker = document.createElement('span');
      endMarker.className = 'editor-marker';
      endMarker.textContent = '`';
      
      span.appendChild(startMarker);
      span.appendChild(content);
      span.appendChild(endMarker);
      return span;
    }
    
    case 'codeblock': {
      const div = document.createElement('div');
      div.className = 'editor-codeblock-wrapper';
      
      // Start marker (```language)
      const startMarker = document.createElement('div');
      startMarker.className = 'editor-codeblock-start';
      
      const startMarkerContent = document.createElement('span');
      startMarkerContent.className = 'editor-marker';
      startMarkerContent.textContent = '```' + (token.language || '');
      startMarker.appendChild(startMarkerContent);
      
      // Content with syntax highlighting
      const content = document.createElement('div');
      content.className = 'editor-codeblock-content';
      
      // Apply syntax highlighting and preserve newlines
      const tokens = highlightSyntax(token.content, token.language);
      tokens.forEach(syntaxToken => {
        if (syntaxToken.content.includes('\n')) {
          // Handle newlines in syntax tokens
          const lines = syntaxToken.content.split('\n');
          lines.forEach((line, index) => {
            if (line) {
              const span = document.createElement('span');
              span.className = syntaxToken.className;
              span.textContent = line;
              content.appendChild(span);
            }
            if (index < lines.length - 1) {
              content.appendChild(document.createElement('br'));
            }
          });
        } else {
          const span = document.createElement('span');
          span.className = syntaxToken.className;
          span.textContent = syntaxToken.content;
          content.appendChild(span);
        }
      });
      
      // End marker
      const endMarker = document.createElement('div');
      endMarker.className = 'editor-codeblock-end';
      
      const endMarkerContent = document.createElement('span');
      endMarkerContent.className = 'editor-marker';
      endMarkerContent.textContent = '```';
      endMarker.appendChild(endMarkerContent);
      
      div.appendChild(startMarker);
      div.appendChild(content);
      div.appendChild(endMarker);
      return div;
    }
    
    case 'emoji': {
      const emoji = findEmojiByName(token.content);
      if (emoji && emoji.url) {
        const span = document.createElement('span');
        span.className = 'editor-emoji';
        span.contentEditable = 'false';
        span.setAttribute('data-emoji', token.content);
        
        const img = document.createElement('img');
        img.src = emoji.url;
        img.alt = `:${token.content}:`;
        img.className = 'emoji-image';
        img.draggable = false;
        
        span.appendChild(img);
        return span;
      } else {
        return document.createTextNode(`:${token.content}:`);
      }
    }
    
    default:
      return document.createTextNode(token.content);
  }
};

// Handle input events
const handleInput = (event: Event) => {
  if (isRendering.value) return; // Prevent recursion
  
  const text = getPlainText();
  emit('update:modelValue', text);
  emit('input', event);
  
  // Emit cursor position for auto-suggest
  const cursorPos = getCursorPosition();
  emit('cursor-position-changed', cursorPos);
  
  // DO NOT re-render on input to avoid infinite loops
  // Rendering will happen when modelValue changes externally
  
  // Auto-expand editor
  autoExpand();
};

// Handle keyboard events
const handleKeyDown = (event: KeyboardEvent) => {
  emit('keydown', event);
};

// Handle focus
const handleFocus = (event: FocusEvent) => {
  isFocused.value = true;
  emit('focus', event);
};

// Handle blur
const handleBlur = (event: FocusEvent) => {
  isFocused.value = false;
  emit('blur', event);
};

// Handle paste
const handlePaste = (event: ClipboardEvent) => {
  event.preventDefault();
  const text = event.clipboardData?.getData('text/plain') || '';
  insertTextAtCursor(text);
};

// Insert text at cursor position
const insertTextAtCursor = (text: string) => {
  if (!editorRef.value) return;
  
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    editorRef.value.textContent = (editorRef.value.textContent || '') + text;
  } else {
    const range = selection.getRangeAt(0);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
  }
  
  const newText = getPlainText();
  emit('update:modelValue', newText);
  
  renderContent(newText);
};

// Auto-expand editor based on content
const autoExpand = () => {
  if (!editorRef.value) return;
  
  editorRef.value.style.height = 'auto';
  const scrollHeight = editorRef.value.scrollHeight;
  const newHeight = Math.min(Math.max(scrollHeight, props.minHeight), props.maxHeight);
  
  editorRef.value.style.height = newHeight + 'px';
  editorRef.value.style.overflowY = scrollHeight > props.maxHeight ? 'auto' : 'hidden';
};

// Focus the editor
const focus = () => {
  if (editorRef.value) {
    editorRef.value.focus();
  }
};

// Clear the editor
const clear = () => {
  if (editorRef.value) {
    editorRef.value.innerHTML = '';
    emit('update:modelValue', '');
    autoExpand();
  }
};

defineExpose({
  focus,
  clear,
  insertTextAtCursor,
  getCursorPosition,
  setCursorPosition
});

// Watch for external model value changes
watch(() => props.modelValue, (newValue) => {
  if (editorRef.value) {
    const currentText = getPlainText();
    console.log('🔧 RichTextEditor watch triggered:', { newValue, currentText, different: currentText !== newValue });
    if (currentText !== newValue) {
      console.log('🔧 Calling renderContent with:', newValue);
      renderContent(newValue);
      autoExpand();
    }
  }
});

onMounted(() => {
  if (props.modelValue) {
    renderContent(props.modelValue);
  }
  autoExpand();
});
</script>
<style scoped>
.rich-text-editor {
  min-height: var(--min-height);
  max-height: var(--max-height);
  padding: 11px 12px;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  line-height: 1.375;
  font-family: 'gg sans', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  color: #dcddde;
  overflow-wrap: break-word;
  word-wrap: break-word;
  word-break: break-word;
  resize: none;
  overflow-y: auto;
}

.rich-text-editor:empty:before {
  content: attr(data-placeholder);
  color: #72767d;
  pointer-events: none;
  position: absolute;
}

/* Markdown markers styling */
.rich-text-editor :deep(.editor-marker) {
  color: #72767d;
  opacity: 0.6;
  font-weight: normal;
}

/* Bold styling */
.rich-text-editor :deep(.editor-bold-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-bold-content) {
  font-weight: bold;
  color: #ffffff;
}

/* Italic styling */
.rich-text-editor :deep(.editor-italic-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-italic-content) {
  font-style: italic;
  color: #ffffff;
}

/* Underline styling */
.rich-text-editor :deep(.editor-underline-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-underline-content) {
  text-decoration: underline;
  color: #ffffff;
}

/* Strikethrough styling */
.rich-text-editor :deep(.editor-strikethrough-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-strikethrough-content) {
  text-decoration: line-through;
  color: #ffffff;
}

/* Code styling */
.rich-text-editor :deep(.editor-code-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-code-content) {
  background: #2f3136;
  color: #f8f8f2;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.875em;
  padding: 0.125em 0.25em;
  border-radius: 3px;
  border: 1px solid #202225;
}

/* Code block styling */
.rich-text-editor :deep(.editor-codeblock-wrapper) {
  display: block;
  margin: 6px 0;
  background: #2f3136;
  border: 1px solid #202225;
  border-radius: 4px;
  overflow: hidden;
}

.rich-text-editor :deep(.editor-codeblock-start),
.rich-text-editor :deep(.editor-codeblock-end) {
  background: #36393f;
  padding: 4px 8px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.75em;
  border-bottom: 1px solid #202225;
}

.rich-text-editor :deep(.editor-codeblock-end) {
  border-bottom: none;
  border-top: 1px solid #202225;
}

.rich-text-editor :deep(.editor-codeblock-content) {
  padding: 8px;
  font-family: 'Consolas', 'Monaco', 'Courier New', monospace;
  font-size: 0.875em;
  line-height: 1.125rem;
  color: #f8f8f2;
  white-space: pre-wrap;
  overflow-x: auto;
}

/* Emoji styling */
.rich-text-editor :deep(.editor-emoji) {
  display: inline-block;
  vertical-align: text-bottom;
}

.rich-text-editor :deep(.emoji-image) {
  width: 1.375em;
  height: 1.375em;
  margin: 0 0.05em 0 0.1em;
  vertical-align: -0.2em;
  object-fit: contain;
}

/* Focus styling */
/* .rich-text-editor.is-focused {
  Add any focus-specific styling here
} */

/* Single line mode */
.rich-text-editor.single-line {
  overflow-y: hidden;
}

/* Syntax highlighting for code blocks */
.rich-text-editor :deep(.token.comment) { color: #6272a4; }
.rich-text-editor :deep(.token.prolog),
.rich-text-editor :deep(.token.doctype),
.rich-text-editor :deep(.token.cdata) { color: #6272a4; }
.rich-text-editor :deep(.token.punctuation) { color: #f8f8f2; }
.rich-text-editor :deep(.token.property),
.rich-text-editor :deep(.token.tag),
.rich-text-editor :deep(.token.constant),
.rich-text-editor :deep(.token.symbol),
.rich-text-editor :deep(.token.deleted) { color: #ff79c6; }
.rich-text-editor :deep(.token.boolean),
.rich-text-editor :deep(.token.number) { color: #bd93f9; }
.rich-text-editor :deep(.token.selector),
.rich-text-editor :deep(.token.attr-name),
.rich-text-editor :deep(.token.string),
.rich-text-editor :deep(.token.char),
.rich-text-editor :deep(.token.builtin),
.rich-text-editor :deep(.token.inserted) { color: #50fa7b; }
.rich-text-editor :deep(.token.operator),
.rich-text-editor :deep(.token.entity),
.rich-text-editor :deep(.token.url),
.rich-text-editor :deep(.language-css .token.string),
.rich-text-editor :deep(.style .token.string),
.rich-text-editor :deep(.token.variable) { color: #f8f8f2; }
.rich-text-editor :deep(.token.atrule),
.rich-text-editor :deep(.token.attr-value),
.rich-text-editor :deep(.token.function),
.rich-text-editor :deep(.token.class-name) { color: #f1fa8c; }
.rich-text-editor :deep(.token.keyword) { color: #8be9fd; }
.rich-text-editor :deep(.token.regex),
.rich-text-editor :deep(.token.important) { color: #ffb86c; }
.rich-text-editor :deep(.token.important),
.rich-text-editor :deep(.token.bold) { font-weight: bold; }
.rich-text-editor :deep(.token.italic) { font-style: italic; }
.rich-text-editor :deep(.token.entity) { cursor: help; }

/* Mention styles */
.rich-text-editor :deep(.editor-mention) {
  color: #5865f2;
  background-color: rgba(88, 101, 242, 0.15);
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  user-select: none;
}

.rich-text-editor :deep(.editor-mention:hover) {
  background-color: rgba(88, 101, 242, 0.3);
  text-decoration: underline;
}
</style>
