/**
 * Client-side thread index shared by the parent-message indicator, the
 * threads modal, the channel sidebar and the thread panel.
 *
 * Entries are updated in place, so a view holding an entry sees every later
 * upsert. Server rows arrive from channel and server fetches and from
 * `thread:*` server-structure broadcasts. Optimistic entries carry a
 * `temp-thread-` id until create_thread returns; a server row for the same
 * parent message absorbs the optimistic entry, whichever arrives first.
 */
import { defineStore } from 'pinia'
import type { Message } from '@/types'
import { threadService, type ThreadWithDetails } from '@/services/ThreadService'
import { getRandomId, isOptimisticId } from '@/stores/shared/optimisticMessages'
import { debug } from '@/utils/debug'

export const OPTIMISTIC_THREAD_PREFIX = 'temp-thread-'

export function isOptimisticThreadId(id: unknown): boolean {
  return typeof id === 'string' && id.startsWith(OPTIMISTIC_THREAD_PREFIX)
}

/** Client-only fields a server row never carries; kept across upserts. */
export interface ThreadClientFields {
  /** Local replies sent but not confirmed; holds message_count at its local value. */
  pending_replies?: number
}

export type StoredThread = ThreadWithDetails & ThreadClientFields

export interface ThreadBroadcast {
  type?: string
  restricted?: boolean
  new?: Partial<ThreadWithDetails> & { id?: string }
  old?: Partial<ThreadWithDetails> & { id?: string }
}

export interface OptimisticThreadInput {
  parent: Message
  name: string
  channelId: string
  channelName?: string
  serverId?: string
  creatorId?: string
  autoArchiveDuration?: 60 | 1440 | 4320 | 10080
}

function timeOf(value: unknown): number {
  if (!value) return 0
  const t = new Date(value as string).getTime()
  return Number.isNaN(t) ? 0 : t
}

/** Most recent activity first; threads without replies sort by creation. */
function byActivity(a: StoredThread, b: StoredThread): number {
  const at = timeOf(a.last_message_at) || timeOf(a.created_at)
  const bt = timeOf(b.last_message_at) || timeOf(b.created_at)
  return bt - at
}

/** Auto-archive expiry, evaluated client-side between server sweeps. */
export function isThreadExpired(thread: StoredThread, now = Date.now()): boolean {
  if (!thread.last_message_at || !thread.auto_archive_duration) return false
  return timeOf(thread.last_message_at) + thread.auto_archive_duration * 60_000 <= now
}

/**
 * Copies defined fields of `incoming` onto `target`. Undefined never erases:
 * list reads leave enrichment fields undefined.
 */
function assignDefined(target: StoredThread, incoming: Partial<StoredThread>): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== undefined) (target as any)[key] = value
  }
}

/**
 * Reconciles freshly fetched thread messages with the list on screen.
 * Kept from `local`: optimistic sends, rows delivered by realtime during the
 * fetch, and older pages outside a truncated fetch window. Everything else in
 * the fetch window is replaced by the fetch.
 */
export function mergeFreshThreadMessages(
  local: Message[],
  fresh: Message[],
  options: { freshHasMore: boolean; arrivedDuringFetch: ReadonlySet<string> },
): Message[] {
  const freshIds = new Set(fresh.map(m => m.id))
  const oldest = fresh.length ? timeOf(fresh[0].created_at) : Infinity
  const kept = local.filter(m => {
    if (freshIds.has(m.id)) return false
    if (isOptimisticId(m.id) || options.arrivedDuringFetch.has(m.id)) return true
    return options.freshHasMore && timeOf(m.created_at) < oldest
  })
  if (!kept.length) return fresh
  return [...fresh, ...kept].sort((a, b) => timeOf(a.created_at) - timeOf(b.created_at))
}

const channelLoads = new Map<string, Promise<void>>()

/** Page size of the channel read; a full page may be truncated. */
export const CHANNEL_THREAD_PAGE = 50

