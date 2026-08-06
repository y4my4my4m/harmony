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
import { useViewport } from '@/composables/useViewport';
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
  /** Border with hover/focus states: harmony-primary-alpha on hover, harmony-primary on focus. */
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

const { isMobileViewport, isTouchOnly } = useViewport();

const editorRef = ref<HTMLDivElement>();
const isFocused = ref(false);
const serverChannelStore = useServerChannelStore();
// Only `unifiedLoaded` is consumed locally, watched for re-render.
// Emoji resolution goes through emojiShortcodeResolver.findEmojiByName.
const { isLoaded: unifiedLoaded } = useUnifiedEmoji();
const isRendering = ref(false);
const skipNextWatch = ref(false); // Suppresses the modelValue watcher for one cycle during manual render
const undoRedo = useUndoRedo({ maxHistory: 100, groupingDelayMs: 300 });
const visualTheme = useVisualTheme();

// Role ID → { name, color } for rendering role mentions.
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

const getPlainText = (): string => {
  if (!editorRef.value) return '';
  
  let text = '';
  let lastWasMention = false;
  const MERGEABLE_AFTER_MENTION = /[A-Za-z0-9._@-]/;

  const processNode = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      const content = node.textContent || '';
      if (lastWasMention && content && MERGEABLE_AFTER_MENTION.test(content[0])) {
        text += ' ';
      }
      lastWasMention = false;
      text += content;
    } else if (node.nodeType === Node.ELEMENT_NODE) {
      const el = node as HTMLElement;

      if (el.classList.contains('editor-emoji')) {
        lastWasMention = false;
        const emojiName = el.getAttribute('data-emoji');
        if (emojiName) {
          text += `:${emojiName}:`;
        }
      } else if (el.classList.contains('editor-mention')) {
        const displayText = el.getAttribute('data-display-text');

        if (displayText) {
          // Message parsing consumes the display form: @username or @username@domain.
          text += displayText;
        } else {
          text += el.textContent || '';
        }
        lastWasMention = true;
      } else if (el.classList.contains('editor-blockquote')) {
        lastWasMention = false;
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
        // Greentext lines are verbatim; leading `>` is preserved.
        for (const child of Array.from(node.childNodes)) {
          processNode(child);
        }
      } else if (el.tagName === 'BR') {
        lastWasMention = false;
        text += '\n';
      } else if (el.tagName === 'DIV' || el.tagName === 'P') {
        lastWasMention = false;
        // Browsers insert block elements on Enter; Chrome uses <div>.
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
  
  // processMentionsInText writes \u00A0 into the DOM; map back to space so it
  // does not reach stored content.
  text = text.replace(/\u00A0/g, ' ');
  
  // Deleting all content leaves a lone <br>, yielding '\n'; report empty.
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

const setCursorPosition = (targetPosition: number) => {
  if (!editorRef.value) return;

  debug.log('setCursorPosition called with:', targetPosition);
  setSelectionOffsets(targetPosition, targetPosition);
};

const processMentionsInText = (text: string): DocumentFragment => {
  const fragment = document.createDocumentFragment();
  
  // Pre-scan URL ranges; @mentions inside a URL stay plain text,
  // e.g. https://mastodon.social/@user/12345
  const urlRanges: Array<{ start: number; end: number }> = [];
  const preUrlRegex = /\bhttps?:\/\/\S+/g;
  let urlScan;
  while ((urlScan = preUrlRegex.exec(text)) !== null) {
    urlRanges.push({ start: urlScan.index, end: urlScan.index + urlScan[0].length });
  }
  const isInsideUrl = (pos: number): boolean =>
    urlRanges.some(r => pos >= r.start && pos < r.end);

  // Alternation order: role mention first, then user mention.
  // @role:UUID          role
  // @username@domain    remote user
  // @username           local user
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
      // Displays @RoleName; @role:UUID is retained for extraction.
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

      // Uncached: resolve asynchronously, then patch the element in place.
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
      // A match ending at end-of-text is an in-progress autosuggest query and
      // stays text: in "@username test @use", "@use" is not yet a pill.
      if (matchEnd === text.length) {
        const textNode = document.createTextNode(match[0].replace(/ /g, '\u00A0'));
        fragment.appendChild(textNode);
        lastIndex = matchStart; // Held back so the trailing-text branch emits it
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

const createMentionElementFromDisplay = (displayText: string, username: string, domain?: string): HTMLElement => {
  const span = document.createElement('span');
  span.className = 'editor-mention';
  span.contentEditable = 'false'; // Mention is atomic; caret cannot enter it
  
  let userId: string | null = null;
  let userProfile: any = null;
  let isLocal = false;
  let actualDomain = domain;
  
  try {
    userId = userDataService.findUserIdByUsername(username, domain);
    if (userId) {
      userProfile = userDataService.getUserProfile(userId);
      isLocal = userProfile?.is_local || false;
      actualDomain = userProfile?.domain || domain;
    }
  } catch (error) {
    debug.error('Error looking up user for mention:', error);
  }
  
  // Display text uses the @ separator regardless of what the user typed.
  const normalizedDisplayText = isLocal 
    ? `@${username}` 
    : (domain ? `@${username}@${domain}` : `@${username}`);
  
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

const renderContent = (text: string, skipCursorRestore = false) => {
  debug.log('renderContent called with:', text, 'skipCursorRestore:', skipCursorRestore);
  if (!editorRef.value || isRendering.value) {
    debug.log('renderContent early return:', { hasEditor: !!editorRef.value, isRendering: isRendering.value });
    return;
  }
  
  isRendering.value = true;
  const currentCursorPos = getCursorPosition();
  debug.log('Current cursor position:', currentCursorPos);
  
  editorRef.value.innerHTML = '';
  debug.log('Cleared editor content');
  
  if (!text || text.trim().length === 0) {
    // Editor must hold no nodes, not even <br>, for the CSS :empty:before
    // placeholder to show.
    nextTick(() => {
      if (editorRef.value) {
        editorRef.value.innerHTML = '';
      }
    });
    isRendering.value = false;
    return;
  }
  
  // Blockquote segmentation runs before markdown tokenization so tokens inside
  // `> ...` lines land inside the blockquote element.
  // A `> ` at column 0 inside a fenced ``` block is still treated as a quote;
  // `\>` escapes it.
  const fragment = document.createDocumentFragment();
  appendTextWithBlockquotes(text, fragment);
  
  // An empty fragment leaves the editor with no nodes so the CSS
  // :empty:before placeholder shows.
  if (fragment.hasChildNodes()) {
    editorRef.value.appendChild(fragment);
  } else {
    editorRef.value.innerHTML = '';
  }
  
  if (!skipCursorRestore) {
    nextTick(() => {
      if (editorRef.value && (document.activeElement === editorRef.value || 
          editorRef.value.contains(document.activeElement))) {
        debug.log('Restoring cursor position to:', currentCursorPos);
        setCursorPosition(currentCursorPos);
      }
      isRendering.value = false;
    });
  } else {
    debug.log('Skipping cursor restore, will be set externally');
    nextTick(() => {
      isRendering.value = false;
    });
  }
};

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
      
      const startMarker = document.createElement('div');
      startMarker.className = 'editor-codeblock-start';
      
      const startMarkerContent = document.createElement('span');
      startMarkerContent.className = 'editor-marker';
      startMarkerContent.textContent = '```' + (token.language || '');
      startMarker.appendChild(startMarkerContent);
      
      const content = document.createElement('div');
      content.className = 'editor-codeblock-content';
      
      const tokens = highlightSyntax(token.content, token.language);
      tokens.forEach(syntaxToken => {
        if (syntaxToken.content.includes('\n')) {
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
          // Custom or SVG emoji renders as an image.
          const img = document.createElement('img');
          img.src = getEmojiUrl(emoji.url, 48);
          img.alt = `:${token.content}:`;
          img.className = 'emoji-image';
          img.draggable = false;
          span.appendChild(img);
        } else if (emoji.native) {
          // Native unicode emoji.
          span.className = 'editor-emoji native-emoji';
          span.textContent = emoji.native;
        } else {
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

const applyUndoState = (state: UndoState) => {
  skipNextWatch.value = true;
  emit('update:modelValue', state.text);
  renderContent(state.text, true);
  nextTick(() => {
    setCursorPosition(state.cursorPosition);
    autoExpand();
  });
};

// Guard for renderContent: true when `text` may produce extra DOM - bold,
// italic, underline, strikethrough, inline code, blockquote, greentext,
// fenced code, role mention. Markers stay visible in the rendered editor, so
// a partial marker such as a lone `*` also matches.
const hasFormattableMarkers = (text: string): boolean => {
  if (!text) return false;
  if (/[*_~`]/.test(text)) return true;
  if (/^\s*>/m.test(text)) return true;
  if (/```/.test(text)) return true;
  if (/@role:[a-f0-9-]+/i.test(text)) return true;
  return false;
};

const handleInput = (event?: Event) => {
  if (isRendering.value) return; // Prevent recursion

  const text = getPlainText();
  emit('update:modelValue', text);
  if (event) emit('input', event);

  const cursorPos = getCursorPosition();
  emit('cursor-position-changed', cursorPos);

  undoRedo.pushState(text, cursorPos);

  // Render is driven from input, not the modelValue watcher: the watcher
  // short-circuits when the new value equals the editor's plain text, which
  // holds immediately after a keystroke. Gated on hasFormattableMarkers so
  // plain text typing skips the rebuild. renderContent restores the caret.
  if (hasFormattableMarkers(text)) {
    renderContent(text, false);
  }

  // Browsers leave a stray <br> after deleting all content; clear it so the
  // placeholder shows.
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

const handleKeyDown = (event: KeyboardEvent) => {
  // Undo/redo: Ctrl+Z, Ctrl+Y, Ctrl+Shift+Z and Cmd equivalents.
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

  // Mobile means small viewport or touch-only input.
  const isMobile = isMobileViewport.value || isTouchOnly;
  
  // Mobile: Enter inserts a line break; send is a button tap.
  // Desktop: parent handles Enter as send, Shift+Enter as line break.
  if (event.key === 'Enter' && !event.isComposing && isMobile && !event.shiftKey) {
    // Parent may consume it, e.g. while auto-suggest is open.
    emit('keydown', event);
    
    // Unconsumed: insert the line break here.
    if (!event.defaultPrevented) {
      event.preventDefault();
      
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
  
  // Some browsers skip the input event when typing after a
  // contenteditable=false pill, so cursor-position-changed is emitted from
  // keydown for mention/emoji trigger chars. nextTick runs after insertion.
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

const handleFocus = (event: FocusEvent) => {
  isFocused.value = true;
  emit('focus', event);
};

const handleBlur = (event: FocusEvent) => {
  isFocused.value = false;
  emit('blur', event);
};

const handlePaste = (event: ClipboardEvent) => {
  event.preventDefault();

  // Files in the clipboard are the parent's responsibility.
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

  // Text-only paste.
  const text = event.clipboardData?.getData('text/plain') || '';
  insertTextAtCursor(text);
};

const insertTextAtCursor = (text: string) => {
  if (!editorRef.value) return;
  
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    // Appending a text node preserves emoji, mention and formatting spans;
    // setting textContent would flatten them.
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
  
  nextTick(() => {
    const cursorPos = getCursorPosition();
    undoRedo.pushState(newText, cursorPos);
  });
};

const autoExpand = () => {
  if (!editorRef.value) return;
  
  editorRef.value.style.height = 'auto';
  const scrollHeight = editorRef.value.scrollHeight;
  const newHeight = Math.min(Math.max(scrollHeight, props.minHeight), props.maxHeight);
  
  editorRef.value.style.height = newHeight + 'px';
  editorRef.value.style.overflowY = scrollHeight > props.maxHeight ? 'auto' : 'hidden';
};

const focus = () => {
  if (editorRef.value) {
    debug.log('focus() called, editor exists:', !!editorRef.value);
    
    // Blur first for a clean focus state.
    if (document.activeElement === editorRef.value) {
      debug.log('Editor already focused, blurring first');
      editorRef.value.blur();
    }
    
    editorRef.value.focus();
    
    // Focus can fail silently; retry after a frame.
    requestAnimationFrame(() => {
      if (editorRef.value && document.activeElement !== editorRef.value) {
        debug.warn('Focus attempt failed, trying again');
        editorRef.value.focus();
      }
      debug.log('After focus(), activeElement:', document.activeElement === editorRef.value);
      debug.log('Has selection:', !!window.getSelection()?.rangeCount);
    });
  } else {
    debug.warn('focus() called but editorRef is null');
  }
};

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

// Emoji pack loads lazily; re-render so :shortcode: text resolves.
watch(unifiedLoaded, (loaded) => {
  if (loaded && editorRef.value && props.modelValue) {
    const text = getPlainText();
    if (text && text.includes(':')) {
      renderContent(text);
    }
  }
});

// Role cache is per-server; clearing on switch bounds its growth.
watch(() => serverChannelStore.currentServerId, () => {
  roleDisplayCache.clear();
});

watch(() => props.modelValue, (newValue) => {
  if (editorRef.value) {
    if (skipNextWatch.value) {
      debug.log('Skipping watch cycle due to manual cursor control');
      skipNextWatch.value = false;
      return;
    }
    
    const currentText = getPlainText();
    debug.log('RichTextEditor watch triggered:', { 
      newValue: JSON.stringify(newValue), 
      currentText: JSON.stringify(currentText), 
      different: currentText !== newValue 
    });
    if (currentText !== newValue) {
      debug.log('Calling renderContent with:', JSON.stringify(newValue), '(from watch)');
      // Cursor restore stays on: this path covers normal typing.
      renderContent(newValue || '', false);
      autoExpand();
      
      // Clear leftover <br> so the placeholder shows.
      if (!newValue || newValue.trim().length === 0) {
        nextTick(() => {
          if (editorRef.value) {
            const plainText = getPlainText();
            if (plainText.trim().length === 0 && editorRef.value.innerHTML.trim() !== '') {
              editorRef.value.innerHTML = '';
            }
          }
        });
      }
    }
  }
});

onMounted(async () => {
  // Pre-warm the role cache so mentions render without a resolve round-trip.
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

/* Bordered variant: composer inline mode. */
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

.rich-text-editor :deep(.editor-marker) {
  color: var(--text-muted);
  opacity: 0.6;
  font-weight: normal;
}

.rich-text-editor :deep(.editor-bold-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-bold-content) {
  font-weight: bold;
  color: var(--text-primary);
}

.rich-text-editor :deep(.editor-italic-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-italic-content) {
  font-style: italic;
  color: var(--text-primary);
}

.rich-text-editor :deep(.editor-underline-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-underline-content) {
  text-decoration: underline;
  color: var(--text-primary);
}

.rich-text-editor :deep(.editor-strikethrough-wrapper) {
  display: inline;
}

.rich-text-editor :deep(.editor-strikethrough-content) {
  text-decoration: line-through;
  color: var(--text-primary);
}

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

.rich-text-editor.single-line {
  overflow-y: hidden;
}

/* Prism token classes emitted by highlightSyntax. */
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
