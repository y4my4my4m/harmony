import { ref } from 'vue';
import { supabase } from '@/supabase';
import { activityPubService } from '@/services/activityPubService';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';
import { debug } from '@/utils/debug'

export function useActivityPubUserSearch() {
  const isSearching = ref(false);
  const searchResults = ref<SuggestionItem[]>([]);

  const searchUsers = async (query: string): Promise<SuggestionItem[]> => {
    if (!query.trim()) {
      return [];
    }

    try {
      isSearching.value = true;
      const suggestions: SuggestionItem[] = [];

      // First search for local users
      const { data: localUsers, error: localError } = await supabase
        .from('profiles')
        .select('id, username, display_name, avatar_url, domain, is_local')
        .eq('is_local', true)
        .or(`username.ilike.%${query}%,display_name.ilike.%${query}%`)
        .limit(5);

      if (localUsers && !localError) {
        localUsers.forEach((user: any) => {
          suggestions.push({
            id: user.id,
            display_name: user.display_name,
            username: user.username,
            avatar: user.avatar_url,
            domain: user.domain, // Don't default to any domain, let is_local field handle this
            type: 'mention',
            user: user
          });
        });
      }

      // If query contains @, search for federated users
      if (query.includes('@') && suggestions.length < 10) {
        try {
          const federatedUsers = await activityPubService.searchFederatedUsers(query, 5);
          federatedUsers.forEach((user: any) => {
            // More robust duplicate check using multiple criteria
            const isDuplicate = suggestions.find(s => 
              s.id === user.id || 
              (s.username === user.username && s.domain === user.domain)
            );
            
            if (!isDuplicate) {
              suggestions.push({
                id: user.id,
                display_name: user.display_name,
                username: user.username,
                avatar: user.avatar_url,
                domain: user.domain,
                type: 'mention',
                user: user
              });
            }
          });
        } catch (federatedError) {
          debug.warn('Federated user search failed:', federatedError);
        }
      }

      // Sort by relevance
      suggestions.sort((a, b) => {
        const queryLower = query.toLowerCase();
        const aDisplay = (a.display_name || '').toLowerCase();
        const bDisplay = (b.display_name || '').toLowerCase();
        const aUsername = (a.username || '').toLowerCase();
        const bUsername = (b.username || '').toLowerCase();

        // Exact matches first
        if (aDisplay === queryLower || aUsername === queryLower) {
          if (bDisplay === queryLower || bUsername === queryLower) return 0; // Both exact, keep order
          return -1;
        }
        if (bDisplay === queryLower || bUsername === queryLower) return 1;

        // Starts with query
        const aStartsWith = aDisplay.startsWith(queryLower) || aUsername.startsWith(queryLower);
        const bStartsWith = bDisplay.startsWith(queryLower) || bUsername.startsWith(queryLower);
        
        if (aStartsWith && !bStartsWith) return -1;
        if (bStartsWith && !aStartsWith) return 1;
        if (aStartsWith && bStartsWith) return 0; // Both start with, keep order

        return 0; // Keep original order for equal items
      });

      // Remove any remaining duplicates as a final safety check
      const uniqueSuggestions = suggestions.filter((item, index, self) => 
        index === self.findIndex(s => 
          s.id === item.id || 
          (s.username === item.username && s.domain === item.domain)
        )
      );

      searchResults.value = uniqueSuggestions;
      return uniqueSuggestions.slice(0, 10);
    } catch (error) {
      debug.error('Failed to search ActivityPub users:', error);
      return [];
    } finally {
      isSearching.value = false;
    }
  };

  return {
    isSearching,
    searchResults,
    searchUsers
  };
} 