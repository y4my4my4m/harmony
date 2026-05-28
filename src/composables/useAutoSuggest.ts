import { ref, computed, nextTick, watch, onScopeDispose } from 'vue';
import type { Ref } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { userDataService } from '@/services/userDataService';
import { activityPubService } from '@/services/activityPubService';
import { roleService } from '@/services/RoleService';
import { useServerPermissions } from '@/composables/useServerPermissions';
import { useUnifiedEmoji } from '@/services/unifiedEmojiService';
import { ensureEmojiDataLoaded } from '@/composables/useEmojiLoader';
import type { SuggestionItem, SuggestionPosition } from '@/components/AutoSuggest.vue';
import type { ResolvedEmoji } from '@/types';
import { debug } from '@/utils/debug';
import { supabase } from '@/supabase';

// Bridged user interface (from Discord bridge)
interface BridgedUser {
  id: string;
  username: string;
  displayName: string;
  avatarUrl: string;
  source: 'discord';
}

// SHARED cache for bridged users across all useAutoSuggest instances
// This prevents duplicate API calls when multiple components use autosuggest
interface CachedBridgedUsers {
  users: BridgedUser[];
  timestamp: number;
}

const BRIDGED_USERS_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const BRIDGED_USERS_CACHE_MAX_SIZE = 50; // Max channels to cache

const sharedBridgedUsersCache = new Map<string, CachedBridgedUsers>();
const sharedBridgedUsersPending = new Map<string, Promise<BridgedUser[]>>();

// Cache for bridge bot checks per server (to avoid repeated DB queries)
const bridgeBotCheckCache = new Map<string, { hasBridge: boolean; timestamp: number }>();
const BRIDGE_BOT_CHECK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// Pending requests deduplication - prevents multiple concurrent requests for same server
const bridgeBotCheckPending = new Map<string, Promise<boolean>>();

// Check if cache entry is still valid
function isCacheValid(entry: CachedBridgedUsers | undefined): boolean {
  if (!entry) return false;
  return Date.now() - entry.timestamp < BRIDGED_USERS_CACHE_TTL;
}

// Prune old cache entries to prevent memory bloat
function pruneCache() {
  if (sharedBridgedUsersCache.size <= BRIDGED_USERS_CACHE_MAX_SIZE) return;
  
  // Remove oldest entries first
  const entries = Array.from(sharedBridgedUsersCache.entries())
    .sort((a, b) => a[1].timestamp - b[1].timestamp);
  
  const toRemove = entries.slice(0, entries.length - BRIDGED_USERS_CACHE_MAX_SIZE);
  for (const [key] of toRemove) {
    sharedBridgedUsersCache.delete(key);
  }
}

// Clear cache for a specific channel (call when bridge data changes)
export function clearBridgedUsersCache(channelId?: string) {
  if (channelId) {
    sharedBridgedUsersCache.delete(channelId);
  } else {
    sharedBridgedUsersCache.clear();
  }
}

export interface AutoSuggestTrigger {
  char: string;
  pattern: RegExp;
  type: 'emoji' | 'mention' | 'command';
}

export interface AutoSuggestState {
  isActive: boolean;
  triggerType: 'emoji' | 'mention' | 'command' | null;
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
  const { hasCurrentUserPermission, Permission, isCurrentUserServerOwner } = useServerPermissions();
  const { searchEmojis: searchUnifiedEmojis, isLoaded: unifiedLoaded, isNativePack, getSvgUrl } = useUnifiedEmoji();

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

  // Active parameterized command (e.g. /tenor waiting for query input)
  const activeCommand = ref<{ name: string; params: { name: string; description: string }[] } | null>(null);

  // Dynamic user search results for ActivityPub mode
  const activityPubUsers = ref<any[]>([]);
  
  // Bridged users from Discord (fetched from bot-gateway)
  const bridgedUsers = ref<BridgedUser[]>([]);
  const bridgedUsersLoaded = ref(false);
  const bridgedUsersChannelId = ref<string | null>(null);

  // Server roles for @role mentions
  const serverRoles = ref<any[]>([]);
  const serverRolesLoaded = ref(false);
  const serverRolesServerId = ref<string | null>(null);

  // Trigger patterns
  const triggers: AutoSuggestTrigger[] = [];
  
