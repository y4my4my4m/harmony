import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'

// Saving under the recorded name: storage URLs carry the whole name percent-encoded in
// `download`, the browser follows them; other URLs save through a blob; the desktop app streams
// into Downloads through download_file and Android hands the URL to DownloadManager.

const platform = vi.hoisted(() => ({ tauri: false, desktop: false }))
vi.mock('@/utils/platform', () => ({
  isTauri: () => platform.tauri,
  isTauriDesktop: () => platform.desktop,
}))
vi.mock('@/i18n', () => ({ i18n: { global: { t: (key: string, values?: Record<string, unknown>) => `${key}${values ? JSON.stringify(values) : ''}` } } }))
const toast = vi.hoisted(() => ({ info: vi.fn() }))
vi.mock('vue-toastification', () => ({ useToast: () => toast }))
const openExternalUrl = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/services/outsideLinks', () => ({ openExternalUrl }))
const media = vi.hoisted(() => ({ local: new Map<string, string>(), resolve: vi.fn() }))
vi.mock('@/services/privateMedia', () => ({
  localMediaPathOf: (url: string) => media.local.get(url),
  resolveMediaPartUrl: (part: { path: string }) => media.resolve(part),
}))
const tauri = vi.hoisted(() => ({
  invoke: vi.fn(),
  channels: [] as Array<{ onmessage: ((message: unknown) => void) | null }>,
}))
vi.mock('@tauri-apps/api/core', () => ({
  invoke: tauri.invoke,
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null
    constructor() { tauri.channels.push(this) }
  },
}))

import { namedDownloadUrl, saveFile, storageDownloadUrl } from '@/services/downloads'
import { resetTransfers, transfers } from '@/services/transfers'

const SIGNED = 'https://db.example/storage/v1/object/sign/message_media/c/room/uid/1b4e28ba.zip?token=abc.def'
const NAME = `amogus ünï "q" it's & co #2 + 50%.zip`

let clicks: Array<{ href: string; download: string; target: string }>

beforeEach(() => {
  platform.tauri = false
  platform.desktop = false
  clicks = []
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push({ href: this.href, download: this.download, target: this.target })
  })
  tauri.invoke.mockReset()
  tauri.channels = []
  toast.info.mockReset()
  openExternalUrl.mockClear()
  media.local.clear()
  media.resolve.mockReset()
  resetTransfers()
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('storageDownloadUrl', () => {
  it('names a signed or public object URL with the whole name percent-encoded', () => {
    const named = storageDownloadUrl(SIGNED, NAME)!
    const url = new URL(named)
    expect(url.searchParams.get('download')).toBe(NAME)
    expect(url.searchParams.get('token')).toBe('abc.def')
    expect(named).toContain(`download=${encodeURIComponent(NAME)}`)
    expect(storageDownloadUrl('https://db.example/storage/v1/object/public/user_media/u/posts/x.png', 'cat.png'))
      .toBe('https://db.example/storage/v1/object/public/user_media/u/posts/x.png?download=cat.png')
  })

  it('replaces a download name storage-js put through encodeURI', () => {
    const named = storageDownloadUrl(`${SIGNED}&download=a&b.zip`, 'a&b.zip')!
    expect(new URL(named).searchParams.getAll('download')).toEqual(['a&b.zip'])
  })

  it('leaves other URLs alone', () => {
    expect(storageDownloadUrl('https://cdn.remote.example/media/x.png', 'x.png')).toBeNull()
    expect(storageDownloadUrl('https://db.example/storage/v1/render/image/sign/message_media/x.png?token=t', 'x.png')).toBeNull()
    expect(namedDownloadUrl('blob:https://app/1', 'x.png')).toBe('blob:https://app/1')
  })
})

