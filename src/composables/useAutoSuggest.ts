import { ref, computed, nextTick, watch } from 'vue';
import type { Ref } from 'vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { activityPubService } from '@/services/activityPubService';
import type { SuggestionItem, SuggestionPosition } from '@/components/AutoSuggest.vue';
import type { ResolvedEmoji } from '@/types';

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
  updateText?: (newText: string) => void,
  config: AutoSuggestConfig = { mode: 'chat' }
) {
  const serverChannelStore = useServerChannelStore();
  const serverUsersStore = useServerUsersStore();
  const emojiCacheStore = useEmojiCacheStore();

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
      pattern: /@([a-zA-Z0-9_+-]*)$/,
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
      // Chat mode: Use server users store (current server only)
      const userProfiles = serverUsersStore.userProfiles;
      const suggestions: SuggestionItem[] = [];

      // Search through user profiles
      for (const userId in userProfiles) {
        const user = userProfiles[userId];
        const displayName = user.display_name?.toLowerCase() || '';
        const username = user.username?.toLowerCase() || '';

        if (displayName.includes(query) || username.includes(query)) {
          suggestions.push({
            id: userId,
            display_name: user.display_name,
            username: user.username,
            avatar: user.avatar_url,
            user: user // Keep reference for easy access
          });
        }
      }

      return suggestions
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
      // ActivityPub mode: Use dynamic search results
      return activityPubUsers.value.map(user => ({
        id: user.id,
        display_name: user.display_name,
        username: user.username,
        avatar: user.avatar_url, // Fix: Use avatar_url for avatar field
        handle: user.handle || `@${user.username}${user.domain !== 'har.mony.lol' ? '@' + user.domain : ''}`,
        user: user
      })).slice(0, finalConfig.maxSuggestions);
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
        return finalConfig.mode === 'chat' ? 'Server Users' : 'Users';
      default:
        return '';
    }
  });

  // ActivityPub user search function
  const searchActivityPubUsers = async (query: string) => {
    if (finalConfig.mode !== 'activitypub' || query.length < 2) {
      activityPubUsers.value = [];
      return;
    }

    try {
      const users = await activityPubService.searchUsers(query, finalConfig.maxSuggestions);
      activityPubUsers.value = users;
    } catch (error) {
      console.error('Failed to search ActivityPub users:', error);
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
    
    // Check for trigger patterns
    let foundTrigger = false;
    
    for (const trigger of triggers) {
      const match = textBeforeCursor.match(trigger.pattern);
      if (match) {
        foundTrigger = true;
        const query = match[1] || '';
        
        state.value = {
          isActive: true,
          triggerType: trigger.type,
          query,
          triggerPosition: cursorPosition - match[0].length,
          selectedIndex: 0,
          position: calculateCursorPosition()
        };

        // Trigger ActivityPub user search if needed
        if (trigger.type === 'mention' && finalConfig.mode === 'activitypub') {
          searchActivityPubUsers(query);
        }
        
        break;
      }
    }
    
    if (!foundTrigger && state.value.isActive) {
      closeSuggestions();
    }
  };

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
    const currentText = getCurrentText ? getCurrentText() : '';
    const triggerStart = state.value.triggerPosition;
    const triggerEnd = triggerStart + state.value.query.length + 1; // +1 for trigger char
    
    let insertText = '';
    
    if (state.value.triggerType === 'emoji') {
      insertText = `:${suggestion.name}:`;
    } else if (state.value.triggerType === 'mention') {
      if (finalConfig.mode === 'activitypub') {
        insertText = suggestion.handle || `${suggestion.username}`;
      } else {
        insertText = `${suggestion.username}`;
      }
    }
    
    const newText = currentText.substring(0, triggerStart) + 
                   insertText + 
                   currentText.substring(triggerEnd);
    
    if (updateText) {
      updateText(newText);
    }
    
    closeSuggestions();
    
    // Focus back to input after short delay
    nextTick(() => {
      if (inputElement.value && 'focus' in inputElement.value) {
        inputElement.value.focus();
      }
    });
    
    return insertText;
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