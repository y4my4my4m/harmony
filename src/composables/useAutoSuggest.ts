import { ref, computed, nextTick, watch, onScopeDispose } from 'vue';
import type { Ref } from 'vue';
import { useEmojiCacheStore } from '@/stores/useEmojiCache';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings';
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
import {
  clearBridgedUsersCache,
  fetchBridgedChannelUsers,
  type BridgedChannelUser,
} from '@/services/bridgedChannelUsersService';

export { clearBridgedUsersCache };

// Bridge bot presence is a server-level fact; cached per server id.
const bridgeBotCheckCache = new Map<string, { hasBridge: boolean; timestamp: number }>();
const BRIDGE_BOT_CHECK_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

// In-flight checks per server id; concurrent callers share one request.
const bridgeBotCheckPending = new Map<string, Promise<boolean>>();

export interface AutoSuggestTrigger {
  char: string;
  pattern: RegExp;
  type: 'emoji' | 'mention' | 'command' | 'channel';
}

export interface AutoSuggestState {
  isActive: boolean;
  triggerType: 'emoji' | 'mention' | 'command' | 'channel' | null;
  query: string;
  triggerPosition: number;
  selectedIndex: number;
  position: SuggestionPosition;
}

export interface AutoSuggestConfig {
  mode: 'chat' | 'activitypub';
  enableEmojis?: boolean;
  enableMentions?: boolean;
  /** '#' suggests the current server's channels (server chat only, not DMs). */
  enableChannels?: boolean;
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

  const finalConfig = {
    enableEmojis: true,
    enableMentions: true,
    enableChannels: false,
    maxSuggestions: 10,
    ...config,
    mode: config.mode || 'chat'
  } as Required<AutoSuggestConfig>;

  const state = ref<AutoSuggestState>({
    isActive: false,
    triggerType: null,
    query: '',
    triggerPosition: 0,
    selectedIndex: 0,
    position: { x: 0, y: 0 }
  });

  // Active parameterized command (e.g. /gif waiting for query input)
  const activeCommand = ref<{ name: string; params: { name: string; description: string }[] } | null>(null);

  // Search results, ActivityPub mode only.
  const activityPubUsers = ref<any[]>([]);
  
  // Discord users, fetched from bot-gateway.
  const bridgedUsers = ref<BridgedChannelUser[]>([]);
  const bridgedUsersLoaded = ref(false);
  const bridgedUsersChannelId = ref<string | null>(null);

  // Server roles for @role mentions
  const serverRoles = ref<any[]>([]);
  const serverRolesLoaded = ref(false);
  const serverRolesServerId = ref<string | null>(null);

  const triggers: AutoSuggestTrigger[] = [];
  
  if (finalConfig.enableEmojis) {
    // The `(?<=^|[^a-zA-Z0-9_+-])` lookbehind restricts the match to a `:` that
    // opens a shortcode. Without it the closing `:` of `:joy:` matches with an
    // empty capture group, and an empty query lists every cached custom emoji.
    // `:joy:` yields no match; `:joy` matches with query `joy`.
    triggers.push({
      char: ':',
      pattern: /(?<=^|[^a-zA-Z0-9_+-]):([a-zA-Z0-9_+-]*)$/,
      type: 'emoji'
    });
  }
  
