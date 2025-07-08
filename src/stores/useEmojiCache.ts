import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Emoji, ResolvedEmoji } from '@/types';

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
    // Core cache storage
    serverCaches: new Map<string, ServerEmojiCache>(),
    
    // Global emoji lookup for fast access (emoji_id -> cache_entry)
    globalEmojiIndex: new Map<string, EmojiCacheEntry>(),
    
    // Name-based lookup for autocomplete and parsing (name -> emoji_entries[])
    nameIndex: new Map<string, EmojiCacheEntry[]>(),
    
    // Cross-server resolved emojis (similar to current resolvedEmojiList)
    resolvedEmojis: {} as Record<string, {
      server_name: string;
      server_icon?: string;
      emojis: ResolvedEmoji[];
    }>,
    
    // Cache configuration
    maxCacheAge: 15 * 60 * 1000, // 15 minutes
    maxCacheSize: 100, // Maximum servers to cache
    maxEmojisPerServer: 1000, // Prevent memory issues
    
    // State tracking
    isInitialized: false,
    lastGlobalUpdate: null as Date | null,
    pendingInvalidations: new Set<string>(),
    
    // Performance metrics
    cacheHits: 0,
    cacheMisses: 0,
    lastCleanup: new Date(),
  }),

  getters: {
    // Get cache statistics for debugging
    getCacheStats: (state) => ({
      serverCount: state.serverCaches.size,
      totalEmojis: Array.from(state.serverCaches.values())
        .reduce((sum, cache) => sum + cache.emojis.size, 0),
      hitRate: state.cacheHits / (state.cacheHits + state.cacheMisses) || 0,
      lastCleanup: state.lastCleanup,
    }),

    // Get emojis for a specific server with fallback
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

    // Fast emoji lookup by ID
    getEmojiById: (state) => (emojiId: string): Emoji | null => {
      const entry = state.globalEmojiIndex.get(emojiId);
      if (entry) {
        // Update access statistics
        entry.accessCount++;
        entry.lastAccessed = new Date();
        state.cacheHits++;
        return entry.emoji;
      }
      state.cacheMisses++;
      return null;
    },

    // Search emojis by name across all servers
    searchEmojisByName: (state) => (query: string, limit = 20): ResolvedEmoji[] => {
      const results: ResolvedEmoji[] = [];
      const queryLower = query.toLowerCase();
      
      for (const [name, entries] of state.nameIndex) {
        if (name.toLowerCase().includes(queryLower) && results.length < limit) {
          for (const entry of entries) {
            if (results.length >= limit) break;
            
            const cache = state.serverCaches.get(entry.emoji.server_id);
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
    // Initialize the emoji cache system
    async initialize(userServerIds: string[]) {
      if (this.isInitialized) return;
      
      console.log('🎭 Initializing emoji cache system...');
      
      try {
        // Fetch metadata for all servers to check what needs updating
        await this.fetchAllServerMetadata(userServerIds);
        
        // Load emojis for all user's servers
        await this.loadEmojisForServers(userServerIds);
        
        // Set up real-time subscriptions
        this.setupRealtimeSubscriptions();
        
        // Schedule periodic cleanup
        this.scheduleCleanup();
        
        this.isInitialized = true;
        this.lastGlobalUpdate = new Date();
        
        console.log('✅ Emoji cache initialized successfully');
      } catch (error) {
        console.error('❌ Failed to initialize emoji cache:', error);
        throw error;
      }
    },

    // Fetch metadata for servers to determine what needs updating
    async fetchAllServerMetadata(serverIds: string[]): Promise<Map<string, EmojiMetadata>> {
      const { data, error } = await supabase
        .rpc('get_emoji_metadata_bulk', { server_ids: serverIds });
      
      if (error) {
        console.error('Error fetching emoji metadata:', error);
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

    // Load emojis for multiple servers efficiently
    async loadEmojisForServers(serverIds: string[]) {
      // Determine which servers need updates
      const serversToUpdate = serverIds.filter(serverId => {
        const cache = this.serverCaches.get(serverId);
        return !cache || cache.isStale || this.isCacheExpired(cache);
      });

      if (serversToUpdate.length === 0) {
        console.log('📋 All emoji caches are up to date');
        return;
      }

      console.log(`📥 Loading emojis for ${serversToUpdate.length} servers`);

      // Fetch server details and emojis in parallel
      const [serverDetails, emojiData] = await Promise.all([
        this.fetchServerDetails(serversToUpdate),
        this.fetchEmojisForServers(serversToUpdate),
      ]);

      // Process and cache the data
      for (const serverId of serversToUpdate) {
        const server = serverDetails.get(serverId);
        const emojis = emojiData.get(serverId) || [];
        
        this.updateServerCache(serverId, emojis, server);
      }

      // Rebuild resolved emojis
      this.rebuildResolvedEmojis();
    },

    // Fetch server details for caching
    async fetchServerDetails(serverIds: string[]): Promise<Map<string, any>> {
      const { data, error } = await supabase
        .from('servers')
        .select('id, name, icon, allow_cross_server_emojis')
        .in('id', serverIds);

      if (error) {
        console.error('Error fetching server details:', error);
        return new Map();
      }

      const serverMap = new Map();
      data.forEach(server => serverMap.set(server.id, server));
      return serverMap;
    },

    // Fetch emojis for multiple servers
    async fetchEmojisForServers(serverIds: string[]): Promise<Map<string, Emoji[]>> {
      const { data, error } = await supabase
        .from('emojis')
        .select('*')
        .in('server_id', serverIds)
        .order('name');

      if (error) {
        console.error('Error fetching emojis:', error);
        return new Map();
      }

      const emojiMap = new Map<string, Emoji[]>();
      data.forEach((emoji: Emoji) => {
        if (!emojiMap.has(emoji.server_id)) {
          emojiMap.set(emoji.server_id, []);
        }
        emojiMap.get(emoji.server_id)!.push(emoji);
      });

      return emojiMap;
    },

    // Update cache for a specific server
    updateServerCache(serverId: string, emojis: Emoji[], serverDetails?: any) {
      // Remove old cache if it exists
      this.removeServerFromCache(serverId);

      // Create new cache entry
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
        
        // Update global indices
        this.globalEmojiIndex.set(emoji.id, entry);
        
        // Update name index
        if (!this.nameIndex.has(emoji.name)) {
          this.nameIndex.set(emoji.name, []);
        }
        this.nameIndex.get(emoji.name)!.push(entry);
      });

      // Create server cache
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
      
      console.log(`📦 Cached ${emojis.length} emojis for server: ${serverCache.serverName}`);
    },

    // Remove server from all caches
    removeServerFromCache(serverId: string) {
      const cache = this.serverCaches.get(serverId);
      if (!cache) return;

      // Remove from global index
      for (const entry of cache.emojis.values()) {
        this.globalEmojiIndex.delete(entry.emoji.id);
        
        // Remove from name index
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
    },

    // Rebuild the resolved emojis structure for components
    rebuildResolvedEmojis() {
      const resolved: Record<string, {
        server_name: string;
        server_icon?: string;
        emojis: ResolvedEmoji[];
      }> = {};

      // Handle naming conflicts across servers
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
      console.log('🔄 Rebuilt resolved emojis for', Object.keys(resolved).length, 'servers');
    },

    // Handle real-time emoji updates
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

    // Handle emoji insertion
    async handleEmojiInsert(emoji: Emoji) {
      const cache = this.serverCaches.get(emoji.server_id);
      if (!cache) {
        // Server not in cache, might need to reload
        this.markServerStale(emoji.server_id);
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
      console.log('➕ Added new emoji to cache:', emoji.name);
    },

    // Handle emoji updates - distinct from handleEmojiUpdate to avoid recursion
    async handleEmojiUpdateEntry(emoji: Emoji) {
      const cache = this.serverCaches.get(emoji.server_id);
      if (!cache) {
        // Server not in cache, might need to reload
        this.markServerStale(emoji.server_id);
        return;
      }

      const existingEntry = cache.emojis.get(emoji.id);
      if (existingEntry) {
        // Remove old name index entry if name changed
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

          // Add new name index entry
          if (!this.nameIndex.has(emoji.name)) {
            this.nameIndex.set(emoji.name, []);
          }
          this.nameIndex.get(emoji.name)!.push(existingEntry);
        }

        // Update the cache entry with new emoji data
        existingEntry.emoji = emoji;
        existingEntry.lastUpdated = new Date();
        
        // Update global index
        this.globalEmojiIndex.set(emoji.id, existingEntry);

        this.rebuildResolvedEmojis();
        console.log('🔄 Updated emoji in cache:', emoji.name);
      } else {
        // Entry doesn't exist, treat as insert
        await this.handleEmojiInsert(emoji);
      }
    },

    // Handle emoji deletion
    async handleEmojiDelete(emoji: Emoji) {
      const cache = this.serverCaches.get(emoji.server_id);
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
        console.log('➖ Removed emoji from cache:', emoji.name);
      }
    },

    // Mark a server cache as stale
    markServerStale(serverId: string) {
      const cache = this.serverCaches.get(serverId);
      if (cache) {
        cache.isStale = true;
        this.pendingInvalidations.add(serverId);
      }
    },

    // Check if cache is expired
    isCacheExpired(cache: ServerEmojiCache): boolean {
      const now = new Date();
      return (now.getTime() - cache.lastFetched.getTime()) > this.maxCacheAge;
    },

    // Set up real-time subscriptions for emoji changes
    setupRealtimeSubscriptions() {
      // Subscribe to emoji table changes
      supabase
        .channel('emoji-changes')
        .on(
          'postgres_changes',
          { event: '*', schema: 'public', table: 'emojis' },
          (payload) => {
            this.handleEmojiUpdate(payload);
          }
        )
        .subscribe();

      console.log('🔔 Set up real-time emoji subscriptions');
    },

    // Cleanup expired cache entries and optimize memory
    performCleanup() {
      const now = new Date();
      let cleanedServers = 0;
      const cleanedEmojis = 0;

      // Remove expired server caches
      for (const [serverId, cache] of this.serverCaches) {
        if (this.isCacheExpired(cache)) {
          this.removeServerFromCache(serverId);
          cleanedServers++;
        }
      }

      // If we're over the cache size limit, remove least recently used
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
        console.log(`🧹 Cache cleanup: removed ${cleanedServers} servers, ${cleanedEmojis} emojis`);
      }
    },

    // Schedule periodic cleanup
    scheduleCleanup() {
      setInterval(() => {
        this.performCleanup();
      }, 5 * 60 * 1000); // Every 5 minutes
    },

    // Force refresh a server's emojis
    async refreshServer(serverId: string) {
      console.log('🔄 Force refreshing emojis for server:', serverId);
      
      this.removeServerFromCache(serverId);
      await this.loadEmojisForServers([serverId]);
    },

    // Preload emojis for better performance
    async preloadFrequentEmojis() {
      // Get most accessed emojis and ensure they're cached
      const frequentEmojis = Array.from(this.globalEmojiIndex.values())
        .filter(entry => entry.accessCount > 5)
        .sort((a, b) => b.accessCount - a.accessCount)
        .slice(0, 50);

      console.log(`🚀 Preloaded ${frequentEmojis.length} frequent emojis`);
    },

    // Get emoji statistics for analytics
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

    // Invalidate specific emojis or servers
    async invalidate(target: { serverId?: string; emojiId?: string }) {
      if (target.serverId) {
        this.markServerStale(target.serverId);
        await this.loadEmojisForServers([target.serverId]);
      } else if (target.emojiId) {
        // Refresh the server containing this emoji
        const entry = this.globalEmojiIndex.get(target.emojiId);
        if (entry) {
          await this.refreshServer(entry.emoji.server_id);
        }
      }
    },

    // Reset entire cache
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
      
      console.log('🔄 Emoji cache reset');
    },
  },
});