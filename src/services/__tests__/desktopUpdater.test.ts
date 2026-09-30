import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  isTauriDesktop: vi.fn(() => true),
  windowLabel: { value: 'main' },
  getVersion: vi.fn(async () => '1.6.1'),
  nativeStatus: { value: 'enabled' as string },
  invoke: vi.fn(),
  check: vi.fn(),
  relaunch: vi.fn(async () => {}),
}))

vi.mock('@/utils/platform', () => ({ isTauriDesktop: mocks.isTauriDesktop }))
vi.mock('@tauri-apps/api/window', () => ({
  getCurrentWindow: () => ({ label: mocks.windowLabel.value }),
}))
vi.mock('@tauri-apps/api/app', () => ({ getVersion: mocks.getVersion }))
vi.mock('@tauri-apps/api/core', () => ({ invoke: mocks.invoke }))
vi.mock('@tauri-apps/plugin-updater', () => ({ check: mocks.check }))
vi.mock('@tauri-apps/plugin-process', () => ({ relaunch: mocks.relaunch }))

type Mod = typeof import('../desktopUpdater')

interface FakeUpdate {
  version: string
  body?: string
  download: ReturnType<typeof vi.fn>
  install: ReturnType<typeof vi.fn>
  close: ReturnType<typeof vi.fn>
}

function fakeUpdate(version = '1.6.2', opts: { failDownload?: boolean; hold?: boolean } = {}) {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const update: FakeUpdate = {
    version,
    body: 'notes',
    download: vi.fn(async (onEvent: (e: unknown) => void) => {
      onEvent({ event: 'Started', data: { contentLength: 200 } })
      onEvent({ event: 'Progress', data: { chunkLength: 50 } })
      if (opts.hold) await gate
      if (opts.failDownload) throw new Error('signature mismatch')
      onEvent({ event: 'Progress', data: { chunkLength: 150 } })
      onEvent({ event: 'Finished' })
    }),
    install: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
  }
  return { update, release }
}

async function load(): Promise<Mod> {
  vi.resetModules()
  return import('../desktopUpdater')
}

