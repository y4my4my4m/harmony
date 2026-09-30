// In-app updates for the desktop build (tauri-plugin-updater). Plugin modules
// are imported dynamically so the web bundle carries none of their code.
//
// Phases:
//   unavailable     not the desktop runtime; nothing runs
//   not-configured  build has no signing pubkey; nothing runs
//   unsupported     install the plugin cannot replace (Linux outside AppImage)
//   idle -> checking -> (idle | available | downloading)
//   available -> downloading          auto-download off; user starts it
//   downloading -> ready              verified payload held in memory
//   ready -> installing               user clicked "Restart to update"
//   any active phase -> error         retried on the next check
//
// A downloaded payload lives in the plugin's resource table, not on disk, so
// quitting without installing discards it; the next launch re-downloads and
// prompts again.

import { reactive, readonly } from 'vue'
import type { DownloadEvent, Update } from '@tauri-apps/plugin-updater'
import { isTauriDesktop } from '@/utils/platform'
import { debug } from '@/utils/debug'

export type UpdatePhase =
  | 'unavailable'
  | 'not-configured'
  | 'unsupported'
  | 'idle'
  | 'checking'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'installing'
  | 'error'

export type CheckOutcome = 'up-to-date' | 'update-found' | 'failed'

export interface DesktopUpdaterState {
  phase: UpdatePhase
  currentVersion: string | null
  availableVersion: string | null
  releaseNotes: string | null
  downloadedBytes: number
  totalBytes: number | null
  error: string | null
  lastCheckedAt: number | null
  lastOutcome: CheckOutcome | null
  autoDownload: boolean
  promptOpen: boolean
}

// Rust `updater::UpdaterStatus`, serde kebab-case.
type NativeStatus = 'enabled' | 'not-configured' | 'unsupported'

export const STARTUP_DELAY_MS = 20_000
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 30_000
const AUTO_DOWNLOAD_KEY = 'harmony.updater.autoDownload'
const ANNOUNCED_KEY = 'harmony.updater.announcedVersion'

const INACTIVE: readonly UpdatePhase[] = ['unavailable', 'not-configured', 'unsupported']
const BUSY: readonly UpdatePhase[] = ['checking', 'downloading', 'installing']

function readAutoDownload(): boolean {
  try {
    return localStorage.getItem(AUTO_DOWNLOAD_KEY) !== '0'
  } catch {
    return true
  }
}

function initialState(): DesktopUpdaterState {
  return {
    phase: 'unavailable',
    currentVersion: null,
    availableVersion: null,
    releaseNotes: null,
    downloadedBytes: 0,
    totalBytes: null,
    error: null,
    lastCheckedAt: null,
    lastOutcome: null,
    autoDownload: readAutoDownload(),
    promptOpen: false,
  }
}

const state = reactive<DesktopUpdaterState>(initialState())
export const updaterState = readonly(state)

let pending: Update | null = null
let initPromise: Promise<void> | null = null

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === 'string') return error
  return 'Unknown error'
}

async function discardPending(): Promise<void> {
  const update = pending
  pending = null
  if (update) await update.close().catch(() => {})
}

async function readNativeStatus(): Promise<NativeStatus> {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke<NativeStatus>('updater_status')
  } catch (error) {
    debug.warn('[desktopUpdater] updater_status failed:', error)
    return 'not-configured'
  }
}

function schedule(): void {
  setTimeout(() => void checkForUpdates(), STARTUP_DELAY_MS)
  setInterval(() => void checkForUpdates(), CHECK_INTERVAL_MS)
  // Timers stall while the machine sleeps; a stale check runs on return.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    const last = state.lastCheckedAt ?? 0
    if (Date.now() - last >= CHECK_INTERVAL_MS) void checkForUpdates()
  })
}

