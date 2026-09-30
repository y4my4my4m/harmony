/**
 * Pinned-message state per channel or DM conversation.
 *
 * `counts` and `lists` hold server truth as of their last fetch, moved forward
 * by confirmed ops and realtime rows. `known` is the last server pin state seen
 * per message; it turns a realtime row, which carries no prior state, into a
 * count delta. `pending` overlays in-flight local ops: a failed op drops its
 * entry and every derived view reverts with it.
 *
 * A fetch that overlaps a delta or a pending op is not applied; the scope
 * refetches once it is quiet.
 */
import { defineStore } from 'pinia'
import type { Message } from '@/types'
import { messageService } from '@/services/MessageService'
import { useChatStore } from '@/stores/useChat'
import { useDMStore } from '@/stores/useDM'
import { useProfileStore } from '@/stores/useProfile'
import { isOptimisticId } from '@/stores/shared/optimisticMessages'
import { debug } from '@/utils/debug'
import { processMessageDecryption } from '@/utils/messageDecryption'

/** `channel:<id>` or `dm:<id>`. */
export type PinScopeKey = string

export function pinScopeKey(channelId?: string | null, conversationId?: string | null): PinScopeKey | null {
  if (conversationId) return `dm:${conversationId}`
  if (channelId) return `channel:${channelId}`
  return null
}

function parseScope(scope: PinScopeKey): { channelId?: string; conversationId?: string } {
  if (scope.startsWith('dm:')) return { conversationId: scope.slice(3) }
  return { channelId: scope.slice('channel:'.length) }
}

type PinFields = Pick<Message, 'is_pinned' | 'pinned_at' | 'pinned_by'>

interface KnownPin {
  pinned: boolean
  scope: PinScopeKey
}

interface PendingPin {
  pinned: boolean
  token: number
  scope: PinScopeKey
  /** Server state assumed while no fetch, row or confirmed op has reported one. */
  fallbackPrior: boolean
  /** Pin fields before the first op in a run of overlapping ops on this message. */
  priorFields: PinFields
  /** Inserted at the head of a loaded list on pin. */
  message: Message
}

/** Subset of a `messages` row as delivered by postgres_changes or broadcast. */
export interface PinRow {
  id?: string
  channel_id?: string | null
  conversation_id?: string | null
  is_pinned?: boolean | null
  is_deleted?: boolean | null
}

export const COUNT_REFRESH_DELAY_MS = 250

const countTimers = new Map<PinScopeKey, ReturnType<typeof setTimeout>>()
const countLoads = new Map<PinScopeKey, Promise<void>>()
const listLoads = new Map<PinScopeKey, Promise<void>>()

function pinFieldsOf(message: Message): PinFields {
  return { is_pinned: !!message.is_pinned, pinned_at: message.pinned_at, pinned_by: message.pinned_by }
}

function findLoadedMessage(id: string): Message | undefined {
  const chat = useChatStore()
  const inChat = chat.messages.find(m => m.id === id)
  if (inChat) return inChat
  const dm = useDMStore()
  return dm.currentDMMessages.find((m: Message) => m.id === id)
}

function patchLoadedMessages(message: Message, fields: PinFields): void {
  Object.assign(message, fields)
  useChatStore().patchMessageFields(message.id, fields)
  useDMStore().patchMessageFields(message.id, fields)
}

