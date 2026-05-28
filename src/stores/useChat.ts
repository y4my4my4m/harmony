import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { services } from '@/services';
import type { Message, ChannelCache, CacheMetadata, Emoji, MessagePart } from '@/types';
import { useReactionsStore } from '@/stores/useReactions';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils';
import { processMessageDecryption } from '@/utils/messageDecryption';
import { debug } from '@/utils/debug';
import { realtimeConnectionManager, type ConnectionStatus } from '@/services/RealtimeConnectionManager';

// import { getEmoji } from '@/services/emojiService';
export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as Message[],
    currentSubscription: null as any | null,
    loadingOlderMessages: false,
    allMessagesLoaded: false,
    
    // Professional caching system
    messageCache: new Map<string, ChannelCache>(),
    cacheValidityDuration: 5 * 60 * 1000, // 5 minutes
    maxCacheSize: 50, // Maximum number of channels to cache
    currentChannelId: null as string | null,
    /** Channel id bound to `currentSubscription` (may differ from `currentChannelId` during navigation). */
    realtimeChannelId: null as string | null,

    // Cache for individual reply messages (bounded to prevent unbounded growth)
    replyMessageCache: new Map<string, Message>(),
    maxReplyCacheSize: 200,
    fetchingReplyMessages: new Set<string>(),
    
    // Jump-to-message functionality
    jumpedToMessages: new Map<string, Message>(),
    messageGaps: new Set<string>(), // Track where gaps should be shown
    
    // Connection status (managed by RealtimeConnectionManager)
    connectionStatus: 'disconnected' as ConnectionStatus,
  }),
  actions: {
    clearMessages() {
      this.messages = [];
      this.allMessagesLoaded = false;
      // Clear jumped messages and gaps when clearing messages
      this.clearJumpedMessages();
    },

    // Fetch individual message (for replies that aren't in current message list)
    async fetchReplyMessage(messageId: string): Promise<Message | null> {
      // Check if already cached
      if (this.replyMessageCache.has(messageId)) {
        return this.replyMessageCache.get(messageId)!;
      }

      // Check if already being fetched
      if (this.fetchingReplyMessages.has(messageId)) {
        // Wait for the existing fetch to complete
        return new Promise((resolve) => {
          const checkCache = () => {
            if (this.replyMessageCache.has(messageId)) {
              resolve(this.replyMessageCache.get(messageId)!);
            } else if (!this.fetchingReplyMessages.has(messageId)) {
              resolve(null);
            } else {
              setTimeout(checkCache, 50);
            }
          };
          checkCache();
        });
      }

      this.fetchingReplyMessages.add(messageId);

      try {
        const { data: message, error } = await supabase
          .from('messages')
          .select('*')
          .eq('id', messageId)
          .single();

        if (error || !message) {
          debug.error('Error fetching reply message:', error);
          return null;
        }

        // Note: Reactions are now loaded via batch loading in MessageService
        // Individual fetches removed for performance

        this.replyMessageCache.set(messageId, message);
        if (this.replyMessageCache.size > this.maxReplyCacheSize) {
          const oldestKey = this.replyMessageCache.keys().next().value;
          if (oldestKey) this.replyMessageCache.delete(oldestKey);
        }
        return message;
      } catch (error) {
        debug.error('Error fetching reply message:', error);
        return null;
      } finally {
        this.fetchingReplyMessages.delete(messageId);
      }
    },

    // Load cached messages instantly (synchronous)
    loadCachedMessages(channelId: string) {
      const cached = this.messageCache.get(channelId);
      if (cached) {
        debug.log(`Loading cached messages instantly: ${channelId}`);
        this.messages = [...cached.messages];
        this.allMessagesLoaded = cached.allMessagesLoaded;
        this.currentChannelId = channelId;
      }
    },

    // Check if message is cached (for skeleton display logic)
    isMessageCached(channelId: string): boolean {
      if (!this.messageCache.has(channelId)) return false;
      
      const cached = this.messageCache.get(channelId)!;
      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
      
      // Cache is valid if less than 5 minutes old
      return cacheAge < this.cacheValidityDuration;
    },

    // Enhanced cache validation that checks both age and message modifications
    async isChannelCacheValid(channelId: string): Promise<boolean> {
      const cached = this.messageCache.get(channelId);
      if (!cached) return false;

      // Check age-based validity first (quick local check)
      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
      if (cacheAge > this.cacheValidityDuration) return false;

      // For recent caches, also check if any messages have been updated
      try {
        const { data: latestMessage, error } = await supabase
          .from('messages')
          .select('updated_at, created_at')
          .eq('channel_id', channelId)
          .order('updated_at', { ascending: false })
          .limit(1);

        if (error || !latestMessage || latestMessage.length === 0) {
          // If we can't fetch latest message info, assume cache is still valid
          return true;
        }

        const latestModification = new Date(latestMessage[0].updated_at || latestMessage[0].created_at);
        
        // Cache is invalid if any message was modified after our cache was created
        return latestModification <= cached.lastFetchedAt;
      } catch (error) {
        debug.error('Error validating cache:', error);
        // On error, assume cache is still valid to avoid unnecessary refetches
        return true;
      }
    },

    // Get cache metadata from server to check if local cache is stale
    async getCacheMetadata(channelId: string): Promise<CacheMetadata | null> {
      try {
        const { data, error } = await supabase
          .from('messages')
          .select('created_at, updated_at')
          .eq('channel_id', channelId)
          .order('created_at', { ascending: false })
          .limit(1);

        if (error || !data || data.length === 0) return null;

        const { count } = await supabase
          .from('messages')
          .select('*', { count: 'exact', head: true })
          .eq('channel_id', channelId);

        const lastMessage = data[0];
        return {
          channelId,
          lastModified: new Date(lastMessage.updated_at || lastMessage.created_at),
          messageCount: count || 0,
        };
      } catch (error) {
        debug.error('Error fetching cache metadata:', error);
        return null;
      }
    },

    // Check if cached data is valid
    isCacheValid(channelId: string, serverMetadata?: CacheMetadata): boolean {
      const cached = this.messageCache.get(channelId);
      if (!cached) return false;

      // Check age-based validity
      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
      if (cacheAge > this.cacheValidityDuration) return false;

      // Check server-side modifications if metadata provided
      if (serverMetadata && cached.lastModified) {
        return serverMetadata.lastModified <= cached.lastModified;
      }

      return true;
    },

    // Evict oldest cache entries when limit exceeded
    evictOldestCache() {
      if (this.messageCache.size <= this.maxCacheSize) return;

      let oldestTime = new Date();
      let oldestChannelId = '';

      this.messageCache.forEach((cache, channelId) => {
        if (cache.lastFetchedAt < oldestTime) {
          oldestTime = cache.lastFetchedAt;
          oldestChannelId = channelId;
        }
      });

      if (oldestChannelId) {
        this.messageCache.delete(oldestChannelId);
        debug.log(`Evicted cache for channel: ${oldestChannelId}`);
      }
    },

    // Load messages with intelligent caching
    async fetchMessages(channelId: string, oldestMessageId: string = '', signal?: AbortSignal) {
      if (this.loadingOlderMessages && oldestMessageId !== '') return;

      // Set currentChannelId immediately so stale-response guards work correctly
      if (oldestMessageId === '' && this.currentChannelId !== channelId) {
        this.currentChannelId = channelId;
      }

      // For initial load, check cache first - make this synchronous for instant loading
      if (oldestMessageId === '') {
        // Simple time-based cache validation (no async database calls)
        if (this.messageCache.has(channelId)) {
          const cached = this.messageCache.get(channelId)!;
          const now = new Date();
          const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
          
          debug.log(`📦 Found cache for channel ${channelId}, age: ${Math.round(cacheAge / 1000)}s, valid: ${cacheAge < this.cacheValidityDuration}`);
          
          // If cache is less than 5 minutes old, use it instantly
          if (cacheAge < this.cacheValidityDuration) {
            debug.log(`✅ Loading ${cached.messages.length} messages from cache instantly (cache is fresh)`);
            this.messages = [...cached.messages];
            this.allMessagesLoaded = cached.allMessagesLoaded;
            this.currentChannelId = channelId;
            // Return immediately - truly instant loading
            return;
          } else {
            debug.log(`⚠️ Cache is stale (${Math.round(cacheAge / 1000)}s old), fetching from database`);
          }
        } else {
          debug.log(`📭 No cache found for channel ${channelId}, fetching from database`);
        }
      }

      // Only set loading state for non-cached messages
      this.loadingOlderMessages = true;
      
      try {
        debug.log('🔄 Loading messages via MessageService:', { channelId, oldestMessageId });
        
        // Use services.messages for consistent loading with service layer
        // Determine cursor for pagination (before timestamp)
        let beforeTimestamp: string | undefined;
        if (oldestMessageId !== '') {
          // Get the timestamp of the oldest message for pagination
          const oldestMessage = this.messages.find(m => m.id === oldestMessageId);
          if (oldestMessage) {
            // Handle both Date objects and ISO strings. `created_at` is typed
            // as `Date` but legacy code paths sometimes pass through ISO strings.
            const ts: unknown = oldestMessage.created_at;
            beforeTimestamp = ts instanceof Date
              ? ts.toISOString()
              : (typeof ts === 'string' ? ts : undefined);
            debug.log('📅 Using timestamp for pagination:', beforeTimestamp);
          }
        }
        
        debug.log('📤 Loading older messages with params:', { channelId, limit: 20, beforeTimestamp });
        
        const { messages, hasMore } = await services.messages.loadChannelMessages(
          channelId,
          {
            limit: 20,
            before: beforeTimestamp,
            signal
          }
        );

        debug.log('✅ Service returned:', { messageCount: messages?.length || 0, hasMore });

        // Process URL embeds asynchronously (non-blocking)
        try {
          ensureMessageEmbeds(messages);
        } catch (error) {
          debug.warn('Failed to prepare message embeds:', error);
        }

        // Check if request was cancelled or channel changed while fetching.
        // BUGS.md H34: previously the stale-channel guard only ran on the
        // INITIAL load (`oldestMessageId === ''`). Pagination requests
        // (`oldestMessageId !== ''`) had no guard, so switching channels
        // mid-`fetchOlderMessages` would prepend channel A's history into
        // channel B's `messages` array and corrupt the cache.
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        if (this.currentChannelId !== channelId) {
          debug.log(`⏭️ Discarding stale response for channel ${channelId} (current: ${this.currentChannelId})`);
          return;
        }

        if (!messages || messages.length === 0) {
          debug.log('📭 No older messages found');
          this.allMessagesLoaded = true;
          
          // IMPORTANT: Still set currentChannelId for empty channels!
          // This ensures real-time messages will be received correctly
          if (oldestMessageId === '' && this.currentChannelId !== channelId) {
            this.currentChannelId = channelId;
            this.messages = []; // Clear any stale messages
            
            // Create an empty cache entry so real-time messages can be added
            this.messageCache.set(channelId, {
              messages: [],
              lastFetchedAt: new Date(),
              oldestMessageId: null,
              allMessagesLoaded: true,
              lastModified: new Date(),
            });
            debug.log(`✅ Initialized empty cache for new channel: ${channelId}`);
          }
          return;
        }
        
        // Get reactions store instance
        const reactionsStore = useReactionsStore();
        
        // Extract unique user IDs from messages and pre-load profiles
        // Service already loads user profiles, but we pre-load for consistency
        const userIds = new Set<string>();
        messages.forEach(message => {
          if (message?.user_id) {
            userIds.add(message.user_id);
          }
        });
        
        // Pre-load all user profiles before updating messages
        // This ensures no "Loading..." appears in message display
        if (userIds.size > 0) {
          const serverUsersStore = useServerUsersStore();
          await serverUsersStore.fetchMultipleUserProfiles(Array.from(userIds));
        }
        
        // ✅ PERFORMANCE FIX: Reactions are already loaded by MessageService
        // Components should use message.reactions directly instead of fetching

        // Service returns messages in chronological order (oldest first after reversing)
        const olderMessages = messages;
        const allLoaded = !hasMore;

        debug.log('📦 Processing messages:', { count: olderMessages.length, allLoaded, isInitialLoad: oldestMessageId === '' });

        if (oldestMessageId === '') {
          // Initial load - merge with any messages received via realtime
          // during the fetch to prevent losing them.
          const realtimeOnly = this.messages.filter(
            (m: Message) => m.channel_id === channelId && !olderMessages.some((om: Message) => om.id === m.id)
          );
          if (realtimeOnly.length > 0) {
            debug.log(`🔀 Merging ${realtimeOnly.length} realtime messages received during history fetch`);
          }
          const merged = [...olderMessages, ...realtimeOnly];
          merged.sort((a: Message, b: Message) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
          this.messages = merged;
          this.allMessagesLoaded = allLoaded;
          
          // Only update currentChannelId if it's actually different to prevent recursive loops
          if (this.currentChannelId !== channelId) {
            this.currentChannelId = channelId;
          }

          // Update cache
          this.evictOldestCache();
          this.messageCache.set(channelId, {
            messages: [...merged],
            lastFetchedAt: new Date(),
            oldestMessageId: merged[0]?.id || null,
            allMessagesLoaded: allLoaded,
            lastModified: new Date(),
          });

          debug.log(`✅ Initial load: Cached ${merged.length} messages for channel`);
        } else {
          // Loading older messages - PREPEND to current (older messages go BEFORE)
          debug.log(`📤 Prepending ${olderMessages.length} older messages to ${this.messages.length} current messages`);
          this.messages = [...olderMessages, ...this.messages];
          this.allMessagesLoaded = allLoaded;

          // Update cache with new older messages
          const cached = this.messageCache.get(channelId);
          if (cached) {
            cached.messages = [...olderMessages, ...cached.messages];
            cached.oldestMessageId = olderMessages[0]?.id || cached.oldestMessageId;
            cached.allMessagesLoaded = allLoaded;
            cached.lastFetchedAt = new Date();
          }
          
          debug.log(`✅ Pagination: Now have ${this.messages.length} total messages, allLoaded: ${allLoaded}`);
        }
      } catch (error: any) {
        if (error.message === 'Request aborted') {
          throw new Error('AbortError');
        }
        throw error;
      } finally {
        this.loadingOlderMessages = false;
      }
    },

    // Update cache when new message arrives via real-time
    addMessageToCache(message: Message) {
      try {
        ensureMessageEmbeds(message);
      } catch (error) {
        debug.warn('Failed to prepare embeds for realtime message:', error);
      }
      // Skip DM messages - they should be handled by the DM store
      if (!message.channel_id || message.conversation_id) {
        debug.log('Skipping DM message in chat store - should be handled by DM store');
        return;
      }

      debug.log('🔄 Adding message to cache via real-time:', {
        messageId: message.id,
        channelId: message.channel_id,
        currentChannelId: this.currentChannelId,
        match: this.currentChannelId === message.channel_id
      });

      // Add to current messages if it's the current channel
      if (this.currentChannelId === message.channel_id) {
        if (!this.messages.some(msg => msg.id === message.id)) {
          this._insertMessageSorted(this.messages, message);
          debug.log('✅ Real-time message added to current messages:', message.id);
        } else {
          debug.log('⚠️ Message already exists in current messages:', message.id);
        }
      } else {
        debug.log('🔍 Message not for current channel:', {
          messageChannelId: message.channel_id,
          currentChannelId: this.currentChannelId
        });
      }

      // Update cache
      const cached = this.messageCache.get(message.channel_id);
      if (cached) {
        if (!cached.messages.some(msg => msg.id === message.id)) {
          this._insertMessageSorted(cached.messages, message);
          cached.lastModified = new Date();
          debug.log('✅ Real-time message added to cache:', message.id);
        }
      } else {
        debug.log('⚠️ No cache found for channel:', message.channel_id);
      }
    },

    /**
     * Insert a message into a sorted array by created_at.
     * Most realtime messages are newest and will be appended (O(1) fast path).
     * Older messages (e.g. arriving after reconnect) are binary-inserted.
     */
    _insertMessageSorted(arr: Message[], msg: Message) {
      const msgTime = new Date(msg.created_at).getTime();
      // Fast path: message is newer than the last element (most common)
      if (arr.length === 0 || new Date(arr[arr.length - 1].created_at).getTime() <= msgTime) {
        arr.push(msg);
        return;
      }
      // Binary search for insertion point
      let lo = 0, hi = arr.length;
      while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        if (new Date(arr[mid].created_at).getTime() <= msgTime) {
          lo = mid + 1;
        } else {
          hi = mid;
        }
      }
      arr.splice(lo, 0, msg);
    },

    async reprocessEncryptedMessages(roomId?: string) {
      try {
        // If roomId provided, only reprocess that room's messages
        if (roomId) {
          if (this.currentChannelId === roomId && this.messages.length > 0) {
            const hasEncrypted = this.messages.some((m: Message) => m.encrypted && !m.decrypted);
            if (hasEncrypted) {
              this.messages = await processMessageDecryption(this.messages);
            }
          }
          const cache = this.messageCache.get(roomId);
          if (cache?.messages?.length) {
            const hasEncrypted = cache.messages.some((m: Message) => m.encrypted && !m.decrypted);
            if (hasEncrypted) {
              cache.messages = await processMessageDecryption(cache.messages);
            }
          }
          return;
        }

        // Fallback: reprocess all
        if (this.messages.length > 0) {
          const hasEncrypted = this.messages.some((m: Message) => m.encrypted && !m.decrypted);
          if (hasEncrypted) {
            this.messages = await processMessageDecryption(this.messages);
          }
        }
        for (const cache of this.messageCache.values()) {
          if (cache.messages?.length) {
            const hasEncrypted = cache.messages.some((m: Message) => m.encrypted && !m.decrypted);
            if (hasEncrypted) {
              cache.messages = await processMessageDecryption(cache.messages);
            }
          }
        }
      } catch (error) {
        debug.warn('Failed to reprocess encrypted messages:', error);
      }
    },

    setupEncryptionKeyListener() {
      if ((this as any)._keyListenerActive) return;
      (this as any)._keyListenerActive = true;

      const handler = async (e: Event) => {
        const detail = (e as CustomEvent).detail;
        const roomId = detail?.roomId as string | undefined;
        debug.log(`🔑 Key received${roomId ? ` for room ${roomId.substring(0, 8)}...` : ''} - re-decrypting`);
        await this.reprocessEncryptedMessages(roomId);
      };
      (this as any)._keyListenerHandler = handler;
      window.addEventListener('megolm-key-received', handler);
    },

    cleanupEncryptionKeyListener() {
      if (!(this as any)._keyListenerActive) return;
      if ((this as any)._keyListenerHandler) {
        window.removeEventListener('megolm-key-received', (this as any)._keyListenerHandler);
        (this as any)._keyListenerHandler = null;
      }
      (this as any)._keyListenerActive = false;
    },

    // Update cache when message is edited
    updateMessageInCache(messageId: string, updatedMessage: Message) {
      // Update current messages
      const currentIndex = this.messages.findIndex(msg => msg.id === messageId);
      if (currentIndex !== -1) {
        this.messages[currentIndex] = updatedMessage;
      }

      // Update all relevant caches
      this.messageCache.forEach((cache) => {
        const cacheIndex = cache.messages.findIndex(msg => msg.id === messageId);
        if (cacheIndex !== -1) {
          cache.messages[cacheIndex] = updatedMessage;
          cache.lastModified = new Date();
        }
      });

      try {
        // `ensureMessageEmbeds` takes a single argument now.
        ensureMessageEmbeds(updatedMessage);
      } catch (error) {
        debug.warn('Failed to refresh embeds for updated message:', error);
      }
    },

    // Remove message from cache
    removeMessageFromCache(messageId: string) {
      // Remove from current messages
      this.messages = this.messages.filter(msg => msg.id !== messageId);

      // Remove from all caches
      this.messageCache.forEach((cache) => {
        cache.messages = cache.messages.filter(msg => msg.id !== messageId);
        cache.lastModified = new Date();
      });
    },

    // Clear cache for specific channel
    invalidateChannelCache(channelId: string) {
      this.messageCache.delete(channelId);
      debug.log(`Invalidated cache for channel: ${channelId}`);
    },

    clearAllCaches() {
      this.messageCache.clear();
      this.replyMessageCache.clear();
      this.fetchingReplyMessages.clear();
      this.jumpedToMessages.clear();
      this.messageGaps.clear();
      debug.log('Cleared all message caches');
    },

    async editMessage(messageId: string, content: MessagePart[]) {
      try {
        debug.log('🔄 Editing message via MessageService:', messageId);
        
        // Find the current message to get its data
        const currentMessage = this.messages.find(msg => msg.id === messageId);
        if (!currentMessage) {
          debug.error('❌ Message not found in current messages:', messageId);
          return;
        }
        
        // Use services.messages for consistent editing with service layer
        const updatedMessage = await services.messages.editMessage(messageId, content);
        
        // IMPORTANT: Preserve existing reactions and other computed fields
        // Service may not return all computed fields
        const messageWithReactions = {
          ...updatedMessage,
          reactions: currentMessage.reactions || [],
        };
        
        this.updateMessageInCache(messageId, messageWithReactions);
        debug.log('✅ Message edited via service layer');
        
      } catch (error: any) {
        debug.error('❌ Error editing message via service:', error);
        throw new Error(error.message || 'Failed to edit message');
      }
    },

    async deleteMessage(messageId: string) {
      try {
        debug.log('🔄 Deleting message via MessageService:', messageId);
        
        // Use services.messages for consistent deletion with service layer
        await services.messages.deleteMessage(messageId);
        
        // Remove from local cache (service handles database deletion)
        this.removeMessageFromCache(messageId);
        debug.log('✅ Message deleted via service layer');
      } catch (error: any) {
        debug.error('❌ Error deleting message via service:', error);
        throw new Error(error.message || 'Failed to delete message');
      }
    },

    async sendMessage(
      serverId: string,
      channelId: string,
      userId: string,
      content: Array<Object>,
      replyTo: string,
      extraMetadata?: Record<string, any>,
      options?: { allowPlaintextFallback?: boolean }
    ) {
      // Create optimistic message
      const tempId = `temp-${Date.now()}`;
      const optimisticMessage = {
        id: tempId,
        created_at: new Date(),
        channel_id: channelId,
        user_id: userId,
        content: content as any,
        reply_to: replyTo || undefined,
        sending: true
      };
      
      // Add optimistic message to display immediately
      this.addMessageToCache(optimisticMessage as any);
      
      try {
        debug.log('🔄 Sending message via MessageService:', { channelId, userId });
        
        // Use services.messages for consistent sending with service layer
        const message = await services.messages.sendChannelMessage(
          serverId,
          channelId, 
          content as any, // MessagePart[]
          replyTo || undefined,
          extraMetadata,
          options
        );
        
        debug.log('✅ Message saved to database:', message.id);
        debug.log('📦 Message data from server:', message);
        
        this._replaceTempWithReal(tempId, message, userId, channelId, content);
        
        return message;
      } catch (error: any) {
        debug.error('❌ Error sending message via service:', error);

        // Encryption policy errors are NOT transient. Auto-retrying would either
        // (a) keep failing for the same reason or (b) silently bypass the
        // fail-closed policy. Surface immediately so the UI can ask the user
        // whether to send unencrypted.
        //
        // We *remove* the optimistic instead of marking it failed: if the
        // user accepts the fallback prompt, the UI will re-call this method
        // with `allowPlaintextFallback: true`, which creates a fresh
        // optimistic. Leaving the original as a "failed" message in the
        // timeline made it look like the message had been sent and rejected,
        // which is what BUGS.md flagged after the user pressed Cancel.
        const code = (error?.code || error?.message || '').toString();
        const isEncryptionPolicyError =
          code.includes('ENCRYPTION_REQUIRED') ||
          code.includes('ENCRYPTION_LOCKED') ||
          code.includes('ENCRYPTION_UNAVAILABLE') ||
          code.includes('ENCRYPTION_FAILED_NO_FALLBACK')
        if (isEncryptionPolicyError) {
          this.removeMessageFromCache(tempId);
          throw error;
        }

        // Length-limit and structural validation errors are also not
        // transient — retrying with the same payload will fail the same
        // way. Drop the optimistic message and surface the error so the
        // UI can show "message too long" instead of two doomed retries.
        const isPermanentValidationError =
          code.includes('MESSAGE_TOO_LONG') ||
          code.includes('TOO_MANY_ATTACHMENTS') ||
          // PostgreSQL CHECK constraint violation (messages_text_length_check)
          code.includes('messages_text_length_check') ||
          // Generic CHECK constraint failure on messages.content
          (code.includes('check constraint') && code.includes('messages_'))
        if (isPermanentValidationError) {
          this.removeMessageFromCache(tempId);
          throw error;
        }

        // If offline, mark failed immediately - no point retrying
        if (!navigator.onLine) {
          debug.log('📴 Offline - marking message as failed, will retry when user clicks Retry');
          this._markMessageFailed(tempId);
          return;
        }

        // Auto-retry up to 2 times with exponential backoff (service call only, no new optimistic msg)
        for (let attempt = 1; attempt <= 2; attempt++) {
          const delay = Math.pow(2, attempt) * 1000;
          debug.log(`🔁 Auto-retrying message send in ${delay}ms (attempt ${attempt}/2)`);
          await new Promise(r => setTimeout(r, delay));

          if (!navigator.onLine) {
            debug.log('📴 Went offline during retry - marking as failed');
            break;
          }

          try {
            const retryResult = await services.messages.sendChannelMessage(
              serverId, channelId, content as any, replyTo || undefined, extraMetadata, options
            );
            this._replaceTempWithReal(tempId, retryResult, userId, channelId, content);
            return retryResult;
          } catch (retryError) {
            debug.warn(`🔁 Retry attempt ${attempt} failed:`, retryError);
          }
        }

        this._markMessageFailed(tempId);
      }
    },

    _markMessageFailed(tempId: string) {
      const idx = this.messages.findIndex((m: any) => m.id === tempId);
      if (idx !== -1) {
        this.messages[idx] = { ...this.messages[idx], sending: false, failed: true } as any;
      }

      this.messageCache.forEach((cache) => {
        const cacheIdx = cache.messages.findIndex((m: any) => m.id === tempId);
        if (cacheIdx !== -1) {
          cache.messages[cacheIdx] = { ...cache.messages[cacheIdx], sending: false, failed: true } as any;
          cache.lastModified = new Date();
        }
      });
    },

    _replaceTempWithReal(tempId: string, message: any, userId: string, channelId: string, content: any) {
      const tempIndex = this.messages.findIndex((m: any) => m.id === tempId);
      if (tempIndex === -1) return;

      const isOwnEncrypted = message.encrypted && message.user_id === userId;
      const realMessage = {
        id: message.id,
        user_id: message.user_id,
        content: isOwnEncrypted ? content : message.content,
        created_at: new Date(message.created_at),
        channel_id: message.channel_id,
        reply_to: message.reply_to,
        reactions: message.reactions || [],
        is_system: message.is_system,
        metadata: message.metadata || undefined,
        encrypted: message.encrypted || false,
        decrypted: isOwnEncrypted ? true : (message.decrypted || false),
        encryption_metadata: message.encryption_metadata
      };

      try { ensureMessageEmbeds(realMessage); } catch { /* embeds are best-effort */ }

      this.messages.splice(tempIndex, 1, realMessage as any);
      debug.log('✅ Replaced temp message with real message:', { tempId, realId: message.id });

      const cached = this.messageCache.get(channelId);
      if (cached) {
        const cacheIndex = cached.messages.findIndex((m: any) => m.id === tempId);
        if (cacheIndex !== -1) {
          cached.messages.splice(cacheIndex, 1, realMessage as any);
          cached.lastModified = new Date();
        }
      }
    },

    async retryMessage(tempId: string, serverId: string, channelId: string, userId: string, content: Array<Object>, replyTo: string) {
      const idx = this.messages.findIndex((m: any) => m.id === tempId);
      if (idx === -1) return;

      this.messages[idx] = { ...this.messages[idx], sending: true, failed: false } as any;

      try {
        const message = await services.messages.sendChannelMessage(
          serverId, channelId, content as any, replyTo || undefined
        );
        this._replaceTempWithReal(tempId, message, userId, channelId, content);
      } catch (error) {
        debug.error('❌ Retry failed:', error);
        this._markMessageFailed(tempId);
      }
    },

    discardFailedMessage(tempId: string) {
      this.removeMessageFromCache(tempId);
    },

    async addReaction(messageId: string, emojiId: string, userId: string, emojiData?: Emoji) {
      try {
        // Use the reactions store for consistent handling
        const reactionsStore = useReactionsStore();
        const result = await reactionsStore.toggleReaction(messageId, emojiId, userId, emojiData);
        
        if (result.success) {
          // debug.log('🎯 Reaction successfully toggled');
        } else if (result.reason === 'duplicate_request') {
          // debug.log('🎯 Reaction toggle skipped (duplicate request prevented)');
        } else {
          debug.error('🎯 Failed to toggle reaction:', (result as any).message || result.reason);
        }
      } catch (e) {
        debug.error('Error during reaction toggle:', e);
      }
    },

    /**
     * Subscribe to real-time messages for a channel using RealtimeConnectionManager
     * Handles INSERT, UPDATE, DELETE events with automatic reconnection
     */
    _teardownChannelRealtime(): void {
      if (this.currentSubscription) {
        if (typeof this.currentSubscription === 'function') {
          this.currentSubscription();
        } else {
          this.currentSubscription.unsubscribe?.();
        }
        this.currentSubscription = null;
      }
      if (this.realtimeChannelId) {
        realtimeConnectionManager.unsubscribe(`channel-reactions-${this.realtimeChannelId}`);
        realtimeConnectionManager.unsubscribe(`channel-messages-${this.realtimeChannelId}`);
      }
      this.realtimeChannelId = null;
    },

    subscribeToMessages(channelId: string) {
      const channelName = `channel-messages-${channelId}`;
      const reactionsChannelName = `channel-reactions-${channelId}`;
      const hasMessagesSub = realtimeConnectionManager.hasSubscription(channelName);
      const hasReactionsSub = realtimeConnectionManager.hasSubscription(reactionsChannelName);
      const boundToThisChannel = this.realtimeChannelId === channelId;

      // Require BOTH subscriptions AND a matching binding. `currentChannelId` is
      // updated early for UI/stale guards, so it must NOT drive teardown - that
      // left the previous channel's realtime active when switching channels.
      if (hasMessagesSub && hasReactionsSub && boundToThisChannel && this.currentSubscription) {
        debug.log('📡 Already subscribed to channel + reactions:', channelName);
        return;
      }

      const reactionsStore = useReactionsStore();

      if (hasMessagesSub && !hasReactionsSub && boundToThisChannel) {
        debug.log('📡 Messages subscription exists but reactions missing - re-attaching reactions for:', channelId);
        this.setupEncryptionKeyListener();
        this._subscribeToChannelReactions(channelId, reactionsChannelName, reactionsStore);
        this.realtimeChannelId = channelId;
        return;
      }

      // Stale binding or orphaned subs from a prior channel - rebuild cleanly.
      if (this.currentSubscription || this.realtimeChannelId) {
        debug.log('🔄 Tearing down previous realtime channel:', this.realtimeChannelId, '→', channelId);
        this._teardownChannelRealtime();
      }

      debug.log('🔔 Setting up real-time subscription for channel:', channelId);

      const store = this; // Capture store reference for handlers

      // Ensure encryption key listener is active
      this.setupEncryptionKeyListener();

      debug.log('📡 Creating real-time subscription via RealtimeConnectionManager:', channelName);
      
      // Use RealtimeConnectionManager for automatic reconnection and health monitoring
      this.currentSubscription = realtimeConnectionManager.subscribeToTable({
        channelName,
        table: 'messages',
        filter: `channel_id=eq.${channelId}`,
        
        // Handle new messages
        onInsert: async (payload) => {
          debug.log('🟢 Real-time INSERT received:', payload.new?.id);
          
          const payloadNew = payload.new as any;
          
          // Skip thread messages - they only appear in thread view, not main channel
          if (payloadNew.thread_id) {
            debug.log('⚠️ Skipping thread message in main channel:', payloadNew.id);
            return;
          }
          
          // Skip if this message already exists (from optimistic update)
          if (store.messages.findIndex(m => m.id === payloadNew.id) !== -1) {
            debug.log('⚠️ Real message already exists (from sendMessage), skipping');
            return;
          }
          
          // Check if temp message exists (race condition fallback).
          // Match by user_id AND content similarity to avoid collisions with
          // multiple rapid sends from the same user.
          const payloadContent = JSON.stringify(payloadNew.content);
          const tempMessageIndex = store.messages.findIndex(m => 
            m.id.startsWith('temp-') && m.user_id === payloadNew.user_id &&
            JSON.stringify(m.content) === payloadContent
          );
          
          if (tempMessageIndex !== -1) {
            debug.warn('⚠️ Temp message still exists during real-time, replacing now');
            let resolvedMessage: Message = {
              id: payloadNew.id,
              created_at: new Date(payloadNew.created_at),
              updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
              channel_id: payloadNew.channel_id,
              conversation_id: payloadNew.conversation_id,
              user_id: payloadNew.user_id,
              bot_id: payloadNew.bot_id,
              content: payloadNew.content,
              reactions: payloadNew.reactions,
              reply_to: payloadNew.reply_to,
              is_system: payloadNew.is_system,
              metadata: payloadNew.metadata || null,
              encrypted: payloadNew.encrypted === true || payloadNew.encrypted === 'true',
              encryption_metadata: payloadNew.encryption_metadata || null,
            };
            
            try {
              ensureMessageEmbeds(resolvedMessage);
              if (resolvedMessage.encrypted || resolvedMessage.encryption_metadata) {
                const decrypted = await processMessageDecryption([resolvedMessage]);
                resolvedMessage = decrypted[0];
              }
            } catch (error) {
              debug.warn('Failed to process realtime message:', error);
            }
            
            store.messages.splice(tempMessageIndex, 1, resolvedMessage);
            return;
          }
          
          // Create new message
          let newMessage: Message = {
            id: payloadNew.id,
            created_at: new Date(payloadNew.created_at),
            updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
            channel_id: payloadNew.channel_id,
            conversation_id: payloadNew.conversation_id,
            user_id: payloadNew.user_id,
            bot_id: payloadNew.bot_id,
            content: payloadNew.content,
            reactions: payloadNew.reactions,
            reply_to: payloadNew.reply_to,
            is_system: payloadNew.is_system,
            metadata: payloadNew.metadata || null,
            encrypted: payloadNew.encrypted === true || payloadNew.encrypted === 'true',
            encryption_metadata: payloadNew.encryption_metadata || null,
          };
          
          // Handle bot messages
          if (newMessage.bot_id) {
            debug.log('🤖 Real-time bot message received:', newMessage.id);
          }

          // Decrypt if encrypted
          const contentText = Array.isArray(newMessage.content) && newMessage.content[0]?.type === 'text' 
            ? newMessage.content[0].text 
            : null;
          const looksEncrypted = newMessage.encrypted || 
            newMessage.encryption_metadata ||
            (contentText && /^[A-Za-z0-9+/=]{20,}$/.test(contentText) && newMessage.encryption_metadata);
          
          if (looksEncrypted) {
            try {
              if (!newMessage.encrypted && newMessage.encryption_metadata) {
                newMessage.encrypted = true;
              }
              const decrypted = await processMessageDecryption([newMessage]);
              newMessage = decrypted[0];
            } catch (error) {
              debug.warn('Failed to decrypt real-time message:', error);
            }
          }

          store.addMessageToCache(newMessage);
          debug.log('📝 Real-time message added:', newMessage.id);
        },
        
        // Handle message updates
        onUpdate: async (payload) => {
          const payloadNew = payload.new as any;
          
          // Thread replies belong only in thread UI. If thread_id was set after insert
          // (e.g. federation resolving a stub thread), remove from main channel cache.
          if (payloadNew.thread_id) {
            store.removeMessageFromCache(payloadNew.id);
            debug.log('⚠️ Thread reply - removed from main channel if present:', payloadNew.id);
            return;
          }
          
          // Handle soft delete (federated message deletions use UPDATE with is_deleted = true)
          if (payloadNew.is_deleted) {
            store.removeMessageFromCache(payloadNew.id);
            debug.log('🗑️ Message soft-deleted via real-time:', payloadNew.id);
            return;
          }
          
          let updatedMessage: Message = {
            id: payloadNew.id,
            created_at: new Date(payloadNew.created_at),
            channel_id: payloadNew.channel_id,
            conversation_id: payloadNew.conversation_id,
            user_id: payloadNew.user_id,
            bot_id: payloadNew.bot_id,
            content: payloadNew.content,
            reactions: payloadNew.reactions,
            reply_to: payloadNew.reply_to,
            is_system: payloadNew.is_system,
            updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
            metadata: payloadNew.metadata || null,
            encrypted: payloadNew.encrypted || false,
            encryption_metadata: payloadNew.encryption_metadata || null,
          };

          // Decrypt if encrypted
          if (updatedMessage.encrypted) {
            try {
              const decrypted = await processMessageDecryption([updatedMessage]);
              updatedMessage = decrypted[0];
            } catch (error) {
              debug.warn('Failed to decrypt updated message:', error);
            }
          }

          store.updateMessageInCache(updatedMessage.id, updatedMessage);
          debug.log('🔄 Message updated via real-time:', updatedMessage.id);
        },
        
        // Handle message deletions
        onDelete: (payload) => {
          const payloadOld = payload.old as any;
          store.removeMessageFromCache(payloadOld.id);
          debug.log('🗑️ Message deleted via real-time:', payloadOld.id);
        },
        
        // Handle connection status changes
        onStatusChange: (status, name) => {
          debug.log(`📡 ${name} status: ${status}`);
          store.connectionStatus = status;
        },
        
        // Gap-fill: fetch recent messages after reconnect to cover the disconnect window
        onReconnected: async () => {
          debug.log('🔀 Channel reconnected, gap-filling missed messages for:', channelId);
          try {
            if (store.messages.length > 0) {
              const newestMsg = store.messages[store.messages.length - 1];
              const { messages: recent } = await services.messages.loadChannelMessages(channelId, {
                after: newestMsg.created_at instanceof Date
                  ? newestMsg.created_at.toISOString()
                  : String(newestMsg.created_at),
                limit: 50
              });
              let added = 0;
              for (const msg of recent) {
                if (!store.messages.some((m: any) => m.id === msg.id)) {
                  store._insertMessageSorted(store.messages, msg);
                  added++;
                }
              }
              if (added > 0) {
                debug.log(`✅ Gap-fill: added ${added} missed messages`);
              }
            }
          } catch (err) {
            debug.error('❌ Gap-fill failed:', err);
          }
        }
      });

      this._subscribeToChannelReactions(channelId, reactionsChannelName, reactionsStore);
      this.realtimeChannelId = channelId;
    },

    _subscribeToChannelReactions(
      channelId: string,
      reactionsChannelName: string,
      reactionsStore: ReturnType<typeof useReactionsStore>,
    ) {
      if (realtimeConnectionManager.hasSubscription(reactionsChannelName)) {
        return;
      }
      realtimeConnectionManager.subscribeToTable({
        channelName: reactionsChannelName,
        table: 'reactions',
        filter: `channel_id=eq.${channelId}`,
        // Forward all reactions for this channel. Thread replies are not in store.messages
        // but share channel_id; MessageDisplay in ThreadView reads the same reactions store.
        onInsert: (payload) => {
          const messageId = (payload.new as any)?.message_id;
          if (messageId) {
            void reactionsStore.handleRealtimeUpdate(payload);
          }
        },
        onDelete: (payload) => {
          const messageId = (payload.old as any)?.message_id;
          if (messageId) {
            void reactionsStore.handleRealtimeUpdate(payload);
          }
        },
      });
    },

    /**
     * Unsubscribe from current channel
     */
    unsubscribeFromMessages() {
      this._teardownChannelRealtime();
      this.cleanupEncryptionKeyListener();
    },

    /**
     * Get current connection status
     */
    getConnectionStatus(): ConnectionStatus {
      return this.connectionStatus;
    },

    // Jump to a specific message (for reply navigation)
    async jumpToMessage(messageId: string, channelId: string): Promise<boolean> {
      // First check if message is already in current messages
      const existingMessage = this.messages.find(msg => msg.id === messageId);
      if (existingMessage) {
        this.highlightMessage(messageId);
        return true;
      }

      // Check if message is in jumped messages cache
      if (this.jumpedToMessages.has(messageId)) {
        this.highlightMessage(messageId);
        return true;
      }

      try {
        // Fetch the specific message
        const { data: message, error } = await supabase
          .from('messages')
          .select('*')
          .eq('id', messageId)
          .eq('channel_id', channelId)
          .single();

        if (error || !message) {
          debug.error('Message not found or error fetching:', error);
          return false;
        }

        // Note: Reactions are now loaded via batch loading in MessageService
        // Individual fetches removed for performance

        // Add the message to jumped messages cache
        this.jumpedToMessages.set(messageId, message);
        
        // Determine where to insert the message and gap
        const messageDate = new Date(message.created_at);
        const currentMessages = [...this.messages];
        
        // Find insertion point (messages are ordered by created_at ascending)
        let insertIndex = 0;
        for (let i = 0; i < currentMessages.length; i++) {
          if (new Date(currentMessages[i].created_at) > messageDate) {
            insertIndex = i;
            break;
          }
          insertIndex = i + 1;
        }

        // Create gap indicator if there's a significant time difference
        const shouldShowGap = this.shouldShowGapBefore(message, insertIndex);
        
        if (shouldShowGap) {
          // Add gap indicator
          this.messageGaps.add(`gap-before-${messageId}`);
        }

        // Insert the message at the correct position
        this.messages.splice(insertIndex, 0, message);
        
        // Highlight the message after a short delay
        setTimeout(() => {
          this.highlightMessage(messageId);
        }, 100);

        return true;
      } catch (error) {
        debug.error('Error jumping to message:', error);
        return false;
      }
    },

    // Check if we should show a gap before this message
    shouldShowGapBefore(message: Message, insertIndex: number): boolean {
      const messageDate = new Date(message.created_at);
      
      // Check gap with previous message
      if (insertIndex > 0) {
        const prevMessage = this.messages[insertIndex - 1];
        const prevDate = new Date(prevMessage.created_at);
        const timeDiff = messageDate.getTime() - prevDate.getTime();
        
        // Show gap if more than 1 hour difference
        if (timeDiff > 60 * 60 * 1000) {
          return true;
        }
      }

      // Check gap with next message
      if (insertIndex < this.messages.length) {
        const nextMessage = this.messages[insertIndex];
        const nextDate = new Date(nextMessage.created_at);
        const timeDiff = nextDate.getTime() - messageDate.getTime();
        
        // Show gap if more than 1 hour difference
        if (timeDiff > 60 * 60 * 1000) {
          return true;
        }
      }

      return false;
    },

    // Highlight a message (scroll to it and add highlight effect)
    highlightMessage(_messageId: string) {
      // This will be implemented in the component
      // The actual DOM manipulation happens in MessageDisplay component
      // Parameter prefixed with underscore to indicate it's intentionally unused
    },

    // Clear jumped messages and gaps when switching channels
    clearJumpedMessages() {
      this.jumpedToMessages.clear();
      this.messageGaps.clear();
    },
  },
});
