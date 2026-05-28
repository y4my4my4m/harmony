<template>
  <div 
    ref="editorRef"
    class="rich-text-editor"
    :class="{ 
      'is-empty': !modelValue && !hasContent, 
      'is-focused': isFocused,
      'single-line': isSingleLine,
      'bordered': bordered
    }"
    role="textbox"
    aria-multiline="true"
    spellcheck="true"
    aria-haspopup="listbox"
    aria-invalid="false"
    aria-autocomplete="list"
    :aria-expanded="props.autoSuggestActive || false"
    :aria-activedescendant="props.autoSuggestSelectedId || undefined"
    aria-controls="auto-suggest-listbox"
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
import { splitIntoBlockSegments } from '@/utils/chatBlockquotes';
import { useVisualTheme } from '@/composables/useVisualTheme';
import { highlightSyntax } from '@/utils/syntaxHighlighter';
import { getEmojiUrl } from '@/utils/emojiUtils';
import { userDataService } from '@/services/userDataService';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { roleService } from '@/services/RoleService';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useUndoRedo, type UndoState } from '@/composables/useUndoRedo';
import { findEmojiByName } from '@/services/emojiShortcodeResolver';
import { applyInlineFormatToggle, type InlineFormatKind } from '@/utils/richTextFormatting';

interface Props {
  modelValue: string;
  placeholder?: string;
  maxHeight?: number;
  minHeight?: number;
  /** When true, shows border with hover/focus states (harmony-primary-alpha on hover, harmony-primary on focus) */
  bordered?: boolean;
  autoSuggestActive?: boolean;
  autoSuggestSelectedId?: string;
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
  minHeight: 44,
  bordered: false
});

const emit = defineEmits<Emits>();

const editorRef = ref<HTMLDivElement>();
const isFocused = ref(false);
const serverChannelStore = useServerChannelStore();
// Only `unifiedLoaded` is consumed locally (watched for re-render).
// Emoji resolution itself goes through emojiShortcodeResolver.findEmojiByName.
const { isLoaded: unifiedLoaded } = useUnifiedEmoji();
const isRendering = ref(false);
const skipNextWatch = ref(false); // Flag to skip watch when manually rendering
const undoRedo = useUndoRedo({ maxHistory: 100, groupingDelayMs: 300 });
const visualTheme = useVisualTheme();

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
  return !!props.modelValue?.trim();
});

