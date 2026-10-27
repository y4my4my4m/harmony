import { reactive } from 'vue'
import { useToast } from 'vue-toastification'
import { i18n } from '@/i18n'
import { debug } from '@/utils/debug'
import { isTauri, isTauriDesktop } from '@/utils/platform'
import { openExternalUrl } from '@/services/tauriLinks'
import { registerTransfer, settleTransfer, type TransferProgress } from '@/services/transfers'
import { localMediaPathOf, resolveMediaPartUrl } from '@/services/privateMedia'
import { namedDownloadUrl } from '@/utils/storageDownloadUrl'

export { namedDownloadUrl, storageDownloadUrl } from '@/utils/storageDownloadUrl'

/**
 * Saves files under the name the message, post or Drive file records.
 *
 * A storage object URL gets `download=<name>` (utils/storageDownloadUrl.ts), and the browser
 * saves under that name through its download manager, which resumes with Range. `<a download>`
 * names only same-origin and blob: URLs; storage is another origin.
 *
 * - Web: a storage URL is followed by an anchor; any other URL is fetched into a blob saved
 *   under the name, or opened in a tab when the page may not fetch it.
 * - Tauri desktop: download_file (src-tauri/src/commands/download.rs) writes into the Downloads
 *   folder, resuming with Range after a dropped connection; progress shows in the transfers
 *   indicator.
 * - Android: android_download hands the URL to DownloadManager, which saves into Downloads,
 *   shows its own notification and resumes on its own.
 * - iOS: the named URL opens outside the app.
 */

function clickAnchor(href: string, name?: string, newTab = false): void {
  const a = document.createElement('a')
  a.href = href
  if (name !== undefined) a.download = name
  a.rel = 'noopener'
  if (newTab) a.target = '_blank'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}

async function saveThroughBlob(url: string, name: string): Promise<void> {
  try {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const objectUrl = URL.createObjectURL(await response.blob())
    clickAnchor(objectUrl, name)
    setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
  } catch (error) {
    debug.warn('Fetch for download failed; opening the URL instead', error)
    clickAnchor(url, name, true)
  }
}

function isAndroid(): boolean {
  return typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent)
}

let nextId = 0

type NativeDownloadEvent =
  | { event: 'progress'; loaded: number; total: number }
  | { event: 'retrying'; attempt: number }

async function saveOnDesktop(url: string, name: string): Promise<void> {
  const { Channel, invoke } = await import('@tauri-apps/api/core')
  const id = `download-${Date.now()}-${nextId++}`
  const progress = reactive<TransferProgress>({ loaded: 0, total: 0, status: 'running', error: null, reconnecting: false })
  const entry = registerTransfer({
    id,
    direction: 'download',
    name,
    progress,
    cancel: () => { void invoke('download_cancel', { id }).catch(() => {}) },
  })
  const channel = new Channel<NativeDownloadEvent>()
  channel.onmessage = (message) => {
    if (message.event === 'progress') {
      progress.loaded = message.loaded
      progress.total = message.total
      progress.reconnecting = false
    } else if (message.event === 'retrying') {
      progress.reconnecting = true
    }
  }
  try {
    const path = await invoke<string>('download_file', { id, url, fileName: name, onEvent: channel })
    progress.status = 'completed'
    progress.reconnecting = false
    if (progress.total > 0) progress.loaded = progress.total
    entry.savedPath = path
    entry.shown = true
    settleTransfer(entry)
  } catch (error) {
    const message = typeof error === 'string' ? error : error instanceof Error ? error.message : String(error)
    progress.reconnecting = false
    if (message === 'cancelled') {
      progress.status = 'aborted'
    } else {
      progress.status = 'error'
      progress.error = i18n.global.t('transfers.downloadFailed', { reason: message }) as string
    }
    settleTransfer(entry)
  }
}

/**
 * Saves the file at `url` as `name`. `url` must be fetchable without credentials: a public or
 * signed storage URL, or a remote URL. `named`: the server answers `url` with the name's
 * Content-Disposition itself (the backend's Drive link route).
 */
export async function saveFile(url: string, name: string, options: { named?: boolean } = {}): Promise<void> {
  const fileName = name.trim() || 'download'
  // This client's upload renders from a blob: URL; the stored object downloads like any other.
  const local = url.startsWith('blob:') ? localMediaPathOf(url) : undefined
  if (local) url = (await resolveMediaPartUrl({ path: local }).catch(() => undefined)) ?? url
  if (/^(blob|data):/i.test(url)) {
    // Same-origin bytes: <a download> names them; in Tauri desktop the webview's download
    // handler (src-tauri/src/lib.rs) saves them.
    clickAnchor(url, fileName)
    return
  }
  const target = namedDownloadUrl(url, fileName)
  if (isTauri()) {
    if (isTauriDesktop()) {
      await saveOnDesktop(target, fileName)
      return
    }
    if (isAndroid()) {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('android_download', { url: target, fileName })
        useToast().info(i18n.global.t('transfers.downloadStarted', { name: fileName }) as string)
        return
      } catch (error) {
        debug.warn('DownloadManager refused the download; opening the URL outside the app', error)
      }
    }
    await openExternalUrl(target)
    return
  }
  if (target !== url || options.named) clickAnchor(target, fileName)
  else await saveThroughBlob(url, fileName)
}
