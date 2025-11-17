import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import { services } from '@/services';
import type { Message, MessagePart, ChannelCache, CacheMetadata } from '@/types';
import { useReactionsStore } from '@/stores/useReactions';
import { useServerUsersStore } from '@/stores/useServerUsers';

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
    
    // Cache for individual reply messages
    replyMessageCache: new Map<string, Message>(),
    fetchingReplyMessages: new Set<string>(),
    
    // Jump-to-message functionality
    jumpedToMessages: new Map<string, Message>(),
    messageGaps: new Set<string>(), // Track where gaps should be shown
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
          console.error('Error fetching reply message:', error);
          return null;
        }

        // Note: Reactions are now loaded via batch loading in MessageService
        // Individual fetches removed for performance

        // Cache the message
        this.replyMessageCache.set(messageId, message);
        return message;
      } catch (error) {
        console.error('Error fetching reply message:', error);
        return null;
      } finally {
        this.fetchingReplyMessages.delete(messageId);
      }
    },

    // Load cached messages instantly (synchronous)
    loadCachedMessages(channelId: string) {
      const cached = this.messageCache.get(channelId);
      if (cached) {
        console.log(`Loading cached messages instantly: ${channelId}`);
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
        console.error('Error validating cache:', error);
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
        console.error('Error fetching cache metadata:', error);
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
        console.log(`Evicted cache for channel: ${oldestChannelId}`);
      }
    },

    // Load messages with intelligent caching
    async fetchMessages(channelId: string, oldestMessageId: string = '', signal?: AbortSignal) {
      if (this.loadingOlderMessages && oldestMessageId !== '') return;

      // For initial load, check cache first - make this synchronous for instant loading
      if (oldestMessageId === '') {
        // Simple time-based cache validation (no async database calls)
        if (this.messageCache.has(channelId)) {
          const cached = this.messageCache.get(channelId)!;
          const now = new Date();
          const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
          
          console.log(`📦 Found cache for channel ${channelId}, age: ${Math.round(cacheAge / 1000)}s, valid: ${cacheAge < this.cacheValidityDuration}`);
          
          // If cache is less than 5 minutes old, use it instantly
          if (cacheAge < this.cacheValidityDuration) {
            console.log(`✅ Loading ${cached.messages.length} messages from cache instantly (cache is fresh)`);
            this.messages = [...cached.messages];
            this.allMessagesLoaded = cached.allMessagesLoaded;
            this.currentChannelId = channelId;
            // Return immediately - truly instant loading
            return;
          } else {
            console.log(`⚠️ Cache is stale (${Math.round(cacheAge / 1000)}s old), fetching from database`);
          }
        } else {
          console.log(`📭 No cache found for channel ${channelId}, fetching from database`);
        }
      }

      // Only set loading state for non-cached messages
      this.loadingOlderMessages = true;
      
      try {
        console.log('🔄 Loading messages via MessageService:', { channelId, oldestMessageId });
        
        // Use services.messages for consistent loading with service layer
        // Determine cursor for pagination (before timestamp)
        let beforeTimestamp: string | undefined;
        if (oldestMessageId !== '') {
          // Get the timestamp of the oldest message for pagination
          const oldestMessage = this.messages.find(m => m.id === oldestMessageId);
          if (oldestMessage) {
            beforeTimestamp = oldestMessage.created_at.toISOString();
          }
        }
        
        console.log('📤 Loading older messages with params:', { channelId, limit: 20, beforeTimestamp });
        
        const { messages, hasMore } = await services.messages.loadChannelMessages(
          channelId,
          20, // limit
          beforeTimestamp
        );

        console.log('✅ Service returned:', { messageCount: messages?.length || 0, hasMore });

        // Check if request was cancelled
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        if (!messages || messages.length === 0) {
          console.log('📭 No older messages found');
          this.allMessagesLoaded = true;
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

        console.log('📦 Processing messages:', { count: olderMessages.length, allLoaded, isInitialLoad: oldestMessageId === '' });

        if (oldestMessageId === '') {
          // Initial load - update cache and current messages
          this.messages = olderMessages;
          this.allMessagesLoaded = allLoaded;
          
          // Only update currentChannelId if it's actually different to prevent recursive loops
          if (this.currentChannelId !== channelId) {
            this.currentChannelId = channelId;
          }

          // Update cache
          this.evictOldestCache();
          this.messageCache.set(channelId, {
            messages: [...olderMessages],
            lastFetchedAt: new Date(),
            oldestMessageId: olderMessages[0]?.id || null,
            allMessagesLoaded: allLoaded,
            lastModified: new Date(),
          });

          console.log(`✅ Initial load: Cached ${olderMessages.length} messages for channel`);
        } else {
          // Loading older messages - PREPEND to current (older messages go BEFORE)
          console.log(`📤 Prepending ${olderMessages.length} older messages to ${this.messages.length} current messages`);
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
          
          console.log(`✅ Pagination: Now have ${this.messages.length} total messages, allLoaded: ${allLoaded}`);
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
      // Skip DM messages - they should be handled by the DM store
      if (!message.channel_id || message.conversation_id) {
        console.log('Skipping DM message in chat store - should be handled by DM store');
        return;
      }

      console.log('🔄 Adding message to cache via real-time:', {
        messageId: message.id,
        channelId: message.channel_id,
        currentChannelId: this.currentChannelId,
        match: this.currentChannelId === message.channel_id
      });

      // Add to current messages if it's the current channel
      if (this.currentChannelId === message.channel_id) {
        if (!this.messages.some(msg => msg.id === message.id)) {
          this.messages.push(message);
          console.log('✅ Real-time message added to current messages:', message.id);
        } else {
          console.log('⚠️ Message already exists in current messages:', message.id);
        }
      } else {
        console.log('🔍 Message not for current channel:', {
          messageChannelId: message.channel_id,
          currentChannelId: this.currentChannelId
        });
      }

      // Update cache
      const cached = this.messageCache.get(message.channel_id);
      if (cached) {
        if (!cached.messages.some(msg => msg.id === message.id)) {
          cached.messages.push(message);
          cached.lastModified = new Date();
          console.log('✅ Real-time message added to cache:', message.id);
        }
      } else {
        console.log('⚠️ No cache found for channel:', message.channel_id);
      }
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
      console.log(`Invalidated cache for channel: ${channelId}`);
    },

    // Clear all caches
    clearAllCaches() {
      this.messageCache.clear();
      console.log('Cleared all message caches');
    },

    async editMessage(messageId: string, content: MessagePart[]) {
      try {
        console.log('🔄 Editing message via MessageService:', messageId);
        
        // Find the current message to get its data
        const currentMessage = this.messages.find(msg => msg.id === messageId);
        if (!currentMessage) {
          console.error('❌ Message not found in current messages:', messageId);
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
        console.log('✅ Message edited via service layer');
        
      } catch (error: any) {
        console.error('❌ Error editing message via service:', error);
        throw new Error(error.message || 'Failed to edit message');
      }
    },

    async deleteMessage(messageId: string) {
      try {
        console.log('🔄 Deleting message via MessageService:', messageId);
        
        // Use services.messages for consistent deletion with service layer
        await services.messages.deleteMessage(messageId);
        
        // Remove from local cache (service handles database deletion)
        this.removeMessageFromCache(messageId);
        console.log('✅ Message deleted via service layer');
      } catch (error: any) {
        console.error('❌ Error deleting message via service:', error);
        throw new Error(error.message || 'Failed to delete message');
      }
    },

    async sendMessage(serverId: string, channelId: string, userId: string, content: Array<Object>, replyTo: string) {
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
        console.log('🔄 Sending message via MessageService:', { channelId, userId });
        
        // Use services.messages for consistent sending with service layer
        const message = await services.messages.sendChannelMessage(
          serverId,
          channelId, 
          content as any, // MessagePart[]
          replyTo || undefined
        );
        
        console.log('✅ Message saved to database:', message.id);
        console.log('📦 Message data from server:', message);
        
        // Real-time will replace the temp message with the real one
        console.log('⏳ Waiting for real-time to replace temp message...');
        
        // Real-time INSERT will handle replacing temp → real
        // This ensures we don't interfere with the database event flow
        
        return message;
      } catch (error: any) {
        // Remove optimistic message on error
        this.removeMessageFromCache(tempId);
        console.error('❌ Error sending message via service:', error);
        throw new Error(error.message || 'Failed to send message');
      }
    },

    async addReaction(messageId: string, emojiId: string, userId: string) {
      try {
        // console.log('🎯 Adding reaction:', { messageId, emojiId, userId });
        
        // Use the reactions store for consistent handling
        const reactionsStore = useReactionsStore();
        const result = await reactionsStore.toggleReaction(messageId, emojiId, userId);
        
        if (result.success) {
          // console.log('🎯 Reaction successfully toggled');
        } else if (result.reason === 'duplicate_request') {
          // console.log('🎯 Reaction toggle skipped (duplicate request prevented)');
        } else {
          console.error('🎯 Failed to toggle reaction:', result.message || result.reason);
        }
      } catch (e) {
        console.error('Error during reaction toggle:', e);
      }
    },

    subscribeToMessages(channelId: string) {
      console.log('🔔 Setting up real-time subscription for channel:', channelId);
      
      if (this.currentSubscription) {
        console.log('🔄 Unsubscribing from previous channel');
        this.currentSubscription.unsubscribe();
      }

      // Get reactions store for handling real-time updates
      const reactionsStore = useReactionsStore();

      // Maintain a list of message IDs for which to listen to reactions
      const listenedMessageIds = new Set();

      const channelName = `channel-${channelId}`;
      console.log('📡 Creating real-time subscription:', channelName);
      
      this.currentSubscription = supabase
        .channel(channelName)
        .on(
          'postgres_changes', 
          { 
            event: 'INSERT', 
            schema: 'public', 
            table: 'messages',
            filter: `channel_id=eq.${channelId}`
          },
          (payload) => {
            console.log('🟢 Real-time INSERT received:', payload);
            
            // Check if this is our own message (already replaced by sendMessage)
            // Real-time should NOT add it again
            const existingRealMessage = this.messages.findIndex(m => m.id === payload.new.id);
            if (existingRealMessage !== -1) {
              console.log('⚠️ Real message already exists (from sendMessage), skipping real-time duplicate');
              return;
            }
            
            // Check if temp message exists (shouldn't happen - sendMessage should have replaced it)
            const tempMessageIndex = this.messages.findIndex(m => m.id.startsWith('temp-') && m.user_id === payload.new.user_id);
            if (tempMessageIndex !== -1) {
              console.warn('⚠️ Temp message still exists during real-time, this is a race condition!');
              console.log('🔄 Replacing late:', this.messages[tempMessageIndex].id);
              this.messages.splice(tempMessageIndex, 1, {
                id: payload.new.id,
                created_at: new Date(payload.new.created_at),
                channel_id: payload.new.channel_id,
                user_id: payload.new.user_id,
                content: payload.new.content,
                reactions: payload.new.reactions,
                reply_to: payload.new.reply_to,
                is_system: payload.new.is_system,
              });
              return;
            }
            
            // Check if message already exists (from manual replacement)
            const existingIndex = this.messages.findIndex(m => m.id === payload.new.id);
            if (existingIndex !== -1) {
              console.log('⚠️ Message already exists, skipping duplicate');
              return;
            }
            
            const newMessage: Message = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at),
              channel_id: payload.new.channel_id,
              user_id: payload.new.user_id,
              content: payload.new.content,
              reactions: payload.new.reactions,
              reply_to: payload.new.reply_to,
              is_system: payload.new.is_system,
            };

            this.addMessageToCache(newMessage);
            listenedMessageIds.add(newMessage.id);
            console.log('📝 Real-time message processed, total listened messages:', listenedMessageIds.size);
          }
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'reactions' },
          async (payload) => {
            // console.log('🟢 INSERT event received for reaction:', payload);
            reactionsStore.handleRealtimeUpdate(payload);
          }
        )
        .on(
          'postgres_changes',
          { 
            event: 'UPDATE', 
            schema: 'public', 
            table: 'messages',
            filter: `channel_id=eq.${channelId}`
          },
          (payload) => {
            const updatedMessage: Message = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at),
              channel_id: payload.new.channel_id,
              user_id: payload.new.user_id,
              content: payload.new.content,
              reactions: payload.new.reactions,
              reply_to: payload.new.reply_to,
              is_system: payload.new.is_system,
              updated_at: payload.new.updated_at ? new Date(payload.new.updated_at) : undefined,
            };

            this.updateMessageInCache(updatedMessage.id, updatedMessage);
            console.log('🔄 Message updated via real-time:', updatedMessage.id);
          }
        )
        .on(
          'postgres_changes',
          { 
            event: 'DELETE', 
            schema: 'public', 
            table: 'messages',
            filter: `channel_id=eq.${channelId}`
          },
          (payload) => {
            const deletedMessageId = payload.old.id;
            this.removeMessageFromCache(deletedMessageId);
            console.log('🗑️ Message deleted via real-time:', deletedMessageId);
          }
        )
        .on(
          'postgres_changes',
          { 
            event: 'DELETE', 
            schema: 'public', 
            table: 'reactions',
            filter: undefined
          },
          async (payload) => {
            // console.log('🔥 DELETE event received for reaction:', payload);
            reactionsStore.handleRealtimeUpdate(payload);
          }
        )
        .subscribe((status) => {
          console.log('📡 Real-time subscription status:', status, 'for channel:', channelName);
          if (status === 'SUBSCRIBED') {
            console.log('✅ Successfully subscribed to real-time updates for channel:', channelId);
          } else if (status === 'CHANNEL_ERROR') {
            console.error('❌ Real-time subscription error for channel:', channelId);
          } else if (status === 'TIMED_OUT') {
            console.error('⏰ Real-time subscription timed out for channel:', channelId);
          }
        });            
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
          console.error('Message not found or error fetching:', error);
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
        console.error('Error jumping to message:', error);
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
