/**
 * History import in bridge settings: importProgress helpers, BridgeImportControls states and
 * the BridgeChannelPairs start / cancel wiring.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import BridgeChannelPairs from '../BridgeChannelPairs.vue'
import { bridgeSupportsImport, importPercent, isImportablePair } from '../importProgress'
import type { ImportJob } from '../bridgeApi'
import { GUILD_ID, SNAPSHOT, healthyBridge, iconStub, installBackend, makeI18n, makePair, missingKeys, rpcCalls } from './bridgeTestKit'

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
    authors_skipped: 0,
    automod_skipped: 0,
    error: null,
    requested_via: 'harmony',
    requested_by_remote: null,
    created_at: '2026-10-01T00:00:00Z',
    updated_at: '2026-10-01T00:00:00Z',
    finished_at: null,
    ...overrides,
  }
}

const BRIDGE = healthyBridge({ bridge_version: '2.6.0', discord_guild_id: GUILD_ID })

function mountPairs(
  props: Partial<{ pairs: ReturnType<typeof makePair>[]; imports: ImportJob[]; bridge: typeof BRIDGE; encryptedChannelIds: string[]; attachmentMode: string | null; importMode: string | null }> = {},
) {
  return mount(BridgeChannelPairs, {
    props: {
      bridge: BRIDGE,
      pairs: [makePair()],
      harmonyChannels: [{ id: 'h-general', name: 'general', categoryName: null }],
      imports: [],
      importMode: 'self_run',
      ...props,
    },
    global: global(),
  })
}

/** Ticks the consent box and presses the dialog's start button. */
async function agree(w: ReturnType<typeof mountPairs>, button = 'import-consent-start') {
  await w.get('[data-testid="import-consent-check"]').setValue(true)
  await w.get(`[data-testid="${button}"]`).trigger('click')
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
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'], p_include_private: false }])
    expect(w.emitted('changed')).toHaveLength(1)
  })

  it('nothing starts before the consent box is ticked, and Cancel closes the dialog', async () => {
    const w = mountPairs()
    await w.get('[data-testid="import-start"]').trigger('click')
    const dialog = w.get('[data-testid="import-consent"]')
    expect(dialog.attributes('role')).toBe('alertdialog')
    expect(dialog.text()).toContain('Import the history of 1 channel?')
    expect(dialog.text()).toContain('/bridge-privacy')
    expect(dialog.text()).toContain('left the Discord server are skipped')
    const start = w.get('[data-testid="import-consent-start"]')
    expect(start.attributes('disabled')).toBeDefined()
    await start.trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([])

    await w.get('[data-testid="import-consent-check"]').setValue(true)
    expect(w.get('[data-testid="import-consent-start"]').attributes('disabled')).toBeUndefined()
    await w.get('[data-testid="import-consent-cancel"]').trigger('click')
    expect(w.find('[data-testid="import-consent"]').exists()).toBe(false)
    expect(rpcCalls('discord_bridge_import_start')).toEqual([])

    // A second ask starts unticked.
    await w.get('[data-testid="import-start"]').trigger('click')
    expect((w.get('[data-testid="import-consent-check"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('says why import is unavailable: the instance switch is off, or self_run meets a bridge that is not self-run', async () => {
    for (const importMode of ['off', null, undefined, 'everything']) {
      for (const mode of ['self', 'instance'] as const) {
        const off = mountPairs({ importMode: importMode as string | null, bridge: healthyBridge({ bridge_version: '2.8.0', discord_guild_id: GUILD_ID, mode }) })
        expect(off.get('[data-testid="import-unavailable"]').text()).toBe('History import is turned off on this instance.')
        expect(off.find('[data-testid="import-start"]').exists()).toBe(false)
        expect(off.find('[data-testid="import-toolbar"]').exists()).toBe(false)
      }
    }
    for (const mode of ['instance', 'hosted'] as const) {
      const other = mountPairs({ bridge: healthyBridge({ bridge_version: '2.8.0', discord_guild_id: GUILD_ID, mode }) })
      expect(other.get('[data-testid="import-unavailable"]').attributes('data-reason')).toBe('bridge_mode')
      expect(other.get('[data-testid="import-unavailable"]').text()).toContain("their server's owner runs")
      expect(other.find('[data-testid="import-start"]').exists()).toBe(false)
    }
    expect(mountPairs().find('[data-testid="import-unavailable"]').exists()).toBe(false)
  })

  it('all lets the instance bot and hosted bridges import from bridge 2.8.0 on', async () => {
    for (const mode of ['instance', 'hosted', 'self'] as const) {
      const w = mountPairs({ importMode: 'all', bridge: healthyBridge({ bridge_version: '2.8.0', discord_guild_id: GUILD_ID, mode }) })
      expect(w.find('[data-testid="import-unavailable"]').exists()).toBe(false)
      await w.get('[data-testid="import-start"]').trigger('click')
      await agree(w)
      await flushPromises()
    }
    expect(rpcCalls('discord_bridge_import_start')).toHaveLength(3)

    const old = mountPairs({ importMode: 'all', bridge: healthyBridge({ bridge_version: '2.7.0', discord_guild_id: GUILD_ID, mode: 'instance' }) })
    expect(old.get('[data-testid="import-update-bridge"]').text()).toContain("This instance's bridge service needs version 2.8.0")
    const self = mountPairs({ importMode: 'all', bridge: healthyBridge({ bridge_version: '2.6.0', discord_guild_id: GUILD_ID, mode: 'self' }) })
    expect(self.find('[data-testid="import-update-bridge"]').exists()).toBe(false)
  })

  it('shows what a run left out for its authors and for AutoMod', () => {
    const running = mountPairs({ imports: [makeJob({ authors_skipped: 3, automod_skipped: 1 })] })
    expect(running.get('[data-testid="import-detail"]').text()).toContain('3 skipped (authors left or opted out)')
    expect(running.get('[data-testid="import-detail"]').text()).toContain('1 blocked by AutoMod')
    const done = mountPairs({ imports: [makeJob({ state: 'done', imported_count: 40, authors_skipped: 1 })] })
    expect(done.get('[data-testid="import-state"]').text()).toBe('Imported 40 messages · 1 skipped (author left or opted out)')
    const clean = mountPairs({ imports: [makeJob()] })
    expect(clean.get('[data-testid="import-detail"]').text()).not.toContain('skipped')
  })

  it('explains a private Discord channel that needs its import started on Discord', () => {
    const w = mountPairs({ imports: [makeJob({ state: 'failed', error: 'discord_approval_required' })] })
    expect(w.get('[data-testid="import-state"]').text()).toBe(
      'Import stopped: the Discord channel is private: start it again with private channels included, or run /bridge import-history scope:All bridged channels once on Discord',
    )
    const off = mountPairs({ imports: [makeJob({ state: 'failed', error: 'import_disabled' })] })
    expect(off.get('[data-testid="import-state"]').text()).toBe('Import stopped: history import was turned off')
    const purged = mountPairs({ imports: [makeJob({ state: 'failed', error: 'server_purged' })] })
    expect(purged.get('[data-testid="import-state"]').text()).toBe(
      'Import stopped: every bridged message of this server was removed; starting again imports the whole history',
    )
    const instancePurged = mountPairs({ imports: [makeJob({ state: 'failed', error: 'instance_purged' })] })
    expect(instancePurged.get('[data-testid="import-state"]').text()).toBe(
      'Import stopped: an instance admin removed every Discord message of this instance',
    )
  })

  it('Import all starts the importable pairs that have no job', async () => {
    const w = mountPairs()
    await w.get('[data-testid="import-all"]').trigger('click')
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'], p_include_private: false }])
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
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_ids: ['h-b', 'h-c', 'h-d', 'h-g'], p_include_private: false },
    ])
  })

  it('hides Import all when every importable pair is done or active', () => {
    const w = mountPairs({ imports: [makeJob({ state: 'done' })] })
    expect(w.find('[data-testid="import-all"]').exists()).toBe(false)
    const running = mountPairs({ imports: [makeJob({ state: 'running' })] })
    expect(running.find('[data-testid="import-all"]').exists()).toBe(false)
  })

  it('offers Import all again once every importable pair is done, and runs them after a confirm', async () => {
    const pairs = [
      makePair({ harmony_channel_id: 'h-a', discord_channel_id: '1' }),
      makePair({ harmony_channel_id: 'h-b', discord_channel_id: '2' }),
      makePair({ harmony_channel_id: 'h-c', discord_channel_id: '3', direction: 'to_discord' }),
    ]
    const w = mountPairs({
      pairs,
      harmonyChannels: pairs.map((p) => ({ id: p.harmony_channel_id, name: p.harmony_channel_id, categoryName: null })),
      imports: [
        makeJob({ id: '1', harmony_channel_id: 'h-a', discord_channel_id: '1', state: 'done' }),
        makeJob({ id: '2', harmony_channel_id: 'h-b', discord_channel_id: '2', state: 'done' }),
      ],
    })
    expect(w.find('[data-testid="import-all"]').exists()).toBe(false)
    await w.get('[data-testid="import-all-again"]').trigger('click')
    expect(rpcCalls('discord_bridge_import_start')).toEqual([])
    expect(w.get('[data-testid="import-all-again-confirm"]').text()).toContain('all 2 channels')
    expect(w.get('[data-testid="import-all-again-yes"]').attributes('disabled')).toBeDefined()
    await agree(w, 'import-all-again-yes')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-a', 'h-b'], p_include_private: false }])
    expect(w.find('[data-testid="import-all-again-confirm"]').exists()).toBe(false)
  })

  it('hides Import all again while Import all has work or a job is active', () => {
    const pending = mountPairs({
      pairs: [makePair({ harmony_channel_id: 'h-a', discord_channel_id: '1' }), makePair({ harmony_channel_id: 'h-b', discord_channel_id: '2' })],
      imports: [makeJob({ harmony_channel_id: 'h-a', state: 'done' })],
    })
    expect(pending.find('[data-testid="import-all"]').exists()).toBe(true)
    expect(pending.find('[data-testid="import-all-again"]').exists()).toBe(false)
    const running = mountPairs({
      pairs: [makePair({ harmony_channel_id: 'h-a', discord_channel_id: '1' }), makePair({ harmony_channel_id: 'h-b', discord_channel_id: '2' })],
      imports: [makeJob({ id: '1', harmony_channel_id: 'h-a', state: 'done' }), makeJob({ id: '2', harmony_channel_id: 'h-b', state: 'running' })],
    })
    expect(running.find('[data-testid="import-all-again"]').exists()).toBe(false)
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

  it('a job its bridge has not stopped yet offers Stop now, which cancels it again', async () => {
    const w = mountPairs({ imports: [makeJob({ cancel_requested: true })] })
    expect(w.get('[data-testid="import-state"]').text()).toBe('Cancelling…')
    expect(w.find('[data-testid="import-cancel"]').exists()).toBe(false)
    expect(w.get('[data-testid="import-stop-hint"]').text()).toContain('If it is offline')
    const stop = w.get('[data-testid="import-stop"]')
    expect(stop.attributes('disabled')).toBeUndefined()
    expect(stop.attributes('aria-label')).toBe('Stop the import for #general now')
    await stop.trigger('click')
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_cancel')).toEqual([{ p_bridge_id: 'b1', p_import_id: 'j1' }])
  })

  it('a paused job offers Resume for its channel', async () => {
    const w = mountPairs({ imports: [makeJob({ state: 'paused' })] })
    expect(w.get('[data-testid="import-retry"]').text()).toBe('Resume')
    await w.get('[data-testid="import-retry"]').trigger('click')
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'], p_include_private: false }])
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
    await agree(cancelled)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([{ p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'], p_include_private: false }])
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
    await agree(w)
    await flushPromises()
    expect(toast.error).toHaveBeenCalledWith(expect.stringContaining("can't import history"))
  })
})

describe('BridgeChannelPairs private Discord channels', () => {
  // Bridge 2.8.0 reports everyone_can_view: #general is public, #memes is private.
  const withVisibility = (map: Record<string, boolean>) => ({
    guilds: SNAPSHOT.guilds.map((g) => ({
      ...g,
      channels: g.channels.map((c) => (c.id in map ? { ...c, everyone_can_view: map[c.id] } : c)),
    })),
  })
  const PAIRS = [
    makePair({ id: 'p1', harmony_channel_id: 'h-general', discord_channel_id: '11', discord_channel_name: 'general' }),
    makePair({ id: 'p2', harmony_channel_id: 'h-memes', discord_channel_id: '14', discord_channel_name: 'memes' }),
  ]
  const CHANNELS = [
    { id: 'h-general', name: 'general', categoryName: null },
    { id: 'h-memes', name: 'memes', categoryName: null },
  ]
  const mountPrivate = (snapshot: unknown = withVisibility({ '11': true, '14': false })) =>
    mount(BridgeChannelPairs, {
      props: {
        bridge: healthyBridge({ bridge_version: '2.8.0', discord_guild_id: GUILD_ID, snapshot }),
        pairs: PAIRS,
        harmonyChannels: CHANNELS,
        imports: [],
        importMode: 'all',
      },
      global: global(),
    })

  it('marks a pair whose Discord channel @everyone cannot read', () => {
    const w = mountPrivate()
    const rows = w.findAll('[data-testid="pair-row"]')
    expect(rows[0].find('[data-testid="pair-private"]').exists()).toBe(false)
    expect(rows[1].get('[data-testid="pair-private"]').text()).toBe('Private on Discord')
  })

  it('Import all leaves the private channels out unless the second box is ticked', async () => {
    const w = mountPrivate()
    await w.get('[data-testid="import-all"]').trigger('click')
    expect(w.get('[data-testid="import-private"]').text()).toContain('Private on Discord: #memes')
    expect(w.get('[data-testid="import-private"]').text()).toContain('cannot read their history on Discord')
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general'], p_include_private: false },
    ])
  })

  it('the second box includes them and records the consent', async () => {
    const w = mountPrivate()
    await w.get('[data-testid="import-all"]').trigger('click')
    await w.get('[data-testid="import-private-check"]').setValue(true)
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general', 'h-memes'], p_include_private: true },
    ])
  })

  it('a private channel alone cannot start without the second box', async () => {
    const w = mountPrivate()
    const rows = w.findAll('[data-testid="pair-row"]')
    await rows[1].get('[data-testid="import-start"]').trigger('click')
    await w.get('[data-testid="import-consent-check"]').setValue(true)
    expect(w.get('[data-testid="import-consent-start"]').attributes('disabled')).toBeDefined()
    await w.get('[data-testid="import-private-check"]').setValue(true)
    expect(w.get('[data-testid="import-consent-start"]').attributes('disabled')).toBeUndefined()
    // A new ask starts with both boxes unticked.
    await w.get('[data-testid="import-consent-cancel"]').trigger('click')
    await rows[1].get('[data-testid="import-start"]').trigger('click')
    expect((w.get('[data-testid="import-private-check"]').element as HTMLInputElement).checked).toBe(false)
  })

  it('asks nothing more of a bridge that does not report @everyone visibility', async () => {
    const w = mountPrivate(SNAPSHOT)
    expect(w.find('[data-testid="pair-private"]').exists()).toBe(false)
    await w.get('[data-testid="import-all"]').trigger('click')
    expect(w.find('[data-testid="import-private"]').exists()).toBe(false)
    await agree(w)
    await flushPromises()
    expect(rpcCalls('discord_bridge_import_start')).toEqual([
      { p_bridge_id: 'b1', p_harmony_channel_ids: ['h-general', 'h-memes'], p_include_private: false },
    ])
  })
})