export const usePinsStore = defineStore('pins', {
  state: () => ({
    counts: {} as Record<PinScopeKey, number>,
    lists: {} as Record<PinScopeKey, Message[]>,
    listStale: {} as Record<PinScopeKey, boolean>,
    known: {} as Record<string, KnownPin>,
    pending: {} as Record<string, PendingPin>,
    /** Bumped by every delta; a fetch that sees it move is discarded. */
    versions: {} as Record<PinScopeKey, number>,
    /** A fetch was discarded under a pending op; refetch when the scope settles. */
    refetchOnSettle: {} as Record<PinScopeKey, boolean>,
    nextToken: 1,
  }),

  getters: {
    pinnedCount: (state) => (scope: PinScopeKey | null): number => {
      if (!scope) return 0
      const base = state.counts[scope]
      if (base === undefined) return 0
      let n = base
      for (const [id, p] of Object.entries(state.pending)) {
        if (p.scope !== scope) continue
        const prior = state.known[id]?.pinned ?? p.fallbackPrior
        if (p.pinned !== prior) n += p.pinned ? 1 : -1
      }
      return Math.max(0, n)
    },

    /** Newest pin first; null until the list is fetched. */
    pinnedMessages: (state) => (scope: PinScopeKey | null): Message[] | null => {
      if (!scope) return null
      const list = state.lists[scope]
      if (!list) return null
      const listed = new Set(list.map(m => m.id))
      const added = Object.values(state.pending)
        .filter(p => p.scope === scope && p.pinned && !listed.has(p.message.id))
        .sort((a, b) => b.token - a.token)
        .map(p => p.message)
      const kept = list.filter(m => {
        const p = state.pending[m.id]
        if (p) return p.pinned
        return state.known[m.id]?.pinned !== false
      })
      return [...added, ...kept]
    },

    isListStale: (state) => (scope: PinScopeKey | null): boolean =>
      !!scope && !!state.listStale[scope],
  },

  actions: {
    _hasPending(scope: PinScopeKey): boolean {
      return Object.values(this.pending).some(p => p.scope === scope)
    },

    _bump(scope: PinScopeKey): void {
      this.versions[scope] = (this.versions[scope] ?? 0) + 1
    },

    /**
     * Server pin state before the change being applied. Undefined when nothing
     * local can tell; the caller then refetches the count.
     */
    _priorFor(id: string, scope: PinScopeKey): boolean | undefined {
      const known = this.known[id]
      if (known) return known.pinned
      const p = this.pending[id]
      if (p) return p.fallbackPrior
      const list = this.lists[scope]
      if (list && !this.listStale[scope]) return list.some(m => m.id === id)
      if (this.counts[scope] === 0 && !this._hasPending(scope)) return false
      const loaded = findLoadedMessage(id)
      return loaded ? !!loaded.is_pinned : undefined
    },

    /** Records a server-side pin state and moves counts and lists with it. */
    _applyServerState(id: string, scope: PinScopeKey, pinned: boolean, prior: boolean | undefined): void {
      this.known[id] = { pinned, scope }

      if (this.counts[scope] !== undefined) {
        if (prior === undefined) {
          this._bump(scope)
          this.scheduleCountRefresh(scope)
        } else if (prior !== pinned) {
          this.counts[scope] = Math.max(0, this.counts[scope] + (pinned ? 1 : -1))
          this._bump(scope)
        }
      }

      const list = this.lists[scope]
      if (!list) return
      const index = list.findIndex(m => m.id === id)
      if (!pinned) {
        if (index !== -1) list.splice(index, 1)
        return
      }
      if (index !== -1) return
      const source = this.pending[id]?.message ?? findLoadedMessage(id)
      if (source) {
        list.unshift({ ...source, is_pinned: true })
      } else {
        this.listStale[scope] = true
      }
    },

    _settle(scope: PinScopeKey): void {
      if (!this.refetchOnSettle[scope] || this._hasPending(scope)) return
      delete this.refetchOnSettle[scope]
      this.scheduleCountRefresh(scope)
    },

    /**
     * Stale-while-revalidate: the previous count stays visible until this
     * resolves. `entering` marks a scope whose realtime feed was not followed
     * since its last fetch; its per-message states and list are no longer
     * trusted for deltas.
     */
    loadCount(
      channelId?: string | null,
      conversationId?: string | null,
      options: { entering?: boolean } = {},
    ): Promise<void> {
      const scope = pinScopeKey(channelId, conversationId)
      if (!scope) return Promise.resolve()
      if (options.entering) {
        for (const [id, k] of Object.entries(this.known)) {
          if (k.scope === scope && !this.pending[id]) delete this.known[id]
        }
        if (this.lists[scope]) this.listStale[scope] = true
      }
      const inflight = countLoads.get(scope)
      if (inflight) return inflight

      const run = (async () => {
        const version = this.versions[scope] ?? 0
        let n: number
        try {
          n = await messageService.getPinnedCount(channelId ?? undefined, conversationId ?? undefined)
        } catch (error) {
          debug.warn('Pinned count fetch failed; keeping previous value:', error)
          return
        }
        if ((this.versions[scope] ?? 0) !== version) {
          this.scheduleCountRefresh(scope)
          return
        }
        if (this._hasPending(scope)) {
          this.refetchOnSettle[scope] = true
          return
        }
        this.counts[scope] = n
      })().finally(() => countLoads.delete(scope))

      countLoads.set(scope, run)
      return run
    },

    scheduleCountRefresh(scope: PinScopeKey): void {
      const existing = countTimers.get(scope)
      if (existing) clearTimeout(existing)
      countTimers.set(scope, setTimeout(() => {
        countTimers.delete(scope)
        const { channelId, conversationId } = parseScope(scope)
        void this.loadCount(channelId, conversationId)
      }, COUNT_REFRESH_DELAY_MS))
    },

    /** Stale-while-revalidate; a complete list also settles the count. */
    loadList(channelId?: string | null, conversationId?: string | null): Promise<void> {
      const scope = pinScopeKey(channelId, conversationId)
      if (!scope) return Promise.resolve()
      const inflight = listLoads.get(scope)
      if (inflight) return inflight

      const run = (async () => {
        const version = this.versions[scope] ?? 0
        const loaded = conversationId
          ? await messageService.getPinnedDMMessages(conversationId)
          : await messageService.getPinnedChannelMessages(channelId!)
        const list = await processMessageDecryption(loaded)
        this.lists[scope] = list
        delete this.listStale[scope]

        if ((this.versions[scope] ?? 0) !== version || this._hasPending(scope)) {
          // Rows applied during the fetch may be missing from it.
          this.listStale[scope] = true
          this.refetchOnSettle[scope] = true
          this._settle(scope)
          return
        }
        this.counts[scope] = list.length
        const listed = new Set(list.map(m => m.id))
        for (const [id, k] of Object.entries(this.known)) {
          if (k.scope === scope && !listed.has(id)) this.known[id] = { pinned: false, scope }
        }
        for (const id of listed) this.known[id] = { pinned: true, scope }
      })().finally(() => listLoads.delete(scope))

      listLoads.set(scope, run)
      return run
    },

    /**
     * Optimistic pin or unpin. Local state moves at once; on failure it
     * reverts and the error is rethrown. A failure superseded by a later op on
     * the same message resolves silently: the later op decides the state.
     */
    async setPinned(message: Message, pinned: boolean): Promise<void> {
      if (!message?.id || isOptimisticId(message.id)) return
      const scope = pinScopeKey(message.channel_id, message.conversation_id)
      if (!scope) return

      const id = message.id
      const previous = this.pending[id]
      const token = this.nextToken++
      const fallbackPrior = previous ? previous.fallbackPrior : !!message.is_pinned
      const priorFields = previous ? previous.priorFields : pinFieldsOf(message)
      const profileId = useProfileStore().profileId ?? undefined
      const optimisticFields: PinFields = pinned
        ? { is_pinned: true, pinned_at: new Date().toISOString(), pinned_by: profileId }
        : { is_pinned: false, pinned_at: undefined, pinned_by: undefined }

      this.pending[id] = {
        pinned,
        token,
        scope,
        fallbackPrior,
        priorFields,
        message: { ...message },
      }
      patchLoadedMessages(message, optimisticFields)

      try {
        if (pinned) {
          await messageService.pinMessage(id)
        } else {
          await messageService.unpinMessage(id)
        }
      } catch (error) {
        if (this.pending[id]?.token !== token) return
        delete this.pending[id]
        const serverPinned = this.known[id]?.pinned ?? fallbackPrior
        patchLoadedMessages(message, serverPinned === fallbackPrior
          ? priorFields
          : { is_pinned: serverPinned, pinned_at: undefined, pinned_by: undefined })
        this._settle(scope)
        throw error
      }

      this._applyServerState(id, scope, pinned, this._priorFor(id, scope))
      const current = this.pending[id]
      if (current?.token === token) {
        delete this.pending[id]
      } else if (!current && !!message.is_pinned !== pinned) {
        // A later op on this message failed first and reverted to the state
        // before this one.
        patchLoadedMessages(message, optimisticFields)
      }
      this._settle(scope)
    },

    /** Realtime UPDATE (either transport). Duplicate deliveries are no-ops. */
    applyRealtimeRow(row: PinRow | null | undefined): void {
      if (!row?.id) return
      const scope = pinScopeKey(row.channel_id, row.conversation_id)
      if (!scope) return
      const pinned = !!row.is_pinned && !row.is_deleted
      this._applyServerState(row.id, scope, pinned, this._priorFor(row.id, scope))
    },

    /** Realtime DELETE. postgres_changes may deliver the primary key alone. */
    applyRealtimeDelete(row: PinRow | null | undefined): void {
      if (!row?.id) return
      const loaded = findLoadedMessage(row.id)
      const scope = pinScopeKey(row.channel_id, row.conversation_id)
        ?? this.known[row.id]?.scope
        ?? pinScopeKey(loaded?.channel_id, loaded?.conversation_id)
      if (!scope) return
      this._applyServerState(row.id, scope, false, this._priorFor(row.id, scope))
    },

    /** A realtime copy of a message with a pending op keeps the optimistic pin state. */
    overlayPending<T extends { id?: string; is_pinned?: boolean }>(message: T): T {
      const p = message?.id ? this.pending[message.id] : undefined
      if (p) message.is_pinned = p.pinned
      return message
    },
  },
})