export const useThreadsStore = defineStore('threads', {
  state: () => ({
    byId: {} as Record<string, StoredThread>,
    /** Parent message id -> thread id. */
    byParent: {} as Record<string, string>,
  }),

  getters: {
    threadForMessage: (state) => (messageId: string): StoredThread | undefined => {
      const id = state.byParent[messageId]
      return id ? state.byId[id] : undefined
    },

    channelThreads: (state) => (channelId: string, options: { includeArchived?: boolean } = {}): StoredThread[] =>
      Object.values(state.byId)
        .filter(t => t.channel_id === channelId && (options.includeArchived || !t.archived))
        .sort(byActivity),

    /** Unarchived and not past auto-archive expiry. */
    activeChannelThreads: (state) => (channelId: string): StoredThread[] => {
      const now = Date.now()
      return Object.values(state.byId)
        .filter(t => t.channel_id === channelId && !t.archived && !isThreadExpired(t, now))
        .sort(byActivity)
    },
  },

  actions: {
    _index(thread: StoredThread): void {
      if (thread.parent_message_id) this.byParent[thread.parent_message_id] = thread.id
    },

    /**
     * Merges a row into the entry with the same id, in place. A server row
     * whose parent message holds an optimistic entry absorbs that entry.
     */
    upsert(incoming: Partial<StoredThread> & { id: string }): StoredThread {
      const existing = this.byId[incoming.id]
      if (existing) {
        const next = { ...incoming }
        if ((existing.pending_replies ?? 0) > 0 && next.message_count !== undefined) {
          next.message_count = Math.max(next.message_count, existing.message_count ?? 0)
        }
        assignDefined(existing, next)
        this._index(existing)
        return existing
      }

      const parentId = incoming.parent_message_id
      const optimisticId = parentId ? this.byParent[parentId] : undefined
      if (optimisticId && isOptimisticThreadId(optimisticId) && !isOptimisticThreadId(incoming.id)) {
        return this._absorb(optimisticId, incoming)
      }

      this.byId[incoming.id] = { ...incoming } as StoredThread
      const stored = this.byId[incoming.id]
      this._index(stored)
      return stored
    },

    /**
     * Re-keys an optimistic entry to its server id, keeping client fields.
     * The object keeps its identity, so a view holding it follows the re-key.
     */
    _absorb(optimisticId: string, incoming: Partial<StoredThread> & { id: string }): StoredThread {
      const optimistic = this.byId[optimisticId]
      delete this.byId[optimisticId]
      const existing = this.byId[incoming.id]
      if (existing) {
        for (const [key, value] of Object.entries(optimistic)) {
          if (key !== 'id' && (existing as any)[key] === undefined) (existing as any)[key] = value
        }
        assignDefined(existing, incoming)
        if ((optimistic.pending_replies ?? 0) > 0) {
          existing.message_count = Math.max(existing.message_count ?? 0, optimistic.message_count ?? 0)
        }
        this._index(existing)
        return existing
      }
      const next = { ...incoming }
      if ((optimistic.pending_replies ?? 0) > 0 && next.message_count !== undefined) {
        next.message_count = Math.max(next.message_count, optimistic.message_count ?? 0)
      }
      assignDefined(optimistic, next)
      optimistic.id = incoming.id
      this.byId[incoming.id] = optimistic
      const stored = this.byId[incoming.id]
      this._index(stored)
      return stored
    },

    remove(threadId: string): void {
      const thread = this.byId[threadId]
      if (!thread) return
      delete this.byId[threadId]
      const parentId = thread.parent_message_id
      if (parentId && this.byParent[parentId] === threadId) delete this.byParent[parentId]
    },

    removeByParent(messageId: string): void {
      const id = this.byParent[messageId]
      if (id) this.remove(id)
    },

    patch(threadId: string, fields: Partial<StoredThread>): void {
      const thread = this.byId[threadId]
      if (thread) Object.assign(thread, fields)
    },

    /**
     * A complete read is authoritative for the channel: entries absent from
     * `rows` are dropped (unarchived ones only unless `includeArchived`).
     * Optimistic entries stay. A truncated read only adds and updates.
     */
    ingestChannel(
      channelId: string,
      rows: ThreadWithDetails[],
      options: { includeArchived?: boolean; complete?: boolean } = {},
    ): void {
      if (options.complete === false) {
        for (const row of rows) this.upsert(row)
        return
      }
      const returned = new Set(rows.map(r => r.id))
      for (const thread of Object.values(this.byId)) {
        if (thread.channel_id !== channelId || returned.has(thread.id)) continue
        if (isOptimisticThreadId(thread.id)) continue
        if (options.includeArchived || !thread.archived) this.remove(thread.id)
      }
      for (const row of rows) this.upsert(row)
    },

    loadChannelThreads(channelId: string, options: { includeArchived?: boolean } = {}): Promise<void> {
      const key = `${channelId}:${options.includeArchived ? 'all' : 'open'}`
      const inflight = channelLoads.get(key)
      if (inflight) return inflight
      const run = (async () => {
        const rows = await threadService.getChannelThreads(channelId, {
          includeArchived: options.includeArchived,
          limit: CHANNEL_THREAD_PAGE,
        })
        this.ingestChannel(channelId, rows, { ...options, complete: rows.length < CHANNEL_THREAD_PAGE })
      })().finally(() => channelLoads.delete(key))
      channelLoads.set(key, run)
      return run
    },

    /** server-structure `thread:*` event. Restricted events carry ids only. */
    async applyBroadcast(event: ThreadBroadcast): Promise<void> {
      const type = event?.type
      if (!type) return
      if (type === 'thread:delete') {
        const id = event.old?.id
        if (id) this.remove(id)
        return
      }
      const id = event.new?.id
      if (!id) return
      if (!event.restricted) {
        this.upsert(event.new as Partial<StoredThread> & { id: string })
        return
      }
      try {
        const row = await threadService.getThreadRow(id)
        if (row) this.upsert(row)
        else this.remove(id)
      } catch (error) {
        debug.warn('Restricted thread refresh failed:', error)
      }
    },

    addOptimistic(input: OptimisticThreadInput): StoredThread {
      const id = `${OPTIMISTIC_THREAD_PREFIX}${getRandomId()}`
      const parentAuthor = input.parent.user_id
      const memberCount = parentAuthor && parentAuthor !== input.creatorId ? 2 : 1
      return this.upsert({
        id,
        channel_id: input.channelId,
        parent_message_id: input.parent.id,
        name: input.name,
        created_by: input.creatorId ?? '',
        created_at: new Date().toISOString(),
        archived: false,
        locked: false,
        auto_archive_duration: input.autoArchiveDuration ?? 1440,
        message_count: 0,
        member_count: memberCount,
        channel_name: input.channelName,
        server_id: input.serverId,
        parent_message: input.parent,
        is_member: true,
        participants: input.creatorId ? [{ id: input.creatorId }] : undefined,
      })
    },

    /** Binds an optimistic entry to the id create_thread returned. */
    reconcileOptimistic(optimisticId: string, serverId: string): StoredThread | undefined {
      if (this.byId[optimisticId]) return this._absorb(optimisticId, { id: serverId })
      return this.byId[serverId]
    },
  },
})
