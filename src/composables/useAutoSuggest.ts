import { ref, computed, nextTick } from 'vue';
import type { Ref } from 'vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
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

export function useAutoSuggest(inputElement: Ref<HTMLTextAreaElement | HTMLInputElement | null>) {
  const serverChannelStore = useServerChannelStore();
  const serverUsersStore = useServerUsersStore();

  // Auto-suggest state
  const state = ref<AutoSuggestState>({
    isActive: false,
    triggerType: null,
    query: '',
    triggerPosition: 0,
    selectedIndex: 0,
    position: { x: 0, y: 0 }
  });

  // Trigger patterns
  const triggers: AutoSuggestTrigger[] = [
    {
      char: ':',
      pattern: /:([a-zA-Z0-9_+-]*)$/,
      type: 'emoji'
    },
    {
      char: '@',
      pattern: /@([a-zA-Z0-9_+-]*)$/,
      type: 'mention'
    }
  ];

  // Get emoji suggestions
  const emojiSuggestions = computed((): SuggestionItem[] => {
    if (state.value.triggerType !== 'emoji' || !state.value.query) {
      return [];
    }

    const suggestions: SuggestionItem[] = [];
    const query = state.value.query.toLowerCase();
    const resolvedEmojiList = serverChannelStore.resolvedEmojiList;

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
      .slice(0, 10); // Limit to 10 suggestions
  });

  // Get user mention suggestions
  const mentionSuggestions = computed((): SuggestionItem[] => {
    if (state.value.triggerType !== 'mention' || !state.value.query) {
      return [];
    }

    const query = state.value.query.toLowerCase();
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

    // Sort by relevance
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
      .slice(0, 10); // Limit to 10 suggestions
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
        return 'Users';
      default:
        return '';
    }
  });

  // Calculate cursor position for suggestion placement
  const calculateCursorPosition = (): SuggestionPosition => {
    if (!inputElement.value) {
      return { x: 0, y: 0 };
    }

    const input = inputElement.value;
    const inputRect = input.getBoundingClientRect();
    
    // Calculate dynamic height based on number of suggestions
    const suggestionCount = suggestions.value.length;
    const baseHeight = 40; // Header height
    const itemHeight = 40; // Each suggestion item height
    const maxHeight = 200; // Maximum popup height
    
    // Calculate actual popup height needed
    const popupHeight = Math.min(baseHeight + (suggestionCount * itemHeight), maxHeight);
    
    // Position above the input with dynamic spacing
    const x = inputRect.left + 10; // Small left margin
    const y = inputRect.top - popupHeight - 30; // Position above with 30px margin
    
    // Make sure the popup doesn't go off-screen
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    
    // Adjust x position if it would go off the right edge
    const adjustedX = Math.min(x, viewportWidth - 320); // 320px = max popup width + margin
    
    // Adjust y position if it would go off the top edge
    let adjustedY = y;
    if (y < 10) {
      // If not enough space above, position below the input instead
      adjustedY = inputRect.bottom + 10;
    }
    
    return {
      x: Math.max(adjustedX, 10), // Minimum 10px from left
      y: adjustedY
    };
  };

  // Handle input change
  const handleInput = (value: string, cursorPosition: number) => {
    const textBeforeCursor = value.substring(0, cursorPosition);
    
    // Check for trigger patterns
    let matchFound = false;
    
    for (const trigger of triggers) {
      const match = textBeforeCursor.match(trigger.pattern);
      if (match) {
        const query = match[1] || '';
        
        state.value = {
          isActive: true,
          triggerType: trigger.type,
          query,
          triggerPosition: cursorPosition - match[0].length,
          selectedIndex: 0,
          position: { x: 0, y: 0 } // Will be updated after suggestions are computed
        };
        
        // Update position after suggestions are computed in the next tick
        nextTick(() => {
          if (state.value.isActive) {
            state.value.position = calculateCursorPosition();
          }
        });
        
        matchFound = true;
        break;
      }
    }

    if (!matchFound) {
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
        // Don't handle Enter/Tab here - let MessageInput handle it
        return false; // Let MessageInput handle the Enter key

      case 'Escape':
        event.preventDefault();
        closeSuggestions();
        return true;

      default:
        return false;
    }
  };

  // Select a suggestion
  const selectSuggestion = (suggestion: SuggestionItem): string => {
    if (!inputElement.value || !state.value.isActive) {
      return '';
    }

    const input = inputElement.value;
    const currentValue = input.value;
    const cursorPosition = input.selectionStart || 0;

    // Find the trigger character position
    const triggerStart = state.value.triggerPosition;
    
    // Calculate replacement text
    let insertText = '';

    if (state.value.triggerType === 'emoji') {
      // For emojis, replace with :emoji_name: format
      insertText = `:${suggestion.name}:`;
    } else if (state.value.triggerType === 'mention') {
      // For mentions, replace the entire @query with @username
      const username = suggestion.username || suggestion.display_name;
      insertText = `${username}`;
    }

    // Replace the entire trigger + query with the selected suggestion
    // triggerStart is the position of @ or :, cursorPosition is after the query
    const newValue = 
      currentValue.substring(0, triggerStart) + 
      insertText + 
      currentValue.substring(cursorPosition);

    // Update input value
    input.value = newValue;
    
    // Position cursor after the inserted text
    const newCursorPosition = triggerStart + insertText.length;
    nextTick(() => {
      input.setSelectionRange(newCursorPosition, newCursorPosition);
      input.focus();
    });

    closeSuggestions();
    return newValue;
  };

  // Close suggestions
  const closeSuggestions = () => {
    state.value = {
      isActive: false,
      triggerType: null,
      query: '',
      triggerPosition: 0,
      selectedIndex: 0,
      position: { x: 0, y: 0 }
    };
  };

  // Update position when needed
  const updatePosition = () => {
    if (state.value.isActive) {
      state.value.position = calculateCursorPosition();
    }
  };

  return {
    // State
    state: computed(() => state.value),
    suggestions,
    headerText,
    
    // Methods
    handleInput,
    handleKeyDown,
    selectSuggestion,
    closeSuggestions,
    updatePosition
  };
}