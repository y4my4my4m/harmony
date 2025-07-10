import { ref } from 'vue';
import { supabase } from '@/supabase';
import { activityPubService } from '@/services/activityPubService';
import type { SuggestionItem } from '@/components/AutoSuggest.vue';

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
            domain: user.domain || 'har.mony.lol',
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
            if (!suggestions.find(s => s.id === user.id)) {
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
          console.warn('Federated user search failed:', federatedError);
        }
      }

      // Sort by relevance
      suggestions.sort((a, b) => {
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
      });

      searchResults.value = suggestions;
      return suggestions.slice(0, 10);
    } catch (error) {
      console.error('Failed to search ActivityPub users:', error);
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