  if (finalConfig.enableEmojis) {
    // The `(?<=^|[^a-zA-Z0-9_+-])` lookbehind guarantees the `:` opens a NEW
    // shortcode rather than CLOSING an existing one. Without it, typing the
    // closing `:` of `:joy:` matched the regex with an empty capture group,
    // which the suggestion code then treated as "show every emoji whose name
    // contains the empty string" - i.e. every server custom emoji in the
    // user's cache (`:xd:`, `:wtf:`, `:whoa:`, ...). Now `:joy:` produces no
    // match, and `:joy` (cursor just after `joy`) still matches with query
    // `joy` because the leading `:` is preceded by start-of-string.
    triggers.push({
      char: ':',
      pattern: /(?<=^|[^a-zA-Z0-9_+-]):([a-zA-Z0-9_+-]*)$/,
      type: 'emoji'
    });
  }
  
  if (finalConfig.enableMentions) {
    triggers.push({
      char: '@',
      // \s* before $ allows trailing whitespace - contenteditable (ActivityPub Composer) can report
      // cursor after a trailing space, unlike textarea (chat) which has exact selectionStart
      pattern: /(?:^|\s)@([a-zA-Z0-9_+-]*)\s*$/,
      type: 'mention'
    });
  }

  if (finalConfig.mode === 'chat') {
    triggers.push({
      char: '/',
      pattern: /^\/([a-zA-Z]*)$/,
      type: 'command'
    });
  }