async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  localStorage.clear()
  mocks.isTauriDesktop.mockReturnValue(true)
  mocks.windowLabel.value = 'main'
  mocks.nativeStatus.value = 'enabled'
  mocks.invoke.mockReset().mockImplementation(async (cmd: string) => {
    if (cmd === 'updater_status') return mocks.nativeStatus.value
    throw new Error(`unexpected command ${cmd}`)
  })
  mocks.check.mockReset().mockResolvedValue(null)
  mocks.relaunch.mockClear()
  mocks.getVersion.mockClear()
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('initDesktopUpdater gating', () => {
  it('stays inert outside the desktop runtime', async () => {
    mocks.isTauriDesktop.mockReturnValue(false)
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('unavailable')
    expect(mocks.invoke).not.toHaveBeenCalled()
    expect(await m.checkForUpdates()).toBeNull()
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it('stays inert in windows other than main', async () => {
    mocks.windowLabel.value = 'oauth'
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('unavailable')
    expect(mocks.invoke).not.toHaveBeenCalled()
  })

  it('treats the placeholder pubkey build as not configured and never checks', async () => {
    mocks.nativeStatus.value = 'not-configured'
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('not-configured')
    expect(m.updaterState.currentVersion).toBe('1.6.1')

    await vi.advanceTimersByTimeAsync(m.CHECK_INTERVAL_MS * 2)
    expect(await m.checkForUpdates()).toBeNull()
    expect(mocks.check).not.toHaveBeenCalled()
    expect(m.updaterState.phase).toBe('not-configured')
  })

  it('treats a failing status command as not configured', async () => {
    mocks.invoke.mockRejectedValue(new Error('command updater_status not found'))
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('not-configured')
  })

  it('reports installs the plugin cannot replace as unsupported', async () => {
    mocks.nativeStatus.value = 'unsupported'
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('unsupported')
    await vi.advanceTimersByTimeAsync(m.CHECK_INTERVAL_MS)
    expect(mocks.check).not.toHaveBeenCalled()
  })

  it('is idempotent', async () => {
    const m = await load()
    await Promise.all([m.initDesktopUpdater(), m.initDesktopUpdater()])
    expect(mocks.invoke).toHaveBeenCalledTimes(1)
  })
})

describe('scheduling', () => {
  it('checks shortly after startup, then every interval', async () => {
    const m = await load()
    await m.initDesktopUpdater()
    expect(m.updaterState.phase).toBe('idle')
    expect(mocks.check).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(m.STARTUP_DELAY_MS)
    expect(mocks.check).toHaveBeenCalledTimes(1)
    expect(m.updaterState.lastOutcome).toBe('up-to-date')
    expect(m.updaterState.phase).toBe('idle')

    await vi.advanceTimersByTimeAsync(m.CHECK_INTERVAL_MS)
    expect(mocks.check).toHaveBeenCalledTimes(2)
  })

  it('runs a stale check when the window becomes visible', async () => {
    const add = vi.spyOn(document, 'addEventListener')
    const m = await load()
    await m.initDesktopUpdater()
    const handler = add.mock.calls.find(([type]) => type === 'visibilitychange')?.[1] as () => void
    add.mockRestore()
    expect(handler).toBeTypeOf('function')

    handler()
    await flush()
    expect(mocks.check).toHaveBeenCalledTimes(1)

    handler()
    await flush()
    expect(mocks.check).toHaveBeenCalledTimes(1)
  })
})

describe('check and download', () => {
  it('downloads in the background and becomes ready without restarting', async () => {
    const { update, release } = fakeUpdate('1.6.2', { hold: true })
    mocks.check.mockResolvedValue(update)
    const m = await load()
    await m.initDesktopUpdater()

    const outcome = await m.checkForUpdates()
    expect(outcome).toBe('update-found')
    expect(m.updaterState.phase).toBe('downloading')
    expect(m.updaterState.availableVersion).toBe('1.6.2')
    expect(m.updaterState.totalBytes).toBe(200)
    expect(m.updaterState.downloadedBytes).toBe(50)

    release()
    await flush()
    expect(m.updaterState.phase).toBe('ready')
    expect(m.updaterState.downloadedBytes).toBe(200)
    expect(update.install).not.toHaveBeenCalled()
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('holds a found update when automatic download is off', async () => {
    const { update } = fakeUpdate()
    mocks.check.mockResolvedValue(update)
    const m = await load()
    m.setAutoDownload(false)
    await m.initDesktopUpdater()

    await m.checkForUpdates()
    expect(m.updaterState.phase).toBe('available')
    expect(update.download).not.toHaveBeenCalled()

    await m.downloadUpdate()
    expect(m.updaterState.phase).toBe('ready')
  })

  it('starts a held download when automatic download is switched on', async () => {
    const { update } = fakeUpdate()
    mocks.check.mockResolvedValue(update)
    const m = await load()
    m.setAutoDownload(false)
    await m.initDesktopUpdater()
    await m.checkForUpdates()

    m.setAutoDownload(true)
    await flush()
    expect(update.download).toHaveBeenCalledTimes(1)
    expect(m.updaterState.phase).toBe('ready')
  })

  it('persists the automatic download preference per device', async () => {
    let m = await load()
    expect(m.updaterState.autoDownload).toBe(true)
    m.setAutoDownload(false)
    m = await load()
    expect(m.updaterState.autoDownload).toBe(false)
  })

  it('records a failed check and recovers on the next one', async () => {
    mocks.check.mockRejectedValueOnce(new Error('network down'))
    const m = await load()
    await m.initDesktopUpdater()

    expect(await m.checkForUpdates()).toBe('failed')
    expect(m.updaterState.phase).toBe('error')
    expect(m.updaterState.error).toBe('network down')

    expect(await m.checkForUpdates()).toBe('up-to-date')
    expect(m.updaterState.phase).toBe('idle')
    expect(m.updaterState.error).toBeNull()
  })

  it('discards the update when download or verification fails', async () => {
    const { update } = fakeUpdate('1.6.2', { failDownload: true })
    mocks.check.mockResolvedValue(update)
    const m = await load()
    await m.initDesktopUpdater()
    await m.checkForUpdates()
    await flush()

    expect(m.updaterState.phase).toBe('error')
    expect(m.updaterState.error).toBe('signature mismatch')
    expect(update.close).toHaveBeenCalled()
  })

  it('ignores checks while busy and keeps a ready payload', async () => {
    const { update, release } = fakeUpdate('1.6.2', { hold: true })
    mocks.check.mockResolvedValue(update)
    const m = await load()
    await m.initDesktopUpdater()
    await m.checkForUpdates()

    expect(await m.checkForUpdates()).toBeNull()
    release()
    await flush()
    expect(m.updaterState.phase).toBe('ready')

    expect(await m.checkForUpdates()).toBe('update-found')
    expect(mocks.check).toHaveBeenCalledTimes(1)
    expect(update.close).not.toHaveBeenCalled()
  })
})

describe('install', () => {
  async function readyModule() {
    const { update } = fakeUpdate()
    mocks.check.mockResolvedValue(update)
    const m = await load()
    await m.initDesktopUpdater()
    await m.checkForUpdates()
    await flush()
    expect(m.updaterState.phase).toBe('ready')
    return { m, update }
  }

  it('opens the prompt only when an update is ready', async () => {
    const m = await load()
    m.openUpdatePrompt()
    expect(m.updaterState.promptOpen).toBe(false)

    const ready = await readyModule()
    ready.m.openUpdatePrompt()
    expect(ready.m.updaterState.promptOpen).toBe(true)
    ready.m.closeUpdatePrompt()
    expect(ready.m.updaterState.promptOpen).toBe(false)
  })

  it('installs then relaunches on request', async () => {
    const { m, update } = await readyModule()
    m.openUpdatePrompt()
    await m.installAndRestart()
    expect(update.install).toHaveBeenCalledTimes(1)
    expect(mocks.relaunch).toHaveBeenCalledTimes(1)
    expect(update.install.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.relaunch.mock.invocationCallOrder[0],
    )
    expect(m.updaterState.promptOpen).toBe(false)
    expect(m.updaterState.phase).toBe('installing')
  })

  it('does nothing before an update is ready', async () => {
    const m = await load()
    await m.initDesktopUpdater()
    await m.installAndRestart()
    expect(mocks.relaunch).not.toHaveBeenCalled()
  })

  it('surfaces an install failure without relaunching', async () => {
    const { m, update } = await readyModule()
    update.install.mockRejectedValueOnce(new Error('permission denied'))
    await expect(m.installAndRestart()).rejects.toThrow('permission denied')
    expect(mocks.relaunch).not.toHaveBeenCalled()
    expect(m.updaterState.phase).toBe('error')
    expect(m.updaterState.error).toBe('permission denied')
  })
})

describe('claimReadyAnnouncement', () => {
  it('announces each version once per device', async () => {
    const m = await load()
    expect(m.claimReadyAnnouncement('1.6.2')).toBe(true)
    expect(m.claimReadyAnnouncement('1.6.2')).toBe(false)
    expect(m.claimReadyAnnouncement('1.6.3')).toBe(true)
  })
})

describe('useDesktopUpdater', () => {
  it('derives download percent from progress', async () => {
    const { update, release } = fakeUpdate('1.6.2', { hold: true })
    mocks.check.mockResolvedValue(update)
    const m = await load()
    const { useDesktopUpdater } = await import('@/composables/useDesktopUpdater')
    const u = useDesktopUpdater()
    await m.initDesktopUpdater()
    expect(u.isActive.value).toBe(true)

    await m.checkForUpdates()
    expect(u.isBusy.value).toBe(true)
    expect(u.downloadPercent.value).toBe(25)

    release()
    await flush()
    expect(u.isReady.value).toBe(true)
    expect(u.downloadPercent.value).toBeNull()
  })
})
