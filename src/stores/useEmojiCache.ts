import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Emoji, ResolvedEmoji } from '@/types';
import { debug } from '@/utils/debug'
import {
  getAllCachedServerEmojis,
  setCachedServerEmojis,
  removeCachedServerEmojis,
} from '@/services/emojiIndexedDBCache'

/**
 * Reserved cache keys for non-server emoji groups. They flow through the same
 * server-keyed machinery (so they land in nameIndex/globalEmojiIndex and resolve
 * in :shortcode: at send time) but are not real servers — they're never
 * persisted to IndexedDB and the picker renders them as their own sections.
 */
export const PERSONAL_EMOJI_GROUPS = {
  ai: '__ai_generated__',
  user: '__user_emoji__',
  instance: '__instance_emoji__',
} as const;

/** True for the synthetic personal/instance group keys above. */
export function isPersonalEmojiGroup(key: string): boolean {
  return key.startsWith('__');
}

interface EmojiCacheEntry {
  emoji: Emoji;
  lastUpdated: Date;
  accessCount: number;
  lastAccessed: Date;
}

interface ServerEmojiCache {
  serverId: string;
  serverName: string;
  serverIcon?: string;
  emojis: Map<string, EmojiCacheEntry>;
  lastFetched: Date;
  isStale: boolean;
  allowCrossServer: boolean;
}

interface EmojiMetadata {
  serverId: string;
  lastModified: Date;
  count: number;
}