export function initDesktopUpdater(): Promise<void> {
  if (initPromise) return initPromise
  initPromise = (async () => {
    if (!isTauriDesktop()) return
    // The OAuth popup loads this bundle too; the updater capability is scoped
    // to the main window.
    try {
      const { getCurrentWindow } = await import('@tauri-apps/api/window')
      if (getCurrentWindow().label !== 'main') return
    } catch {
      return
    }
    try {
      const { getVersion } = await import('@tauri-apps/api/app')
      state.currentVersion = await getVersion()
    } catch (error) {
      debug.warn('[desktopUpdater] getVersion failed:', error)
    }
    const status = await readNativeStatus()
    if (status !== 'enabled') {
      state.phase = status
      return
    }
    state.phase = 'idle'
    schedule()
  })()
  return initPromise
}

async function downloadPending(): Promise<void> {
  const update = pending
  if (!update) return
  state.phase = 'downloading'
  state.downloadedBytes = 0
  state.totalBytes = null
  state.error = null
  try {
    await update.download((event: DownloadEvent) => {
      if (event.event === 'Started') {
        state.totalBytes = event.data.contentLength ?? null
      } else if (event.event === 'Progress') {
        state.downloadedBytes += event.data.chunkLength
      }
    })
    state.phase = 'ready'
  } catch (error) {
    debug.warn('[desktopUpdater] download failed:', error)
    await discardPending()
    state.phase = 'error'
    state.error = errorText(error)
  }
}

export async function checkForUpdates(): Promise<CheckOutcome | null> {
  if (INACTIVE.includes(state.phase) || BUSY.includes(state.phase)) return null
  // A verified payload is already waiting on the user; a newer release is
  // picked up after the restart.
  if (state.phase === 'ready') return 'update-found'

  state.phase = 'checking'
  state.error = null
  let outcome: CheckOutcome
  try {
    const { check } = await import('@tauri-apps/plugin-updater')
    const update = await check({ timeout: CHECK_TIMEOUT_MS })
    await discardPending()
    if (!update) {
      state.availableVersion = null
      state.releaseNotes = null
      state.phase = 'idle'
      outcome = 'up-to-date'
    } else {
      pending = update
      state.availableVersion = update.version
      state.releaseNotes = update.body ?? null
      outcome = 'update-found'
      if (state.autoDownload) {
        void downloadPending()
      } else {
        state.phase = 'available'
      }
    }
  } catch (error) {
    debug.warn('[desktopUpdater] check failed:', error)
    state.phase = 'error'
    state.error = errorText(error)
    outcome = 'failed'
  }
  state.lastCheckedAt = Date.now()
  state.lastOutcome = outcome
  return outcome
}

export async function downloadUpdate(): Promise<void> {
  if (state.phase !== 'available') return
  await downloadPending()
}

export function setAutoDownload(enabled: boolean): void {
  state.autoDownload = enabled
  try {
    localStorage.setItem(AUTO_DOWNLOAD_KEY, enabled ? '1' : '0')
  } catch {
    /* per-device preference; the in-memory value still applies */
  }
  if (enabled && state.phase === 'available') void downloadPending()
}

// Windows: install() hands off to the NSIS installer (passive, /R relaunches)
// and exits this process, so relaunch() is reached on macOS and Linux only.
export async function installAndRestart(): Promise<void> {
  if (state.phase !== 'ready' || !pending) return
  state.phase = 'installing'
  state.promptOpen = false
  try {
    await pending.install()
    const { relaunch } = await import('@tauri-apps/plugin-process')
    await relaunch()
  } catch (error) {
    debug.error('[desktopUpdater] install failed:', error)
    await discardPending()
    state.phase = 'error'
    state.error = errorText(error)
    throw error
  }
}

export function openUpdatePrompt(): void {
  if (state.phase === 'ready') state.promptOpen = true
}

export function closeUpdatePrompt(): void {
  state.promptOpen = false
}

// One toast per version per device; the rail indicator stays until restart.
export function claimReadyAnnouncement(version: string): boolean {
  try {
    if (localStorage.getItem(ANNOUNCED_KEY) === version) return false
    localStorage.setItem(ANNOUNCED_KEY, version)
  } catch {
    /* storage unavailable: announced on every transition to ready */
  }
  return true
}