  // Get emoji suggestions (server emojis + unified emoji pack)
  // Allow empty query so typing ":" alone shows initial emoji list
  const emojiSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableEmojis || state.value.triggerType !== 'emoji') {
      return [];
    }
    
    // Trigger lazy loading of emoji data when user starts typing emoji autocomplete
    ensureEmojiDataLoaded()

    const suggestions: SuggestionItem[] = [];
    const query = state.value.query.toLowerCase();
    const resolvedEmojiList = emojiCacheStore.resolvedEmojis;
    const seenNames = new Set<string>();

    // Collect emojis from all servers (custom server emojis)
    for (const serverId in resolvedEmojiList) {
      const server = resolvedEmojiList[serverId];
      const matchingEmojis = server.emojis.filter((emoji: ResolvedEmoji) => 
        (emoji.name?.toLowerCase() ?? '').includes(query) || 
        (emoji.display_name?.toLowerCase() ?? '').includes(query)
      );

      suggestions.push(...matchingEmojis.map((emoji: ResolvedEmoji): SuggestionItem => {
        seenNames.add((emoji.name ?? '').toLowerCase());
        return {
          id: emoji.id,
          name: emoji.name,
          display_name: emoji.display_name,
          url: emoji.url,
          server_name: server.server_name,
          emoji: emoji // Keep reference for easy access
        };
      }));
    }

    // Also search unified emoji pack (Mutant Standard / native emojis)
    if (unifiedLoaded.value && query.length >= 2) {
      const unifiedResults = searchUnifiedEmojis(query, finalConfig.maxSuggestions);
      
      for (const emoji of unifiedResults) {
        // Skip if already added from server emojis
        if (seenNames.has((emoji.shortcode ?? '').toLowerCase())) continue;
        
        // Get URL for display (SVG or null for native)
        const svgUrl = getSvgUrl(emoji.shortcode);
        
        suggestions.push({
          id: emoji.unicode || emoji.shortcode,
          name: emoji.shortcode,
          display_name: emoji.description || emoji.shortcode,
          url: isNativePack.value ? undefined : svgUrl || undefined,
          native: isNativePack.value || !svgUrl ? emoji.unicode : undefined,
          server_name: 'Emojis',
          emoji: {
            id: emoji.unicode || emoji.shortcode,
            name: emoji.shortcode,
            url: svgUrl || undefined,
            native: emoji.unicode,
            source: 'unified'
          }
        });
      }
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
    if (!finalConfig.enableMentions || state.value.triggerType !== 'mention') {
      return [];
    }
    // For chat mode we need a query to filter. For ActivityPub we use search results (may be empty initially).
    const query = (state.value.query || '').toLowerCase();
    if (finalConfig.mode === 'chat' && !query) {
      return [];
    }

    if (finalConfig.mode === 'chat') {
      // Chat mode: Use server context-aware user filtering
      const suggestions: SuggestionItem[] = [];
      let usersToSearch: any[] = [];

      // Get current server ID to filter users by server membership
      const currentServerId = serverChannelStore.currentServerId;
      
      // Log bridged users status
      debug.log(`🎯 AutoSuggest: bridgedUsers count = ${bridgedUsers.value.length}, loaded = ${bridgedUsersLoaded.value}`);
      
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
      
      // Add Harmony users
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
          const currentDomain = import.meta.env.VITE_DOMAIN as string;
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
      
      // Add bridged Discord users (only if loaded)
      // Note: Bridge bot check happens lazily in handleInput when user types @
      for (const bridgedUser of bridgedUsers.value) {
        // Skip if we've already seen this user (by Discord ID)
        const bridgedKey = `discord:${bridgedUser.id}`;
        if (seenUsers.has(bridgedKey)) {
          continue;
        }
        seenUsers.add(bridgedKey);
        
        const displayName = bridgedUser.displayName?.toLowerCase() || '';
        const usernameStr = bridgedUser.username?.toLowerCase() || '';
        
        if (displayName.includes(query) || usernameStr.includes(query)) {
          // For Discord users, use compact format: @d!ID:username
          // This preserves the Discord ID for translation while keeping username for display
          const displayText = `@${bridgedUser.username}`;
          const mentionText = `@d!${bridgedUser.id}:${bridgedUser.username}`;
          
          suggestions.push({
            id: bridgedUser.id,
            display_name: bridgedUser.displayName,
            username: bridgedUser.username,
            avatar: bridgedUser.avatarUrl,
            display_text: displayText, // What user sees: @username
            mention_text: mentionText, // What gets stored: @discord:ID:username
            isBridged: true,
            bridgeSource: 'discord',
            user: {
              id: bridgedUser.id,
              username: bridgedUser.username,
              displayName: bridgedUser.displayName,
              avatarUrl: bridgedUser.avatarUrl,
              domain: 'discord.com',
              isLocal: false
            }
          });
        }
      }

      // Add mentionable roles to suggestions (including @everyone)
      for (const role of serverRoles.value) {
        if (!role.mentionable) continue;
        
        const roleName = role.name?.toLowerCase() || '';
        
        if (roleName.includes(query)) {
          suggestions.push({
            id: `role:${role.id}`,
            display_name: role.name,
            username: role.name,
            avatar: undefined,
            display_text: `@${role.name}`,
            mention_text: `@role:${role.id}`,
            isRole: true,
            roleColor: role.color || (role.is_default ? '#99AAB5' : undefined),
            role: role
          });
        }
      }

      // Additional final deduplication check based on user ID (should be unnecessary now but kept for safety)
      const uniqueSuggestions = suggestions.filter((item, index, self) => 
        index === self.findIndex(s => s.id === item.id)
      );

      return uniqueSuggestions
        .sort((a, b) => {
          // Roles first, then users
          if (a.isRole && !b.isRole) return -1;
          if (!a.isRole && b.isRole) return 1;
          
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
      // RPC search_federated_users returns user_id (not id) - use it so DisplayName + cache priming work
      return activityPubUsers.value.map(user => {
        const profileId = (user as { user_id?: string }).user_id ?? (user as { id?: string }).id ?? '';
        let handle = user.handle || `@${user.username}${!user.is_local && user.domain ? '@' + user.domain : ''}`;
        if (!handle.startsWith('@')) {
          handle = '@' + handle;
        }
        return {
          id: profileId,
          display_name: user.display_name,
          username: user.username,
          avatar: user.avatar_url,
          handle: handle,
          user: user
        };
      }).filter(s => s.id).slice(0, finalConfig.maxSuggestions);
    }

    return [];
  });

  // Slash commands filtered by user permissions
  interface SlashCommand {
    id: string;
    name: string;
    description: string;
    permission: string;
    params?: { name: string; description: string }[];
  }

  const SLASH_COMMANDS: SlashCommand[] = [
    { id: 'cmd:kick', name: 'kick', description: 'Kick a member from the server', permission: 'KICK_MEMBERS' },
    { id: 'cmd:ban', name: 'ban', description: 'Ban a member from the server', permission: 'BAN_MEMBERS' },
    { id: 'cmd:tenor', name: 'tenor', description: 'Search for a GIF', permission: '', params: [{ name: 'query', description: 'Search for a GIF' }] },
  ];

  const commandSuggestions = computed((): SuggestionItem[] => {
    if (state.value.triggerType !== 'command') return [];
    const query = (state.value.query || '').toLowerCase();
    const isOwner = isCurrentUserServerOwner.value;
    return SLASH_COMMANDS
      .filter(cmd => {
        if (!cmd.name.includes(query)) return false;
        if (!cmd.permission) return true;
        if (isOwner) return true;
        return hasCurrentUserPermission(Permission[cmd.permission as keyof typeof Permission]);
      })
      .map(cmd => ({
        id: cmd.id,
        name: cmd.name,
        display_name: `/${cmd.name}`,
        description: cmd.description,
        isCommand: true,
        commandParams: cmd.params,
      }));
  });

  const suggestions = computed((): SuggestionItem[] => {
    switch (state.value.triggerType) {
      case 'emoji':
        return emojiSuggestions.value;
      case 'mention':
        return mentionSuggestions.value;
      case 'command':
        return commandSuggestions.value;
      default:
        return [];
    }
  });

  // Header text for suggestions
  const headerText = computed((): string => {
    switch (state.value.triggerType) {
      case 'emoji':
        return 'Emojis';
      case 'command':
        return 'Commands';
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
  
  // Check if server has bridge bots installed (with server-level caching and request deduplication)
  const hasBridgeBots = async (serverId: string | null): Promise<boolean> => {
    if (!serverId) {
      return false;
    }
    
    // Check cache first (bridge bots are server-level, so cache per server)
    const cached = bridgeBotCheckCache.get(serverId);
    if (cached && Date.now() - cached.timestamp < BRIDGE_BOT_CHECK_CACHE_TTL) {
      return cached.hasBridge;
    }
    
    // Check if there's already a pending request for this server
    const pendingRequest = bridgeBotCheckPending.get(serverId);
    if (pendingRequest) {
      debug.log(`🌉 Bridge bot check already pending for server ${serverId}, reusing request`);
      return pendingRequest;
    }
    
    // Create new request and store it
    const requestPromise = (async () => {
      try {
        const { data, error } = await supabase
          .from('bot_server_permissions')
          .select(`
            bot:bots(
              id,
              bot_type
            )
          `)
          .eq('server_id', serverId)
          .eq('is_active', true);
        
        if (error) {
          debug.warn('🌉 Failed to check for bridge bots:', error);
          // Cache negative result to avoid repeated failed queries
          bridgeBotCheckCache.set(serverId, { hasBridge: false, timestamp: Date.now() });
          return false;
        }
        
        // Filter for bridge bots in the result
        const bridgeBots = (data || []).filter((perm: any) => perm.bot?.bot_type === 'bridge');
        const hasBridge = bridgeBots.length > 0;
        
        // Cache the result (per server, not per channel)
        bridgeBotCheckCache.set(serverId, { hasBridge, timestamp: Date.now() });
        
        if (hasBridge) {
          debug.log(`🌉 Server ${serverId} has ${bridgeBots.length} bridge bot(s)`);
        }
        return hasBridge;
      } catch (error) {
        debug.warn('🌉 Error checking for bridge bots:', error);
        // Cache negative result
        bridgeBotCheckCache.set(serverId, { hasBridge: false, timestamp: Date.now() });
        return false;
      } finally {
        // Remove from pending map when done
        bridgeBotCheckPending.delete(serverId);
      }
    })();
    
    // Store the pending request
    bridgeBotCheckPending.set(serverId, requestPromise);
    
    return requestPromise;
  };

  // Fetch bridged users from bot-gateway for current channel
  // Note: This is only called if the server has bridge bots (checked at server level)
  // The API will tell us if this specific channel has a bridge mapping
  const fetchBridgedUsers = async (channelId: string) => {
    if (!channelId) {
      return;
    }
    
    // Check shared cache first (with TTL check)
    const cached = sharedBridgedUsersCache.get(channelId);
    if (isCacheValid(cached)) {
      bridgedUsers.value = cached!.users;
      bridgedUsersChannelId.value = channelId;
      bridgedUsersLoaded.value = true;
      debug.log(`🌉 fetchBridgedUsers: Using cached data for ${channelId}, ${bridgedUsers.value.length} users`);
      return;
    }
    
    // Check if a request is already pending for this channel
    if (sharedBridgedUsersPending.has(channelId)) {
      debug.log(`🌉 fetchBridgedUsers: Request already pending for ${channelId}, waiting...`);
      try {
        bridgedUsers.value = await sharedBridgedUsersPending.get(channelId)!;
        bridgedUsersChannelId.value = channelId;
        bridgedUsersLoaded.value = true;
      } catch {
        bridgedUsers.value = [];
        bridgedUsersLoaded.value = true;
      }
      return;
    }
    
    // Create the fetch promise and store it
    const fetchPromise = (async (): Promise<BridgedUser[]> => {
      try {
        const url = `/bot-gateway/bridged-users/${channelId}`;
        debug.log(`🌉 fetchBridgedUsers: Fetching from ${url}`);

        // The gateway requires a Supabase user JWT now (BUGS.md C4).
        // Pass the current session's access token; without it the request
        // is rejected with 401.
        const { data: { session } } = await supabase.auth.getSession();
        const headers: Record<string, string> = {};
        if (session?.access_token) {
          headers['Authorization'] = `Bearer ${session.access_token}`;
        }
        const response = await fetch(url, { headers });

        if (response.ok) {
          const data = await response.json();
          
          if (data.has_bridge && Array.isArray(data.users)) {
            const users = data.users as BridgedUser[];
            sharedBridgedUsersCache.set(channelId, { users, timestamp: Date.now() });
            pruneCache(); // Prevent unbounded growth
            debug.log(`🌉 ✅ Loaded ${users.length} bridged Discord users for channel ${channelId}`);
            return users;
          } else {
            sharedBridgedUsersCache.set(channelId, { users: [], timestamp: Date.now() });
            debug.log(`🌉 Channel ${channelId} has no bridge or no users`);
            return [];
          }
        } else {
          debug.log(`🌉 ❌ Failed to fetch bridged users: ${response.status}`);
          return [];
        }
      } catch (error) {
        debug.log('🌉 ❌ Bridge API not available:', error);
        return [];
      } finally {
        sharedBridgedUsersPending.delete(channelId);
      }
    })();
    
    sharedBridgedUsersPending.set(channelId, fetchPromise);
    
    bridgedUsers.value = await fetchPromise;
    bridgedUsersChannelId.value = channelId;
    bridgedUsersLoaded.value = true;
  };

  // Fetch server roles for @role mentions
  const fetchServerRoles = async (serverId: string) => {
    if (!serverId) {
      serverRoles.value = [];
      return;
    }
    
    // Skip if already loaded for this server
    if (serverRolesLoaded.value && serverRolesServerId.value === serverId) {
      return;
    }
    
    try {
      const roles = await roleService.getRolesForServer(serverId);
      // Filter to only mentionable roles
      serverRoles.value = roles;
      serverRolesServerId.value = serverId;
      serverRolesLoaded.value = true;
      debug.log(`🎭 Loaded ${serverRoles.value.length} mentionable roles for server ${serverId}`);
    } catch (error) {
      debug.warn('🎭 Failed to fetch server roles:', error);
      serverRoles.value = [];
      serverRolesLoaded.value = true;
    }
  };

  // Debounced ActivityPub user search
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  const searchActivityPubUsersDebounced = (query: string) => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => searchActivityPubUsers(query), 150);
  };

  // ActivityPub user search function with timeout
  const searchActivityPubUsers = async (query: string) => {
    debug.log('[DEBUG] searchActivityPubUsers called:', { query, mode: finalConfig.mode });
    
    if (finalConfig.mode !== 'activitypub' || query.length < 1) {
      activityPubUsers.value = [];
      return;
    }

    // Cancel any in-flight search
    if (currentSearchAbortController) {
      currentSearchAbortController.abort();
    }
    
    currentSearchAbortController = new AbortController();
    currentSearchQuery = query;

    try {
      debug.log('[DEBUG] searchActivityPubUsers: Calling activityPubService.searchUsers...');
      
      // Race the search against a timeout
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Search timeout after 5s')), 5000);
      });
      
      const searchPromise = activityPubService.searchUsers(query, finalConfig.maxSuggestions);
      
      const users = await Promise.race([searchPromise, timeoutPromise]);
      
      // Only update if this is still the current query
      if (query === currentSearchQuery) {
        debug.log('[DEBUG] searchActivityPubUsers: Got results:', users?.length || 0, 'users');
        activityPubUsers.value = users;
        // Prime userDataService cache so DisplayName can resolve shortcodes (custom emojis) in composer dropdown
        for (const u of users || []) {
          const profileId = (u as { user_id?: string }).user_id ?? (u as { id?: string }).id;
          if (profileId) {
            userDataService.fetchUserProfile(profileId, true).catch(() => {});
          }
        }
      } else {
        debug.log('[DEBUG] searchActivityPubUsers: Ignoring stale results for:', query);
      }
    } catch (error: any) {
      if (error?.name === 'AbortError') {
        debug.log('[DEBUG] searchActivityPubUsers: Search aborted');
        return;
      }
      debug.error('[DEBUG] searchActivityPubUsers: ERROR:', error);
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
        debug.debug('Cursor position detection failed, using default positioning');
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

  // Clear active command state
  const dismissActiveCommand = () => {
    activeCommand.value = null;
  };

  // Handle input changes and detect triggers
  const handleInput = (value: string, cursorPosition: number) => {
    const textBeforeCursor = value.substring(0, cursorPosition);
    // RichTextEditor uses \u00A0 (nbsp) for spaces; \s doesn't match it. Normalize for pattern matching.
    const normalizedForMatch = textBeforeCursor.replace(/\u00A0/g, ' ');
    
    debug.log('[DEBUG] handleInput called:', { value: value.substring(0, 50), cursorPosition, textBeforeCursor: textBeforeCursor.substring(textBeforeCursor.length - 20) });
    
    // Check for trigger patterns
    let foundTrigger = false;
    
    for (const trigger of triggers) {
      const match = normalizedForMatch.match(trigger.pattern);
      debug.log('[DEBUG] Checking trigger:', trigger.type, 'pattern:', trigger.pattern, 'match:', match);
      if (match && match.index !== undefined) {
        foundTrigger = true;
        const query = match[1] || '';
        
        debug.log('[DEBUG] Trigger found!', { type: trigger.type, query, matchIndex: match.index });
        
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
        
        // LAZY: Check for bridge bots and load server roles only when user actually types @ (not on server change)
        if (trigger.type === 'mention' && finalConfig.mode === 'chat') {
          const serverId = serverChannelStore.currentServerId;
          const channelId = serverChannelStore.currentChannelId;
          
          // Fetch server roles for @role mentions
          if (serverId && serverId !== serverRolesServerId.value) {
            fetchServerRoles(serverId);
          }
          
          // Check if server has bridge bots (lazy - only when @ is typed)
          checkBridgeBotsIfNeeded(serverId).then(hasBridge => {
            // Only fetch bridged users if server has bridge bots and we haven't loaded them yet
            if (hasBridge && channelId && channelId !== bridgedUsersChannelId.value) {
              fetchBridgedUsers(channelId);
            }
          }).catch(err => {
            debug.warn('Failed to check bridge bots:', err);
          });
        }
        
        debug.log('[DEBUG] State set to active:', state.value);

        // Trigger ActivityPub user search if needed (debounced to prevent duplicate calls)
        if (trigger.type === 'mention' && finalConfig.mode === 'activitypub') {
          searchActivityPubUsersDebounced(query);
        }
        
        break;
      }
    }
    
    if (!foundTrigger && state.value.isActive) {
      debug.log('[DEBUG] No trigger found, closing suggestions');
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

      // Slash commands
      if (state.value.triggerType === 'command' && suggestion.isCommand) {
        closeSuggestions();

        // Commands with params: clear input and enter command mode
        if (suggestion.commandParams?.length) {
          activeCommand.value = { name: suggestion.name || '', params: suggestion.commandParams };
          if (updateText) {
            updateText('', 0);
          }
          return '';
        }

        // Commands without params: dispatch event and clear input
        window.dispatchEvent(new CustomEvent('harmony-command', { detail: { command: suggestion.name } }));
        const clearedText = currentText.substring(0, triggerStart) + currentText.substring(triggerEnd);
        if (updateText) {
          updateText(clearedText.trim() ? clearedText : '', triggerStart);
        }
        return clearedText.trim() ? clearedText : '';
      }
      
      if (state.value.triggerType === 'emoji') {
        // Standard/unified emojis: insert unicode character directly
        // Custom server emojis: keep :shortcode: format
        if (suggestion.emoji?.source === 'unified' && (suggestion.native || suggestion.emoji?.native)) {
          insertText = (suggestion.native || suggestion.emoji.native) + ' ';
        } else {
          insertText = `:${suggestion.name}: `;
        }
      } else if (state.value.triggerType === 'mention') {
        if (finalConfig.mode === 'activitypub') {
          // Use display form that matches what RichTextEditor renders as data-display-text:
          //   local users  → @username        (no domain)
          //   remote users → @username@domain
          // This prevents cursor position mismatch when setCursorPosition walks the DOM.
          if (suggestion.user?.is_local) {
            insertText = `@${suggestion.username} `;
          } else {
            insertText = (suggestion.handle || `@${suggestion.username}`) + ' ';
          }
          debug.log('🔧 ActivityPub mention insert:', {
            handle: suggestion.handle,
            username: suggestion.username,
            domain: suggestion.user?.domain,
            is_local: suggestion.user?.is_local,
            insertText
          });
        } else {
          // Chat mode: use display_text (human-readable @username@domain format)
          // The RichTextEditor will handle looking up the user ID when creating the mention element
          // For bridged Discord users, use mention_text since it contains the special d!ID:username format
          if (suggestion.isBridged && suggestion.mention_text) {
            insertText = suggestion.mention_text + ' '; // Use special bridged user format
          } else if (suggestion.isRole && suggestion.mention_text) {
            insertText = suggestion.mention_text + ' '; // @role:UUID format for reliable parsing
          } else if (suggestion.display_text) {
            insertText = suggestion.display_text + ' '; // Human-readable @username or @username@domain
          } else {
            insertText = `@${suggestion.username} `; // Fallback
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
  
  // Track current server's bridge bot status (cached per server)
  // LAZY: Only check when user actually types @ (not on server change)
  const currentServerHasBridgeBots = ref<boolean | null>(null);
  const currentServerIdForBridgeCheck = ref<string | null>(null);
  
  // Lazy check for bridge bots - only when user starts typing a mention
  const checkBridgeBotsIfNeeded = async (serverId: string | null) => {
    if (!serverId) {
      currentServerHasBridgeBots.value = false;
      return false;
    }
    
    // If we already checked this server, use cached result
    if (currentServerIdForBridgeCheck.value === serverId && currentServerHasBridgeBots.value !== null) {
      return currentServerHasBridgeBots.value;
    }
    
    // Only check if we haven't checked this server yet
    if (currentServerIdForBridgeCheck.value !== serverId) {
      currentServerIdForBridgeCheck.value = serverId;
      // Check if this server has bridge bots (cached per server)
      currentServerHasBridgeBots.value = await hasBridgeBots(serverId);
    }
    
    return currentServerHasBridgeBots.value || false;
  };

  // LAZY: Don't check bridge bots on channel change - only when user types @
  // Clear bridged users when channel changes (but don't fetch until needed)
  watch(() => serverChannelStore.currentChannelId, (newChannelId) => {
    if (newChannelId !== bridgedUsersChannelId.value) {
      bridgedUsersLoaded.value = false;
      bridgedUsers.value = [];
      bridgedUsersChannelId.value = null;
      // Reset bridge bot check when channel changes (will re-check when @ is typed)
      if (serverChannelStore.currentServerId !== currentServerIdForBridgeCheck.value) {
        currentServerHasBridgeBots.value = null;
        currentServerIdForBridgeCheck.value = null;
      }
    }
  });

  if (typeof window !== 'undefined') {
    window.addEventListener('resize', updatePosition);
    window.addEventListener('scroll', updatePosition);
  }

  onScopeDispose(() => {
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', updatePosition);
      window.removeEventListener('scroll', updatePosition);
    }
  });

  return {
    state,
    suggestions,
    headerText,
    activeCommand,
    handleInput,
    handleKeyDown,
    selectSuggestion,
    closeSuggestions,
    dismissActiveCommand,
    updatePosition
  };
}