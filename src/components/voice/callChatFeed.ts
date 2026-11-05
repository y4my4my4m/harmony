/**
 * The call's chat while the routed view shows another one: the messageCache
 * entry of the voice channel (useChat) or conversation (useDM), its pages, and
 * a realtime subscription on the chat's topic. Sends, edits, deletes and
 * re-decryption reach the entry through the stores' cache-wide updates.
 *
 * RealtimeConnectionManager holds one subscription per topic. The routed
 * store's binding takes precedence: the feed subscribes only while the store
 * holds another chat. useChat's own subscribe replaces the feed's; useDM's
 * skips while the feed's is live, so the feed hands the topic back to it.
 */

import { computed, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { Message } from '@/types'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { usePinsStore } from '@/stores/usePins'
import { useReactionsStore } from '@/stores/useReactions'
import { useMessagePollsStore } from '@/stores/useMessagePolls'
import { realtimeConnectionManager } from '@/services/RealtimeConnectionManager'
import { routeMessageEvent } from '@/stores/shared/realtimeMessageEvent'
import { findOptimisticMatchIndex } from '@/stores/shared/optimisticMessages'
import { placeStoredRow } from '@/stores/shared/messageCacheUtils'
import { keepPendingEdit } from '@/stores/shared/optimisticEdit'
import { processMessageDecryption } from '@/utils/messageDecryption'
import { ensureMessageEmbeds } from '@/utils/messageEmbedUtils'
import { debug } from '@/utils/debug'
import type { CallChat, CallChatTarget } from './callChat'

/** Paging state of a list the routed stores do not hold (MessageDisplay's listState). */
export interface CallChatListState {
  loadingOlder: boolean
  allLoaded: boolean
}

export interface CallChatFeed {
  /** The feed serves the side chat: the routed view shows another chat. */
  active: ComputedRef<boolean>
  messages: ComputedRef<Message[]>
  /** The first page is loading and nothing is held yet. */
  loading: Ref<boolean>
  listState: ComputedRef<CallChatListState>
  loadOlder: () => Promise<void>
}

interface CacheEntry {
  messages: Message[]
  allMessagesLoaded: boolean
}

export interface FeedSource {
  key: string
  topic: string
  entry: () => CacheEntry | undefined
  loadPage: (older: boolean) => Promise<void>
  /** The routed store's binding is on this chat. */
  routedHolds: () => boolean
  /** Ends the feed's subscription; the routed store keeps or regains its own. */
  release: () => void
  /** The row is this chat's (a thread reply of a channel included). */
  owns: (row: any) => boolean
  toMessage: (row: any) => Message
  add: (message: Message) => void
  update: (id: string, message: Message) => void
  remove: (id: string) => void
}

function channelSource(channelId: string): FeedSource {
  const store = useChatStore()
  const topic = `channel-messages-${channelId}`
  return {
    key: `channel:${channelId}`,
    topic,
    entry: () => store.messageCache.get(channelId),
    loadPage: (older) => store.loadCachedChannelPage(channelId, older),
    routedHolds: () => store.realtimeChannelId === channelId,
    release: () => {
      // The store's subscribe replaced the feed's: the topic is the store's now.
      if (store.realtimeChannelId !== channelId) realtimeConnectionManager.unsubscribe(topic)
    },
    owns: (row) => row?.channel_id === channelId,
    toMessage: (row) => ({
      id: row.id,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      channel_id: row.channel_id,
      conversation_id: row.conversation_id,
      user_id: row.user_id,
      bot_id: row.bot_id,
      content: row.content,
      reactions: row.reactions,
      reply_to: row.reply_to,
      is_system: row.is_system,
      is_pinned: row.is_pinned,
      metadata: row.metadata || null,
      encrypted: row.encrypted === true || row.encrypted === 'true',
      encryption_metadata: row.encryption_metadata || null,
    }) as Message,
    add: (message) => store.addMessageToCache(message),
    update: (id, message) => store.updateMessageInCache(id, message),
    remove: (id) => store.removeMessageFromCache(id),
  }
}

function conversationSource(conversationId: string): FeedSource {
  const store = useDMStore()
  const topic = `dm-conversation-${conversationId}`
  return {
    key: `dm:${conversationId}`,
    topic,
    entry: () => store.cachedConversation(conversationId),
    loadPage: (older) => store.loadCachedConversationPage(conversationId, older),
    routedHolds: () => store.currentConversationId === conversationId,
    release: () => {
      realtimeConnectionManager.unsubscribe(topic)
      // useDM skipped its own subscribe while the feed's was live.
      if (store.currentConversationId === conversationId) store.setupConversationSubscription(conversationId)
    },
    owns: (row) => row?.conversation_id === conversationId,
    toMessage: (row) => ({
      ...row,
      created_at: new Date(row.created_at),
      updated_at: row.updated_at ? new Date(row.updated_at) : undefined,
      channel_id: '',
      reactions: row.reactions || [],
      metadata: row.metadata || null,
      encrypted: row.encrypted || false,
    }) as Message,
    add: (message) => store.addMessageToCache(message),
    update: (id, message) => store.updateMessageInCache(id, message),
    remove: (id) => store.removeMessageFromCache(id),
  }
}

export function feedSource(target: CallChatTarget): FeedSource {
  return target.kind === 'channel' ? channelSource(target.channelId) : conversationSource(target.conversationId)
}

async function decrypted(message: Message): Promise<Message> {
  if (!message.encrypted && !message.encryption_metadata) return message
  try {
    return (await processMessageDecryption([message]))[0]
  } catch (error) {
    debug.warn('[CallChatFeed] decryption failed:', error)
    return message
  }
}

/** Subscribes `source`'s topic; rows land in its cache entry. Returns nothing: release() ends it. */
export function subscribeFeed(source: FeedSource): void {
  const pins = usePinsStore()
  const reactions = useReactionsStore()

  const onInsert = async ({ new: row }: { new: any }) => {
    // Thread replies show in the thread view only.
    if (!source.owns(row) || row.thread_id) return
    const message = await decrypted(source.toMessage(row))
    try { ensureMessageEmbeds(message) } catch { /* embeds are best-effort */ }
    const entry = source.entry()
    if (!entry || entry.messages.some((m) => m.id === row.id)) return
    // Realtime can beat the send response: the optimistic row becomes the stored one.
    const pending = findOptimisticMatchIndex(entry.messages as any, row)
    if (pending !== -1) {
      placeStoredRow(entry.messages, entry.messages[pending].id, message)
      return
    }
    source.add(message)
  }

  const onUpdate = async ({ new: row }: { new: any }) => {
    if (!source.owns(row)) return
    pins.applyRealtimeRow(row)
    if (row.thread_id || row.is_deleted) {
      source.remove(row.id)
      return
    }
    let message = await decrypted(source.toMessage(row))
    message = keepPendingEdit(source.entry()?.messages.find((m) => m.id === row.id), message)
    source.update(row.id, message)
  }

  const onDelete = ({ old }: { old: any }) => {
    pins.applyRealtimeDelete(old)
    source.remove(old.id)
  }

  realtimeConnectionManager.subscribeBroadcast({
    channelName: source.topic,
    private: true,
    broadcasts: [
      { event: 'reaction_event', handler: (payload) => void reactions.handleRealtimeUpdate(payload) },
      { event: 'message_event', handler: (payload) => routeMessageEvent(payload, { onInsert, onUpdate, onDelete }) },
      { event: 'poll_event', handler: (payload) => useMessagePollsStore().applyRealtime(payload) },
    ],
    // Rows sent while the socket was down reach no transport.
    onReconnected: () => source.loadPage(false).catch((error) => debug.warn('[CallChatFeed] gap fill failed:', error)),
  })
}

/** The side chat's list while the routed view shows another chat; released with the calling scope. */
export function useCallChatFeed(chat: CallChat): CallChatFeed {
  const chatStore = useChatStore()
  const dmStore = useDMStore()

  const active = computed(() => !!chat.target.value && !chat.routed.value)
  const source = computed<FeedSource | null>(() => (active.value ? feedSource(chat.target.value!) : null))
  const loading = ref(false)
  const loadingOlder = ref(false)

  let subscribed: FeedSource | null = null
  let loadedKey: string | null = null

  const release = () => {
    const held = subscribed
    subscribed = null
    held?.release()
  }

  const load = async (current: FeedSource) => {
    loadedKey = current.key
    loading.value = !current.entry()
    try {
      await current.loadPage(false)
    } catch (error) {
      debug.warn('[CallChatFeed] page load failed:', error)
    } finally {
      if (loadedKey === current.key) loading.value = false
    }
  }

  const sync = () => {
    const current = source.value
    if (subscribed && subscribed.key !== current?.key) release()
    if (!current) {
      loadedKey = null
      loading.value = false
      return
    }
    // Loaded once per activation, and again when the entry was evicted.
    if (loadedKey !== current.key || (!current.entry() && !loading.value)) void load(current)
    if (current.routedHolds()) {
      // The routed store binds this chat: rows reach the entry through its subscription.
      if (subscribed) release()
      return
    }
    if (!subscribed) {
      subscribeFeed(current)
      subscribed = current
    }
  }

  watch(
    [() => source.value?.key, () => chatStore.realtimeChannelId, () => dmStore.currentConversationId, () => !!source.value?.entry()],
    sync,
    { immediate: true, flush: 'sync' },
  )

  onScopeDispose(() => {
    release()
    loadedKey = null
  })

  const messages = computed<Message[]>(() => source.value?.entry()?.messages ?? [])

  const listState = computed<CallChatListState>(() => ({
    loadingOlder: loadingOlder.value,
    allLoaded: source.value?.entry()?.allMessagesLoaded ?? false,
  }))

  const loadOlder = async () => {
    const current = source.value
    if (!current || loadingOlder.value) return
    loadingOlder.value = true
    try {
      await current.loadPage(true)
    } catch (error) {
      debug.warn('[CallChatFeed] older page failed:', error)
    } finally {
      loadingOlder.value = false
    }
  }

  return { active, messages, loading, listState, loadOlder }
}