export const useEmojiCacheStore = defineStore('emojiCache', {
  state: () => ({
    serverCaches: new Map<string, ServerEmojiCache>(),
    
    globalEmojiIndex: new Map<string, EmojiCacheEntry>(),
    
    nameIndex: new Map<string, EmojiCacheEntry[]>(),
    
    resolvedEmojis: {} as Record<string, {
      server_name: string;
      server_icon?: string;
      emojis: ResolvedEmoji[];
    }>,
    
    maxCacheAge: 15 * 60 * 1000,
    maxCacheSize: 100,
    maxEmojisPerServer: 1000,
    
    isInitialized: false,
    lastGlobalUpdate: null as Date | null,
    pendingInvalidations: new Set<string>(),
    
    _pendingEmojiLoads: null as Promise<void> | null,
    _loadingServerIds: new Set<string>() as Set<string>,

    _emojiChannel: null as any,
    
    cacheHits: 0,
    cacheMisses: 0,
    lastCleanup: new Date(),
  }),

  getters: {
    getCacheStats: (state) => ({
      serverCount: state.serverCaches.size,
      totalEmojis: Array.from(state.serverCaches.values())
        .reduce((sum, cache) => sum + cache.emojis.size, 0),
      hitRate: state.cacheHits / (state.cacheHits + state.cacheMisses) || 0,
      lastCleanup: state.lastCleanup,
    }),

    getServerEmojis: (state) => (serverId: string): ResolvedEmoji[] => {
      const cache = state.serverCaches.get(serverId);
      if (!cache || cache.isStale) {
        return [];
      }

      return Array.from(cache.emojis.values()).map(entry => ({
        ...entry.emoji,
        display_name: entry.emoji.name,
      }));
    },

    getEmojiById: (state) => (emojiId: string): Emoji | null => {
      const entry = state.globalEmojiIndex.get(emojiId);
      if (entry) {
        entry.accessCount++;
        entry.lastAccessed = new Date();
        state.cacheHits++;
        return entry.emoji;
      }
      state.cacheMisses++;
      return null;
    },

    searchEmojisByName: (state) => (query: string, limit = 20): ResolvedEmoji[] => {
      const results: ResolvedEmoji[] = [];
      const queryLower = query.toLowerCase();
      
      for (const [name, entries] of state.nameIndex) {
        if (name.toLowerCase().includes(queryLower) && results.length < limit) {
          for (const entry of entries) {
            if (results.length >= limit) break;
            const serverId = entry.emoji.server_id;
            if (!serverId) continue;
            const cache = state.serverCaches.get(serverId);
            if (cache && !cache.isStale) {
              results.push({
                ...entry.emoji,
                display_name: entry.emoji.name,
              });
            }
          }
        }
      }
      
      return results.sort((a, b) => a.name.localeCompare(b.name));
    },
  },

  actions: {
    async initialize(userServerIds: string[]) {
      if (this.isInitialized) return;
      
      debug.log('🎭 Initializing emoji cache system...');
      
      try {
        await this.fetchAllServerMetadata(userServerIds);
        
        await this.loadEmojisForServers(userServerIds);
        
        this.setupRealtimeSubscriptions();
        
        this.scheduleCleanup();
        
        this.isInitialized = true;
        this.lastGlobalUpdate = new Date();
        
        debug.log('✅ Emoji cache initialized successfully');
      } catch (error) {
        debug.error('❌ Failed to initialize emoji cache:', error);
        throw error;
      }
    },

    async initializeSelective(priorityServerIds: string[] = [], backgroundServerIds: string[] = []) {
      if (this.isInitialized) return;
      
      debug.log('🎭 Initializing emoji cache system (selective loading)...');
      debug.log(`⚡ Priority servers: ${priorityServerIds.length}, Background: ${backgroundServerIds.length}`);
      
      try {
        const allRequestedIds = [...priorityServerIds, ...backgroundServerIds];
        const hydratedServerIds: string[] = [];

        try {
          const cachedServers = await getAllCachedServerEmojis();
          for (const cached of cachedServers) {
            if (allRequestedIds.includes(cached.serverId)) {
              this.updateServerCache(
                cached.serverId,
                cached.emojis as Emoji[],
                { name: cached.serverName, icon: cached.serverIcon, allow_cross_server_emojis: cached.allowCrossServer },
              );
              hydratedServerIds.push(cached.serverId);
            }
          }
          if (hydratedServerIds.length > 0) {
            this.rebuildResolvedEmojis();
            debug.log(`⚡ Hydrated ${hydratedServerIds.length} servers from IndexedDB cache`);
          }
        } catch (e) {
          debug.warn('IndexedDB hydration failed, will fetch from network:', e);
        }

        const priorityMissing = priorityServerIds.filter(id => !hydratedServerIds.includes(id));
        const backgroundMissing = backgroundServerIds.filter(id => !hydratedServerIds.includes(id));

        if (priorityMissing.length > 0) {
          debug.log(`⚡ Loading ${priorityMissing.length} priority servers from network...`);
          await this.loadEmojisForServers(priorityMissing);
        }
        
        if (backgroundMissing.length > 0) {
          setTimeout(async () => {
            debug.log(`🔄 Loading ${backgroundMissing.length} background servers from network...`);
            await this.loadEmojisForServers(backgroundMissing);
          }, 1000);
        }

        if (hydratedServerIds.length > 0) {
          setTimeout(async () => {
            debug.log(`🔄 Revalidating ${hydratedServerIds.length} cached servers...`);
            for (const id of hydratedServerIds) {
              const cache = this.serverCaches.get(id);
              if (cache) cache.isStale = true;
            }
            await this.loadEmojisForServers(hydratedServerIds);
          }, 2000);
        }
        
        this.setupRealtimeSubscriptions();
        
        this.scheduleCleanup();
        
        this.isInitialized = true;
        this.lastGlobalUpdate = new Date();
        
        debug.log('✅ Emoji cache initialized successfully (selective)');
      } catch (error) {
        debug.error('❌ Failed to initialize emoji cache selectively:', error);
        throw error;
      }
    },

    async fetchAllServerMetadata(serverIds: string[]): Promise<Map<string, EmojiMetadata>> {
      const { data, error } = await supabase
        .rpc('get_emoji_metadata_bulk', { server_ids: serverIds });
      
      if (error) {
        debug.error('Error fetching emoji metadata:', error);
        return new Map();
      }
      
      const metadataMap = new Map<string, EmojiMetadata>();
      data.forEach((item: any) => {
        metadataMap.set(item.server_id, {
          serverId: item.server_id,
          lastModified: new Date(item.last_modified),
          count: item.emoji_count,
        });
      });
      
      return metadataMap;
    },

    async loadEmojisForServers(serverIds: string[]) {
      const serversToUpdate = serverIds.filter(serverId => {
        if (this._loadingServerIds.has(serverId)) {
          debug.log(`⏳ Server ${serverId} emoji load already in progress, skipping`);
          return false;
        }
        const cache = this.serverCaches.get(serverId);
        return !cache || cache.isStale || this.isCacheExpired(cache);
      });

      if (serversToUpdate.length === 0) {
        debug.log('📋 All emoji caches are up to date or loading');
        return;
      }

      serversToUpdate.forEach(id => this._loadingServerIds.add(id));

      try {
        debug.log(`📥 Loading emojis for ${serversToUpdate.length} servers`);

        const [serverDetails, emojiData] = await Promise.all([
          this.fetchServerDetails(serversToUpdate),
          this.fetchEmojisForServers(serversToUpdate),
        ]);

        for (const serverId of serversToUpdate) {
          const server = serverDetails.get(serverId);
          const emojis = emojiData.get(serverId) || [];
          
          this.updateServerCache(serverId, emojis, server);
        }

        // Rebuild resolved emojis
        this.rebuildResolvedEmojis();
      } finally {
        serversToUpdate.forEach(id => this._loadingServerIds.delete(id));
      }
    },

    async fetchServerDetails(serverIds: string[]): Promise<Map<string, any>> {
      const { data, error } = await supabase
        .from('servers')
        .select('id, name, icon, allow_cross_server_emojis')
        .in('id', serverIds);

      if (error) {
        debug.error('Error fetching server details:', error);
        return new Map();
      }

      const serverMap = new Map();
      data.forEach(server => serverMap.set(server.id, server));
      return serverMap;
    },

    async fetchEmojisForServers(serverIds: string[]): Promise<Map<string, Emoji[]>> {
      const { data, error } = await supabase
        .from('emojis')
        .select('*')
        .in('server_id', serverIds)
        .order('name');

      if (error) {
        debug.error('Error fetching emojis:', error);
        return new Map();
      }

      const emojiMap = new Map<string, Emoji[]>();
      data.forEach((emoji: Emoji) => {
        const serverId = emoji.server_id;
        if (!serverId) return;
        if (!emojiMap.has(serverId)) {
          emojiMap.set(serverId, []);
        }
        emojiMap.get(serverId)!.push(emoji);
      });

      return emojiMap;
    },

    updateServerCache(serverId: string, emojis: Emoji[], serverDetails?: any, persist = true) {
      this.removeServerFromCache(serverId);

      const emojiMap = new Map<string, EmojiCacheEntry>();
      const now = new Date();

      emojis.forEach(emoji => {
        const entry: EmojiCacheEntry = {
          emoji,
          lastUpdated: now,
          accessCount: 0,
          lastAccessed: now,
        };
        
        emojiMap.set(emoji.id, entry);
        
        this.globalEmojiIndex.set(emoji.id, entry);
        
        if (!this.nameIndex.has(emoji.name)) {
          this.nameIndex.set(emoji.name, []);
        }
        this.nameIndex.get(emoji.name)!.push(entry);
      });

      const serverCache: ServerEmojiCache = {
        serverId,
        serverName: serverDetails?.name || `Server ${serverId}`,
        serverIcon: serverDetails?.icon,
        emojis: emojiMap,
        lastFetched: now,
        isStale: false,
        allowCrossServer: serverDetails?.allow_cross_server_emojis ?? true,
      };

      this.serverCaches.set(serverId, serverCache);
      
      // Write-through to IndexedDB for persistence across page reloads.
      // Synthetic personal/instance groups are session-scoped (refetched on open).
      if (persist) {
        setCachedServerEmojis({
          serverId,
          serverName: serverCache.serverName,
          serverIcon: serverCache.serverIcon,
          allowCrossServer: serverCache.allowCrossServer,
          emojis,
          lastFetched: now.getTime(),
        });
      }
      
      debug.log(`📦 Cached ${emojis.length} emojis for: ${serverCache.serverName}`);
    },

    /**
     * Load the viewer's personal (user-scoped) emoji and the instance-wide
     * emoji into the picker. AI-generated emoji become their own group. This is
     * what surfaces generated emoji as a category and makes user/instance custom
     * emoji resolvable in messages.
     */
    async loadPersonalEmojis(profileId: string | null) {
      try {
        const requests: Promise<{ data: Emoji[] | null }>[] = [
          // Instance category: only LOCAL (and admin-imported, re-hosted) emoji.
          // Emoji cached from inter-instance interactions carry a `domain`, so
          // exclude those — they don't belong in this instance's own collection.
          supabase
            .from('emojis')
            .select('*')
            .eq('scope', 'instance')
            .is('domain', null)
            .order('name') as any,
        ];
        if (profileId) {
          requests.push(
            supabase
              .from('emojis')
              .select('*')
              .eq('scope', 'user')
              .eq('uploader', profileId)
              .order('created_at', { ascending: false }) as any,
          );
        }
        const results = await Promise.all(requests);
        const instanceEmojis = (results[0]?.data || []) as Emoji[];
        const userEmojis = ((profileId ? results[1]?.data : []) || []) as Emoji[];

        const aiEmojis = userEmojis.filter((e) => (e as any).is_ai_generated === true);
        const ownEmojis = userEmojis.filter((e) => (e as any).is_ai_generated !== true);

        // Name the instance group after the instance (e.g. "Spacify Emoji").
        let instanceLabel = 'Instance Emoji';
        try {
          const { useInstanceSettingsStore } = await import('@/stores/useInstanceSettings');
          const name = useInstanceSettingsStore().settings.instanceName?.trim();
          if (name) instanceLabel = `${name} Emoji`;
        } catch { /* settings not ready — keep fallback */ }

        this.updateServerCache(PERSONAL_EMOJI_GROUPS.ai, aiEmojis, { name: 'AI Generated' }, false);
        this.updateServerCache(PERSONAL_EMOJI_GROUPS.user, ownEmojis, { name: 'My Emoji' }, false);
        this.updateServerCache(PERSONAL_EMOJI_GROUPS.instance, instanceEmojis, { name: instanceLabel }, false);
        this.rebuildResolvedEmojis();
      } catch (e) {
        debug.error('Failed to load personal/instance emoji:', e);
      }
    },

    /** Add a single emoji to a personal group (e.g. a freshly generated one). */
    addPersonalEmoji(groupKey: string, groupName: string, emoji: Emoji) {
      const cache = this.serverCaches.get(groupKey);
      const existing = cache
        ? Array.from(cache.emojis.values())
            .map((e) => e.emoji)
            .filter((e) => e.id !== emoji.id)
        : [];
      this.updateServerCache(groupKey, [emoji, ...existing], { name: groupName }, false);
      this.rebuildResolvedEmojis();
    },

    removeServerFromCache(serverId: string) {
      const cache = this.serverCaches.get(serverId);
      if (!cache) return;

      for (const entry of cache.emojis.values()) {
        this.globalEmojiIndex.delete(entry.emoji.id);
        
        const nameEntries = this.nameIndex.get(entry.emoji.name);
        if (nameEntries) {
          const index = nameEntries.indexOf(entry);
          if (index > -1) {
            nameEntries.splice(index, 1);
          }
          if (nameEntries.length === 0) {
            this.nameIndex.delete(entry.emoji.name);
          }
        }
      }

      this.serverCaches.delete(serverId);
      removeCachedServerEmojis(serverId);
    },

    rebuildResolvedEmojis() {
      const resolved: Record<string, {
        server_name: string;
        server_icon?: string;
        emojis: ResolvedEmoji[];
      }> = {};

      const nameCount: Record<string, number> = {};

      for (const [serverId, cache] of this.serverCaches) {
        if (cache.isStale) continue;

        const emojis: ResolvedEmoji[] = [];
        
        for (const entry of cache.emojis.values()) {
          const count = nameCount[entry.emoji.name] || 0;
          nameCount[entry.emoji.name] = count + 1;

          emojis.push({
            ...entry.emoji,
            display_name: count > 0 ? `${entry.emoji.name}~${count}` : entry.emoji.name,
          });
        }

        resolved[serverId] = {
          server_name: cache.serverName,
          server_icon: cache.serverIcon,
          emojis,
        };
      }

      this.resolvedEmojis = resolved;
      debug.log('🔄 Rebuilt resolved emojis for', Object.keys(resolved).length, 'servers');

      import('@/services/userDataService').then(({ userDataService }) => {
        userDataService.reResolveAllDisplayNames()
      }).catch(() => { /* userDataService not ready yet */ })
    },

    async handleEmojiUpdate(payload: any) {
      const { eventType, new: newEmoji, old: oldEmoji } = payload;
      
      switch (eventType) {
        case 'INSERT':
          await this.handleEmojiInsert(newEmoji);
          break;
        case 'UPDATE':
          await this.handleEmojiUpdateEntry(newEmoji);
          break;
        case 'DELETE':
          await this.handleEmojiDelete(oldEmoji);
          break;
      }
    },

    async handleEmojiInsert(emoji: Emoji) {
      const serverId = emoji.server_id;
      if (!serverId) return;
      const cache = this.serverCaches.get(serverId);
      if (!cache) {
        this.markServerStale(serverId);
        return;
      }

      const entry: EmojiCacheEntry = {
        emoji,
        lastUpdated: new Date(),
        accessCount: 0,
        lastAccessed: new Date(),
      };

      cache.emojis.set(emoji.id, entry);
      this.globalEmojiIndex.set(emoji.id, entry);
      
      if (!this.nameIndex.has(emoji.name)) {
        this.nameIndex.set(emoji.name, []);
      }
      this.nameIndex.get(emoji.name)!.push(entry);

      this.rebuildResolvedEmojis();
      debug.log('➕ Added new emoji to cache:', emoji.name);
    },

    async handleEmojiUpdateEntry(emoji: Emoji) {
      const serverId = emoji.server_id;
      if (!serverId) return;
      const cache = this.serverCaches.get(serverId);
      if (!cache) {
        this.markServerStale(serverId);
        return;
      }

      const existingEntry = cache.emojis.get(emoji.id);
      if (existingEntry) {
        if (existingEntry.emoji.name !== emoji.name) {
          const oldNameEntries = this.nameIndex.get(existingEntry.emoji.name);
          if (oldNameEntries) {
            const index = oldNameEntries.indexOf(existingEntry);
            if (index > -1) {
              oldNameEntries.splice(index, 1);
            }
            if (oldNameEntries.length === 0) {
              this.nameIndex.delete(existingEntry.emoji.name);
            }
          }

          if (!this.nameIndex.has(emoji.name)) {
            this.nameIndex.set(emoji.name, []);
          }
          this.nameIndex.get(emoji.name)!.push(existingEntry);
        }

        existingEntry.emoji = emoji;
        existingEntry.lastUpdated = new Date();
        
        this.globalEmojiIndex.set(emoji.id, existingEntry);

        this.rebuildResolvedEmojis();
        debug.log('🔄 Updated emoji in cache:', emoji.name);
      } else {
        await this.handleEmojiInsert(emoji);
      }
    },

    async handleEmojiDelete(emoji: Emoji) {
      const serverId = emoji.server_id;
      if (!serverId) return;
      const cache = this.serverCaches.get(serverId);
      if (!cache) return;

      const entry = cache.emojis.get(emoji.id);
      if (entry) {
        cache.emojis.delete(emoji.id);
        this.globalEmojiIndex.delete(emoji.id);
        
        const nameEntries = this.nameIndex.get(emoji.name);
        if (nameEntries) {
          const index = nameEntries.indexOf(entry);
          if (index > -1) {
            nameEntries.splice(index, 1);
          }
          if (nameEntries.length === 0) {
            this.nameIndex.delete(emoji.name);
          }
        }

        this.rebuildResolvedEmojis();

        const remainingEmojis = Array.from(cache.emojis.values()).map(e => e.emoji);
        await setCachedServerEmojis({
          serverId,
          serverName: cache.serverName,
          serverIcon: cache.serverIcon,
          allowCrossServer: cache.allowCrossServer,
          emojis: remainingEmojis,
          lastFetched: Date.now(),
        });

        debug.log('➖ Removed emoji from cache:', emoji.name);
      }
    },

    markServerStale(serverId: string) {
      const cache = this.serverCaches.get(serverId);
      if (cache) {
        cache.isStale = true;
        this.pendingInvalidations.add(serverId);
      }
    },

    isCacheExpired(cache: ServerEmojiCache): boolean {
      const now = new Date();
      return (now.getTime() - cache.lastFetched.getTime()) > this.maxCacheAge;
    },

    /**
     * Emoji realtime is now handled via server-scoped broadcast
     * on the server-presence channel (relay through userDataService).
     * These methods are kept as no-ops for backward compatibility.
     */
    setupRealtimeSubscriptions() {
      debug.log('🔔 Emoji realtime: handled via server-presence broadcast');
    },

    cleanupRealtimeSubscriptions() {
    },

    performCleanup() {
      const now = new Date();
      let cleanedServers = 0;
      const cleanedEmojis = 0;

      for (const [serverId, cache] of this.serverCaches) {
        if (this.isCacheExpired(cache)) {
          this.removeServerFromCache(serverId);
          cleanedServers++;
        }
      }

      if (this.serverCaches.size > this.maxCacheSize) {
        const sortedCaches = Array.from(this.serverCaches.entries())
          .sort(([, a], [, b]) => a.lastFetched.getTime() - b.lastFetched.getTime());

        const toRemove = sortedCaches.slice(0, this.serverCaches.size - this.maxCacheSize);
        toRemove.forEach(([serverId]) => {
          this.removeServerFromCache(serverId);
          cleanedServers++;
        });
      }

      this.lastCleanup = now;
      
      if (cleanedServers > 0 || cleanedEmojis > 0) {
        debug.log(`🧹 Cache cleanup: removed ${cleanedServers} servers, ${cleanedEmojis} emojis`);
      }
    },

    scheduleCleanup() {
      setInterval(() => {
        this.performCleanup();
      }, 5 * 60 * 1000);
    },

    async refreshServer(serverId: string) {
      debug.log('🔄 Force refreshing emojis for server:', serverId);
      
      this.removeServerFromCache(serverId);
      await this.loadEmojisForServers([serverId]);
    },

    async preloadFrequentEmojis() {
      const frequentEmojis = Array.from(this.globalEmojiIndex.values())
        .filter(entry => entry.accessCount > 5)
        .sort((a, b) => b.accessCount - a.accessCount)
        .slice(0, 50);

      debug.log(`🚀 Preloaded ${frequentEmojis.length} frequent emojis`);
    },

    getEmojiAnalytics() {
      const stats = {
        totalServers: this.serverCaches.size,
        totalEmojis: this.globalEmojiIndex.size,
        mostUsedEmojis: Array.from(this.globalEmojiIndex.values())
          .sort((a, b) => b.accessCount - a.accessCount)
          .slice(0, 10)
          .map(entry => ({
            name: entry.emoji.name,
            usage: entry.accessCount,
            lastUsed: entry.lastAccessed,
          })),
        cachePerformance: {
          hitRate: this.cacheHits / (this.cacheHits + this.cacheMisses) || 0,
          totalRequests: this.cacheHits + this.cacheMisses,
        },
      };

      return stats;
    },

    async invalidate(target: { serverId?: string; emojiId?: string }) {
      if (target.serverId) {
        this.markServerStale(target.serverId);
        await this.loadEmojisForServers([target.serverId]);
      } else if (target.emojiId) {
        const entry = this.globalEmojiIndex.get(target.emojiId);
        if (entry && entry.emoji.server_id) {
          await this.refreshServer(entry.emoji.server_id);
        }
      }
    },

    reset() {
      this.serverCaches.clear();
      this.globalEmojiIndex.clear();
      this.nameIndex.clear();
      this.resolvedEmojis = {};
      this.isInitialized = false;
      this.lastGlobalUpdate = null;
      this.pendingInvalidations.clear();
      this.cacheHits = 0;
      this.cacheMisses = 0;
      
      debug.log('🔄 Emoji cache reset');
    },
  },
});