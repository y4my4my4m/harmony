import { ref, computed, nextTick, watch } from 'vue';
import type { Ref } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { userDataService } from '@/services/userDataService';
import { activityPubService } from '@/services/activityPubService';
import type { SuggestionItem, SuggestionPosition } from '@/components/AutoSuggest.vue';
import type { ResolvedEmoji } from '@/types';
import { debug } from '@/utils/debug'

export interface AutoSuggestTrigger {
  char: string;
  pattern: RegExp;
  type: 'emoji' | 'mention';
}

export interface AutoSuggestState {
  isActive: boolean;
  triggerType: 'emoji' | 'mention' | null;
  query: string;
  triggerPosition: number;
  selectedIndex: number;
  position: SuggestionPosition;
}

export interface AutoSuggestConfig {
  mode: 'chat' | 'activitypub';
  enableEmojis?: boolean;
  enableMentions?: boolean;
  maxSuggestions?: number;
}

interface RichTextEditorRef {
  getCursorPosition?: () => number;
  focus?: () => void;
  insertTextAtCursor?: (text: string) => void;
  $el?: HTMLElement;
}

type InputElementType = HTMLTextAreaElement | HTMLInputElement | RichTextEditorRef | any;

export function useAutoSuggest(
  inputElement: Ref<InputElementType | null>,
  getCurrentText?: () => string,
  updateText?: (newText: string, cursorPosition?: number) => void,
  config: AutoSuggestConfig = { mode: 'chat' }
) {
  const emojiCacheStore = useEmojiCacheStore();
  const serverChannelStore = useServerChannelStore();

  // Merge config with defaults
  const finalConfig = {
    enableEmojis: true,
    enableMentions: true,
    maxSuggestions: 10,
    ...config,
    mode: config.mode || 'chat'
  } as Required<AutoSuggestConfig>;

  // Auto-suggest state
  const state = ref<AutoSuggestState>({
    isActive: false,
    triggerType: null,
    query: '',
    triggerPosition: 0,
    selectedIndex: 0,
    position: { x: 0, y: 0 }
  });

  // Dynamic user search results for ActivityPub mode
  const activityPubUsers = ref<any[]>([]);

  // Trigger patterns
  const triggers: AutoSuggestTrigger[] = [];
  
  if (finalConfig.enableEmojis) {
    triggers.push({
      char: ':',
      pattern: /:([a-zA-Z0-9_+-]*)$/,
      type: 'emoji'
    });
  }
  
  if (finalConfig.enableMentions) {
    triggers.push({
      char: '@',
      pattern: /(?:^|\s)@([a-zA-Z0-9_+-]*)$/,
      type: 'mention'
    });
  }

  // Get emoji suggestions
  const emojiSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableEmojis || state.value.triggerType !== 'emoji' || !state.value.query) {
      return [];
    }

    const suggestions: SuggestionItem[] = [];
    const query = state.value.query.toLowerCase();
    const resolvedEmojiList = emojiCacheStore.resolvedEmojis;

    // Collect emojis from all servers
    for (const serverId in resolvedEmojiList) {
      const server = resolvedEmojiList[serverId];
      const matchingEmojis = server.emojis.filter((emoji: ResolvedEmoji) => 
        emoji.name.toLowerCase().includes(query) || 
        emoji.display_name.toLowerCase().includes(query)
      );

      suggestions.push(...matchingEmojis.map((emoji: ResolvedEmoji): SuggestionItem => ({
        id: emoji.id,
        name: emoji.name,
        display_name: emoji.display_name,
        url: emoji.url,
        server_name: server.server_name,
        emoji: emoji // Keep reference for easy access
      })));
    }

    // Sort by relevance (exact matches first, then starts with, then contains)
    return suggestions
      .sort((a, b) => {
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        const aDisplay = (a.display_name || '').toLowerCase();
        const bDisplay = (b.display_name || '').toLowerCase();

        // Exact matches first
        if (aName === query || aDisplay === query) return -1;
        if (bName === query || bDisplay === query) return 1;

        // Starts with query
        if (aName.startsWith(query) || aDisplay.startsWith(query)) return -1;
        if (bName.startsWith(query) || bDisplay.startsWith(query)) return 1;

        return 0;
      })
      .slice(0, finalConfig.maxSuggestions);
  });

  // Get user mention suggestions based on mode
  const mentionSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableMentions || state.value.triggerType !== 'mention' || !state.value.query) {
      return [];
    }

    const query = state.value.query.toLowerCase();

    if (finalConfig.mode === 'chat') {
      // Chat mode: Use server context-aware user filtering
      const suggestions: SuggestionItem[] = [];
      let usersToSearch: any[] = [];

      // Get current server ID to filter users by server membership
      const currentServerId = serverChannelStore.currentServerId;
      
      if (currentServerId) {
        // Get users only from the current server context
        usersToSearch = userDataService.getUsersInContext(currentServerId);
        debug.log(`🎯 AutoSuggest: Using server context ${currentServerId}, found ${usersToSearch.length} server members`);
      } else {
        // Fallback to all users only if no server context is available
        // This should rarely happen in normal chat usage
        usersToSearch = userDataService.getAllUsers();
        debug.log(`⚠️ AutoSuggest: No server context, falling back to all users (${usersToSearch.length} total)`);
      }

      const seenUsers = new Set<string>(); // Track already processed users
      
      for (const userData of usersToSearch) {
        // Skip if we've already seen this user
        if (seenUsers.has(userData.id)) {
          continue;
        }
        seenUsers.add(userData.id);
        
        const displayName = userData.displayName?.toLowerCase() || '';
        const usernameStr = userData.username?.toLowerCase() || '';

        if (displayName.includes(query) || usernameStr.includes(query)) {
          // Create display format for text input (what user sees while typing)
          const isLocal = userData.isLocal;
          const currentDomain = import.meta.env.VITE_DOMAIN || 'har.mony.lol';
          const userDomain = userData.domain || currentDomain;
          const displayText = isLocal ? `@${userData.username}` : `@${userData.username}@${userDomain}`;
          
          // Create storage format for database (always @uuid@domain)
          const mentionText = `@${userData.id}@${userDomain}`;

          suggestions.push({
            id: userData.id,
            display_name: userData.displayName,
            username: userData.username,
            avatar: userData.avatarUrl,
            display_text: displayText, // What user sees in input
            mention_text: mentionText, // What gets stored in DB
            user: userData // Keep reference for easy access
          });
        }
      }

      // Additional final deduplication check based on user ID (should be unnecessary now but kept for safety)
      const uniqueSuggestions = suggestions.filter((item, index, self) => 
        index === self.findIndex(s => s.id === item.id)
      );

      return uniqueSuggestions
        .sort((a, b) => {
          const aDisplay = (a.display_name || '').toLowerCase();
          const bDisplay = (b.display_name || '').toLowerCase();
          const aUsername = (a.username || '').toLowerCase();
          const bUsername = (b.username || '').toLowerCase();

          // Exact matches first
          if (aDisplay === query || aUsername === query) return -1;
          if (bDisplay === query || bUsername === query) return 1;

          // Starts with query
          if (aDisplay.startsWith(query) || aUsername.startsWith(query)) return -1;
          if (bDisplay.startsWith(query) || bUsername.startsWith(query)) return 1;

          return 0;
        })
        .slice(0, finalConfig.maxSuggestions);
        
    } else if (finalConfig.mode === 'activitypub') {
      // ActivityPub mode: Use dynamic search results (no server filtering needed)
      return activityPubUsers.value.map(user => {
        // Ensure handle has leading @ if database doesn't include it
        let handle = user.handle || `@${user.username}${!user.is_local && user.domain ? '@' + user.domain : ''}`;
        if (!handle.startsWith('@')) {
          handle = '@' + handle;
        }
        
        return {
        id: user.id,
        display_name: user.display_name,
        username: user.username,
          avatar: user.avatar_url,
          handle: handle,
        user: user
        };
      }).slice(0, finalConfig.maxSuggestions);
    }

    return [];
  });

  // Combined suggestions based on current trigger type
  const suggestions = computed((): SuggestionItem[] => {
    switch (state.value.triggerType) {
      case 'emoji':
        return emojiSuggestions.value;
      case 'mention':
        return mentionSuggestions.value;
      default:
        return [];
    }
  });

  // Header text for suggestions
  const headerText = computed((): string => {
    switch (state.value.triggerType) {
      case 'emoji':
        return 'Emojis';
      case 'mention':
        if (finalConfig.mode === 'chat') {
          const currentServerId = serverChannelStore.currentServerId;
          return currentServerId ? 'Server Members' : 'Users';
        }
        return 'Users';
      default:
        return '';
    }
  });

  // Track current search to abort stale requests
  let currentSearchAbortController: AbortController | null = null;
  let currentSearchQuery = '';

  // ActivityPub user search function with timeout
  const searchActivityPubUsers = async (query: string) => {
    console.log('[DEBUG] searchActivityPubUsers called:', { query, mode: finalConfig.mode });
    
    if (finalConfig.mode !== 'activitypub' || query.length < 2) {
      console.log('[DEBUG] searchActivityPubUsers: Skipping (mode or query too short)', { mode: finalConfig.mode, queryLength: query.length });
      activityPubUsers.value = [];
      return;
    }

    // Cancel any in-flight search
    if (currentSearchAbortController) {
      console.log('[DEBUG] searchActivityPubUsers: Aborting previous search');
      currentSearchAbortController.abort();
    }
    
    currentSearchAbortController = new AbortController();
    currentSearchQuery = query;

    try {
      console.log('[DEBUG] searchActivityPubUsers: Calling activityPubService.searchUsers...');
      
      // Race the search against a timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Search timeout after 5s')), 5000);
      });
      
      const searchPromise = activityPubService.searchUsers(query, finalConfig.maxSuggestions);
      
      const users = await Promise.race([searchPromise, timeoutPromise]);
      
      // Only update if this is still the current query
      if (query === currentSearchQuery) {
        console.log('[DEBUG] searchActivityPubUsers: Got results:', users?.length || 0, 'users');
        activityPubUsers.value = users;
      } else {
        console.log('[DEBUG] searchActivityPubUsers: Ignoring stale results for:', query);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        console.log('[DEBUG] searchActivityPubUsers: Search aborted');
        return;
      }
      console.error('[DEBUG] searchActivityPubUsers: ERROR:', error);
      debug.error('Failed to search ActivityPub users:', error);
      activityPubUsers.value = [];
    }
  };

  // Calculate cursor position for suggestion placement
  const calculateCursorPosition = (): SuggestionPosition => {
    if (!inputElement.value) {
      return { x: 0, y: 0 };
    }

    const input = inputElement.value;
    let inputRect: DOMRect;
    
    // Handle different input types
    if ('getBoundingClientRect' in input) {
      inputRect = input.getBoundingClientRect();
    } else if (input.$el) {
      inputRect = input.$el.getBoundingClientRect();
    } else {
      return { x: 0, y: 0 };
    }

    // Calculate suggestion popup dimensions
    const suggestionCount = suggestions.value.length;
    const headerHeight = finalConfig.enableEmojis || finalConfig.enableMentions ? 32 : 0; // Header height
    const itemHeight = 44; // Each suggestion item height
    const maxHeight = 240; // Maximum popup height
    const padding = 8; // Popup padding
    
    // Calculate actual popup height needed
    const popupHeight = Math.min(
      headerHeight + (suggestionCount * itemHeight) + padding,
      maxHeight
    );

    let x = inputRect.left;
    let y = inputRect.bottom + 8; // Default: below input

    // For chat mode, position above the input since it's typically at bottom of screen
    if (finalConfig.mode === 'chat') {
      y = inputRect.top - popupHeight - 8; // Position above with 8px margin
      
      // Try to get more precise cursor position for better x positioning
      try {
        if ('selectionStart' in input && input.selectionStart !== null) {
          // For textarea/input elements, try to calculate cursor position
          const cursorPos = input.selectionStart;
          const textBeforeCursor = input.value?.substring(0, cursorPos) || '';
          
          // Rough estimation: 8px per character (this could be improved with canvas measurement)
          const estimatedCursorX = textBeforeCursor.length * 8;
          x = Math.max(inputRect.left, inputRect.left + estimatedCursorX - 100); // Offset to center suggestion on cursor
        } else if ('getCursorPosition' in input && typeof input.getCursorPosition === 'function') {
          // For RichTextEditor components
          const cursorPos = input.getCursorPosition();
          const currentText = getCurrentText ? getCurrentText() : '';
          const textBeforeCursor = currentText.substring(0, cursorPos);
          
          // Rough estimation for cursor position
          const estimatedCursorX = textBeforeCursor.length * 8;
          x = Math.max(inputRect.left, inputRect.left + estimatedCursorX - 100);
        }
      } catch (error) {
        // Fallback to default positioning if cursor detection fails
        console.debug('Cursor position detection failed, using default positioning');
      }
    }

    // Ensure suggestions don't go off-screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popupWidth = 280; // Estimated popup width

    // Adjust x position if it would go off the right edge
    if (x + popupWidth > viewportWidth) {
      x = viewportWidth - popupWidth - 16;
    }
    
    // Ensure minimum distance from left edge
    x = Math.max(16, x);

    // If positioning above would go off the top of screen, position below instead
    if (y < 16) {
      y = inputRect.bottom + 8;
    }
    
    // If positioning below would go off bottom of screen, position above
    if (y + popupHeight > viewportHeight - 16) {
      y = inputRect.top - popupHeight - 8;
    }

    return { x, y };
  };

  // Handle input changes and detect triggers
  const handleInput = (value: string, cursorPosition: number) => {
    const textBeforeCursor = value.substring(0, cursorPosition);
    
    console.log('[DEBUG] handleInput called:', { value: value.substring(0, 50), cursorPosition, textBeforeCursor: textBeforeCursor.substring(textBeforeCursor.length - 20) });
    
    // Check for trigger patterns
    let foundTrigger = false;
    
    for (const trigger of triggers) {
      const match = textBeforeCursor.match(trigger.pattern);
      console.log('[DEBUG] Checking trigger:', trigger.type, 'pattern:', trigger.pattern, 'match:', match);
      if (match && match.index !== undefined) {
        foundTrigger = true;
        const query = match[1] || '';
        
        console.log('[DEBUG] Trigger found!', { type: trigger.type, query, matchIndex: match.index });
        
        // Calculate the actual trigger position (where @ or : starts)
        let triggerPosition = match.index;
        
        if (trigger.type === 'mention') {
          // For mentions, the pattern is (?:^|\s)@([a-zA-Z0-9_+-]*)$
          // So if the match starts with whitespace, we need to adjust
          const matchText = match[0];
          if (matchText.startsWith(' ') || matchText.startsWith('\t')) {
            triggerPosition = match.index + 1; // Skip the whitespace
          }
        }
        // For emojis, the position is already correct since pattern is :([a-zA-Z0-9_+-]*)$
        
        state.value = {
          isActive: true,
          triggerType: trigger.type,
          query,
          triggerPosition,
          selectedIndex: 0,
          position: calculateCursorPosition()
        };
        
        console.log('[DEBUG] State set to active:', state.value);

        // Trigger ActivityPub user search if needed
        if (trigger.type === 'mention' && finalConfig.mode === 'activitypub') {
          console.log('[DEBUG] Searching ActivityPub users for:', query);
          searchActivityPubUsers(query);
        }
        
        break;
      }
    }
    
    if (!foundTrigger && state.value.isActive) {
      console.log('[DEBUG] No trigger found, closing suggestions');
      closeSuggestions();
    }
  };

  // Selection state to prevent duplicate selections
  const isSelecting = ref(false);

  // Handle keyboard navigation
  const handleKeyDown = (event: KeyboardEvent): boolean => {    
    if (!state.value.isActive || suggestions.value.length === 0) {
      return false;
    }

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault();
        state.value.selectedIndex = Math.max(0, state.value.selectedIndex - 1);
        return true;
        
      case 'ArrowDown':
        event.preventDefault();
        state.value.selectedIndex = Math.min(suggestions.value.length - 1, state.value.selectedIndex + 1);
        return true;
        
      case 'Enter':
      case 'Tab':
        event.preventDefault();
        if (suggestions.value[state.value.selectedIndex]) {
          selectSuggestion(suggestions.value[state.value.selectedIndex]);
        }
        return true;
        
      case 'Escape':
        event.preventDefault();
        closeSuggestions();
        return true;
        
      default:
        return false;
    }
  };

  // Select a suggestion and replace the trigger text
  const selectSuggestion = (suggestion: SuggestionItem): string => {
    // Prevent duplicate selections
    if (isSelecting.value) {
      debug.log('🔧 Preventing duplicate selection');
      return '';
    }
    
    isSelecting.value = true;
    
    try {
      const currentText = getCurrentText ? getCurrentText() : '';
      
      // Use the stored trigger position
      const triggerStart = state.value.triggerPosition;
      
      // Find the end of the current trigger text by looking from the trigger position
      // to the next space, newline, or end of text
      const textFromTrigger = currentText.substring(triggerStart);
      const endMatch = textFromTrigger.match(/^[^\s\n]*/);
      const triggerLength = endMatch ? endMatch[0].length : 1;
      const triggerEnd = triggerStart + triggerLength;
      
      debug.log('🔧 selectSuggestion detailed debug:', {
        currentText,
        triggerPosition: state.value.triggerPosition,
        query: state.value.query,
        triggerStart,
        triggerEnd,
        triggerLength,
        textToReplace: currentText.substring(triggerStart, triggerEnd),
        textBeforeTrigger: currentText.substring(0, triggerStart),
        textAfterTrigger: currentText.substring(triggerEnd)
      });
      
      let insertText = '';
      
      if (state.value.triggerType === 'emoji') {
        insertText = `:${suggestion.name}: `; // Add space after emoji
      } else if (state.value.triggerType === 'mention') {
        if (finalConfig.mode === 'activitypub') {
          insertText = (suggestion.handle || `@${suggestion.username}`) + ' '; // Add space after mention
          debug.log('🔧 ActivityPub mention insert:', {
            handle: suggestion.handle,
            username: suggestion.username,
            domain: suggestion.user?.domain,
            is_local: suggestion.user?.is_local,
            insertText
          });
        } else {
          // Chat mode: use display_text for what user sees
          if (suggestion.display_text) {
            insertText = suggestion.display_text + ' '; // Add space after mention
          } else {
            insertText = `@${suggestion.username} `; // Add space after mention
          }
        }
      }
      
      const newText = currentText.substring(0, triggerStart) + 
                     insertText + 
                     currentText.substring(triggerEnd);
      
      // Calculate new cursor position (should be right after the inserted text including the space)
      const newCursorPosition = triggerStart + insertText.length;
      
      debug.log('🔧 Final replacement:', { 
        insertText, 
        newText,
        oldLength: currentText.length,
        newLength: newText.length,
        newCursorPosition
      });
      
      if (updateText) {
        updateText(newText, newCursorPosition);
      }
      
      closeSuggestions();
      
      return newText;
    } finally {
      // Reset selection flag to allow future selections
      isSelecting.value = false;
    }
  };

  // Close suggestions
  const closeSuggestions = () => {
    state.value.isActive = false;
    state.value.triggerType = null;
    state.value.query = '';
    state.value.selectedIndex = 0;
    activityPubUsers.value = [];
  };

  // Update position (useful for responsive positioning)
  const updatePosition = () => {
    if (state.value.isActive) {
      state.value.position = calculateCursorPosition();
    }
  };

  // Watch suggestions to update position when list changes (affects popup height)
  watch(suggestions, () => {
    if (state.value.isActive) {
      nextTick(() => {
        updatePosition();
      });
    }
  });

  // Watch window resize to reposition suggestions
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition);
  }

  return {
    state,
    suggestions,
    headerText,
    handleInput,
    handleKeyDown,
    selectSuggestion,
    closeSuggestions,
    updatePosition
  };
}