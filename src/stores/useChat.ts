import { defineStore } from 'pinia';
import { routeMessageEvent } from '@/stores/shared/realtimeMessageEvent';
import { supabase } from '@/supabase';
import { services } from '@/services';
import type { Message, ChannelCache, CacheMetadata, Emoji, MessagePart } from '@/types';
import { seedNoReactions, useReactionsStore } from '@/stores/useReactions';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { usePinsStore } from '@/stores/usePins';
import { useMessagePollsStore } from '@/stores/useMessagePolls';
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils';
import { processMessageDecryption } from '@/utils/messageDecryption';
import { reportChannelEncryptionError } from '@/composables/useEncryptionAction';
import { debug } from '@/utils/debug';
import { realtimeConnectionManager, type ConnectionStatus } from '@/services/RealtimeConnectionManager';
import { getRandomId, createTempMessageId, findOptimisticMatchIndex } from '@/stores/shared/optimisticMessages';
import { insertMessageSorted, evictOldestCacheEntry, placeStoredRow, trimCachedMessages, waitForPendingReplyFetch } from '@/stores/shared/messageCacheUtils';
import { inSendOrder, sendKeyForChannel, takeSendTurn, type SendTurn } from '@/stores/shared/sendOrder';
import { findStalledRowMessage, insertWithDeadline, isSendUnresolved, resendRow, type StalledSendHandlers } from '@/stores/shared/stalledSends';
import { keepPendingEdit, saveEditOptimistically } from '@/stores/shared/optimisticEdit';
import { isModerationRejectionCode } from '@/services/AutoModService';
import { releaseFloatingVideo } from '@/composables/useFloatingVideo';
import { clearHistoryCutoffs } from '@/services/channelHistoryCutoff';
import { useProfileStore } from '@/stores/useProfile';
import { NEWER_PAGE, acceptsLiveRow, appendNewer, cursorOf, isPendingRow, mergeTail, newestPersisted } from '@/utils/messageWindow';

// Newest-page loads started by prefetchChannelMessages, by channel id.
const pendingPrefetch = new Map<string, Promise<void>>();

// Bumped by every load that replaces the list (jump, newest page); a load
// started under an older value is discarded.
let windowSeq = 0;

/** Rows a catch-up after the newest loaded message reads at once. */
const CATCH_UP_LIMIT = 50;

