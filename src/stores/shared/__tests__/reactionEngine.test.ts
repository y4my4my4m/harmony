import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { createReactionEngine, type ReactionEngineAdapter } from '../reactionEngine'

interface Group {
  key: string
  count: number
  reacted: boolean
}
interface EmojiInput {
  key: string
}

/** Build an engine over an in-memory server with spy-able adapter methods. */
function setup(initial: Record<string, Group[]> = {}, opts: { withDelta?: boolean } = {}) {
  const server: Record<string, Group[]> = JSON.parse(JSON.stringify(initial))

  const fetchBatch = vi.fn(async (ids: string[]) => {
    const out: Record<string, Group[]> = {}
    for (const id of ids) out[id] = JSON.parse(JSON.stringify(server[id] || []))
    return out
  })

  const toggleOnServer = vi.fn(async (entityId: string, emoji: EmojiInput, currentlyReacted: boolean) => {
    const groups = server[entityId] || (server[entityId] = [])
    const g = groups.find(x => x.key === emoji.key)
    if (currentlyReacted) {
      if (g) {
        g.count -= 1
        g.reacted = false
        if (g.count <= 0) server[entityId] = groups.filter(x => x.key !== emoji.key)
      }
    } else if (g) {
      g.count += 1
      g.reacted = true
    } else {
      groups.push({ key: emoji.key, count: 1, reacted: true })
    }
  })

  const adapter: ReactionEngineAdapter<Group, EmojiInput> = {
    fetchBatch,
    toggleOnServer,
    applyOptimistic(base, emoji, operation) {
      const result: Group[] = JSON.parse(JSON.stringify(base))
      const idx = result.findIndex(g => g.key === emoji.key)
      if (operation === 'add') {
        if (idx >= 0) { result[idx].count += 1; result[idx].reacted = true }
        else result.push({ key: emoji.key, count: 1, reacted: true })
      } else if (idx >= 0) {
        result[idx].count -= 1
        result[idx].reacted = false
        if (result[idx].count <= 0) result.splice(idx, 1)
      }
      return result
    },
    matchesEmoji: (g, e) => g.key === e.key,
    hasReacted: (g) => g.reacted,
    groupKey: (g) => g.key,
    emojiKey: (e) => e.key,
    entityIdFromRealtime: (p) => p?.entityId,
    reconcileDelayMs: 1500,
  }

  if (opts.withDelta) {
    adapter.applyRealtimeDelta = (base: Group[], payload: any) => {
      const result: Group[] = JSON.parse(JSON.stringify(base))
      const idx = result.findIndex(g => g.key === payload.key)
      if (payload.op === 'add') {
        if (idx >= 0) { result[idx].count += 1; if (payload.isCurrentUser) result[idx].reacted = true }
        else result.push({ key: payload.key, count: 1, reacted: !!payload.isCurrentUser })
      } else if (idx >= 0) {
        result[idx].count -= 1
        if (payload.isCurrentUser) result[idx].reacted = false
        if (result[idx].count <= 0) result.splice(idx, 1)
      }
      return result
    }
  }

  return { engine: createReactionEngine(adapter), server, fetchBatch, toggleOnServer }
}