  if (finalConfig.enableMentions) {
    triggers.push({
      char: '@',
      // \s* before $ tolerates trailing whitespace: contenteditable (ActivityPub Composer)
      // reports the cursor after a trailing space; textarea (chat) gives exact selectionStart.
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

  if (finalConfig.enableChannels && finalConfig.mode === 'chat') {
    triggers.push({
      char: '#',
      // Same shape as the parser's hashtag/channel token so what autocomplete
      // inserts is exactly what parseContentToMessageParts resolves.
      pattern: /(?:^|\s)#([\p{L}\p{N}_-]*)$/u,
      type: 'channel'
    });
  }

  // Server emojis plus the unified pack. Empty query is allowed: ":" alone lists emojis.
  const emojiSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableEmojis || state.value.triggerType !== 'emoji') {
      return [];
    }
    
    ensureEmojiDataLoaded()

    const suggestions: SuggestionItem[] = [];
    const query = state.value.query.toLowerCase();
    const resolvedEmojiList = emojiCacheStore.resolvedEmojis;
    const seenNames = new Set<string>();

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
          emoji: emoji
        };
      }));
    }

    // Unified pack: twemoji or native, per pack selection.
    if (unifiedLoaded.value && query.length >= 2) {
      const unifiedResults = searchUnifiedEmojis(query, finalConfig.maxSuggestions);
      
      for (const emoji of unifiedResults) {
        // Server emoji of the same shortcode takes precedence.
        if (seenNames.has((emoji.shortcode ?? '').toLowerCase())) continue;
        
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

    // Order: exact match, then prefix match, then substring match.
    return suggestions
      .sort((a, b) => {
        const aName = (a.name || '').toLowerCase();
        const bName = (b.name || '').toLowerCase();
        const aDisplay = (a.display_name || '').toLowerCase();
        const bDisplay = (b.display_name || '').toLowerCase();

        if (aName === query || aDisplay === query) return -1;
        if (bName === query || bDisplay === query) return 1;

        if (aName.startsWith(query) || aDisplay.startsWith(query)) return -1;
        if (bName.startsWith(query) || bDisplay.startsWith(query)) return 1;

        return 0;
      })
      .slice(0, finalConfig.maxSuggestions);
  });

  const mentionSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableMentions || state.value.triggerType !== 'mention') {
      return [];
    }
    // Chat mode filters on the query; ActivityPub renders search results, empty until they arrive.
    const query = (state.value.query || '').toLowerCase();
    if (finalConfig.mode === 'chat' && !query) {
      return [];
    }

    if (finalConfig.mode === 'chat') {
      // Candidates are scoped to the current server's members.
      const suggestions: SuggestionItem[] = [];
      let usersToSearch: any[] = [];

      const currentServerId = serverChannelStore.currentServerId;
      
      debug.log(`AutoSuggest: bridgedUsers count = ${bridgedUsers.value.length}, loaded = ${bridgedUsersLoaded.value}`);
      
      if (currentServerId) {
        usersToSearch = userDataService.getUsersInContext(currentServerId);
        debug.log(`AutoSuggest: Using server context ${currentServerId}, found ${usersToSearch.length} server members`);
      } else {
        // No server context: fall back to every known user.
        usersToSearch = userDataService.getAllUsers();
        debug.log(`AutoSuggest: No server context, falling back to all users (${usersToSearch.length} total)`);
      }

      const seenUsers = new Set<string>();
      
      for (const userData of usersToSearch) {
        if (seenUsers.has(userData.id)) {
          continue;
        }
        seenUsers.add(userData.id);
        
        const displayName = userData.displayName?.toLowerCase() || '';
        const usernameStr = userData.username?.toLowerCase() || '';

        if (displayName.includes(query) || usernameStr.includes(query)) {
          const isLocal = userData.isLocal;
          const currentDomain = import.meta.env.VITE_DOMAIN as string;
          const userDomain = userData.domain || currentDomain;
          const displayText = isLocal ? `@${userData.username}` : `@${userData.username}@${userDomain}`;
          
          const mentionText = `@${userData.id}@${userDomain}`;

          suggestions.push({
            id: userData.id,
            display_name: userData.displayName,
            username: userData.username,
            avatar: userData.avatarUrl,
            display_text: displayText, // shown in the input
            mention_text: mentionText, // persisted to the DB
            user: userData
          });
        }
      }
      
      // NOTE: the bridge bot check runs in handleInput on '@'; this list stays empty until then.
      for (const bridgedUser of bridgedUsers.value) {
        const bridgedKey = `discord:${bridgedUser.id}`;
        if (seenUsers.has(bridgedKey)) {
          continue;
        }
        seenUsers.add(bridgedKey);
        
        const displayName = bridgedUser.displayName?.toLowerCase() || '';
        const usernameStr = bridgedUser.username?.toLowerCase() || '';
        
        if (displayName.includes(query) || usernameStr.includes(query)) {
          // Discord mentions store `@d!ID:username`: the id drives translation, the username display.
          const displayText = `@${bridgedUser.username}`;
          const mentionText = `@d!${bridgedUser.id}:${bridgedUser.username}`;
          
          suggestions.push({
            id: bridgedUser.id,
            display_name: bridgedUser.displayName,
            username: bridgedUser.username,
            avatar: bridgedUser.avatarUrl,
            display_text: displayText, // @username
            mention_text: mentionText, // @d!ID:username
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

      // Final dedup by id across users, bridged users and roles.
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

          if (aDisplay === query || aUsername === query) return -1;
          if (bDisplay === query || bUsername === query) return 1;

          if (aDisplay.startsWith(query) || aUsername.startsWith(query)) return -1;
          if (bDisplay.startsWith(query) || bUsername.startsWith(query)) return 1;

          return 0;
        })
        .slice(0, finalConfig.maxSuggestions);
        
    } else if (finalConfig.mode === 'activitypub') {
      // ActivityPub: search results are used unfiltered; there is no server scope.
      // RPC search_federated_users returns user_id, not id; DisplayName and cache priming key on it.
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

  interface SlashCommand {
    id: string;
    name: string;
    description: string;
    permission: string;
    params?: { name: string; description: string }[];
    /** Optional instance-setting gate; command is hidden when this returns false. */
    enabled?: () => boolean;
  }

  const instanceSettings = useInstanceSettingsStore();

  const SLASH_COMMANDS: SlashCommand[] = [
    { id: 'cmd:kick', name: 'kick', description: 'Kick a member from the server', permission: 'KICK_MEMBERS' },
    { id: 'cmd:ban', name: 'ban', description: 'Ban a member from the server', permission: 'BAN_MEMBERS' },
    { id: 'cmd:gif', name: 'gif', description: 'Search KLIPY for a GIF', permission: '', params: [{ name: 'query', description: 'Search KLIPY for a GIF' }] },
    { id: 'cmd:sticker', name: 'sticker', description: 'Search KLIPY for a sticker', permission: '', params: [{ name: 'query', description: 'Search KLIPY for a sticker' }] },
    { id: 'cmd:clip', name: 'clip', description: 'Search KLIPY for a Clip', permission: '', params: [{ name: 'query', description: 'Search KLIPY for a Clip' }], enabled: () => instanceSettings.gifClipsEnabled },
    { id: 'cmd:meme', name: 'meme', description: 'Search KLIPY for a meme', permission: '', params: [{ name: 'query', description: 'Search KLIPY for a meme' }], enabled: () => instanceSettings.gifMemesEnabled },
    { id: 'cmd:aiemoji', name: 'aiemoji', description: 'Search KLIPY for an AI emoji', permission: '', params: [{ name: 'query', description: 'Search KLIPY for an AI emoji' }], enabled: () => instanceSettings.gifAiEmojisEnabled },
  ];

  const commandSuggestions = computed((): SuggestionItem[] => {
    if (state.value.triggerType !== 'command') return [];
    const query = (state.value.query || '').toLowerCase();
    const isOwner = isCurrentUserServerOwner.value;
    return SLASH_COMMANDS
      .filter(cmd => {
        if (!cmd.name.includes(query)) return false;
        if (cmd.enabled && !cmd.enabled()) return false;
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

  // Membership-scoped: the store holds channels only for servers the user belongs to.
  const channelSuggestions = computed((): SuggestionItem[] => {
    if (!finalConfig.enableChannels || state.value.triggerType !== 'channel') return [];
    const serverId = serverChannelStore.currentServerId;
    if (!serverId) return [];

    const query = state.value.query.toLowerCase();
    return serverChannelStore.channels
      .filter(c => c.type === 0 && c.name.toLowerCase().includes(query))
      .slice(0, finalConfig.maxSuggestions)
      .map(c => ({
        id: c.id,
        name: c.name,
        display_name: `#${c.name}`,
        description: c.description,
        isChannel: true,
        serverId: c.server_id || serverId,
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
      case 'channel':
        return channelSuggestions.value;
      default:
        return [];
    }
  });

  const headerText = computed((): string => {
    switch (state.value.triggerType) {
      case 'emoji':
        return 'Emojis';
      case 'command':
        return 'Commands';
      case 'channel':
        return 'Channels';
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

  let currentSearchAbortController: AbortController | null = null;
  let currentSearchQuery = '';
  
  // Result is cached per server for BRIDGE_BOT_CHECK_CACHE_TTL; concurrent calls share one query.
  const hasBridgeBots = async (serverId: string | null): Promise<boolean> => {
    if (!serverId) {
      return false;
    }
    
    const cached = bridgeBotCheckCache.get(serverId);
    if (cached && Date.now() - cached.timestamp < BRIDGE_BOT_CHECK_CACHE_TTL) {
      return cached.hasBridge;
    }
    
    const pendingRequest = bridgeBotCheckPending.get(serverId);
    if (pendingRequest) {
      debug.log(`Bridge bot check already pending for server ${serverId}, reusing request`);
      return pendingRequest;
    }
    
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
          debug.warn('Failed to check for bridge bots:', error);
          // Negative result is cached; a failing query repeats at most once per TTL.
          bridgeBotCheckCache.set(serverId, { hasBridge: false, timestamp: Date.now() });
          return false;
        }
        
        const bridgeBots = (data || []).filter((perm: any) => perm.bot?.bot_type === 'bridge');
        const hasBridge = bridgeBots.length > 0;
        
        bridgeBotCheckCache.set(serverId, { hasBridge, timestamp: Date.now() });
        
        if (hasBridge) {
          debug.log(`Server ${serverId} has ${bridgeBots.length} bridge bot(s)`);
        }
        return hasBridge;
      } catch (error) {
        debug.warn('Error checking for bridge bots:', error);
        bridgeBotCheckCache.set(serverId, { hasBridge: false, timestamp: Date.now() });
        return false;
      } finally {
        bridgeBotCheckPending.delete(serverId);
      }
    })();
    
    bridgeBotCheckPending.set(serverId, requestPromise);
    
    return requestPromise;
  };

  // Called only when the server has bridge bots. Whether this channel has a bridge
  // mapping is decided by the API; absence yields an empty list.
  const fetchBridgedUsers = async (channelId: string) => {
    if (!channelId) {
      return;
    }

    try {
      const result = await fetchBridgedChannelUsers(channelId);
      bridgedUsers.value = result.users;
      bridgedUsersChannelId.value = channelId;
      bridgedUsersLoaded.value = true;
    } catch {
      bridgedUsers.value = [];
      bridgedUsersLoaded.value = true;
    }
  };

  const fetchServerRoles = async (serverId: string) => {
    if (!serverId) {
      serverRoles.value = [];
      return;
    }
    
    if (serverRolesLoaded.value && serverRolesServerId.value === serverId) {
      return;
    }
    
    try {
      const roles = await roleService.getRolesForServer(serverId);
      serverRoles.value = roles;
      serverRolesServerId.value = serverId;
      serverRolesLoaded.value = true;
      debug.log(`Loaded ${serverRoles.value.length} mentionable roles for server ${serverId}`);
    } catch (error) {
      debug.warn('Failed to fetch server roles:', error);
      serverRoles.value = [];
      serverRolesLoaded.value = true;
    }
  };

  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  
  const searchActivityPubUsersDebounced = (query: string) => {
    if (searchDebounceTimer) clearTimeout(searchDebounceTimer);
    searchDebounceTimer = setTimeout(() => searchActivityPubUsers(query), 150);
  };

  // Latest query wins: earlier searches are aborted and stale results discarded.
  const searchActivityPubUsers = async (query: string) => {
    debug.log('[DEBUG] searchActivityPubUsers called:', { query, mode: finalConfig.mode });
    
    if (finalConfig.mode !== 'activitypub' || query.length < 1) {
      activityPubUsers.value = [];
      return;
    }

    if (currentSearchAbortController) {
      currentSearchAbortController.abort();
    }
    
    currentSearchAbortController = new AbortController();
    currentSearchQuery = query;

    try {
      debug.log('[DEBUG] searchActivityPubUsers: Calling activityPubService.searchUsers...');
      
      const timeoutPromise = new Promise<never>((_, reject) => {
        setTimeout(() => reject(new Error('Search timeout after 5s')), 5000);
      });
      
      const searchPromise = activityPubService.searchUsers(query, finalConfig.maxSuggestions);
      
      const users = await Promise.race([searchPromise, timeoutPromise]);
      
      // Stale responses are dropped.
      if (query === currentSearchQuery) {
        debug.log('[DEBUG] searchActivityPubUsers: Got results:', users?.length || 0, 'users');
        activityPubUsers.value = users;
        // Primes userDataService so DisplayName resolves custom emoji shortcodes in the dropdown.
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
      // Clearing is scoped to the current query; a stale timed-out search must not
      // wipe fresh results.
      if (query === currentSearchQuery) {
        activityPubUsers.value = [];
      }
    }
  };

  const calculateCursorPosition = (): SuggestionPosition => {
    if (!inputElement.value) {
      return { x: 0, y: 0 };
    }

    const input = inputElement.value;
    let inputRect: DOMRect;
    
    if ('getBoundingClientRect' in input) {
      inputRect = input.getBoundingClientRect();
    } else if (input.$el) {
      inputRect = input.$el.getBoundingClientRect();
    } else {
      return { x: 0, y: 0 };
    }

    const suggestionCount = suggestions.value.length;
    // px, matching AutoSuggest.vue styling.
    const headerHeight = finalConfig.enableEmojis || finalConfig.enableMentions ? 32 : 0;
    const itemHeight = 44;
    const maxHeight = 240;
    const padding = 8;
    
    const popupHeight = Math.min(
      headerHeight + (suggestionCount * itemHeight) + padding,
      maxHeight
    );

    let x = inputRect.left;
    let y = inputRect.bottom + 8; // below the input

    // Chat input sits at the bottom of the screen; the popup goes above it.
    if (finalConfig.mode === 'chat') {
      y = inputRect.top - popupHeight - 8; // 8px margin
      
      try {
        if ('selectionStart' in input && input.selectionStart !== null) {
          const cursorPos = input.selectionStart;
          const textBeforeCursor = input.value?.substring(0, cursorPos) || '';
          
          // Character width estimated at 8px; no text measurement.
          const estimatedCursorX = textBeforeCursor.length * 8;
          x = Math.max(inputRect.left, inputRect.left + estimatedCursorX - 100); // centers the popup on the cursor
        } else if ('getCursorPosition' in input && typeof input.getCursorPosition === 'function') {
          // RichTextEditor exposes the caret offset instead of selectionStart.
          const cursorPos = input.getCursorPosition();
          const currentText = getCurrentText ? getCurrentText() : '';
          const textBeforeCursor = currentText.substring(0, cursorPos);
          
          const estimatedCursorX = textBeforeCursor.length * 8;
          x = Math.max(inputRect.left, inputRect.left + estimatedCursorX - 100);
        }
      } catch (error) {
        // x keeps the input's left edge.
        debug.debug('Cursor position detection failed, using default positioning');
      }
    }

    // Clamp to the viewport, 16px inset.
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const popupWidth = state.value.triggerType === 'command' ? 380 : 280;

    if (x + popupWidth > viewportWidth) {
      x = viewportWidth - popupWidth - 16;
    }
    
    x = Math.max(16, x);

    if (y < 16) {
      y = inputRect.bottom + 8;
    }
    
    if (y + popupHeight > viewportHeight - 16) {
      y = inputRect.top - popupHeight - 8;
    }

    return { x, y };
  };

  const dismissActiveCommand = () => {
    activeCommand.value = null;
  };

  const handleInput = (value: string, cursorPosition: number) => {
    const textBeforeCursor = value.substring(0, cursorPosition);
    // RichTextEditor emits \u00A0 for spaces and \s does not match it; normalized before matching.
    const normalizedForMatch = textBeforeCursor.replace(/\u00A0/g, ' ');
    
    debug.log('[DEBUG] handleInput called:', { value: value.substring(0, 50), cursorPosition, textBeforeCursor: textBeforeCursor.substring(textBeforeCursor.length - 20) });
    
    let foundTrigger = false;
    
    for (const trigger of triggers) {
      const match = normalizedForMatch.match(trigger.pattern);
      debug.log('[DEBUG] Checking trigger:', trigger.type, 'pattern:', trigger.pattern, 'match:', match);
      if (match && match.index !== undefined) {
        foundTrigger = true;
        const query = match[1] || '';
        
        debug.log('[DEBUG] Trigger found!', { type: trigger.type, query, matchIndex: match.index });
        
        let triggerPosition = match.index;
        
        if (trigger.type === 'mention') {
          // The mention pattern can consume a leading whitespace char; the insert
          // position starts at the '@'.
          const matchText = match[0];
          if (matchText.startsWith(' ') || matchText.startsWith('\t')) {
            triggerPosition = match.index + 1;
          }
        }
        // The emoji pattern's match starts at ':', so its index needs no adjustment.
        
        state.value = {
          isActive: true,
          triggerType: trigger.type,
          query,
          triggerPosition,
          selectedIndex: 0,
          position: calculateCursorPosition()
        };
        
        // Bridge bot check and role load run on '@', not on server change.
        if (trigger.type === 'mention' && finalConfig.mode === 'chat') {
          const serverId = serverChannelStore.currentServerId;
          const channelId = serverChannelStore.currentChannelId;
          
          if (serverId && serverId !== serverRolesServerId.value) {
            fetchServerRoles(serverId);
          }
          
          checkBridgeBotsIfNeeded(serverId).then(hasBridge => {
            if (hasBridge && channelId && channelId !== bridgedUsersChannelId.value) {
              fetchBridgedUsers(channelId);
            }
          }).catch(err => {
            debug.warn('Failed to check bridge bots:', err);
          });
        }
        
        debug.log('[DEBUG] State set to active:', state.value);

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

  // Guards selectSuggestion against re-entry.
  const isSelecting = ref(false);

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

  // Replaces the trigger text with the suggestion and returns the new text.
  const selectSuggestion = (suggestion: SuggestionItem): string => {
    if (isSelecting.value) {
      debug.log('Preventing duplicate selection');
      return '';
    }
    
    isSelecting.value = true;
    
    try {
      const currentText = getCurrentText ? getCurrentText() : '';
      
      const triggerStart = state.value.triggerPosition;
      
      // Trigger text runs from the trigger char to the next space, newline, or end of text.
      const textFromTrigger = currentText.substring(triggerStart);
      const endMatch = textFromTrigger.match(/^[^\s\n]*/);
      const triggerLength = endMatch ? endMatch[0].length : 1;
      const triggerEnd = triggerStart + triggerLength;
      
      debug.log('selectSuggestion detailed debug:', {
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

      if (state.value.triggerType === 'command' && suggestion.isCommand) {
        closeSuggestions();

        // Parameterized commands clear the input and enter command mode.
        if (suggestion.commandParams?.length) {
          activeCommand.value = { name: suggestion.name || '', params: suggestion.commandParams };
          if (updateText) {
            updateText('', 0);
          }
          return '';
        }

        // Bare commands dispatch 'harmony-command' and clear the trigger text.
        window.dispatchEvent(new CustomEvent('harmony-command', { detail: { command: suggestion.name } }));
        const clearedText = currentText.substring(0, triggerStart) + currentText.substring(triggerEnd);
        if (updateText) {
          updateText(clearedText.trim() ? clearedText : '', triggerStart);
        }
        return clearedText.trim() ? clearedText : '';
      }
      
      if (state.value.triggerType === 'channel') {
        insertText = `#${suggestion.name} `;
      } else if (state.value.triggerType === 'emoji') {
        // Unified emojis insert the unicode character; custom server emojis keep :shortcode:.
        if (suggestion.emoji?.source === 'unified' && (suggestion.native || suggestion.emoji?.native)) {
          insertText = (suggestion.native || suggestion.emoji.native) + ' ';
        } else {
          insertText = `:${suggestion.name}: `;
        }
      } else if (state.value.triggerType === 'mention') {
        if (finalConfig.mode === 'activitypub') {
          // Matches what RichTextEditor renders as data-display-text:
          //   local users  → @username        (no domain)
          //   remote users → @username@domain
          if (suggestion.user?.is_local) {
            insertText = `@${suggestion.username} `;
          } else {
            insertText = (suggestion.handle || `@${suggestion.username}`) + ' ';
          }
          debug.log('ActivityPub mention insert:', {
            handle: suggestion.handle,
            username: suggestion.username,
            domain: suggestion.user?.domain,
            is_local: suggestion.user?.is_local,
            insertText
          });
        } else {
          // Chat mode inserts display_text; RichTextEditor resolves the user id when it
          // builds the mention element. Bridged and role mentions carry their own encoding.
          if (suggestion.isBridged && suggestion.mention_text) {
            insertText = suggestion.mention_text + ' '; // @d!ID:username
          } else if (suggestion.isRole && suggestion.mention_text) {
            insertText = suggestion.mention_text + ' '; // @role:UUID
          } else if (suggestion.display_text) {
            insertText = suggestion.display_text + ' '; // @username or @username@domain
          } else {
            insertText = `@${suggestion.username} `;
          }
        }
      }
      
      const newText = currentText.substring(0, triggerStart) + 
                     insertText + 
                     currentText.substring(triggerEnd);
      
      // Cursor lands after the inserted text, past its trailing space.
      const newCursorPosition = triggerStart + insertText.length;
      
      debug.log('Final replacement:', { 
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
      isSelecting.value = false;
    }
  };

  const closeSuggestions = () => {
    state.value.isActive = false;
    state.value.triggerType = null;
    state.value.query = '';
    state.value.selectedIndex = 0;
    activityPubUsers.value = [];
  };

  const updatePosition = () => {
    if (state.value.isActive) {
      state.value.position = calculateCursorPosition();
    }
  };

  // List length determines popup height, which determines the anchor point.
  watch(suggestions, () => {
    if (state.value.isActive) {
      nextTick(() => {
        updatePosition();
      });
    }
  });
  
  // Composable-local memo of the bridge bot check; null means unchecked.
  const currentServerHasBridgeBots = ref<boolean | null>(null);
  const currentServerIdForBridgeCheck = ref<string | null>(null);
  
  const checkBridgeBotsIfNeeded = async (serverId: string | null) => {
    if (!serverId) {
      currentServerHasBridgeBots.value = false;
      return false;
    }
    
    if (currentServerIdForBridgeCheck.value === serverId && currentServerHasBridgeBots.value !== null) {
      return currentServerHasBridgeBots.value;
    }
    
    if (currentServerIdForBridgeCheck.value !== serverId) {
      currentServerIdForBridgeCheck.value = serverId;
      currentServerHasBridgeBots.value = await hasBridgeBots(serverId);
    }
    
    return currentServerHasBridgeBots.value || false;
  };

  // Channel change invalidates the bridged user list; the refetch waits for the next '@'.
  watch(() => serverChannelStore.currentChannelId, (newChannelId) => {
    if (newChannelId !== bridgedUsersChannelId.value) {
      bridgedUsersLoaded.value = false;
      bridgedUsers.value = [];
      bridgedUsersChannelId.value = null;
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