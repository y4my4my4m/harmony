import { ref, computed, type Ref, type ComputedRef } from 'vue'

/**
 * Shared reaction engine for message reactions (`useReactions`) and post
 * reactions (`postReactions`).
 *
 * Both features need the exact same orchestration: a cached real-data map, an
 * optimistic overlay for instant UI, batch fetching with in-flight dedup, a
 * debounced reconcile that merges server data into the optimistic groups
 * in-place (so Vue's <TransitionGroup> doesn't run leave/enter and flicker),
 * realtime handling, and logout cleanup. That logic used to be copy-pasted into
 * both stores (including two `createOptimisticReactions`).
 *
 * Everything entity-specific (which RPC to call, how a group is shaped, how to
 * build an optimistic group) lives in the adapter. The engine owns the rest.
 *
 *   G = reaction-group shape (ReactionGroup for messages, PostReactionGroup for posts)
 *   E = emoji input shape passed to toggle
 */
export interface ReactionEngineAdapter<G, E> {
  /** Fetch real reaction groups for a batch of entity ids. */
  fetchBatch(entityIds: string[]): Promise<Record<string, G[]>>
  /** Perform the server-side toggle. `currentlyReacted` is the pre-toggle state. */
  toggleOnServer(entityId: string, emoji: E, currentlyReacted: boolean): Promise<void>
  /** Produce a new optimistic group array (clone of base) for the operation. */
  applyOptimistic(base: G[], emoji: E, operation: 'add' | 'remove'): G[]
  /** Whether a group corresponds to the given emoji. */
  matchesEmoji(group: G, emoji: E): boolean
  /** Server-computed "current user is in this group" flag. */
  hasReacted(group: G): boolean
  /** Stable identity for a group, used to merge real data into optimistic. */
  groupKey(group: G): string
  /** Stable identity for an emoji, used for the per-toggle dedup key. */
  emojiKey(emoji: E): string
  /** Extract the entity id from a realtime payload. */
  entityIdFromRealtime(payload: any): string | undefined
  /** Reconcile delay after a local toggle (ms). Default 1500. */
  reconcileDelayMs?: number
  /** Reconcile delay when a realtime event arrives mid-optimistic (ms). Default 1500. */
  realtimeReconcileDelayMs?: number
  /** Cache TTL for skipping refetch (ms). Default 30000. */
  cacheTtlMs?: number
}

export interface ReactionEngine<G, E> {
  reactionsByEntity: Ref<Map<string, G[]>>
  getReactions: ComputedRef<(entityId: string) => G[]>
  hasUserReacted: ComputedRef<(entityId: string, emoji: E) => boolean>
  isLoadingReactions: ComputedRef<(entityId: string) => boolean>
  fetch(entityId: string, force?: boolean): Promise<void>
  fetchMultiple(entityIds: string[], force?: boolean): Promise<void>
  toggle(entityId: string, emoji: E): Promise<{ success: boolean; reason?: string }>
  handleRealtimeUpdate(payload: any): Promise<void>
  bulkSet(data: Record<string, G[]>): void
  setReactions(entityId: string, groups: G[]): void
  clearOptimisticState(entityId: string): void
  dispose(): void
}

