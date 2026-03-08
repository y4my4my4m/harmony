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
import { debug } from '@/utils/debug'
import { parseMarkdownWithMarkers, type MarkdownToken } from '@/utils/markdownParser';
import { highlightSyntax } from '@/utils/syntaxHighlighter';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { userDataService } from '@/services/userDataService';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { roleService } from '@/services/RoleService';
import { useServerChannelStore } from '@/stores/useServerChannel';

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
  (e: 'paste', event: ClipboardEvent): void;
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
const serverChannelStore = useServerChannelStore();
const { resolveEmoji, isNativePack, getSvgUrl, isLoaded: unifiedLoaded } = useUnifiedEmoji();
const isRendering = ref(false);
const skipNextWatch = ref(false); // Flag to skip watch when manually rendering

// Cache of role ID → { name, color } for displaying role mentions in the editor
const roleDisplayCache = new Map<string, { name: string; color: string | null }>();

async function resolveRoleDisplay(roleId: string): Promise<{ name: string; color: string | null }> {
  if (roleDisplayCache.has(roleId)) return roleDisplayCache.get(roleId)!;
  const serverId = serverChannelStore.currentServerId;
  if (serverId) {
    try {
      const roles = await roleService.getRolesForServer(serverId);
      for (const role of roles) {
        roleDisplayCache.set(role.id, { name: role.name.replace(/^@/, ''), color: role.color });
      }
      if (roleDisplayCache.has(roleId)) return roleDisplayCache.get(roleId)!;
    } catch { /* fall through */ }
  }
  try {
    const role = await roleService.getRole(roleId);
    if (role) {
      const entry = { name: role.name.replace(/^@/, ''), color: role.color };
      roleDisplayCache.set(roleId, entry);
      return entry;
    }
  } catch { /* fall through */ }
  return { name: 'Unknown Role', color: null };
}

function getCachedRoleDisplay(roleId: string): { name: string; color: string | null } | null {
  return roleDisplayCache.get(roleId) || null;
}

const hasContent = computed(() => {
  if (!editorRef.value) return false;
  const text = getPlainText();
  return text.length > 0;
});

const isSingleLine = computed(() => {
  return !props.modelValue.includes('\n');
});

// Find emoji by name in cache or unified emoji pack
const findEmojiByName = (name: string) => {
  try {
    // First check server custom emojis via name index (fast path)
    const nameIndexEntries = emojiCache.nameIndex.get(name);
    if (nameIndexEntries && nameIndexEntries.length > 0) {
      for (const entry of nameIndexEntries) {
        if (entry.emoji && entry.emoji.url) {
          return entry.emoji;
        }
      }
    }
    
    // Fallback: iterate through server caches
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
    
    // Then check unified emoji pack (mutant or native)
    if (unifiedLoaded.value) {
      const resolved = resolveEmoji(name);
      if (resolved.display.type === 'svg') {
        return {
          name: resolved.shortcode || name,
          url: resolved.display.content
        };
      } else if (resolved.display.type === 'native' && resolved.unicode !== name) {
        // Return native emoji (renderer will handle display)
        return {
          name: resolved.shortcode || name,
          url: null,
          native: resolved.unicode
        };
      }
    }
    
    return null;
  } catch (error) {
    debug.warn('Error finding emoji by name:', error);
    return null;
  }
};

