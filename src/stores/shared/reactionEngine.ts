import { ref, computed, type Ref, type ComputedRef } from 'vue'

/** Shared reaction orchestration for message and post reaction stores. */
export interface ReactionEngineAdapter<G, E> {
  fetchBatch(entityIds: string[]): Promise<Record<string, G[]>>
  toggleOnServer(entityId: string, emoji: E, currentlyReacted: boolean): Promise<void>
  applyOptimistic(base: G[], emoji: E, operation: 'add' | 'remove'): G[]
  /**
   * Apply a realtime broadcast event in place (no refetch), returning the new
   * group array or null if the payload can't be applied. When provided,
   * handleRealtimeUpdate uses this instead of refetching - avoiding an RPC per
   * event per viewer (thundering herd) at scale.
   */
  applyRealtimeDelta?(base: G[], payload: any): G[] | null
  matchesEmoji(group: G, emoji: E): boolean
  hasReacted(group: G): boolean
  groupKey(group: G): string
  emojiKey(emoji: E): string
  entityIdFromRealtime(payload: any): string | undefined
  reconcileDelayMs?: number
  realtimeReconcileDelayMs?: number
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
   * Merge server data into the optimistic group array in place so
   * <TransitionGroup> doesn't re-animate chips on reconcile.
   */
  function syncOptimisticToReal(entityId: string): boolean {
    const optimistic = optimisticByEntity.value.get(entityId)
    if (!optimistic) return false
    const real = reactionsByEntity.value.get(entityId) || []

    const realByKey = new Map<string, G>()
    for (const g of real) realByKey.set(adapter.groupKey(g), g)

    for (let i = optimistic.length - 1; i >= 0; i--) {
      if (!realByKey.has(adapter.groupKey(optimistic[i]))) optimistic.splice(i, 1)
    }

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

    // Scalable path: apply the broadcast delta in place, no RPC. Dedup in the
    // adapter makes our own echoed event a no-op, so this is safe even mid-toggle.
    if (adapter.applyRealtimeDelta) {
      // Keep any live optimistic overlay in sync so the viewer's own pending
      // changes and incoming remote changes coexist.
      const optimistic = optimisticByEntity.value.get(entityId)
      if (optimistic) {
        const updatedOptimistic = adapter.applyRealtimeDelta(optimistic, payload)
        if (updatedOptimistic) optimisticByEntity.value.set(entityId, updatedOptimistic)
      }

      const real = reactionsByEntity.value.get(entityId)
      if (!real) {
        // No base cached yet - fetch once so later deltas have something to apply to.
        lastFetched.value.delete(entityId)
        await fetch(entityId, true)
        return
      }

      const updatedReal = adapter.applyRealtimeDelta(real, payload)
      if (updatedReal) reactionsByEntity.value.set(entityId, updatedReal)
      return
    }

    // Legacy refetch path (e.g. post reactions, which fan out only to the author).
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