export function createReactionEngine<G, E>(
  adapter: ReactionEngineAdapter<G, E>,
): ReactionEngine<G, E> {
  const cacheTtlMs = adapter.cacheTtlMs ?? 30000
  const reconcileDelayMs = adapter.reconcileDelayMs ?? 1500
  const realtimeReconcileDelayMs = adapter.realtimeReconcileDelayMs ?? 1500

  const reactionsByEntity = ref(new Map<string, G[]>()) as Ref<Map<string, G[]>>
  const optimisticByEntity = ref(new Map<string, G[]>()) as Ref<Map<string, G[]>>
  const lastFetched = ref(new Map<string, number>())
  const isLoading = ref(new Set<string>())
  const pendingToggleKeys = ref(new Set<string>())
  const pendingReconcileTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  let batchFetchInFlight: Promise<void> | null = null

  // `temp-` ids are unsaved optimistic messages; never hit the server for them.
  const isFetchable = (entityId: string) => !!entityId && !entityId.startsWith('temp-')

  const getReactions = computed(() => (entityId: string): G[] => {
    if (!entityId) return []
    return optimisticByEntity.value.get(entityId) ?? reactionsByEntity.value.get(entityId) ?? []
  })

  const findGroup = (groups: G[], emoji: E): G | undefined =>
    groups.find(g => adapter.matchesEmoji(g, emoji))

  const hasUserReacted = computed(() => (entityId: string, emoji: E): boolean => {
    const group = findGroup(getReactions.value(entityId), emoji)
    return group ? adapter.hasReacted(group) : false
  })

  const isLoadingReactions = computed(() => (entityId: string): boolean =>
    isLoading.value.has(entityId))

  async function fetch(entityId: string, force = false): Promise<void> {
    if (!isFetchable(entityId)) return

    const now = Date.now()
    if (!force && now - (lastFetched.value.get(entityId) || 0) < cacheTtlMs) return
    if (isLoading.value.has(entityId)) return

    try {
      isLoading.value.add(entityId)
      const result = await adapter.fetchBatch([entityId])
      reactionsByEntity.value.set(entityId, result[entityId] || [])
      lastFetched.value.set(entityId, now)
    } finally {
      isLoading.value.delete(entityId)
    }
  }

  async function fetchMultiple(entityIds: string[], force = false): Promise<void> {
    if (!entityIds.length) return
    if (batchFetchInFlight) return batchFetchInFlight

    const now = Date.now()
    const idsToFetch = (force
      ? entityIds
      : entityIds.filter(id => now - (lastFetched.value.get(id) || 0) >= cacheTtlMs)
    ).filter(isFetchable)

    if (!idsToFetch.length) return

    idsToFetch.forEach(id => isLoading.value.add(id))

    const run = (async () => {
      try {
        const grouped = await adapter.fetchBatch(idsToFetch)
        // Initialise every requested id (so "no reactions" is cached, not refetched).
        for (const id of idsToFetch) {
          reactionsByEntity.value.set(id, grouped[id] || [])
          lastFetched.value.set(id, now)
        }
      } finally {
        idsToFetch.forEach(id => isLoading.value.delete(id))
      }
    })()

    batchFetchInFlight = run.then(() => { batchFetchInFlight = null })
    return run
  }

  /**
   * Merge the latest server data into the existing optimistic group array
   * IN PLACE: same array + same group object references, only fields change.
   * This is what keeps <TransitionGroup> from animating chips on reconcile.
   */
  function syncOptimisticToReal(entityId: string): boolean {
    const optimistic = optimisticByEntity.value.get(entityId)
    if (!optimistic) return false
    const real = reactionsByEntity.value.get(entityId) || []

    const realByKey = new Map<string, G>()
    for (const g of real) realByKey.set(adapter.groupKey(g), g)

    // Drop optimistic groups that no longer exist server-side.
    for (let i = optimistic.length - 1; i >= 0; i--) {
      if (!realByKey.has(adapter.groupKey(optimistic[i]))) optimistic.splice(i, 1)
    }

    // Update existing groups in place; append new ones.
    const optByKey = new Map<string, G>()
    for (const g of optimistic) optByKey.set(adapter.groupKey(g), g)

    for (const realG of real) {
      const optG = optByKey.get(adapter.groupKey(realG))
      if (optG) Object.assign(optG as object, realG as object)
      else optimistic.push(realG)
    }
    return true
  }

  function scheduleReconcile(entityId: string, delayMs: number): void {
    if (pendingReconcileTimeouts.has(entityId)) return
    const timeoutId = setTimeout(async () => {
      pendingReconcileTimeouts.delete(entityId)
      lastFetched.value.delete(entityId)
      await fetch(entityId, true)
      syncOptimisticToReal(entityId)
    }, delayMs)
    pendingReconcileTimeouts.set(entityId, timeoutId)
  }

  async function toggle(entityId: string, emoji: E): Promise<{ success: boolean; reason?: string }> {
    const toggleKey = `${entityId}-${adapter.emojiKey(emoji)}`
    if (pendingToggleKeys.value.has(toggleKey)) {
      return { success: false, reason: 'duplicate_request' }
    }
    pendingToggleKeys.value.add(toggleKey)

    try {
      const base = reactionsByEntity.value.get(entityId) || []
      const currentlyReacted = hasUserReacted.value(entityId, emoji)
      const operation = currentlyReacted ? 'remove' : 'add'

      // Instant optimistic overlay before any network.
      optimisticByEntity.value.set(entityId, adapter.applyOptimistic(base, emoji, operation))

      await adapter.toggleOnServer(entityId, emoji, currentlyReacted)
      scheduleReconcile(entityId, reconcileDelayMs)
      return { success: true }
    } catch (error: any) {
      optimisticByEntity.value.delete(entityId) // rollback
      return { success: false, reason: error?.message || 'toggle_failed' }
    } finally {
      setTimeout(() => pendingToggleKeys.value.delete(toggleKey), 100)
    }
  }

  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const entityId = adapter.entityIdFromRealtime(payload)
    if (!entityId) return

    // A reconcile from our own toggle is already pending - let it handle it.
    if (pendingReconcileTimeouts.has(entityId)) return

    // Mid-optimistic: schedule a reconcile so other users' reactions still land.
    if (optimisticByEntity.value.has(entityId)) {
      scheduleReconcile(entityId, realtimeReconcileDelayMs)
      return
    }

    lastFetched.value.delete(entityId)
    await fetch(entityId, true)
  }

  function bulkSet(data: Record<string, G[]>): void {
    const now = Date.now()
    for (const [entityId, groups] of Object.entries(data)) {
      reactionsByEntity.value.set(entityId, groups)
      lastFetched.value.set(entityId, now)
    }
  }

  function setReactions(entityId: string, groups: G[]): void {
    reactionsByEntity.value.set(entityId, groups)
    lastFetched.value.set(entityId, Date.now())
  }

  function clearOptimisticState(entityId: string): void {
    optimisticByEntity.value.delete(entityId)
  }

  function dispose(): void {
    for (const t of pendingReconcileTimeouts.values()) clearTimeout(t)
    pendingReconcileTimeouts.clear()
    reactionsByEntity.value.clear()
    optimisticByEntity.value.clear()
    lastFetched.value.clear()
    isLoading.value.clear()
    pendingToggleKeys.value.clear()
    batchFetchInFlight = null
  }

  return {
    reactionsByEntity,
    getReactions,
    hasUserReacted,
    isLoadingReactions,
    fetch,
    fetchMultiple,
    toggle,
    handleRealtimeUpdate,
    bulkSet,
    setReactions,
    clearOptimisticState,
    dispose,
  }
}