// Extract plain text from the editor (preserving markdown)
const getPlainText = (): string => {
  if (!editorRef.value) return '';
  
  let text = '';
  
  const processNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent || '';
      // Always add text content (including whitespace/newlines)
      text += content;
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
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        // Block elements created by some browsers (Chrome uses <div> for Enter)
        if (text.length > 0 && !text.endsWith('\n')) {
          text += '\n';
        }
        for (const child of Array.from(node.childNodes)) {
          processNode(child);
        }
      } else {
        for (const child of Array.from(node.childNodes)) {
          processNode(child);
        }
      }
    }
  };
  
  for (const child of Array.from(editorRef.value.childNodes)) {
    processNode(child);
  }
  
  // Only return empty if there's truly no content (no text, no BRs, or only whitespace)
  // But preserve newlines if they exist (user might have typed them)
  const trimmed = text.trim();
  if (trimmed.length === 0 && !text.includes('\n')) {
    return '';
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
        const displayText = el.getAttribute('data-display-text');
        if (displayText) {
          position += displayText.length; // Count the display text length (@username or @username@domain)
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
  
  debug.log('🔧 setCursorPosition called with:', targetPosition);
  
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
        // Skip nodes inside contenteditable=false elements (like mention spans)
        let parent = node.parentElement;
        while (parent && parent !== editorRef.value) {
          if (parent.getAttribute('contenteditable') === 'false') {
            return NodeFilter.FILTER_SKIP;
          }
          parent = parent.parentElement;
        }
        
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
      debug.log('🔧 Processing text node:', { text: JSON.stringify(node.textContent), length: nodeLength, currentPos, targetPosition });
      if (currentPos + nodeLength >= targetPosition) {
        targetNode = node;
        targetOffset = targetPosition - currentPos;
        debug.log('🔧 Found target in text node:', { targetOffset, text: JSON.stringify(node.textContent) });
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
        const displayText = el.getAttribute('data-display-text');
        if (displayText) {
          nodeLength = displayText.length; // Count the display text length (@username or @username@domain)
        }
        debug.log('🔧 Processing mention element:', { displayText, length: nodeLength, currentPos, targetPosition });
      } else if (el.tagName === 'BR') {
        nodeLength = 1;
      }
      
      if (currentPos + nodeLength >= targetPosition) {
        // Position cursor after this element
        targetNode = el.parentNode;
        targetOffset = Array.from(el.parentNode?.childNodes || []).indexOf(el) + 1;
        debug.log('🔧 Found target after element:', { element: el.tagName, targetOffset });
        break;
      }
      currentPos += nodeLength;
    }
    node = walker.nextNode();
  }
  
  if (targetNode) {
    try {
      debug.log('🔧 Setting range:', { 
        nodeType: targetNode.nodeType, 
        nodeName: targetNode.nodeName, 
        targetOffset,
        nodeContent: targetNode.nodeType === Node.TEXT_NODE ? JSON.stringify(targetNode.textContent) : 'N/A'
      });
      const range = document.createRange();
      if (targetNode.nodeType === Node.TEXT_NODE) {
        range.setStart(targetNode, Math.min(targetOffset, targetNode.textContent?.length || 0));
      } else {
        range.setStart(targetNode, Math.min(targetOffset, targetNode.childNodes.length));
      }
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
      debug.log('🔧 Cursor position set successfully');
    } catch (e) {
      debug.warn('Error setting cursor position:', e);
    }
  } else {
    debug.warn('🔧 Could not find target node for position:', targetPosition);
  }
};