describe('reactionEngine', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('applies an optimistic add instantly, before the server resolves', async () => {
    const { engine } = setup()
    const p = engine.toggle('e1', { key: '👍' })
    // Synchronously after calling toggle, the overlay is already visible.
    const groups = engine.getReactions.value('e1')
    expect(groups).toHaveLength(1)
    expect(groups[0]).toMatchObject({ key: '👍', count: 1, reacted: true })
    await p
  })

  it('dedupes concurrent toggles of the same emoji', async () => {
    const { engine, toggleOnServer } = setup()
    const [r1, r2] = await Promise.all([
      engine.toggle('e1', { key: '👍' }),
      engine.toggle('e1', { key: '👍' }),
    ])
    expect(r1.success).toBe(true)
    expect(r2).toEqual({ success: false, reason: 'duplicate_request' })
    expect(toggleOnServer).toHaveBeenCalledTimes(1)
  })

  it('toggles off when already reacted (server-boolean drives the decision)', async () => {
    const { engine, server } = setup({ e1: [{ key: '👍', count: 1, reacted: true }] })
    await engine.fetchMultiple(['e1'], true)
    expect(engine.hasUserReacted.value('e1', { key: '👍' })).toBe(true)

    await engine.toggle('e1', { key: '👍' })
    // Optimistic removal drops the group.
    expect(engine.getReactions.value('e1')).toHaveLength(0)
    expect(server.e1).toHaveLength(0)
  })

  it('rolls back the optimistic overlay when the server errors', async () => {
    const { engine, toggleOnServer } = setup()
    toggleOnServer.mockRejectedValueOnce(new Error('boom'))
    const r = await engine.toggle('e1', { key: '👍' })
    expect(r.success).toBe(false)
    expect(engine.getReactions.value('e1')).toHaveLength(0) // overlay cleared
  })

  it('reconciles server data into the optimistic overlay in place', async () => {
    const { engine, server } = setup()
    await engine.toggle('e1', { key: '👍' })
    // Simulate another user also reacting on the server before reconcile.
    server.e1.push({ key: '🎉', count: 3, reacted: false })

    await vi.runAllTimersAsync() // fire the reconcile timeout + its async fetch

    const groups = engine.getReactions.value('e1')
    const keys = groups.map(g => g.key).sort()
    expect(keys).toEqual(['🎉', '👍'])
    expect(groups.find(g => g.key === '👍')).toMatchObject({ count: 1, reacted: true })
  })

  it('dedupes concurrent batch fetches into a single call', async () => {
    const { engine, fetchBatch } = setup({ e1: [], e2: [] })
    await Promise.all([
      engine.fetchMultiple(['e1', 'e2'], true),
      engine.fetchMultiple(['e1', 'e2'], true),
    ])
    expect(fetchBatch).toHaveBeenCalledTimes(1)
  })

  it('never fetches optimistic temp- ids', async () => {
    const { engine, fetchBatch } = setup()
    await engine.fetch('temp-abc', true)
    expect(fetchBatch).not.toHaveBeenCalled()
  })

  describe('realtime delta (broadcast) path', () => {
    it('applies a remote add in place without refetching', async () => {
      const { engine, fetchBatch } = setup({ e1: [] }, { withDelta: true })
      await engine.fetchMultiple(['e1'], true)
      fetchBatch.mockClear()

      await engine.handleRealtimeUpdate({ entityId: 'e1', key: '🎉', op: 'add', isCurrentUser: false })

      const groups = engine.getReactions.value('e1')
      expect(groups).toEqual([{ key: '🎉', count: 1, reacted: false }])
      expect(fetchBatch).not.toHaveBeenCalled()
    })

    it('applies a remote remove in place', async () => {
      const { engine } = setup({ e1: [{ key: '👍', count: 2, reacted: false }] }, { withDelta: true })
      await engine.fetchMultiple(['e1'], true)

      await engine.handleRealtimeUpdate({ entityId: 'e1', key: '👍', op: 'remove', isCurrentUser: false })

      expect(engine.getReactions.value('e1')).toEqual([{ key: '👍', count: 1, reacted: false }])
    })

    it('fetches once when no base is cached, then applies the delta', async () => {
      const { engine, fetchBatch } = setup({ e1: [{ key: '👍', count: 1, reacted: false }] }, { withDelta: true })
      await engine.handleRealtimeUpdate({ entityId: 'e1', key: '👍', op: 'add', isCurrentUser: false })
      expect(fetchBatch).toHaveBeenCalledTimes(1)
      expect(engine.getReactions.value('e1')).toEqual([{ key: '👍', count: 2, reacted: false }])
    })

    it('keeps the optimistic overlay consistent with remote deltas', async () => {
      const { engine } = setup({ e1: [] }, { withDelta: true })
      await engine.fetchMultiple(['e1'], true) // base cached on load, as in real usage
      // Our own optimistic add creates an overlay.
      const p = engine.toggle('e1', { key: '👍' })
      // A different user reacts with another emoji while our overlay is live.
      await engine.handleRealtimeUpdate({ entityId: 'e1', key: '🎉', op: 'add', isCurrentUser: false })
      const keys = engine.getReactions.value('e1').map(g => g.key).sort()
      expect(keys).toEqual(['🎉', '👍'])
      await p
    })
  })
})
