/**
 * History import in bridge settings: importProgress helpers, BridgeImportControls states and
 * the BridgeChannelPairs start / cancel wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeChannelPairs from '../BridgeChannelPairs.vue'
import { bridgeSupportsImport, importPercent, isImportablePair } from '../importProgress'
import type { ImportJob } from '../bridgeApi'
import { GUILD_ID, healthyBridge, iconStub, installBackend, makeI18n, makePair, missingKeys, rpcCalls } from './bridgeTestKit'

const { toast } = vi.hoisted(() => ({
  toast: { success: vi.fn(), error: vi.fn(), info: vi.fn(), warning: vi.fn() },
}))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))

const global = () => ({ plugins: [makeI18n()], stubs: { Icon: iconStub } })

beforeEach(() => {
  missingKeys.length = 0
  Object.values(toast).forEach((fn) => fn.mockReset())
  installBackend({}, () => [])
})

afterEach(() => {
  expect(missingKeys).toEqual([])
})

function makeJob(overrides: Partial<ImportJob> = {}): ImportJob {
  return {
    id: 'j1',
    harmony_channel_id: 'h-general',
    discord_channel_id: '11',
    state: 'running',
    phase: 'messages',
    cancel_requested: false,
    start_discord_message_id: '500',
    start_at: '2026-01-01T00:00:00Z',
    reached_discord_message_id: '300',
    reached_at: '2025-07-02T00:00:00Z',
    channel_created_at: '2025-01-01T00:00:00Z',
    threads_total: null,
    threads_done: 0,
    thread_cursor: null,
    imported_count: 120,
    skipped_count: 0,
    pins_skipped: 0,
    error: null,
    requested_via: 'harmony',
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    finished_at: null,
    ...overrides,
  }
}

const BRIDGE = healthyBridge({ bridge_version: '2.6.0', discord_guild_id: GUILD_ID })

function mountPairs(
  props: Partial<{ pairs: ReturnType<typeof makePair>[]; imports: ImportJob[]; bridge: typeof BRIDGE; encryptedChannelIds: string[]; attachmentMode: string | null }> = {},
) {
  return mount(BridgeChannelPairs, {
    props: {
      bridge: BRIDGE,
      pairs: [makePair()],
      harmonyChannels: [{ id: 'h-general', name: 'general', categoryName: null }],
      imports: [],
      ...props,
    },
    global: global(),
  })
}

describe('importProgress', () => {
  it('importPercent is 50 at the midpoint', () => {
    const job = makeJob({ start_at: '2026-01-01T00:00:00Z', channel_created_at: '2025-01-01T00:00:00Z', reached_at: '2025-07-02T12:00:00Z' })
    expect(importPercent(job)).toBe(50)
  })

  it('importPercent is null without channel_created_at, 100 when done, clamped otherwise', () => {
    expect(importPercent(makeJob({ channel_created_at: null }))).toBeNull()
    expect(importPercent(makeJob({ reached_at: null }))).toBeNull()
    expect(importPercent(makeJob({ state: 'done', channel_created_at: null }))).toBe(100)
    expect(importPercent(makeJob({ reached_at: '2024-01-01T00:00:00Z' }))).toBe(100)
    expect(importPercent(makeJob({ reached_at: '2026-06-01T00:00:00Z' }))).toBe(0)
  })

  it('bridgeSupportsImport needs 2.6.0 or later', () => {
    expect(bridgeSupportsImport('2.5.9')).toBe(false)
    expect(bridgeSupportsImport('2.6.0')).toBe(true)
    expect(bridgeSupportsImport('2.10.1')).toBe(true)
    expect(bridgeSupportsImport('3.0.0')).toBe(true)
    expect(bridgeSupportsImport(null)).toBe(false)
    expect(bridgeSupportsImport('dev')).toBe(false)
  })

  it('isImportablePair needs a Discord-to-Harmony direction and a plaintext channel', () => {
    expect(isImportablePair(makePair({ direction: 'both' }), { encrypted: false })).toBe(true)
    expect(isImportablePair(makePair({ direction: 'to_harmony' }), null)).toBe(true)
    expect(isImportablePair(makePair({ direction: 'to_discord' }), { encrypted: false })).toBe(false)
    expect(isImportablePair(makePair({ direction: 'both' }), { encrypted: true })).toBe(false)
  })
})

describe('BridgeChannelPairs import controls', () => {
  it('the button starts an import for that channel', async () => {
    const w = mountPairs()
    await w.get('[data-testid="import-start"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'] }])
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('Import all starts the importable pairs that have no job', async () => {
    const w = mountPairs()
    await w.get('[data-testid="import-all"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'] }])
  })

  it('Import all leaves out pairs whose job is done, queued or running', async () => {
    const pairs = [
      makePair({ harmony_channel_id: 'h-a', discord_channel_id: '1' }),
      makePair({ harmony_channel_id: 'h-b', discord_channel_id: '2' }),
      makePair({ harmony_channel_id: 'h-c', discord_channel_id: '3' }),
      makePair({ harmony_channel_id: 'h-d', discord_channel_id: '4' }),
      makePair({ harmony_channel_id: 'h-e', discord_channel_id: '5' }),
      makePair({ harmony_channel_id: 'h-f', discord_channel_id: '6' }),
      makePair({ harmony_channel_id: 'h-g', discord_channel_id: '7' }),
    ]
    const job = (id: string, channel: string, state: ImportJob['state']) =>
      makeJob({ id, harmony_channel_id: channel, discord_channel_id: id, state })
    const w = mountPairs({
      pairs,
      harmonyChannels: pairs.map((p) => ({ id: p.harmony_channel_id, name: p.harmony_channel_id, categoryName: null })),
      imports: [
        job('1', 'h-a', 'done'),
        job('2', 'h-b', 'failed'),
        job('3', 'h-c', 'cancelled'),
        job('4', 'h-d', 'paused'),
        job('5', 'h-e', 'running'),
        job('6', 'h-f', 'queued'),
      ],
    })
    await w.get('[data-testid="import-all"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_ids: ['h-b', 'h-c', 'h-d', 'h-g'] },
    ])
  })

  it('hides Import all when every importable pair is done or active', () => {
    const w = mountPairs({ imports: [makeJob({ state: 'done' })] })
    expect(w.find('[data-testid="import-all"]').exists()).toBe(false)
    const running = mountPairs({ imports: [makeJob({ state: 'running' })] })
    expect(running.find('[data-testid="import-all"]').exists()).toBe(false)
  })

  it('a running job shows its percent and Cancel cancels that job', async () => {
    const w = mountPairs({ imports: [makeJob()] })
    expect(w.get('[data-testid="import-state"]').text()).toBe('Importing… 50%')
    expect(w.get('[data-testid="import-detail"]').text()).toContain('Back to July 2025')
    expect(w.get('[data-testid="import-detail"]').text()).toContain('120 messages')
    expect(w.find('[data-testid="import-start"]').exists()).toBe(false)
    await w.get('[data-testid="import-cancel"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_cancel')).toEqual([{ p_bridge_id: 'b1', p_import_id: 'j1' }])
  })

  it('Cancel all cancels every job of the bridge', async () => {
    const w = mountPairs({ imports: [makeJob()] })
    await w.get('[data-testid="cancel-all"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_cancel')).toEqual([{ p_bridge_id: 'b1', p_import_id: null }])
  })

  it('a to_discord pair shows the ineligible text and no button', () => {
    const w = mountPairs({ pairs: [makePair({ direction: 'to_discord' })] })
    expect(w.get('[data-testid="import-ineligible"]').text()).toBe(
      'Only pairs that bring Discord messages to Harmony can import history',
    )
    expect(w.find('[data-testid="import-start"]').exists()).toBe(false)
    expect(w.find('[data-testid="import-all"]').exists()).toBe(false)
  })

  it('an encrypted channel cannot import', () => {
    const w = mountPairs({ encryptedChannelIds: ['h-general'] })
    expect(w.get('[data-testid="import-ineligible"]').text()).toBe("Encrypted channels can't import history")
    expect(w.find('[data-testid="import-start"]').exists()).toBe(false)
  })

  it('an old bridge shows the update text and no import buttons', () => {
    const w = mountPairs({ bridge: healthyBridge({ bridge_version: '2.5.0', discord_guild_id: GUILD_ID }) })
    expect(w.get('[data-testid="import-update-bridge"]').text()).toBe('Update the bridge to 2.6.0 or later to import history')
    expect(w.find('[data-testid="import-start"]').exists()).toBe(false)
    expect(w.find('[data-testid="import-all"]').exists()).toBe(false)
    expect(w.find('[data-testid="import-controls"]').exists()).toBe(false)
  })

  it('shows the state line for queued, done, failed, cancelled and paused jobs', () => {
    const text = (job: Partial<ImportJob>) => mountPairs({ imports: [makeJob(job)] }).get('[data-testid="import-state"]').text()
    expect(text({ state: 'queued' })).toBe('Waiting')
    expect(text({ state: 'done', imported_count: 42 })).toBe('Imported 42 messages')
    // A re-run over an already-imported channel adds nothing.
    expect(text({ state: 'done', imported_count: 0 })).toBe('Up to date: no new messages')
    expect(text({ state: 'failed', error: 'Missing Access' })).toBe('Import stopped: Missing Access')
    expect(text({ state: 'cancelled' })).toBe('Cancelled')
    expect(text({ state: 'paused' })).toBe('Paused: waiting for the bridge')
  })

  it('Try again and Resume start the pair again', async () => {
    const failed = mountPairs({ imports: [makeJob({ state: 'failed', error: 'x' })] })
    expect(failed.get('[data-testid="import-retry"]').text()).toBe('Try again')
    const cancelled = mountPairs({ imports: [makeJob({ state: 'cancelled' })] })
    expect(cancelled.get('[data-testid="import-retry"]').text()).toBe('Resume')
    await cancelled.get('[data-testid="import-retry"]').trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'] }])
  })

  it('shows thread progress during the thread phase', () => {
    const w = mountPairs({ imports: [makeJob({ phase: 'threads', threads_total: 9, threads_done: 4 })] })
    expect(w.get('[data-testid="import-detail"]').text()).toContain('Threads 4 of 9')
  })

  it('shows the mirror note only when the attachment mode is mirror', () => {
    expect(mountPairs({ attachmentMode: 'mirror' }).get('[data-testid="import-mirror-note"]').text()).toBe(
      "Imported files are copied into this instance's storage.",
    )
    expect(mountPairs({ attachmentMode: 'refresh' }).find('[data-testid="import-mirror-note"]').exists()).toBe(false)
    expect(mountPairs({ attachmentMode: null }).find('[data-testid="import-mirror-note"]').exists()).toBe(false)
  })

  it('maps pair_not_importable to a toast', async () => {
    installBackend({}, (name) => {
      if (name === 'discord_bridge_import_start') throw Object.assign(new Error('pair_not_importable'), { code: 'P0001' })
      return []
    })
    const w = mountPairs()
    await w.get('[data-testid="import-start"]').trigger('click')
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("can't import history"))
  })
})