// Process mentions in text and create visual elements
const processMentionsInText = (text: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  
  // Match role mentions, then user mentions
  // @role:UUID - role mention
  // @username@domain - remote user mention
  // @username - local user mention
  const mentionRegex = /(@role:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))|(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(text)) !== null) {
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    
    if (matchStart > lastIndex) {
      const textBefore = text.substring(lastIndex, matchStart);
      const textNode = document.createTextNode(textBefore.replace(/ /g, '\u00A0'));
      fragment.appendChild(textNode);
    }
    
    if (match[1]) {
      // Role mention – show @RoleName visually, keep @role:UUID for extraction
      const roleId = match[2];
      const cached = getCachedRoleDisplay(roleId);
      const rawName = cached?.name || 'loading...';
      const roleName = rawName.replace(/^@/, '');
      const roleColor = cached?.color;

      const span = document.createElement('span');
      span.className = 'editor-mention editor-role-mention';
      span.contentEditable = 'false';
      span.setAttribute('data-role-id', roleId);
      span.setAttribute('data-display-text', match[0]); // @role:UUID for getPlainText
      span.textContent = `@${roleName}`;
      if (roleColor) {
        span.style.color = roleColor;
        span.style.backgroundColor = roleColor + '1a';
      }

      // If not cached yet, resolve async and re-render
      if (!cached) {
        resolveRoleDisplay(roleId).then(() => {
          if (editorRef.value && !isRendering.value) {
            const el = editorRef.value.querySelector(`[data-role-id="${roleId}"]`);
            if (el) {
              const resolved = getCachedRoleDisplay(roleId);
              if (resolved) {
                el.textContent = `@${resolved.name.replace(/^@/, '')}`;
                if (resolved.color) {
                  (el as HTMLElement).style.color = resolved.color;
                  (el as HTMLElement).style.backgroundColor = resolved.color + '1a';
                }
              }
            }
          }
        });
      }
      fragment.appendChild(span);
    } else if (match[3]) {
      // User mention
      const username = match[4];
      const domain = match[5];
      const mentionElement = createMentionElementFromDisplay(match[0], username, domain);
      fragment.appendChild(mentionElement);
    }
    
    lastIndex = matchEnd;
  }
  
  if (lastIndex < text.length) {
    const remainingText = text.substring(lastIndex);
    const textNode = document.createTextNode(remainingText.replace(/ /g, '\u00A0'));
    fragment.appendChild(textNode);
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
      actualDomain = userProfile?.domain || domain;
    }
  } catch (error) {
    debug.error('Error looking up user for mention:', error);
  }
  
  // Normalize display text to use @ separator (even if user typed with .)
  const normalizedDisplayText = isLocal 
    ? `@${username}` 
    : (domain ? `@${username}@${domain}` : `@${username}`);
  
  // Store rich metadata in data attributes
  span.setAttribute('data-type', 'mention');
  span.setAttribute('data-username', username);
  span.setAttribute('data-display-text', normalizedDisplayText);
  
  if (userId) {
    span.setAttribute('data-userid', userId);
  }
  if (actualDomain) {
    span.setAttribute('data-domain', actualDomain);
  }
  span.setAttribute('data-islocal', isLocal.toString());
  
  // Display text (what the user sees) - use normalized format
  span.textContent = normalizedDisplayText;
  
  return span;
};

