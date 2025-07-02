import { defineStore } from 'pinia';
import { supabase } from '@/supabase';
import type { Message, MessagePart, ChannelCache, CacheMetadata } from '@/types';
import { 
  broadcastInServer,
} from '@/services/notificationService';

import { GetUserIdFromUsername } from '@/utils/getFromUser';

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

        // Fetch reactions for the message if it has any
        if (message.reactions && message.reactions.length > 0) {
          const { data: reactions, error: reactionsError } = await supabase
            .rpc('get_message_reactions', { message_id: message.id });
      
          if (!reactionsError) {
            message.reactions = reactions;
          }
        }

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
          
          // If cache is less than 5 minutes old, use it instantly
          if (cacheAge < this.cacheValidityDuration) {
            console.log(`Loading from cache instantly: ${channelId}`);
            this.messages = [...cached.messages];
            this.allMessagesLoaded = cached.allMessagesLoaded;
            this.currentChannelId = channelId;
            // Return immediately - truly instant loading
            return;
          }
        }
      }

      // Only set loading state for non-cached messages
      this.loadingOlderMessages = true;
      
      try {
        let query = supabase
          .from('messages')
          .select(`*`)
          .eq('channel_id', channelId)
          .order('created_at', { ascending: false })
          .limit(20);

        if (oldestMessageId !== '') {
          const { data: oldestMessage } = await supabase
            .from('messages')
            .select('created_at')
            .eq('id', oldestMessageId)
            .single();

          if (oldestMessage) {
            query = query.lt('created_at', oldestMessage.created_at);
          }
        }

        const { data: messages, error } = await query;

        // Check if request was cancelled
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }

        if (error) {
          console.error('Error fetching messages:', error);
          return;
        }

        if (!messages) return;
        
        // Fetch reactions for messages
        for (const message of messages) {
          if (message.reactions && message.reactions.length > 0) {
            const { data: reactions, error: reactionsError } = await supabase
              .rpc('get_message_reactions', { message_id: message.id });
        
            if (reactionsError) {
              console.error('Error fetching reactions:', reactionsError);
              continue;
            }
        
            message.reactions = reactions;
          }
        }

        const reversedMessages = messages.reverse();
        const allLoaded = messages.length < 20;

        if (oldestMessageId === '') {
          // Initial load - update cache and current messages
          this.messages = reversedMessages;
          this.allMessagesLoaded = allLoaded;
          this.currentChannelId = channelId;

          // Update cache
          this.evictOldestCache();
          this.messageCache.set(channelId, {
            messages: [...reversedMessages],
            lastFetchedAt: new Date(),
            oldestMessageId: reversedMessages[0]?.id || null,
            allMessagesLoaded: allLoaded,
            lastModified: new Date(),
          });

          console.log(`Cached messages for channel: ${channelId}`);
        } else {
          // Loading older messages - append to current
          this.messages = [...reversedMessages, ...this.messages];
          this.allMessagesLoaded = allLoaded;

          // Update cache with new older messages
          const cached = this.messageCache.get(channelId);
          if (cached) {
            cached.messages = [...reversedMessages, ...cached.messages];
            cached.oldestMessageId = reversedMessages[0]?.id || cached.oldestMessageId;
            cached.allMessagesLoaded = allLoaded;
            cached.lastFetchedAt = new Date();
          }
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
      // Add to current messages if it's the current channel
      if (this.currentChannelId === message.channel_id.toString()) {
        if (!this.messages.some(msg => msg.id === message.id)) {
          this.messages.push(message);
        }
      }

      // Update cache
      const cached = this.messageCache.get(message.channel_id.toString());
      if (cached) {
        if (!cached.messages.some(msg => msg.id === message.id)) {
          cached.messages.push(message);
          cached.lastModified = new Date();
        }
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

    async editMessage(messageId: string, content: string) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .update({ content: content })
          .match({ id: messageId })
          .select('*');
    
        if (error) {
          console.error('Error editing message:', error);
          return;
        }
        if (data && data.length > 0) {
          this.updateMessageInCache(messageId, data[0]);
        }
        console.log('Message edited:', data);
      } catch (e) {
        console.error('Error during message edition:', e);
      }
    },

    async deleteMessage(messageId: string) {
      try {
        const { error } = await supabase.from('messages').delete().match({ id: messageId });
        if (error) {
          console.error('Error deleting message:', error);
          return;
        }
        this.removeMessageFromCache(messageId);
      } catch (e) {
        console.error('Error during message deletion:', e);
      }
    },

    async sendMessage(serverId: string, channelId: string, userId: string, content: Array<Object>, replyTo: string) {
      try {
        const { data, error } = await supabase
          .from('messages')
          .insert([{ 
            channel_id: channelId, 
            user_id: userId, 
            content: content,
            ...(replyTo ? { reply_to: replyTo } : {})
          }])
          .select('*');
    
        if (error) {
          console.error('Error sending message:', error);
          return;
        }
        if (data && data.length > 0) {
          // Real-time subscription will handle adding to cache
          this.addMessageToCache(data[0]);

          // if content contains a mention, send to the notification service
          for (const part of Array.from(content) as MessagePart[]) {
            console.log(part);
            if (part.type === 'mention') {
              const toUserId = await GetUserIdFromUsername(part.mention);
              broadcastInServer('mention', serverId, toUserId, userId, part.mention, data[0].id );
            }
          }
        }
        console.log('Message sent:', data);
      } catch (e) {
        console.error('Error during message sending:', e);
      }
    },

    async addReaction(messageId: string, emojiId: string, userId: string) {
      try {
        // Attempt to insert new reaction
        const { data: reactionData, error: insertError } = await supabase
          .from('reactions')
          .insert([{ 
            message_id: messageId, 
            emoji_id: emojiId,
            user_id: userId,
          }])
          .select('id');
    
        let wasRemoval = false;
        let removedReactionId: string;
        if (insertError) {
          // Check for unique constraint violation (duplicate reaction)
          if (insertError.code === "23505") {
            // Delete the reaction if it already exists
            const {data: removedReaction, error: removedError} = await supabase
              .from('reactions')
              .delete()
              .match({ message_id: messageId, emoji_id: emojiId, user_id: userId })
              .select('id')
              .single();
            removedReactionId = removedReaction?.id;
            if (removedError) {
              console.error('Error removing reaction:', removedError);
              return;
            } else {
              console.log('Reaction removed: ', removedReactionId);
            }
            wasRemoval = true;
          }
        }
    
        // Fetch and update reaction data in messages
        const updatedReactionData = await this.fetchAndPopulateReactions(messageId);
        const messageIndex = this.messages.findIndex(msg => msg.id === messageId);
        if (messageIndex !== -1) {
          this.messages[messageIndex].reactions = updatedReactionData;
        }

        // Update cache for all channels containing this message
        this.messageCache.forEach((cache) => {
          const cacheIndex = cache.messages.findIndex(msg => msg.id === messageId);
          if (cacheIndex !== -1) {
            cache.messages[cacheIndex].reactions = updatedReactionData;
            cache.lastModified = new Date();
          }
        });

        // Update message reactions array in database
        const { data: messageReactions, error: messageError} = await supabase
          .from('messages')
          .select(`reactions`)
          .eq('id', messageId)
          .single();

        if (messageError) {
          console.error('Error fetching current reactions:', messageError);
          return;
        }

        const currentReactionIds = messageReactions?.reactions || [];
        let updatedReactions;
        
        if (wasRemoval) {
          updatedReactions = currentReactionIds.filter((id:string) => id !== removedReactionId);
        } else {
          const newReactionId = reactionData[0].id;
          updatedReactions = [...currentReactionIds, newReactionId];
        }

        await supabase
          .from('messages')
          .update({ reactions: updatedReactions })
          .match({ id: messageId });
      } catch (e) {
        console.error('Error during reaction add:', e);
      }
    },

    async fetchAndPopulateReactions(messageId:string) {
      const { data: reactions, error } = await supabase
        .rpc('get_message_reactions', { message_id: messageId });

      if (error) {
        console.error('Error fetching reactions:', error);
        return [];
      }
    
      return reactions;
    },

    subscribeToMessages(channelId: string) {
      
      if (this.currentSubscription) {
        this.currentSubscription.unsubscribe();
      }

      // Maintain a list of message IDs for which to listen to reactions
      const listenedMessageIds = new Set();

      const channelName = `channel-${channelId}`;
      this.currentSubscription = supabase
        .channel(channelName)
        .on(
          'postgres_changes', 
          { event: 'INSERT', schema: 'public', table: 'messages'},
          (payload) => {
            const newMessage: Message = {
              id: payload.new.id,
              created_at: new Date(payload.new.created_at),
              channel_id: payload.new.channel_id,
              user_id: payload.new.user_id,
              content: payload.new.content,
              reactions: payload.new.reactions,
              reply_to: payload.new.reply_to,
            };

            this.addMessageToCache(newMessage);
            listenedMessageIds.add(newMessage.id);
            console.log(listenedMessageIds);
          }
        )
        .on(
          'postgres_changes',
          { event: 'INSERT', schema: 'public', table: 'reactions' },
          async (payload) => {
            const updatedReactionData = await this.fetchAndPopulateReactions(payload.new.message_id);
            const messageIndex = this.messages.findIndex(msg => msg.id === payload.new.message_id);
            if (messageIndex !== -1) {
              this.messages[messageIndex].reactions = updatedReactionData;
            }

            // Update cache
            this.messageCache.forEach((cache) => {
              const cacheIndex = cache.messages.findIndex(msg => msg.id === payload.new.message_id);
              if (cacheIndex !== -1) {
                cache.messages[cacheIndex].reactions = updatedReactionData;
                cache.lastModified = new Date();
              }
            });
          }
        )
        .on(
          'postgres_changes',
          { event: 'DELETE', schema: 'public', table: 'reactions' },
          async (payload) => {
            const reactionIdToDelete = payload.old.id;
        
            for (const message of this.messages) {
              if (message.reactions) {
                for (const reactionObj of message.reactions) {
                  const reactionArray = reactionObj.reactions;
                  if (reactionArray && Array.isArray(reactionArray)) {
                    const reactionIndex = reactionArray.findIndex(reaction => reaction.reaction_id === reactionIdToDelete);
                    if (reactionIndex !== -1) {
                      reactionArray.splice(reactionIndex, 1);
                      reactionObj.count = reactionArray.length;
        
                      try {
                        const updatedReactionData = await this.fetchAndPopulateReactions(message.id);
                        message.reactions = updatedReactionData;

                        // Update cache
                        this.messageCache.forEach((cache) => {
                          const cacheIndex = cache.messages.findIndex(msg => msg.id === message.id);
                          if (cacheIndex !== -1) {
                            cache.messages[cacheIndex].reactions = updatedReactionData;
                            cache.lastModified = new Date();
                          }
                        });
                      } catch (error) {
                        console.error('Error during reaction deletion handling:', error);
                      }
                      break;
                    }
                  }
                }
              }
            }
          }
        )
        .subscribe();            
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

        // Fetch reactions for the message if it has any
        if (message.reactions && message.reactions.length > 0) {
          const { data: reactions, error: reactionsError } = await supabase
            .rpc('get_message_reactions', { message_id: message.id });
      
          if (!reactionsError) {
            message.reactions = reactions;
          }
        }

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
    highlightMessage(messageId: string) {
      // This will be implemented in the component
      // The actual DOM manipulation happens in MessageDisplay component
    },

    // Clear jumped messages and gaps when switching channels
    clearJumpedMessages() {
      this.jumpedToMessages.clear();
      this.messageGaps.clear();
    },
  },
});