const isSingleLine = computed(() => {
  return !props.modelValue.includes('\n');
});

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
      } else if (el.classList.contains('editor-blockquote')) {
        const lineEls = el.querySelectorAll(':scope > .editor-blockquote-line');
        lineEls.forEach((lineEl, index) => {
          if (index > 0) text += '\n';
          text += lineEl.getAttribute('data-prefix') || '';
          const content = lineEl.querySelector('.editor-blockquote-content');
          if (content) {
            for (const child of Array.from(content.childNodes)) {
              processNode(child);
            }
          }
        });
      } else if (el.classList.contains('editor-greentext')) {
        // Greentext lines are stored verbatim (leading `>` is preserved)
        for (const child of Array.from(node.childNodes)) {
          processNode(child);
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
  
  // Normalize non-breaking spaces back to regular spaces so they don't
  // leak into stored content (processMentionsInText uses \u00A0 in the DOM)
  text = text.replace(/\u00A0/g, ' ');
  
  // Treat as empty when there's no actual text (trimmed is empty).
  // Lone <br> from browser when user deletes everything → text is '\n', trimmed is '' → return ''.
  const trimmed = text.trim();
  if (trimmed.length === 0) {
    return '';
  }
  
  return text;
};

const createPlainTextWalker = (root: HTMLElement) =>
  document.createTreeWalker(
    root,
    NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT,
    {
      acceptNode: (node) => {
        let parent = node.parentElement;
        while (parent && parent !== root) {
          if (parent.getAttribute('contenteditable') === 'false') {
            return NodeFilter.FILTER_SKIP;
          }
          parent = parent.parentElement;
        }

        if (node.nodeType === Node.TEXT_NODE) {
          return NodeFilter.FILTER_ACCEPT;
        }
        if (node.nodeType === Node.ELEMENT_NODE) {
          const el = node as HTMLElement;
          if (
            el.classList.contains('editor-emoji') ||
            el.classList.contains('editor-mention') ||
            el.tagName === 'BR'
          ) {
            return NodeFilter.FILTER_ACCEPT;
          }
        }
        return NodeFilter.FILTER_SKIP;
      },
    },
  );

const getNodePlainTextLength = (node: Node): number => {
  if (node.nodeType === Node.TEXT_NODE) {
    return (node.textContent || '').length;
  }
  if (node.nodeType === Node.ELEMENT_NODE) {
    const el = node as HTMLElement;
    if (el.classList.contains('editor-emoji')) {
      const emojiName = el.getAttribute('data-emoji');
      return emojiName ? `:${emojiName}:`.length : 0;
    }
    if (el.classList.contains('editor-mention')) {
      const displayText = el.getAttribute('data-display-text');
      return displayText?.length ?? 0;
    }
    if (el.tagName === 'BR') {
      return 1;
    }
  }
  return 0;
};

const getPlainTextOffsetForPoint = (
  root: HTMLElement,
  targetContainer: Node,
  targetOffset: number,
): number => {
  let position = 0;
  const walker = createPlainTextWalker(root);
  let node = walker.nextNode();

  while (node) {
    if (node === targetContainer) {
      if (node.nodeType === Node.TEXT_NODE) {
        position += targetOffset;
      }
      break;
    }
    if (
      targetContainer.nodeType === Node.ELEMENT_NODE &&
      targetContainer.contains(node)
    ) {
      const nodesBefore = Array.from(targetContainer.childNodes).slice(0, targetOffset);
      if (!nodesBefore.some((n) => n === node || n.contains(node as Node))) {
        break;
      }
    }

    position += getNodePlainTextLength(node);
    node = walker.nextNode();
  }

  return position;
};

const findDomPointAtPlainTextOffset = (
  root: HTMLElement,
  targetPosition: number,
): { node: Node; offset: number } | null => {
  let currentPos = 0;
  const walker = createPlainTextWalker(root);
  let node = walker.nextNode();

  while (node) {
    const nodeLength = getNodePlainTextLength(node);
    if (currentPos + nodeLength >= targetPosition) {
      if (node.nodeType === Node.TEXT_NODE) {
        return { node, offset: targetPosition - currentPos };
      }
      const parent = node.parentNode;
      if (!parent) return null;
      return {
        node: parent,
        offset: Array.from(parent.childNodes).indexOf(node as ChildNode) + 1,
      };
    }
    currentPos += nodeLength;
    node = walker.nextNode();
  }

  return null;
};

const getSelectionOffsets = (): { start: number; end: number } => {
  if (!editorRef.value) return { start: 0, end: 0 };

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return { start: 0, end: 0 };

  const range = selection.getRangeAt(0);
  const start = getPlainTextOffsetForPoint(
    editorRef.value,
    range.startContainer,
    range.startOffset,
  );
  const end = getPlainTextOffsetForPoint(
    editorRef.value,
    range.endContainer,
    range.endOffset,
  );
  return { start, end: Math.max(start, end) };
};

const setSelectionOffsets = (selStart: number, selEnd: number) => {
  if (!editorRef.value) return;

  const selection = window.getSelection();
  if (!selection) return;

  const startPoint = findDomPointAtPlainTextOffset(editorRef.value, selStart);
  const endPoint = findDomPointAtPlainTextOffset(editorRef.value, selEnd);
  if (!startPoint || !endPoint) return;

  try {
    const range = document.createRange();
    if (startPoint.node.nodeType === Node.TEXT_NODE) {
      range.setStart(
        startPoint.node,
        Math.min(startPoint.offset, startPoint.node.textContent?.length || 0),
      );
    } else {
      range.setStart(startPoint.node, Math.min(startPoint.offset, startPoint.node.childNodes.length));
    }
    if (endPoint.node.nodeType === Node.TEXT_NODE) {
      range.setEnd(
        endPoint.node,
        Math.min(endPoint.offset, endPoint.node.textContent?.length || 0),
      );
    } else {
      range.setEnd(endPoint.node, Math.min(endPoint.offset, endPoint.node.childNodes.length));
    }
    selection.removeAllRanges();
    selection.addRange(range);
  } catch (e) {
    debug.warn('Error setting selection offsets:', e);
  }
};

// Get cursor position as text offset
const getCursorPosition = (): number => {
  if (!editorRef.value) return 0;

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return 0;

  const range = selection.getRangeAt(0);
  return getPlainTextOffsetForPoint(
    editorRef.value,
    range.startContainer,
    range.startOffset,
  );
};

// Set cursor position from text offset
const setCursorPosition = (targetPosition: number) => {
  if (!editorRef.value) return;

  debug.log('🔧 setCursorPosition called with:', targetPosition);
  setSelectionOffsets(targetPosition, targetPosition);
};

// Process mentions in text and create visual elements
const processMentionsInText = (text: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  
  // Pre-scan for URLs to avoid rendering @mentions inside them
  // (e.g., https://mastodon.social/@user/12345)
  const urlRanges: Array<{ start: number; end: number }> = [];
  const preUrlRegex = /\bhttps?:\/\/\S+/g;
  let urlScan;
  while ((urlScan = preUrlRegex.exec(text)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  // Match role mentions, then user mentions
  // @role:UUID - role mention
  // @username@domain - remote user mention
  // @username - local user mention
  const mentionRegex = /(@role:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))|(@([a-zA-Z0-9_-]+)(?:@([a-zA-Z0-9.-]+))?)/g;
  
  let lastIndex = 0;
  let match;
  
  while ((match = mentionRegex.exec(text)) !== null) {
    if (isInsideUrl(match.index)) continue;
    const matchStart = match.index;
    const matchEnd = match.index + match[0].length;
    
    if (matchStart > lastIndex) {
      const textBefore = text.substring(lastIndex, matchStart);
      const textNode = document.createTextNode(textBefore.replace(/ /g, '\u00A0'));
      fragment.appendChild(textNode);
    }
    
    if (match[1]) {
      // Role mention - show @RoleName visually, keep @role:UUID for extraction
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
      // User mention - but skip if match is at the end of text (likely in-progress autosuggest query)
      // e.g. "@username test @use" - don't convert "@use" to a pill yet, let autosuggest trigger
      if (matchEnd === text.length) {
        const textNode = document.createTextNode(match[0].replace(/ /g, '\u00A0'));
        fragment.appendChild(textNode);
        lastIndex = matchStart; // Don't advance - we're leaving it as text, will be in remaining
      } else {
        const username = match[4];
        const domain = match[5];
        const mentionElement = createMentionElementFromDisplay(match[0], username, domain);
        fragment.appendChild(mentionElement);
      }
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

const appendTextWithBlockquotes = (text: string, target: DocumentFragment | HTMLElement) => {
  const greentextEnabled = visualTheme.currentSettings.value.greentextEnabled !== false;
  const segments = splitIntoBlockSegments(text, { greentext: greentextEnabled });

  segments.forEach((segment, segmentIndex) => {
    if (segmentIndex > 0) {
      target.appendChild(document.createElement('br'));
    }

    if (segment.type === 'text') {
      appendFormattedText(segment.content, target);
    } else if (segment.type === 'greentext') {
      appendGreentext(target, segment.lines);
    } else if (target instanceof DocumentFragment) {
      appendBlockquote(target, segment.lines, segment.multiLine);
    } else {
      const inner = document.createDocumentFragment();
      appendBlockquote(inner, segment.lines, segment.multiLine);
      target.appendChild(inner);
    }
  });
};

const appendGreentext = (target: DocumentFragment | HTMLElement, lines: string[]) => {
  lines.forEach((line, index) => {
    if (index > 0) target.appendChild(document.createElement('br'));
    const span = document.createElement('span');
    span.className = 'editor-greentext';
    appendFormattedText(line, span);
    target.appendChild(span);
  });
};

const appendFormattedText = (text: string, target: DocumentFragment | HTMLElement) => {
  const tokens = parseMarkdownWithMarkers(text);
  tokens.forEach((token) => {
    if (token.type === 'text') {
      const lines = token.content.split('\n');
      lines.forEach((line, index) => {
        if (line) {
          target.appendChild(processMentionsInText(line));
        }
        if (index < lines.length - 1) {
          target.appendChild(document.createElement('br'));
        }
      });
    } else {
      target.appendChild(createElementFromToken(token));
    }
  });
};

const appendBlockquote = (
  target: DocumentFragment,
  lines: string[],
  multiLine = false,
) => {
  const block = document.createElement('div');
  block.className = 'editor-blockquote';
  block.setAttribute('data-quote-mode', multiLine ? 'multi' : 'single');

  lines.forEach((line, index) => {
    const lineEl = document.createElement('div');
    lineEl.className = 'editor-blockquote-line';
    const prefix = multiLine ? (index === 0 ? '>>> ' : '') : '> ';
    lineEl.setAttribute('data-prefix', prefix);

    if (prefix) {
      const marker = document.createElement('span');
      marker.className = 'editor-marker';
      marker.textContent = prefix;
      lineEl.appendChild(marker);
    }

    const contentWrap = document.createElement('span');
    contentWrap.className = 'editor-blockquote-content';
    appendFormattedText(line, contentWrap);

    lineEl.appendChild(contentWrap);
    block.appendChild(lineEl);
  });

  target.appendChild(block);
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
  
  // Split into blockquote / non-blockquote segments first so markdown tokens
  // (bold, italic, etc.) inside `> ...` lines render inside the blockquote.
  // Lines inside a fenced ``` block can't start with `>` followed by space at
  // column 0 in practice; if they do the user can avoid quoting by using `\>`.
  const fragment = document.createDocumentFragment();
  appendTextWithBlockquotes(text, fragment);
  
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
      if (token.children) {
        for (const child of token.children) {
          content.appendChild(createElementFromToken(child));
        }
      } else {
        content.textContent = token.content;
      }
      
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
      if (token.children) {
        for (const child of token.children) {
          content.appendChild(createElementFromToken(child));
        }
      } else {
        content.textContent = token.content;
      }
      
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
      if (token.children) {
        for (const child of token.children) {
          content.appendChild(createElementFromToken(child));
        }
      } else {
        content.textContent = token.content;
      }
      
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
      if (token.children) {
        for (const child of token.children) {
          content.appendChild(createElementFromToken(child));
        }
      } else {
        content.textContent = token.content;
      }
      
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
      const emoji = findEmojiByName(token.content) as any;
      if (emoji) {
        const span = document.createElement('span');
        span.className = 'editor-emoji';
        span.contentEditable = 'false';
        span.setAttribute('data-emoji', token.content);
        
        if (emoji.url) {
          // SVG/Custom emoji - use image
          const img = document.createElement('img');
          img.src = getEmojiUrl(emoji.url, 48);
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

// Apply an undo/redo state snapshot
const applyUndoState = (state: UndoState) => {
  skipNextWatch.value = true;
  emit('update:modelValue', state.text);
  renderContent(state.text, true);
  nextTick(() => {
    setCursorPosition(state.cursorPosition);
    autoExpand();
  });
};

// Returns true if `text` likely contains markdown formatting that the
// editor renders with extra DOM (bold, italic, underline, strikethrough,
// inline code, blockquotes, greentext, fenced code, role mentions). We use
// this as a guard so we only pay the renderContent cost on input events
// that actually need to change the DOM, keeping fast typing of plain text
// snappy. The rendered editor includes marker spans (e.g. `**` kept
// visible), so even partial markers like a single `*` trigger a re-render.
const hasFormattableMarkers = (text: string): boolean => {
  if (!text) return false;
  if (/[*_~`]/.test(text)) return true;
  if (/^\s*>/m.test(text)) return true;
  if (/```/.test(text)) return true;
  if (/@role:[a-f0-9-]+/i.test(text)) return true;
  return false;
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

  // Track state for undo/redo
  undoRedo.pushState(text, cursorPos);

  // Re-render to apply markdown / blockquote / greentext styling. The
  // watcher used to be the only call site for `renderContent`, but it
  // short-circuits when the new value equals the editor's plain text -
  // which is always the case immediately after the user types, so live
  // formatting never appeared during input. We now drive the render
  // directly from input events, gated on `hasFormattableMarkers` so plain
  // text typing doesn't pay the rebuild cost. Cursor restore inside
  // `renderContent` keeps the caret stable across the rebuild.
  if (hasFormattableMarkers(text)) {
    renderContent(text, false);
  }

  // Ensure editor is empty when text is removed (for placeholder to show)
  // Clear stray <br> that browsers leave when user deletes all content
  const hasNoContent = !text || text.trim().length === 0;
  if (hasNoContent) {
    nextTick(() => {
      if (editorRef.value) {
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

const applyEditorTextChange = (newText: string, selStart: number, selEnd: number) => {
  skipNextWatch.value = true;
  emit('update:modelValue', newText);
  renderContent(newText, true);
  nextTick(() => {
    setSelectionOffsets(selStart, selEnd);
    undoRedo.pushState(newText, selStart);
    autoExpand();
  });
};

const toggleInlineFormat = (kind: InlineFormatKind) => {
  if (!editorRef.value) return;

  const text = getPlainText();
  const { start, end } = getSelectionOffsets();
  const { text: newText, selectionStart, selectionEnd } = applyInlineFormatToggle(
    text,
    start,
    end,
    kind,
  );
  applyEditorTextChange(newText, selectionStart, selectionEnd);
};

// Handle keyboard events
const handleKeyDown = (event: KeyboardEvent) => {
  // Undo / Redo interception (Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z, Cmd variants)
  if ((event.ctrlKey || event.metaKey) && !event.altKey) {
    if (event.key === 'z' && !event.shiftKey) {
      event.preventDefault();
      const state = undoRedo.undo();
      if (state) applyUndoState(state);
      return;
    }
    if (event.key === 'y' || (event.key === 'z' && event.shiftKey)) {
      event.preventDefault();
      const state = undoRedo.redo();
      if (state) applyUndoState(state);
      return;
    }
    const formatKey = event.key.toLowerCase();
    if (formatKey === 'b') {
      event.preventDefault();
      toggleInlineFormat('bold');
      return;
    }
    if (formatKey === 'i') {
      event.preventDefault();
      toggleInlineFormat('italic');
      return;
    }
  }

  // Detect true mobile devices (small screen OR touch-only without mouse)
  const hasSmallScreen = window.innerWidth <= 768;
  const isTouchOnlyDevice = 'ontouchstart' in window && !window.matchMedia('(pointer: fine)').matches;
  const isMobile = hasSmallScreen || isTouchOnlyDevice;
  
  // On mobile, Enter inserts line break (user taps send button)
  // On desktop, emit to parent and let it handle (Enter sends, Shift+Enter for new line)
  if (event.key === 'Enter' && !event.isComposing && isMobile && !event.shiftKey) {
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
  
  // Fallback: emit cursor-position-changed on keydown for @ or mention/emoji chars.
  // In some browsers, input doesn't fire when typing after contenteditable=false pills.
  // nextTick runs after the key is inserted, so autosuggest gets the correct state.
  const isTriggerChar = !event.isComposing &&
    (event.key === '@' || event.key === ':' ||
    (event.key.length === 1 && /[a-zA-Z0-9_+-]/.test(event.key)));
  if (isTriggerChar && !event.ctrlKey && !event.metaKey && !event.altKey) {
    nextTick(() => {
      if (!isRendering.value && editorRef.value) {
        const sel = window.getSelection();
        if (sel?.rangeCount && editorRef.value.contains(sel.getRangeAt(0).startContainer)) {
          const pos = getCursorPosition();
          emit('cursor-position-changed', pos);
        }
      }
    });
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
    // Append as a text node instead of setting textContent (which would
    // flatten all structured DOM like emojis, mentions, and formatting spans)
    editorRef.value.appendChild(document.createTextNode(text));
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
  
  // Track insertion for undo/redo
  nextTick(() => {
    const cursorPos = getCursorPosition();
    undoRedo.pushState(newText, cursorPos);
  });
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
    undoRedo.clear();
    autoExpand();
  }
};

defineExpose({
  focus,
  clear,
  insertTextAtCursor,
  getCursorPosition,
  setCursorPosition,
  getPlainText,
  renderContent,
  skipNextWatch,
  undo: undoRedo.undo,
  redo: undoRedo.redo,
});

// Re-render when the emoji pack finishes lazy-loading so :shortcode: text resolves
watch(unifiedLoaded, (loaded) => {
  if (loaded && editorRef.value && props.modelValue) {
    const text = getPlainText();
    if (text && text.includes(':')) {
      renderContent(text);
    }
  }
});

// Clear role cache when switching servers to prevent unbounded growth
watch(() => serverChannelStore.currentServerId, () => {
  roleDisplayCache.clear();
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
    undoRedo.reset(props.modelValue, props.modelValue.length);
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
  font-family: var(--font-family);
  color: var(--text-secondary);
  overflow-wrap: break-word;
  word-wrap: break-word;
  word-break: break-word;
  resize: none;
  overflow-y: auto;
}

.rich-text-editor.is-empty::before {
  content: attr(data-placeholder);
  color: var(--text-muted);
  pointer-events: none;
  position: absolute;
  top: 11px;
  left: 12px;
}

/* Bordered variant: border with hover/focus states for composer inline mode */
.rich-text-editor.bordered {
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: border-color 0.2s ease, box-shadow 0.2s ease;
}

.rich-text-editor.bordered:hover {
  border-color: var(--harmony-primary-alpha);
}

.rich-text-editor.bordered.is-focused {
  border-color: var(--harmony-primary);
  box-shadow: 0 0 0 2px var(--harmony-primary-light);
}

/* Markdown markers styling */
.rich-text-editor :deep(.editor-marker) {
  color: var(--text-muted);
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
  background: var(--background-tertiary);
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
  background: var(--background-tertiary);
  border: 1px solid #202225;
  border-radius: 4px;
  overflow: hidden;
}

.rich-text-editor :deep(.editor-codeblock-start),
.rich-text-editor :deep(.editor-codeblock-end) {
  background: var(--background-secondary);
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
  color: #0EA5E9;
  background-color: rgba(14, 165, 233, 0.15);
  border-radius: 3px;
  padding: 0 2px;
  cursor: pointer;
  font-weight: 500;
  user-select: none;
}

.rich-text-editor :deep(.editor-mention:hover) {
  background-color: rgba(14, 165, 233, 0.3);
  text-decoration: underline;
}

.rich-text-editor :deep(.editor-role-mention) {
  font-weight: 600;
}

.rich-text-editor :deep(.editor-blockquote) {
  border-left: 4px solid var(--background-modifier-accent, #4f545c);
  padding-left: 8px;
  margin: 2px 0;
  color: var(--text-secondary);
}

.rich-text-editor :deep(.editor-blockquote-line) {
  display: block;
}

.rich-text-editor :deep(.editor-blockquote-content) {
  color: var(--text-secondary);
}

.rich-text-editor :deep(.editor-greentext) {
  color: #789922;
}
</style>