export const useChatStore = defineStore('chat', {
  state: () => ({
    messages: [] as Message[],
    currentSubscription: null as any | null,
    loadingOlderMessages: false,
    allMessagesLoaded: false,

    messageCache: new Map<string, ChannelCache>(),
    cacheValidityDuration: 5 * 60 * 1000,
    maxCacheSize: 50,
    currentChannelId: null as string | null,
    /** Channel id bound to `currentSubscription` (may differ from `currentChannelId` during navigation). */
    realtimeChannelId: null as string | null,

    // Evicted in insertion order once past maxReplyCacheSize.
    replyMessageCache: new Map<string, Message>(),
    maxReplyCacheSize: 200,
    fetchingReplyMessages: new Set<string>(),

    /** The list ends before the channel's newest message: a jump detached it from the present. */
    hasNewerMessages: false,
    loadingNewerMessages: false,
    /** Messages from others that arrived while the list is detached. */
    unseenWhileDetached: 0,

    connectionStatus: 'disconnected' as ConnectionStatus,
  }),
  actions: {
    clearMessages() {
      this.messages = [];
      this.allMessagesLoaded = false;
      this._resetDetached();
    },

    _resetDetached() {
      this.hasNewerMessages = false;
      this.unseenWhileDetached = 0;
    },

    async fetchReplyMessage(messageId: string): Promise<Message | null> {
      if (this.replyMessageCache.has(messageId)) {
        return this.replyMessageCache.get(messageId)!;
      }

      if (this.fetchingReplyMessages.has(messageId)) {
        return waitForPendingReplyFetch(messageId, this.replyMessageCache, this.fetchingReplyMessages);
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

        // Reactions load via MessageService batch fetch, not per-message here.

        // Reply previews render part.text verbatim, so a message that stays
        // encrypted after a decryption attempt gets a placeholder, not ciphertext.
        let resolved: Message = message;
        if (message.encrypted && message.encryption_metadata) {
          resolved = (await processMessageDecryption([message]))[0] ?? message;
        }
        if (resolved.encrypted && !resolved.decrypted) {
          resolved = { ...resolved, content: [{ type: 'text', text: 'Encrypted message' }] };
        }

        this.replyMessageCache.set(messageId, resolved);
        if (this.replyMessageCache.size > this.maxReplyCacheSize) {
          const oldestKey = this.replyMessageCache.keys().next().value;
          if (oldestKey) this.replyMessageCache.delete(oldestKey);
        }
        return resolved;
      } catch (error) {
        debug.error('Error fetching reply message:', error);
        return null;
      } finally {
        this.fetchingReplyMessages.delete(messageId);
      }
    },

    loadCachedMessages(channelId: string) {
      const cached = this.messageCache.get(channelId);
      if (cached) {
        debug.log(`Loading cached messages instantly: ${channelId}`);
        this.messages = [...cached.messages];
        this.allMessagesLoaded = cached.allMessagesLoaded;
        this.currentChannelId = channelId;
        this._resetDetached();
      }
    },

    // Drives skeleton display.
    isMessageCached(channelId: string): boolean {
      if (!this.messageCache.has(channelId)) return false;
      
      const cached = this.messageCache.get(channelId)!;
      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();

      return cacheAge < this.cacheValidityDuration;
    },

    async isChannelCacheValid(channelId: string): Promise<boolean> {
      const cached = this.messageCache.get(channelId);
      if (!cached) return false;

      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
      if (cacheAge > this.cacheValidityDuration) return false;

      try {
        const { data: latestMessage, error } = await supabase
          .from('messages')
          .select('updated_at, created_at')
          .eq('channel_id', channelId)
          .order('updated_at', { ascending: false })
          .limit(1);

        if (error || !latestMessage || latestMessage.length === 0) {
          // No latest-message info available; treat the cache as valid.
          return true;
        }

        const latestModification = new Date(latestMessage[0].updated_at || latestMessage[0].created_at);
        
        // Any modification after lastFetchedAt invalidates the cache.
        return latestModification <= cached.lastFetchedAt;
      } catch (error) {
        debug.error('Error validating cache:', error);
        // Errors keep the cache valid rather than triggering a refetch storm.
        return true;
      }
    },

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

    isCacheValid(channelId: string, serverMetadata?: CacheMetadata): boolean {
      const cached = this.messageCache.get(channelId);
      if (!cached) return false;

      const now = new Date();
      const cacheAge = now.getTime() - cached.lastFetchedAt.getTime();
      if (cacheAge > this.cacheValidityDuration) return false;

      if (serverMetadata && cached.lastModified) {
        return serverMetadata.lastModified <= cached.lastModified;
      }

      return true;
    },

    evictOldestCache() {
      evictOldestCacheEntry(this.messageCache, this.maxCacheSize);
    },

    // Channel -> DM leaves the channel without calling fetchMessages, so the
    // trim at the top of fetchMessages never runs for that transition.
    trimCachedChannel() {
      trimCachedMessages(this.messageCache, this.currentChannelId);
    },

    async fetchMessages(channelId: string, oldestMessageId: string = '', signal?: AbortSignal) {
      if (this.loadingOlderMessages && oldestMessageId !== '') return;

      if (oldestMessageId === '' && this.currentChannelId !== channelId) {
        // Trim the channel being left, never the one being entered.
        trimCachedMessages(this.messageCache, this.currentChannelId);
        this.currentChannelId = channelId;
      }

      if (oldestMessageId === '') {
        // Time-based validation only; no database round-trip.
        if (this._showFreshCache(channelId)) return;

        // A prefetch already requested this page; reuse it instead of a second load.
        const pending = pendingPrefetch.get(channelId);
        if (pending) {
          await pending;
          if (signal?.aborted) throw new Error('AbortError');
          if (this.currentChannelId !== channelId) return;
          if (this._showFreshCache(channelId)) return;
        }
      }

      this.loadingOlderMessages = true;
      
      try {
        debug.log('Loading messages via MessageService:', { channelId, oldestMessageId });

        let beforeTimestamp: string | undefined;
        if (oldestMessageId !== '') {
          const oldestMessage = this.messages.find(m => m.id === oldestMessageId);
          if (oldestMessage) {
            // Handle both Date objects and ISO strings. `created_at` is typed
            // as `Date` but legacy code paths sometimes pass through ISO strings.
            const ts: unknown = oldestMessage.created_at;
            beforeTimestamp = ts instanceof Date
              ? ts.toISOString()
              : (typeof ts === 'string' ? ts : undefined);
            debug.log('Using timestamp for pagination:', beforeTimestamp);
          }
        }
        
        debug.log('Loading older messages with params:', { channelId, limit: 20, beforeTimestamp });

        // Resolve is_remote from the already-loaded channel/server state so the
        // service can skip its channels + servers lookup round trips. When the
        // channel isn't in the store (direct URL open before structure loads),
        // leave undefined and let the service resolve it from the DB.
        const isRemote = this._knownIsRemote(channelId);

        const { messages, hasMore } = await services.messages.loadChannelMessages(
          channelId,
          {
            limit: 20,
            before: beforeTimestamp,
            signal,
            isRemote
          }
        );

        debug.log('Service returned:', { messageCount: messages?.length || 0, hasMore });

        try {
          ensureMessageEmbeds(messages);
        } catch (error) {
          debug.warn('Failed to prepare message embeds:', error);
        }

        // Stale-channel guard. Applies to pagination requests
        // (`oldestMessageId !== ''`) as well as the initial load: without it, a
        // channel switch mid-fetch prepends channel A's history into channel
        // B's `messages` array and corrupts the cache. BUGS.md H34.
        if (signal?.aborted) {
          throw new Error('Request aborted');
        }
        if (this.currentChannelId !== channelId) {
          debug.log(`Discarding stale response for channel ${channelId} (current: ${this.currentChannelId})`);
          return;
        }
        // A list replaced during the fetch no longer starts with the row this
        // page precedes.
        if (oldestMessageId !== '' && this.messages[0]?.id !== oldestMessageId) return;

        if (!messages || messages.length === 0) {
          debug.log('No older messages found');
          this.allMessagesLoaded = true;
          
          // Empty channels still bind currentChannelId.
          if (oldestMessageId === '' && this.currentChannelId !== channelId) {
            this.currentChannelId = channelId;
            this.messages = [];
            
            this.messageCache.set(channelId, {
              messages: [],
              lastFetchedAt: new Date(),
              oldestMessageId: null,
              allMessagesLoaded: true,
              lastModified: new Date(),
            });
            debug.log(`Initialized empty cache for new channel: ${channelId}`);
          }
          return;
        }
        
        const userIds = new Set<string>();
        messages.forEach(message => {
          if (message?.user_id) {
            userIds.add(message.user_id);
          }
        });
        
        // Profile hydration runs unawaited: awaiting it blocks first paint on a
        // profiles round-trip for cold channel opens. Author names resolve
        // reactively and fill in once the profiles land; most are already
        // cached from the member list or presence. The cache-hit path renders
        // without this preload either way.
        if (userIds.size > 0) {
          const serverUsersStore = useServerUsersStore();
          void serverUsersStore.fetchMultipleUserProfiles(Array.from(userIds)).catch(() => {});
        }
        
        // Service returns chronological order, oldest first.
        const olderMessages = messages;
        const allLoaded = !hasMore;

        debug.log('Processing messages:', { count: olderMessages.length, allLoaded, isInitialLoad: oldestMessageId === '' });

        if (oldestMessageId === '') {
          // Merge in messages realtime delivered during the fetch. A detached
          // list holds history, not arrivals.
          const realtimeOnly = this.hasNewerMessages ? [] : this.messages.filter(
            (m: Message) => m.channel_id === channelId && !olderMessages.some((om: Message) => om.id === m.id)
          );
          if (realtimeOnly.length > 0) {
            debug.log(`Merging ${realtimeOnly.length} realtime messages received during history fetch`);
          }
          const merged = [...olderMessages, ...realtimeOnly];
          merged.sort((a: Message, b: Message) =>
            new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
          );
          this.messages = merged;
          this.allMessagesLoaded = allLoaded;
          this._resetDetached();
          
          // Assigning currentChannelId unconditionally re-triggers watchers.
          if (this.currentChannelId !== channelId) {
            this.currentChannelId = channelId;
          }

          this.evictOldestCache();
          this.messageCache.set(channelId, {
            messages: [...merged],
            lastFetchedAt: new Date(),
            oldestMessageId: merged[0]?.id || null,
            allMessagesLoaded: allLoaded,
            lastModified: new Date(),
          });

          debug.log(`Initial load: Cached ${merged.length} messages for channel`);
        } else {
          debug.log(`Prepending ${olderMessages.length} older messages to ${this.messages.length} current messages`);
          this.messages = [...olderMessages, ...this.messages];
          this.allMessagesLoaded = allLoaded;

          // The cache holds the newest rows; a detached list is not a prefix of them.
          const cached = this.hasNewerMessages ? undefined : this.messageCache.get(channelId);
          if (cached) {
            cached.messages = [...olderMessages, ...cached.messages];
            cached.oldestMessageId = olderMessages[0]?.id || cached.oldestMessageId;
            cached.allMessagesLoaded = allLoaded;
            cached.lastFetchedAt = new Date();
          }
          
          debug.log(`Pagination: Now have ${this.messages.length} total messages, allLoaded: ${allLoaded}`);
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

    /**
     * Shows a fresh cache entry for `channelId` and starts a catch-up fetch.
     * False when no entry is younger than cacheValidityDuration.
     */
    _showFreshCache(channelId: string): boolean {
      const cached = this.messageCache.get(channelId);
      if (!cached) return false;
      const cacheAge = Date.now() - cached.lastFetchedAt.getTime();
      if (cacheAge >= this.cacheValidityDuration) {
        debug.log(`Cache is stale (${Math.round(cacheAge / 1000)}s old), fetching from database`);
        return false;
      }
      this.messages = [...cached.messages];
      this.allMessagesLoaded = cached.allMessagesLoaded;
      this.currentChannelId = channelId;
      this._resetDetached();
      // Stale-while-revalidate: per-channel realtime only delivers to the
      // active subscription, so messages sent while another channel was
      // open never reached this cache. Show cache instantly, then catch up.
      void this.revalidateRecentMessages(channelId);
      return true;
    },

    /**
     * is_remote from the loaded channel and server rows. Undefined when the
     * channel is not in the store; the service then resolves it with two
     * sequential lookups.
     */
    _knownIsRemote(channelId: string): boolean | undefined {
      const serverChannelStore = useServerChannelStore();
      const channel = serverChannelStore.channels.find(c => c.id === channelId)
        ?? Object.values(serverChannelStore._structureCacheByServer)
          .flatMap(s => s.channels)
          .find(c => c.id === channelId);
      if (!channel) return undefined;
      const server = serverChannelStore.servers.find(s => s.id === channel.server_id);
      return channel.is_remote === true || server?.is_local_server === false;
    },

    /**
     * Loads a channel's newest page into messageCache without touching the
     * on-screen list, so opening the channel takes the cache path.
     */
    prefetchChannelMessages(channelId: string): Promise<void> {
      if (!channelId || channelId === this.currentChannelId) return Promise.resolve();
      const cached = this.messageCache.get(channelId);
      if (cached && Date.now() - cached.lastFetchedAt.getTime() < this.cacheValidityDuration) {
        return Promise.resolve();
      }
      const inFlight = pendingPrefetch.get(channelId);
      if (inFlight) return inFlight;

      const work = (async () => {
        try {
          const { messages, hasMore } = await services.messages.loadChannelMessages(channelId, {
            limit: 20,
            isRemote: this._knownIsRemote(channelId),
          });
          // Empty pages stay with the cold path, which also binds the channel.
          if (!messages || messages.length === 0) return;
          // Opened and loaded meanwhile: that entry is at least as new.
          const current = this.messageCache.get(channelId);
          if (current && Date.now() - current.lastFetchedAt.getTime() < this.cacheValidityDuration) return;

          try { ensureMessageEmbeds(messages); } catch (e) { debug.warn('Failed to prepare prefetched embeds:', e); }
          const userIds = [...new Set(messages.map((m: Message) => m.user_id).filter(Boolean))] as string[];
          if (userIds.length > 0) {
            void useServerUsersStore().fetchMultipleUserProfiles(userIds).catch(() => {});
          }

          this.evictOldestCache();
          this.messageCache.set(channelId, {
            messages: [...messages],
            lastFetchedAt: new Date(),
            oldestMessageId: messages[0]?.id || null,
            allMessagesLoaded: !hasMore,
            lastModified: new Date(),
          });
        } catch (error) {
          debug.warn('Channel prefetch failed (non-fatal):', error);
        } finally {
          pendingPrefetch.delete(channelId);
        }
      })();
      pendingPrefetch.set(channelId, work);
      return work;
    },

    /**
     * Catch up on messages that arrived for `channelId` while it wasn't the
     * active realtime subscription. Fetches only messages newer than the
     * currently-loaded newest one (`after` cursor) and merges them in; the
     * common result is zero rows. A channel switch mid-flight makes it a no-op.
     */
    async revalidateRecentMessages(channelId: string) {
      try {
        if (this.hasNewerMessages) return;
        const newest = this.messages.length ? this.messages[this.messages.length - 1] : null;
        if (!newest) return; // Empty channel; realtime populates it.
        const ts: unknown = newest.created_at;
        const afterTs = ts instanceof Date ? ts.toISOString() : (typeof ts === 'string' ? ts : undefined);
        if (!afterTs) return;

        const { messages } = await services.messages.loadChannelMessages(channelId, {
          limit: CATCH_UP_LIMIT,
          after: afterTs,
          isRemote: this._knownIsRemote(channelId),
        });
        if (!messages || messages.length === 0) return;
        // Discard if the active channel changed or a jump detached the list during the fetch.
        if (this.currentChannelId !== channelId || this.hasNewerMessages) return;
        // The page holds the newest rows after the cursor; a full one can leave
        // older missed rows between them and the list.
        if (messages.length >= CATCH_UP_LIMIT) {
          await this.reloadNewestPage(channelId);
          return;
        }

        const existingIds = new Set(this.messages.map((m: Message) => m.id));
        const fresh = messages.filter((m: Message) => !existingIds.has(m.id));
        if (fresh.length === 0) return;

        try { ensureMessageEmbeds(fresh); } catch (e) { debug.warn('Failed to prepare embeds for caught-up messages:', e); }

        const userIds = [...new Set(fresh.map((m: Message) => m.user_id).filter(Boolean))] as string[];
        if (userIds.length > 0) {
          const serverUsersStore = useServerUsersStore();
          await serverUsersStore.fetchMultipleUserProfiles(userIds);
        }
        if (this.currentChannelId !== channelId || this.hasNewerMessages) return;

        const merged = [...this.messages, ...fresh].sort(
          (a: Message, b: Message) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
        );
        this.messages = merged;

        const cached = this.messageCache.get(channelId);
        if (cached) {
          cached.messages = [...merged];
          cached.lastFetchedAt = new Date();
          cached.lastModified = new Date();
        }
        debug.log(`Revalidate: merged ${fresh.length} missed message(s) for channel ${channelId}`);
      } catch (error) {
        debug.warn('Revalidate recent messages failed (non-fatal):', error);
      }
    },

    addMessageToCache(message: Message) {
      try {
        ensureMessageEmbeds(message);
      } catch (error) {
        debug.warn('Failed to prepare embeds for realtime message:', error);
      }
      // DM messages belong to the DM store.
      if (!message.channel_id || message.conversation_id) {
        debug.log('Skipping DM message in chat store - should be handled by DM store');
        return;
      }

      debug.log('Adding message to cache via real-time:', {
        messageId: message.id,
        channelId: message.channel_id,
        currentChannelId: this.currentChannelId,
        match: this.currentChannelId === message.channel_id
      });

      if (this.currentChannelId === message.channel_id) {
        if (this.messages.some(msg => msg.id === message.id)) {
          debug.log('Message already exists in current messages:', message.id);
        } else if (acceptsLiveRow(this.messages, message, this.hasNewerMessages)) {
          this._insertMessageSorted(this.messages, message);
          debug.log('Real-time message added to current messages:', message.id);
        } else if (!message.is_system && message.user_id !== useProfileStore().profileId) {
          this.unseenWhileDetached++;
        }
      } else {
        debug.log('Message not for current channel:', {
          messageChannelId: message.channel_id,
          currentChannelId: this.currentChannelId
        });
      }

      const cached = this.messageCache.get(message.channel_id);
      if (cached) {
        if (!cached.messages.some(msg => msg.id === message.id)) {
          this._insertMessageSorted(cached.messages, message);
          cached.lastModified = new Date();
          debug.log('Real-time message added to cache:', message.id);
        }
      } else {
        debug.log('No cache found for channel:', message.channel_id);
      }
    },

    _insertMessageSorted(arr: Message[], msg: Message) {
      insertMessageSorted(arr, msg);
    },

    // roomId '*' (unlock, pairing) re-decrypts every loaded channel.
    async reprocessEncryptedMessages(roomId?: string) {
      try {
        if (roomId && roomId !== '*') {
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
        debug.log(`Key received${roomId ? ` for room ${roomId.substring(0, 8)}...` : ''} - re-decrypting`);
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

    updateMessageInCache(messageId: string, updatedMessage: Message) {
      const currentIndex = this.messages.findIndex(msg => msg.id === messageId);
      if (currentIndex !== -1) {
        this.messages[currentIndex] = updatedMessage;
      }

      this.messageCache.forEach((cache) => {
        const cacheIndex = cache.messages.findIndex(msg => msg.id === messageId);
        if (cacheIndex !== -1) {
          cache.messages[cacheIndex] = updatedMessage;
          cache.lastModified = new Date();
        }
      });

      try {
        ensureMessageEmbeds(updatedMessage);
      } catch (error) {
        debug.warn('Failed to refresh embeds for updated message:', error);
      }
    },

    /** In place: the live list and cache entries share message objects. */
    patchMessageFields(messageId: string, fields: Partial<Message>) {
      for (const msg of this.messages) {
        if (msg.id === messageId) Object.assign(msg, fields);
      }
      this.messageCache.forEach((cache) => {
        for (const msg of cache.messages) {
          if (msg.id === messageId) Object.assign(msg, fields);
        }
      });
    },

    removeMessageFromCache(messageId: string) {
      releaseFloatingVideo(messageId);
      this.messages = this.messages.filter(msg => msg.id !== messageId);

      this.messageCache.forEach((cache) => {
        cache.messages = cache.messages.filter(msg => msg.id !== messageId);
        cache.lastModified = new Date();
      });
    },

    invalidateChannelCache(channelId: string) {
      this.messageCache.delete(channelId);
      debug.log(`Invalidated cache for channel: ${channelId}`);
    },

    clearAllCaches() {
      this.messageCache.clear();
      this.replyMessageCache.clear();
      this.fetchingReplyMessages.clear();
      clearHistoryCutoffs();
      debug.log('Cleared all message caches');
    },

    /** Shows the edit at once and saves it behind (optimisticEdit.ts); a refusal restores the row and throws. */
    async editMessage(messageId: string, content: MessagePart[]) {
      try {
        debug.log('Editing message via MessageService:', messageId);

        const currentMessage = this.messages.find(msg => msg.id === messageId);
        if (!currentMessage) {
          debug.error('Message not found in current messages:', messageId);
          return;
        }

        await saveEditOptimistically({
          message: currentMessage,
          content,
          patch: (fields) => {
            this.patchMessageFields(messageId, fields);
            try { ensureMessageEmbeds(currentMessage); } catch { /* embeds are best-effort */ }
          },
          save: () => services.messages.editMessage(messageId, content),
        });
        debug.log('Message edited via service layer');
        
      } catch (error: any) {
        debug.error('Error editing message via service:', error);
        throw Object.assign(new Error(error.message || 'Failed to edit message'), { code: error?.code });
      }
    },

    async deleteMessage(messageId: string) {
      try {
        debug.log('Deleting message via MessageService:', messageId);

        await services.messages.deleteMessage(messageId);

        this.removeMessageFromCache(messageId);
        debug.log('Message deleted via service layer');
      } catch (error: any) {
        debug.error('Error deleting message via service:', error);
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
      options?: {
        allowPlaintextFallback?: boolean;
        /** Id of the optimistic row; the outbox passes the id of its pending row. */
        tempId?: string;
        clientNonce?: string;
        /** The channel's send turn, taken at Enter; a fresh one when absent. */
        turn?: SendTurn;
      }
    ) {
      // Temp ID = timestamp plus random suffix. Without the suffix two sends in
      // the same millisecond collide and the second optimistic message dedupes
      // against the first, vanishing until realtime arrives.
      const tempId = options?.tempId ?? createTempMessageId();
      // `client_nonce` is echoed back on the persisted row (via metadata) and on
      // the realtime INSERT. It is the only reliable key when optimistic content
      // (plaintext) differs from stored content (ciphertext), as on encrypted
      // channels where realtime wins the race.
      const clientNonce = options?.clientNonce ?? getRandomId();
      const sendMetadata = { ...(extraMetadata || {}), client_nonce: clientNonce };
      const serviceOptions = options ? { allowPlaintextFallback: options.allowPlaintextFallback } : undefined;
      const optimisticMessage = {
        id: tempId,
        created_at: new Date(),
        channel_id: channelId,
        user_id: userId,
        content: content as any,
        reply_to: replyTo || undefined,
        metadata: { ...(extraMetadata || {}), client_nonce: clientNonce },
        sending: true
      };
      
      this.addMessageToCache(optimisticMessage as any);
      // The optimistic row shows at once; the insert waits for the channel's earlier ones.
      const orderKey = sendKeyForChannel(channelId);
      const turn = options?.turn ?? takeSendTurn(orderKey);
      const stalledHandlers = this._stalledSendHandlers(tempId, userId, channelId, content);
      const insert = () => insertWithDeadline(tempId, services.messages.sendChannelMessage(
        serverId, channelId, content as any, replyTo || undefined, sendMetadata, serviceOptions
      ), stalledHandlers);
      // A re-send of a row whose insert stalled finds the message stored meanwhile.
      const send = () => resendRow(tempId, () => services.messages.findSentMessage({ channelId }, userId, clientNonce), insert);

      try {
        debug.log('Sending message via MessageService:', { channelId, userId });

        const message = await turn.run(send);

        debug.log('Message saved to database:', message.id);
        debug.log('Message data from server:', message);
        
        this._replaceTempWithReal(tempId, message, userId, channelId, content);
        
        return message;
      } catch (error: any) {
        debug.error('Error sending message via service:', error);

        // No answer in time, or a failed lookup: the insert may be stored, so it is not sent
        // again here. The row fails and offers Retry and Delete.
        if (isSendUnresolved(error)) {
          this._markMessageFailed(tempId);
          return;
        }

        // Encryption policy errors are not transient. A retry either fails the
        // same way or bypasses the fail-closed policy, so surface immediately
        // and let the UI ask whether to send unencrypted.
        //
        // The optimistic message is removed rather than marked failed:
        // accepting the fallback prompt re-calls this method with
        // `allowPlaintextFallback: true` and creates a fresh optimistic. A
        // lingering "failed" entry reads as sent-then-rejected on Cancel.
        // BUGS.md.
        // CoreMessageService wraps database errors as INSERT_FAILED with the
        // database message in `message`; both carry codes.
        const code = [error?.code, error?.message].filter(Boolean).join(' ');
        const isEncryptionPolicyError =
          code.includes('ENCRYPTION_REQUIRED') ||
          code.includes('ENCRYPTION_LOCKED') ||
          code.includes('ENCRYPTION_UNAVAILABLE') ||
          code.includes('ENCRYPTION_FAILED_NO_FALLBACK')
        if (isEncryptionPolicyError) {
          this.removeMessageFromCache(tempId);
          throw error;
        }

        // Slowmode rejection is not transient within the window; a retry
        // re-trips the trigger. Drop the optimistic message and sync the
        // input's countdown to the DB's remaining time.
        const slowmodeMatch = code.match(/SLOWMODE_ACTIVE:(\d+)/);
        if (slowmodeMatch) {
          const waitSeconds = parseInt(slowmodeMatch[1], 10);
          this.removeMessageFromCache(tempId);
          window.dispatchEvent(new CustomEvent('harmony:slowmode-hit', {
            detail: { seconds: waitSeconds, channelId },
          }));
          throw Object.assign(new Error(`Slowmode is on - you can send again in ${waitSeconds}s`), {
            code: 'SLOWMODE_ACTIVE',
            retryAfterSeconds: waitSeconds,
          });
        }

        // AutoMod blocks, timeouts, anti-spam limits and channel permissions
        // (Missing permission: USE_EXTERNAL_EMOJIS, ATTACH_FILES) answer the same
        // way on every retry.
        if (isModerationRejectionCode(code) || code.includes('Missing permission:')) {
          this.removeMessageFromCache(tempId);
          throw error;
        }

        // Length-limit and structural validation errors are not transient
        // either; the same payload fails the same way. Drop the optimistic
        // message and surface the error instead of running two doomed retries.
        const isPermanentValidationError =
          code.includes('MESSAGE_TOO_LONG') ||
          code.includes('TOO_MANY_ATTACHMENTS') ||
          // PostgreSQL CHECK constraint messages_text_length_check.
          code.includes('messages_text_length_check') ||
          // Any other CHECK constraint on messages.*
          (code.includes('check constraint') && code.includes('messages_'))
        if (isPermanentValidationError) {
          this.removeMessageFromCache(tempId);
          throw error;
        }

        // Offline: mark failed without retrying.
        if (!navigator.onLine) {
          debug.log('Offline - marking message as failed, will retry when user clicks Retry');
          this._markMessageFailed(tempId);
          return;
        }

        // Up to 2 retries, 2s then 4s. Service call only; no new optimistic message.
        for (let attempt = 1; attempt <= 2; attempt++) {
          const delay = Math.pow(2, attempt) * 1000;
          debug.log(`Auto-retrying message send in ${delay}ms (attempt ${attempt}/2)`);
          await new Promise(r => setTimeout(r, delay));

          if (!navigator.onLine) {
            debug.log('Went offline during retry - marking as failed');
            break;
          }

          try {
            // A retry queues behind the sends made since; it lands at its new created_at.
            const retryResult = await inSendOrder(orderKey, send);
            this._replaceTempWithReal(tempId, retryResult, userId, channelId, content);
            return retryResult;
          } catch (retryError) {
            debug.warn(`Retry attempt ${attempt} failed:`, retryError);
            if (isSendUnresolved(retryError)) break;
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

    /**
     * `addIfAbsent`: a message whose row is held by neither copy is added as a stored row. A
     * stalled outbox send lands so: the outbox removed the store's row when the send failed.
     */
    _replaceTempWithReal(tempId: string, message: any, userId: string, channelId: string, content: any, addIfAbsent = false) {
      seedNoReactions(message.id);
      // The live list and the cache are reconciled independently - realtime
      // `onInsert` may already have replaced the temp row in `messages`. Bail
      // only when neither copy holds it, otherwise the cache keeps a
      // `sending: true` temp row that reappears on channel re-entry.
      const tempIndex = this.messages.findIndex((m: any) => m.id === tempId);
      const cached = this.messageCache.get(channelId);
      const cacheIndex = cached ? cached.messages.findIndex((m: any) => m.id === tempId) : -1;
      if (tempIndex === -1 && cacheIndex === -1 && !addIfAbsent) return;

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

      if (tempIndex === -1 && cacheIndex === -1) {
        this.addMessageToCache(realMessage as any);
        return;
      }

      // Placed by the server's created_at: the sender's list matches what everyone else reads.
      if (tempIndex !== -1) {
        placeStoredRow(this.messages, tempId, realMessage as any);
      }
      debug.log('Replaced temp message with real message:', { tempId, realId: message.id });

      if (cached && cacheIndex !== -1) {
        placeStoredRow(cached.messages, tempId, realMessage as any);
        cached.lastModified = new Date();
      }
    },

    async retryMessage(tempId: string, serverId: string, channelId: string, userId: string, content: Array<Object>, replyTo: string) {
      const idx = this.messages.findIndex((m: any) => m.id === tempId);
      if (idx === -1) return;

      // The row's metadata carries its client_nonce; realtime reconciles by it. A copy:
      // CoreMessageService writes plaintext-override markers into the metadata it gets.
      const metadata = { ...this.messages[idx].metadata };
      const clientNonce = typeof metadata.client_nonce === 'string' ? metadata.client_nonce : null;
      this.messages[idx] = { ...this.messages[idx], sending: true, failed: false } as any;

      try {
        // A row whose insert stalled may be stored already; it is looked up before sending again.
        const message = await inSendOrder(sendKeyForChannel(channelId), async () =>
          (clientNonce
            ? await findStalledRowMessage(tempId, () => services.messages.findSentMessage({ channelId }, userId, clientNonce))
            : null)
          ?? insertWithDeadline(tempId, services.messages.sendChannelMessage(
            serverId, channelId, content as any, replyTo || undefined, metadata
          ), this._stalledSendHandlers(tempId, userId, channelId, content)));
        this._replaceTempWithReal(tempId, message, userId, channelId, content);
      } catch (error) {
        debug.error('Retry failed:', error);
        reportChannelEncryptionError(error);
        this._markMessageFailed(tempId);
      }
    },

    discardFailedMessage(tempId: string) {
      this.removeMessageFromCache(tempId);
    },

    /** A message stored after its row's insert stalled becomes the row; one the row does not keep is deleted. */
    _stalledSendHandlers(tempId: string, userId: string, channelId: string, content: any): StalledSendHandlers<Message> {
      return {
        landed: (message) => this._replaceTempWithReal(tempId, message, userId, channelId, content, true),
        unwanted: (message) => {
          this.deleteMessage(message.id).catch((error) => debug.warn('Deleting a second copy of a sent message failed:', error));
        },
      };
    },

    async addReaction(messageId: string, emojiId: string, userId: string, emojiData?: Emoji) {
      try {
        const reactionsStore = useReactionsStore();
        const result = await reactionsStore.toggleReaction(messageId, emojiId, userId, emojiData);
        
        if (result.success || result.reason === 'duplicate_request') {
          // Success or duplicate request; nothing to do.
        } else {
          debug.error('Failed to toggle reaction:', (result as any).message || result.reason);
        }
      } catch (e) {
        debug.error('Error during reaction toggle:', e);
      }
    },

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
        realtimeConnectionManager.unsubscribe(`channel-messages-${this.realtimeChannelId}`);
      }
      this.realtimeChannelId = null;
    },

    subscribeToMessages(channelId: string) {
      const channelName = `channel-messages-${channelId}`;
      const hasMessagesSub = realtimeConnectionManager.hasSubscription(channelName);
      const boundToThisChannel = this.realtimeChannelId === channelId;

      // Both the subscription and a matching binding are required.
      // `currentChannelId` updates early for UI and stale guards, so it must not
      // drive teardown; doing so leaves the previous channel's realtime active.
      if (hasMessagesSub && boundToThisChannel && this.currentSubscription) {
        debug.log('Already subscribed to channel:', channelName);
        return;
      }

      const reactionsStore = useReactionsStore();

      // Stale binding or orphaned subs from a prior channel; rebuild.
      if (this.currentSubscription || this.realtimeChannelId) {
        debug.log('Tearing down previous realtime channel:', this.realtimeChannelId, '→', channelId);
        this._teardownChannelRealtime();
      }

      debug.log('Setting up real-time subscription for channel:', channelId);

      const store = this;
      const pinsStore = usePinsStore();

      this.setupEncryptionKeyListener();

      debug.log('Creating real-time subscription via RealtimeConnectionManager:', channelName);
      
      const handleMessageInsert = async (payload: any) => {
        debug.log('Real-time INSERT received:', payload.new?.id);
        
        const payloadNew = payload.new as any;

        // Broadcast carries no server-side filter; postgres_changes had
        // `channel_id=eq.${channelId}`. Routing is the trigger's topic choice.
        if (payloadNew.channel_id !== channelId) return;
        
        // Thread messages render only in thread view.
        if (payloadNew.thread_id) {
          debug.log('Skipping thread message in main channel:', payloadNew.id);
          return;
        }
        
        // Already inserted by sendMessage's optimistic path.
        if (store.messages.findIndex(m => m.id === payloadNew.id) !== -1) {
          debug.log('Real message already exists (from sendMessage), skipping');
          return;
        }
        
        // Fallback for when realtime beats `_replaceTempWithReal`: an
        // optimistic row for this message may still be present.
        const tempMessageIndex = findOptimisticMatchIndex(store.messages as any, payloadNew);
        
        if (tempMessageIndex !== -1) {
          debug.warn('Temp message still exists during real-time, replacing now');
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
          
          // The send response or the other transport can land during the await:
          // the row is resolved again, and a real row already in place is kept.
          if (store.messages.some(m => m.id === payloadNew.id)) return;
          const targetIndex = findOptimisticMatchIndex(store.messages as any, payloadNew);
          if (targetIndex === -1) {
            store.addMessageToCache(resolvedMessage);
            return;
          }
          const replacedTempId = (store.messages[targetIndex] as any).id;
          placeStoredRow(store.messages, replacedTempId, resolvedMessage);

          // Cache holds its own copy of the temp row; leaving it stale makes
          // the message render grayed out again on channel re-entry.
          const tempCache = store.messageCache.get(payloadNew.channel_id);
          if (tempCache && placeStoredRow(tempCache.messages, replacedTempId, resolvedMessage)) {
            tempCache.lastModified = new Date();
          }
          return;
        }
        
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
        
        if (newMessage.bot_id) {
          debug.log('Real-time bot message received:', newMessage.id);
        }

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
        debug.log('Real-time message added:', newMessage.id);
      }
      

      const handleMessageUpdate = async (payload: any) => {
        const payloadNew = payload.new as any;

        // Before any await: the pin delta reads the message's prior state.
        pinsStore.applyRealtimeRow(payloadNew);
        
        // Thread replies belong to the thread UI. thread_id can be set after
        // insert (federation resolving a stub thread), so drop the row from
        // the main channel cache here.
        if (payloadNew.thread_id) {
          store.removeMessageFromCache(payloadNew.id);
          debug.log('Thread reply - removed from main channel if present:', payloadNew.id);
          return;
        }
        
        // Soft delete: federated deletions arrive as UPDATE with is_deleted = true.
        if (payloadNew.is_deleted) {
          store.removeMessageFromCache(payloadNew.id);
          debug.log('Message soft-deleted via real-time:', payloadNew.id);
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
          is_pinned: pinsStore.pending[payloadNew.id]?.pinned ?? payloadNew.is_pinned,
          updated_at: payloadNew.updated_at ? new Date(payloadNew.updated_at) : undefined,
          metadata: payloadNew.metadata || null,
          encrypted: payloadNew.encrypted || false,
          encryption_metadata: payloadNew.encryption_metadata || null,
        };

        if (updatedMessage.encrypted) {
          try {
            const decrypted = await processMessageDecryption([updatedMessage]);
            updatedMessage = decrypted[0];
          } catch (error) {
            debug.warn('Failed to decrypt updated message:', error);
          }
        }

        updatedMessage = keepPendingEdit(store.messages.find(m => m.id === updatedMessage.id), updatedMessage);
        store.updateMessageInCache(updatedMessage.id, updatedMessage);
        debug.log('Message updated via real-time:', updatedMessage.id);
      }
      

      const handleMessageDelete = (payload: any) => {
        const payloadOld = payload.old as any;
        pinsStore.applyRealtimeDelete(payloadOld);
        store.removeMessageFromCache(payloadOld.id);
        debug.log('Message deleted via real-time:', payloadOld.id);
      }

      const handleMessageEvent = (payload: any) => routeMessageEvent(payload, {
        onInsert: handleMessageInsert,
        onUpdate: handleMessageUpdate,
        onDelete: handleMessageDelete,
      });

      this.currentSubscription = realtimeConnectionManager.subscribeBroadcast({
        channelName,
        // Private so reaction broadcasts (realtime.send) land on this same channel.
        private: true,
        broadcasts: [
          { event: 'reaction_event', handler: (payload) => void reactionsStore.handleRealtimeUpdate(payload) },
          { event: 'message_event', handler: handleMessageEvent },
          { event: 'poll_event', handler: (payload) => useMessagePollsStore().applyRealtime(payload) },
        ],

        onStatusChange: (status, name) => {
          debug.log(`${name} status: ${status}`);
          store.connectionStatus = status;
        },
        
        // Gap-fill: covers messages sent during the disconnect window.
        onReconnected: async () => {
          debug.log('Channel reconnected, gap-filling missed messages for:', channelId);
          try {
            // A detached list holds history; pages toward the present fill it.
            if (store.messages.length > 0 && !store.hasNewerMessages) {
              const newestMsg = store.messages[store.messages.length - 1];
              const { messages: recent } = await services.messages.loadChannelMessages(channelId, {
                after: newestMsg.created_at instanceof Date
                  ? newestMsg.created_at.toISOString()
                  : String(newestMsg.created_at),
                limit: CATCH_UP_LIMIT
              });
              // A full page can leave older missed rows between it and the list.
              if (recent.length >= CATCH_UP_LIMIT) {
                await store.reloadNewestPage(channelId);
                return;
              }
              let added = 0;
              for (const msg of recent) {
                if (!store.messages.some((m: any) => m.id === msg.id)) {
                  store._insertMessageSorted(store.messages, msg);
                  added++;
                }
              }
              if (added > 0) {
                debug.log(`Gap-fill: added ${added} missed messages`);
              }
            }
            // Reaction events sent during the gap are not replayed: held rows reload theirs.
            const held = store.messages.map((m: any) => m.id as string).filter(id => !id.startsWith('temp-'));
            if (held.length) void useReactionsStore().fetchMultipleMessageReactions(held, true).catch(() => {});
          } catch (err) {
            debug.error('Gap-fill failed:', err);
          }
        }
      });

      this.realtimeChannelId = channelId;
    },

    unsubscribeFromMessages() {
      this._teardownChannelRealtime();
      this.cleanupEncryptionKeyListener();
    },

    getConnectionStatus(): ConnectionStatus {
      return this.connectionStatus;
    },

    /**
     * Shows a message. One outside the list replaces it with the rows around the
     * message, detached from the present when newer rows follow them.
     */
    async jumpToMessage(messageId: string, channelId: string): Promise<boolean> {
      if (this.messages.some(msg => msg.id === messageId)) {
        this.highlightMessage(messageId);
        return true;
      }

      const seq = ++windowSeq;
      try {
        const window = await services.messages.loadMessageWindow(
          { channelId },
          messageId,
          { isRemote: this._knownIsRemote(channelId) },
        );
        if (seq !== windowSeq || this.currentChannelId !== channelId) return false;
        if (!window) {
          debug.warn('Jump target is not a visible message of the channel:', messageId);
          return false;
        }
        this._prepareRows(window.messages);
        this.allMessagesLoaded = window.allOlderLoaded;
        if (window.hasNewer) {
          this.messages = window.messages;
          this.hasNewerMessages = true;
          this.unseenWhileDetached = 0;
        } else {
          this._attachList(channelId, window.messages);
        }
        setTimeout(() => this.highlightMessage(messageId), 100);
        return true;
      } catch (error) {
        debug.error('Error jumping to message:', error);
        return false;
      }
    },

    /**
     * Appends the next page toward the present to a detached list. A short page
     * reached the newest message and attaches the list again.
     */
    async fetchNewerMessages(channelId: string): Promise<void> {
      if (!this.hasNewerMessages || this.loadingNewerMessages || this.currentChannelId !== channelId) return;
      const cursorRow = newestPersisted(this.messages);
      const from = cursorOf(cursorRow);
      if (!cursorRow || !from) return;

      const seq = windowSeq;
      this.loadingNewerMessages = true;
      try {
        const { messages: page } = await services.messages.loadMessagesFrom(
          { channelId },
          { from, limit: NEWER_PAGE },
        );
        if (seq !== windowSeq || this.currentChannelId !== channelId || !this.hasNewerMessages) return;
        if (newestPersisted(this.messages)?.id !== cursorRow.id) return;
        this._prepareRows(page);
        const next = appendNewer(this.messages, page, NEWER_PAGE);
        if (next.hasNewer) this.messages = next.messages;
        else this._attachList(channelId, next.messages);
      } catch (error) {
        debug.error('Failed to load newer messages:', error);
      } finally {
        this.loadingNewerMessages = false;
      }
    },

    /** Rows newer than any page loaded: the list itself, or the cache while detached. */
    _liveTail(channelId: string): Message[] {
      const rows = this.messages.filter((m: Message) => m.channel_id === channelId);
      if (!this.hasNewerMessages) return rows;
      return [...(this.messageCache.get(channelId)?.messages ?? []), ...rows.filter(isPendingRow)];
    },

    /**
     * Shows `rows`, which end at the channel's newest message, followed by what
     * arrived while they loaded. The cache mirrors the attached list.
     */
    _attachList(channelId: string, rows: Message[]) {
      const merged = mergeTail(rows, this._liveTail(channelId));
      this.messages = merged;
      this._resetDetached();

      this.evictOldestCache();
      this.messageCache.set(channelId, {
        messages: [...merged],
        lastFetchedAt: new Date(),
        oldestMessageId: merged[0]?.id || null,
        allMessagesLoaded: this.allMessagesLoaded,
        lastModified: new Date(),
      });
    },

    _prepareRows(rows: Message[]) {
      try { ensureMessageEmbeds(rows); } catch (e) { debug.warn('Failed to prepare message embeds:', e); }
      const userIds = [...new Set(rows.map((m: Message) => m.user_id).filter(Boolean))] as string[];
      if (userIds.length > 0) {
        void useServerUsersStore().fetchMultipleUserProfiles(userIds).catch(() => {});
      }
    },

    /**
     * Replaces the list with the channel's newest page, the page a cold open
     * loads, and attaches it to the present. Rows newer than that page (realtime
     * arrivals, sends in flight) stay.
     */
    async reloadNewestPage(channelId: string): Promise<void> {
      const seq = ++windowSeq;
      const { messages, hasMore } = await services.messages.loadChannelMessages(channelId, {
        limit: 20,
        isRemote: this._knownIsRemote(channelId),
      });
      if (seq !== windowSeq || this.currentChannelId !== channelId || !messages || messages.length === 0) return;
      try { ensureMessageEmbeds(messages); } catch (e) { debug.warn('Failed to prepare embeds for the newest page:', e); }
      this.allMessagesLoaded = !hasMore;
      this._attachList(channelId, messages);
    },

    highlightMessage(_messageId: string) {
      // Scroll and highlight live in MessageDisplay; this hook is a no-op.
    },
  },
});
