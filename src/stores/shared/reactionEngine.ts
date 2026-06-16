import { reactive, shallowReactive, computed, type ComputedRef } from 'vue'

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
  reactionsByEntity: Map<string, G[]>
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

  // shallowReactive() tracks Map mutations without unwrapping generic G[] values.
  const reactionsByEntity = shallowReactive(new Map<string, G[]>())
  const optimisticByEntity = shallowReactive(new Map<string, G[]>())
  const lastFetched = reactive(new Map<string, number>())
  const isLoading = reactive(new Set<string>())
  const pendingToggleKeys = reactive(new Set<string>())
  const pendingReconcileTimeouts = new Map<string, ReturnType<typeof setTimeout>>()
  let batchFetchInFlight: Promise<void> | null = null

  // `temp-` ids are unsaved optimistic messages; never hit the server for them.
  const isFetchable = (entityId: string) => !!entityId && !entityId.startsWith('temp-')

  const getReactions = computed(() => (entityId: string): G[] => {
    if (!entityId) return []
    return optimisticByEntity.get(entityId) ?? reactionsByEntity.get(entityId) ?? []
  })

  const findGroup = (groups: G[], emoji: E): G | undefined =>
    groups.find(g => adapter.matchesEmoji(g, emoji))

  const hasUserReacted = computed(() => (entityId: string, emoji: E): boolean => {
    const group = findGroup(getReactions.value(entityId), emoji)
    return group ? adapter.hasReacted(group) : false
  })

  const isLoadingReactions = computed(() => (entityId: string): boolean =>
    isLoading.has(entityId))

  async function fetch(entityId: string, force = false): Promise<void> {
    if (!isFetchable(entityId)) return

    const now = Date.now()
    if (!force && now - (lastFetched.get(entityId) || 0) < cacheTtlMs) return
    if (isLoading.has(entityId)) return

    try {
      isLoading.add(entityId)
      const result = await adapter.fetchBatch([entityId])
      reactionsByEntity.set(entityId, result[entityId] || [])
      lastFetched.set(entityId, now)
    } finally {
      isLoading.delete(entityId)
    }
  }

  async function fetchMultiple(entityIds: string[], force = false): Promise<void> {
    if (!entityIds.length) return
    if (batchFetchInFlight) return batchFetchInFlight

    const now = Date.now()
    const idsToFetch = (force
      ? entityIds
      : entityIds.filter(id => now - (lastFetched.get(id) || 0) >= cacheTtlMs)
    ).filter(isFetchable)

    if (!idsToFetch.length) return

    idsToFetch.forEach(id => isLoading.add(id))

    const run = (async () => {
      try {
        const grouped = await adapter.fetchBatch(idsToFetch)
        // Initialise every requested id (so "no reactions" is cached, not refetched).
        for (const id of idsToFetch) {
          reactionsByEntity.set(id, grouped[id] || [])
          lastFetched.set(id, now)
        }
      } finally {
        idsToFetch.forEach(id => isLoading.delete(id))
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
    const optimistic = optimisticByEntity.get(entityId)
    if (!optimistic) return false
    const real = reactionsByEntity.get(entityId) || []

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
    optimisticByEntity.set(entityId, [...optimistic])
    return true
  }

  function scheduleReconcile(entityId: string, delayMs: number): void {
    if (pendingReconcileTimeouts.has(entityId)) return
    const timeoutId = setTimeout(async () => {
      pendingReconcileTimeouts.delete(entityId)
      lastFetched.delete(entityId)
      await fetch(entityId, true)
      syncOptimisticToReal(entityId)
    }, delayMs)
    pendingReconcileTimeouts.set(entityId, timeoutId)
  }

  async function toggle(entityId: string, emoji: E): Promise<{ success: boolean; reason?: string }> {
    const toggleKey = `${entityId}-${adapter.emojiKey(emoji)}`
    if (pendingToggleKeys.has(toggleKey)) {
      return { success: false, reason: 'duplicate_request' }
    }
    pendingToggleKeys.add(toggleKey)

    try {
      const base = reactionsByEntity.get(entityId) || []
      const currentlyReacted = hasUserReacted.value(entityId, emoji)
      const operation = currentlyReacted ? 'remove' : 'add'

      optimisticByEntity.set(entityId, adapter.applyOptimistic(base, emoji, operation))

      await adapter.toggleOnServer(entityId, emoji, currentlyReacted)
      scheduleReconcile(entityId, reconcileDelayMs)
      return { success: true }
    } catch (error: any) {
      optimisticByEntity.delete(entityId)
      return { success: false, reason: error?.message || 'toggle_failed' }
    } finally {
      setTimeout(() => pendingToggleKeys.delete(toggleKey), 100)
    }
  }

  async function handleRealtimeUpdate(payload: any): Promise<void> {
    const entityId = adapter.entityIdFromRealtime(payload)
    if (!entityId) return

    if (adapter.applyRealtimeDelta) {
      const optimistic = optimisticByEntity.get(entityId)
      if (optimistic) {
        const updatedOptimistic = adapter.applyRealtimeDelta(optimistic, payload)
        if (updatedOptimistic) optimisticByEntity.set(entityId, updatedOptimistic)
      }

      let real = reactionsByEntity.get(entityId)
      if (!real) {
        lastFetched.delete(entityId)
        await fetch(entityId, true)
        real = reactionsByEntity.get(entityId) || []
      }

      const updatedReal = adapter.applyRealtimeDelta(real, payload)
      if (updatedReal) reactionsByEntity.set(entityId, updatedReal)
      return
    }

    if (pendingReconcileTimeouts.has(entityId)) return

    if (optimisticByEntity.has(entityId)) {
      scheduleReconcile(entityId, realtimeReconcileDelayMs)
      return
    }

    lastFetched.delete(entityId)
    await fetch(entityId, true)
  }

  function bulkSet(data: Record<string, G[]>): void {
    const now = Date.now()
    for (const [entityId, groups] of Object.entries(data)) {
      reactionsByEntity.set(entityId, groups)
      lastFetched.set(entityId, now)
    }
  }

  function setReactions(entityId: string, groups: G[]): void {
    reactionsByEntity.set(entityId, groups)
    lastFetched.set(entityId, Date.now())
  }

  function clearOptimisticState(entityId: string): void {
    optimisticByEntity.delete(entityId)
  }

  function dispose(): void {
    for (const t of pendingReconcileTimeouts.values()) clearTimeout(t)
    pendingReconcileTimeouts.clear()
    reactionsByEntity.clear()
    optimisticByEntity.clear()
    lastFetched.clear()
    isLoading.clear()
    pendingToggleKeys.clear()
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
