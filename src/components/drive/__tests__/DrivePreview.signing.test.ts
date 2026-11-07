/**
 * DrivePreview over private files, through the real signed URL cache: a spinner while the
 * original signs, the file once signed, and the file card with Download once signing fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { supabase } from '@/supabase'
import DrivePreview from '../DrivePreview.vue'
import { resetMediaPartSources } from '@/services/privateMedia'
import type { DriveFile } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

const happyDOM = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM
const UID = 'aaaaaaaa-0000-4000-8000-000000000001'

type Signed = { data: Array<{ path: string; signedUrl: string | null; error: string | null }> | null; error: Error | null }
let answer: (result: Signed) => void
const createSignedUrls = vi.fn(() => new Promise<Signed>((resolve) => { answer = resolve }))

beforeEach(() => {
  document.body.innerHTML = ''
  resetMediaPartSources()
  createSignedUrls.mockClear()
  vi.mocked(supabase.storage.from).mockReturnValue({ createSignedUrls } as never)
  happyDOM.settings.disableIframePageLoading = true
})

afterEach(() => {
  happyDOM.settings.disableIframePageLoading = false
})

const file = (kind: DriveFile['kind'], name: string, mime: string) =>
  ({ id: 'f1', bucket: 'message_media', path: `u/${UID}/${name}`, name, mime_type: mime, kind, state: 'ready' }) as DriveFile

const spinner = () => document.querySelector('[data-testid="media-viewer"] [role="status"]')
const card = () => document.querySelector<HTMLElement>('[data-testid="media-viewer"] .media-file-card')
const signing = () => new Promise((resolve) => setTimeout(resolve, 0)).then(flushPromises)

const KINDS: Array<[DriveFile['kind'], string, string, string]> = [
  ['image', 'harbour.png', 'image/png', 'img.media-image'],
  ['video', 'clip.webm', 'video/webm', 'video.media-video'],
  ['audio', 'tide.ogg', 'audio/ogg', 'video.media-audio-element'],
  ['document', 'notes.pdf', 'application/pdf', 'iframe.media-pdf-frame'],
]

describe('DrivePreview of a private file', () => {
  it.each(KINDS)('%s: spinner while signing, the file card with Download once signing fails', async (kind, name, mime, media) => {
    const wrapper = mount(DrivePreview, { props: { files: [file(kind, name, mime)], startId: 'f1' }, attachTo: document.body })
    await signing()
    expect(createSignedUrls).toHaveBeenCalledWith([`u/${UID}/${name}`], expect.any(Number))
    expect(spinner()).not.toBeNull()
    expect(card()).toBeNull()

    answer({ data: null, error: new Error('signing refused') })
    await flushPromises()
    expect(spinner()).toBeNull()
    expect(document.querySelector(media)).toBeNull()
    expect(card()?.querySelector('.media-file-name')?.textContent).toBe(name)
    expect(card()?.querySelector('.media-file-note')?.textContent).toBe('a11y.lightbox.noPreview')
    card()!.querySelector<HTMLButtonElement>('.media-file-download')!.click()
    expect(wrapper.emitted('download')).toEqual([[wrapper.props('files')[0]]])
  })

  it.each(KINDS)('%s: spinner while signing, then the signed file', async (kind, name, mime, media) => {
    mount(DrivePreview, { props: { files: [file(kind, name, mime)], startId: 'f1' }, attachTo: document.body })
    await signing()
    expect(spinner()).not.toBeNull()

    const path = `u/${UID}/${name}`
    answer({ data: [{ path, signedUrl: `https://signed.test/${path}`, error: null }], error: null })
    await flushPromises()
    expect(spinner()).toBeNull()
    expect(card()).toBeNull()
    expect(document.querySelector(media)?.getAttribute('src')).toBe(`https://signed.test/${path}`)
  })
})
