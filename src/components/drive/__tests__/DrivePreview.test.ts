/**
 * DrivePreview is the media viewer over the files of the view: it opens at the start file
 * under its name, steps with the arrow keys, renders each kind as the viewer does (zoom and
 * rotation for images only), downloads through Drive, and signs only the file on screen.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'

vi.mock('@/services/privateMedia', () => ({
  mediaPartSource: vi.fn((part: { path: string }) => `https://signed.test/${part.path}`),
}))

import DrivePreview from '../DrivePreview.vue'
import { mediaPartSource } from '@/services/privateMedia'
import type { DriveFile } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

const happyDOM = (window as unknown as { happyDOM: { settings: { disableIframePageLoading: boolean } } }).happyDOM

beforeEach(() => {
  document.body.innerHTML = ''
  vi.mocked(mediaPartSource).mockClear()
  // happy-dom would fetch the framed PDF.
  happyDOM.settings.disableIframePageLoading = true
})

afterEach(() => {
  happyDOM.settings.disableIframePageLoading = false
})

const file = (id: string, name: string, kind: DriveFile['kind'], mime: string) =>
  ({ id, bucket: 'message_media', path: `u/owner/${name}`, name, mime_type: mime, kind, state: 'ready' }) as DriveFile

const FILES = [
  file('f1', 'harbour.png', 'image', 'image/png'),
  file('f2', 'notes.pdf', 'document', 'application/pdf'),
  file('f3', 'backup.zip', 'other', 'application/zip'),
  file('f4', 'clip.webm', 'video', 'video/webm'),
]

const viewer = () => document.querySelector<HTMLElement>('[data-testid="media-viewer"] [role="dialog"]')!
const name = () => document.querySelector('.lightbox-name')?.textContent
const press = (key: string) => viewer().dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }))
const tool = (label: string) => viewer().querySelector(`button[aria-label="${label}"]`)

function open(startId = 'f2') {
  return mount(DrivePreview, { props: { files: FILES, startId }, attachTo: document.body })
}

describe('DrivePreview', () => {
  it('opens at the start file under its name and steps through the files with the arrow keys', async () => {
    open()
    await flushPromises()
    expect(name()).toBe('notes.pdf')
    expect(document.querySelector('iframe.media-pdf-frame')?.getAttribute('src')).toBe('https://signed.test/u/owner/notes.pdf')
    expect(tool('a11y.lightbox.zoomIn')).toBeNull()

    press('ArrowLeft')
    await flushPromises()
    expect(name()).toBe('harbour.png')
    expect(document.querySelector('img.media-image')?.getAttribute('src')).toBe('https://signed.test/u/owner/harbour.png')
    expect(tool('a11y.lightbox.zoomIn')).not.toBeNull()
    expect(tool('a11y.lightbox.rotateRight')).not.toBeNull()

    press('ArrowRight')
    await flushPromises()
    press('ArrowRight')
    await flushPromises()
    expect(name()).toBe('backup.zip')
    expect(document.querySelector('.media-file-card .media-file-note')?.textContent).toBe('a11y.lightbox.noPreview')

    press('ArrowRight')
    await flushPromises()
    expect(document.querySelector('video.media-video')?.getAttribute('src')).toBe('https://signed.test/u/owner/clip.webm')
    expect(tool('a11y.lightbox.rotateRight')).toBeNull()
  })

  it('signs only the file on screen, and nothing for a file without a preview', async () => {
    const signed = () => new Set(vi.mocked(mediaPartSource).mock.calls.map(([part]) => part?.path))
    open('f3')
    await flushPromises()
    expect(signed()).toEqual(new Set())
    press('ArrowLeft')
    await flushPromises()
    expect(signed()).toEqual(new Set(['u/owner/notes.pdf']))
  })

  it('downloads the file on screen through Drive and closes on Escape', async () => {
    const wrapper = open('f3')
    await flushPromises()
    document.querySelector<HTMLButtonElement>('[data-testid="lightbox-download"]')!.click()
    document.querySelector<HTMLButtonElement>('.media-file-download')!.click()
    expect(wrapper.emitted('download')).toEqual([[FILES[2]], [FILES[2]]])

    press('Escape')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
