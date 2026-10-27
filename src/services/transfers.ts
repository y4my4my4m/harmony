import { reactive, shallowReactive } from 'vue'

/**
 * Uploads and downloads in flight, app-wide, for the transfers indicator (TransfersIndicator.vue,
 * mounted once in App.vue). A transfer belongs to no component: it keeps running and listed
 * across route changes until it settles.
 *
 * An entry is listed TRANSFER_SHOW_DELAY_MS after it starts, so a transfer that settles sooner
 * never flashes up. A completed one stays TRANSFER_DONE_LINGER_MS; a failed one until dismissed;
 * an aborted one leaves at once.
 */

export type TransferDirection = 'upload' | 'download'
export type TransferStatus = 'running' | 'completed' | 'error' | 'aborted'

export interface TransferProgress {
  /** Bytes done; with `total`, the fraction shown. */
  loaded: number
  /** Bytes in all; 0 when unknown. */
  total: number
  status: TransferStatus
  error: string | null
  /** A dropped connection is being retried. */
  reconnecting: boolean
}

export interface TransferEntry {
  readonly id: string
  readonly direction: TransferDirection
  readonly name: string
  readonly progress: TransferProgress
  /** Where a finished download was saved (Tauri desktop). */
  savedPath?: string
  cancel?: () => void
  shown: boolean
}

export const TRANSFER_SHOW_DELAY_MS = 600
export const TRANSFER_DONE_LINGER_MS = 2500

const entries = shallowReactive<TransferEntry[]>([])
const timers = new Map<string, ReturnType<typeof setTimeout>>()

export function transfers(): readonly TransferEntry[] {
  return entries
}

export function transferFraction(progress: TransferProgress): number {
  return progress.total > 0 ? Math.min(1, progress.loaded / progress.total) : 0
}

function clearTimer(id: string): void {
  const timer = timers.get(id)
  if (timer) clearTimeout(timer)
  timers.delete(id)
}

export function dismissTransfer(id: string): void {
  clearTimer(id)
  const index = entries.findIndex((entry) => entry.id === id)
  if (index >= 0) entries.splice(index, 1)
}

/**
 * Lists a transfer; `progress` is read reactively and `settle` reports its end. The returned
 * entry is reactive: writes to `savedPath` and `cancel` render.
 */
export function registerTransfer(init: {
  id: string
  direction: TransferDirection
  name: string
  progress: TransferProgress
  cancel?: () => void
}): TransferEntry {
  const entry = reactive<TransferEntry>({ ...init, shown: false }) as TransferEntry
  entries.push(entry)
  timers.set(init.id, setTimeout(() => {
    timers.delete(init.id)
    if (entry.progress.status === 'running' || entry.progress.status === 'error') entry.shown = true
  }, TRANSFER_SHOW_DELAY_MS))
  return entry
}

/** The transfer ended with its progress status; schedules its removal. */
export function settleTransfer(entry: TransferEntry): void {
  const { status } = entry.progress
  clearTimer(entry.id)
  if (status === 'aborted') {
    dismissTransfer(entry.id)
  } else if (status === 'error') {
    entry.shown = true
  } else if (status === 'completed') {
    if (!entry.shown) {
      dismissTransfer(entry.id)
      return
    }
    timers.set(entry.id, setTimeout(() => dismissTransfer(entry.id), TRANSFER_DONE_LINGER_MS))
  }
}

/** Sign-out and test hook: drops every entry. Running transfers are aborted by their owners. */
export function resetTransfers(): void {
  for (const timer of timers.values()) clearTimeout(timer)
  timers.clear()
  entries.splice(0, entries.length)
}