describe('saveFile on the web', () => {
  it('follows the named storage URL, which the browser saves under the name', async () => {
    const fetchSpy = vi.fn()
    vi.stubGlobal('fetch', fetchSpy)
    await saveFile(SIGNED, NAME)
    expect(clicks).toHaveLength(1)
    expect(new URL(clicks[0].href).searchParams.get('download')).toBe(NAME)
    expect(clicks[0].target).toBe('')
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('saves a remote file through a blob under the name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bytes')))
    vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:https://app/9')
    await saveFile('https://cdn.remote.example/media/x.png', 'holiday.png')
    expect(clicks).toEqual([{ href: 'blob:https://app/9', download: 'holiday.png', target: '' }])
  })

  it('downloads this client\'s upload from storage, not from its local copy', async () => {
    media.local.set('blob:https://app/local', 'c/room/uid/1b4e28ba.zip')
    media.resolve.mockResolvedValue(SIGNED)
    await saveFile('blob:https://app/local', 'amogus.zip')
    expect(media.resolve).toHaveBeenCalledWith({ path: 'c/room/uid/1b4e28ba.zip' })
    expect(new URL(clicks[0].href).searchParams.get('download')).toBe('amogus.zip')
  })
})

describe('saveFile in the apps', () => {
  it('streams into Downloads on desktop, with progress in the transfers indicator', async () => {
    platform.tauri = true
    platform.desktop = true
    let finish!: (path: string) => void
    tauri.invoke.mockImplementation((command: string) =>
      command === 'download_file' ? new Promise((resolve) => { finish = resolve }) : Promise.resolve())
    const saving = saveFile(SIGNED, NAME)
    await flushPromises()

    const [command, args] = tauri.invoke.mock.calls[0]
    expect(command).toBe('download_file')
    expect(args).toMatchObject({ fileName: NAME })
    expect(new URL(args.url).searchParams.get('download')).toBe(NAME)
    const [entry] = transfers()
    expect(entry).toMatchObject({ direction: 'download', name: NAME })

    tauri.channels[0].onmessage?.({ event: 'progress', loaded: 40, total: 100 })
    expect(entry.progress).toMatchObject({ loaded: 40, total: 100, status: 'running' })
    tauri.channels[0].onmessage?.({ event: 'retrying', attempt: 1 })
    expect(entry.progress.reconnecting).toBe(true)

    entry.cancel?.()
    expect(tauri.invoke).toHaveBeenCalledWith('download_cancel', { id: args.id })

    finish(`/home/me/Downloads/${NAME}`)
    await saving
    expect(entry.progress.status).toBe('completed')
    expect(entry.savedPath).toBe(`/home/me/Downloads/${NAME}`)
    expect(clicks).toHaveLength(0)
  })

  it('reports a failed desktop download in the indicator', async () => {
    platform.tauri = true
    platform.desktop = true
    tauri.invoke.mockRejectedValue('HTTP 403')
    await saveFile(SIGNED, 'x.zip')
    const [entry] = transfers()
    expect(entry.progress).toMatchObject({ status: 'error' })
    expect(entry.progress.error).toContain('HTTP 403')
  })

  it('hands the named URL to DownloadManager on Android', async () => {
    platform.tauri = true
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (Linux; Android 15) Harmony')
    tauri.invoke.mockResolvedValue(undefined)
    await saveFile(SIGNED, NAME)
    const [command, args] = tauri.invoke.mock.calls[0]
    expect(command).toBe('android_download')
    expect(args.fileName).toBe(NAME)
    expect(new URL(args.url).searchParams.get('download')).toBe(NAME)
    expect(toast.info).toHaveBeenCalled()
    expect(openExternalUrl).not.toHaveBeenCalled()
  })

  it('opens the named URL outside the app where no native download exists', async () => {
    platform.tauri = true
    vi.spyOn(navigator, 'userAgent', 'get').mockReturnValue('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')
    await saveFile(SIGNED, NAME)
    expect(tauri.invoke).not.toHaveBeenCalled()
    expect(new URL((openExternalUrl.mock.calls[0] as unknown as [string])[0]).searchParams.get('download')).toBe(NAME)
  })
})