// Render content with Discord-like markdown styling
const renderContent = (text: string, skipCursorRestore = false) => {
  debug.log('🔧 renderContent called with:', text, 'skipCursorRestore:', skipCursorRestore);
  if (!editorRef.value || isRendering.value) {
    debug.log('🔧 renderContent early return:', { hasEditor: !!editorRef.value, isRendering: isRendering.value });
    return;
  }
  
  isRendering.value = true;
  const currentCursorPos = getCursorPosition();
  debug.log('🔧 Current cursor position:', currentCursorPos);
  
  // Clear content
  editorRef.value.innerHTML = '';
  debug.log('🔧 Cleared editor content');
  
  if (!text || text.trim().length === 0) {
    // Keep editor truly empty (no BR tags) so placeholder shows via CSS :empty:before
    // Use nextTick to ensure DOM is updated
    nextTick(() => {
      if (editorRef.value) {
        editorRef.value.innerHTML = '';
      }
    });
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
  
  // Only append fragment if it has content
  // Don't add BR when empty - let CSS :empty:before show placeholder
  if (fragment.hasChildNodes()) {
    editorRef.value.appendChild(fragment);
  } else {
    // Ensure editor is truly empty (no BR tags) when no content
    editorRef.value.innerHTML = '';
  }
  
  // Restore cursor position only if not skipping
  if (!skipCursorRestore) {
    nextTick(() => {
      if (editorRef.value && (document.activeElement === editorRef.value || 
          editorRef.value.contains(document.activeElement))) {
        debug.log('🔧 Restoring cursor position to:', currentCursorPos);
        setCursorPosition(currentCursorPos);
      }
      isRendering.value = false;
    });
  } else {
    debug.log('🔧 Skipping cursor restore, will be set externally');
    nextTick(() => {
      isRendering.value = false;
    });
  }
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
      if (emoji) {
        const span = document.createElement('span');
        span.className = 'editor-emoji';
        span.contentEditable = 'false';
        span.setAttribute('data-emoji', token.content);
        
        if (emoji.url) {
          // SVG/Custom emoji - use image
          const img = document.createElement('img');
          img.src = emoji.url;
          img.alt = `:${token.content}:`;
          img.className = 'emoji-image';
          img.draggable = false;
          span.appendChild(img);
        } else if (emoji.native) {
          // Native unicode emoji
          span.className = 'editor-emoji native-emoji';
          span.textContent = emoji.native;
        } else {
          // Fallback to shortcode text
          return document.createTextNode(`:${token.content}:`);
        }
        
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
const handleInput = (event?: Event) => {
  if (isRendering.value) return; // Prevent recursion
  
  const text = getPlainText();
  emit('update:modelValue', text);
  if (event) emit('input', event);
  
  // Emit cursor position for auto-suggest
  const cursorPos = getCursorPosition();
  emit('cursor-position-changed', cursorPos);
  
  // DO NOT re-render on input to avoid infinite loops
  // Rendering will happen when modelValue changes externally
  
  // Ensure editor is empty when text is removed (for placeholder to show)
  // But preserve intentional newlines (user might have typed them)
  const hasNoContent = !text || text.trim().length === 0;
  const hasNoNewlines = !text?.includes('\n');
  
  if (hasNoContent && hasNoNewlines) {
    nextTick(() => {
      if (editorRef.value) {
        // Only clear if there's no actual content (no text, no intentional newlines)
        const hasOnlyWhitespace = editorRef.value.textContent?.trim().length === 0;
        if (hasOnlyWhitespace && editorRef.value.innerHTML.trim() !== '') {
          editorRef.value.innerHTML = '';
        }
      }
    });
  }
  
  // Auto-expand editor
  autoExpand();
};

// Handle keyboard events
const handleKeyDown = (event: KeyboardEvent) => {
  // Detect true mobile devices (small screen OR touch-only without mouse)
  const hasSmallScreen = window.innerWidth <= 768;
  const isTouchOnlyDevice = 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;
  const isMobile = hasSmallScreen || isTouchOnlyDevice;
  
  // On mobile, Enter inserts line break (user taps send button)
  // On desktop, emit to parent and let it handle (Enter sends, Shift+Enter for new line)
  if (event.key === 'Enter' && isMobile && !event.shiftKey) {
    // Check if parent will handle this (e.g., auto-suggest active)
    emit('keydown', event);
    
    // If parent didn't prevent default, insert a line break manually
    if (!event.defaultPrevented) {
      event.preventDefault();
      
      // Insert a proper <br> tag for single line spacing
      const selection = window.getSelection();
      if (selection && selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        range.deleteContents();
        
        const br = document.createElement('br');
        range.insertNode(br);
        
        range.setStartAfter(br);
        range.setEndAfter(br);
        selection.removeAllRanges();
        selection.addRange(range);
        
        handleInput();
      }
    }
    return;
  }
  
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

  // Check for image/file data in clipboard - let parent handle it
  const items = event.clipboardData?.items;
  if (items) {
    let hasFiles = false;
    for (const item of Array.from(items)) {
      if (item.kind === 'file') {
        hasFiles = true;
        break;
      }
    }
    if (hasFiles) {
      emit('paste', event);
      return;
    }
  }

  // Text-only paste
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
    debug.log('🔧 focus() called, editor exists:', !!editorRef.value);
    
    // Blur first to ensure clean state
    if (document.activeElement === editorRef.value) {
      debug.log('🔧 Editor already focused, blurring first');
      editorRef.value.blur();
    }
    
    // Focus the element
    editorRef.value.focus();
    
    // Double-check focus was established
    requestAnimationFrame(() => {
      if (editorRef.value && document.activeElement !== editorRef.value) {
        debug.warn('🔧 Focus attempt failed, trying again');
        editorRef.value.focus();
      }
      debug.log('🔧 After focus(), activeElement:', document.activeElement === editorRef.value);
      debug.log('🔧 Has selection:', !!window.getSelection()?.rangeCount);
    });
  } else {
    debug.warn('🔧 focus() called but editorRef is null');
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
  setCursorPosition,
  renderContent,
  skipNextWatch // Expose this so MessageInput can set it
});

// Watch for external model value changes
watch(() => props.modelValue, (newValue) => {
  if (editorRef.value) {
    // Check if we should skip this watch cycle (manual cursor control)
    if (skipNextWatch.value) {
      debug.log('🔧 Skipping watch cycle due to manual cursor control');
      skipNextWatch.value = false;
      return;
    }
    
    const currentText = getPlainText();
    debug.log('🔧 RichTextEditor watch triggered:', { 
      newValue: JSON.stringify(newValue), 
      currentText: JSON.stringify(currentText), 
      different: currentText !== newValue 
    });
    if (currentText !== newValue) {
      debug.log('🔧 Calling renderContent with:', JSON.stringify(newValue), '(from watch)');
      // Don't skip cursor restore here - this is for normal typing
      renderContent(newValue || '', false);
      autoExpand();
      
      // Ensure placeholder shows when empty - clear any remaining BR tags
      if (!newValue || newValue.trim().length === 0) {
        nextTick(() => {
          if (editorRef.value) {
            const plainText = getPlainText();
            if (plainText.trim().length === 0 && editorRef.value.innerHTML.trim() !== '') {
              // Clear any remaining content (like BR tags) to show placeholder
              editorRef.value.innerHTML = '';
            }
          }
        });
      }
    }
  }
});

onMounted(async () => {
  // Pre-warm role cache so role mentions resolve instantly
  const serverId = serverChannelStore.currentServerId;
  if (serverId) {
    try {
      const roles = await roleService.getRolesForServer(serverId);
      for (const role of roles) {
        roleDisplayCache.set(role.id, { name: role.name.replace(/^@/, ''), color: role.color });
      }
    } catch { /* non-critical */ }
  }

  if (props.modelValue) {
    renderContent(props.modelValue);
  }
  autoExpand();
});
</script>
<style scoped>
.rich-text-editor {
  position: relative;
  min-height: var(--min-height);
  max-height: var(--max-height);
  padding: 11px 12px;
  background: transparent;
  border: none;
  outline: none;
  font-size: 1rem;
  line-height: 1.375;
  font-family: 'Figtree', 'Noto Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  color: var(--text-secondary);
  overflow-wrap: break-word;
  word-wrap: break-word;
  word-break: break-word;
  resize: none;
  overflow-y: auto;
}

.rich-text-editor.is-empty::before {
  content: attr(data-placeholder);
  color: #72767d;
  pointer-events: none;
  position: absolute;
  top: 11px;
  left: 12px;
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
  color: var(--text-primary);
}

/* Italic styling */
.rich-text-editor :deep(.editor-italic-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-italic-content) {
  font-style: italic;
  color: var(--text-primary);
}

/* Underline styling */
.rich-text-editor :deep(.editor-underline-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-underline-content) {
  text-decoration: underline;
  color: var(--text-primary);
}

/* Strikethrough styling */
.rich-text-editor :deep(.editor-strikethrough-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-strikethrough-content) {
  text-decoration: line-through;
  color: var(--text-primary);
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

.rich-text-editor :deep(.editor-emoji.native-emoji) {
  font-size: 1.25em;
  line-height: 1;
  margin: 0 0.05em;
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

.rich-text-editor :deep(.editor-role-mention) {
  font-weight: 600;
}
</style>
