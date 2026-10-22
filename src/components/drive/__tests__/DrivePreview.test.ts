/**
 * DrivePreview hands its video to the media viewer: the preview pauses, the viewer starts
 * at the preview's time and keeps it playing, and the position comes back on close.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import DrivePreview from '../DrivePreview.vue'
import type { DriveFile } from '@/services/drive/driveService'

enableAutoUnmount(afterEach)

afterEach(() => {
  document.body.innerHTML = ''
})

// happy-dom has no media pipeline: time and play state are stubbed per element.
function stubMedia(media: HTMLMediaElement, time = 0, playing = false) {
  let paused = !playing
  let current = time
  Object.defineProperty(media, 'duration', { configurable: true, get: () => 60 })
  Object.defineProperty(media, 'paused', { configurable: true, get: () => paused })
  Object.defineProperty(media, 'ended', { configurable: true, get: () => false })
  Object.defineProperty(media, 'currentTime', {
    configurable: true,
    get: () => current,
    set: (v: number) => { current = v },
  })
  media.play = vi.fn(() => { paused = false; return Promise.resolve() })
  media.pause = vi.fn(() => { paused = true })
  return media
}

const clip = {
  id: 'f1',
  bucket: 'user_media',
  path: 'u/owner/clip.mp4',
  name: 'clip.mp4',
  mime_type: 'video/mp4',
  kind: 'video',
  state: 'ready',
} as DriveFile

describe('DrivePreview', () => {
  it('pauses its video and hands the position to the viewer and back', async () => {
    mount(DrivePreview, { props: { files: [clip], startId: clip.id }, attachTo: document.body })
    await flushPromises()
    const inline = stubMedia(document.querySelector<HTMLVideoElement>('video.drive-preview__media')!, 7, true)

    document.querySelector<HTMLButtonElement>('[data-testid="drive-preview-lightbox"]')!.click()
    await flushPromises()
    expect(inline.pause).toHaveBeenCalled()
    expect(inline.paused).toBe(true)

    const big = stubMedia(document.querySelector<HTMLVideoElement>('video.media-video')!)
    big.dispatchEvent(new Event('loadedmetadata'))
    expect(big.currentTime).toBe(7)
    expect(big.play).toHaveBeenCalled()

    big.currentTime = 20
    document.querySelector<HTMLButtonElement>('[data-testid="media-viewer"] .close-btn')!.click()
    await flushPromises()
    expect(document.querySelector('[data-testid="media-viewer"]')).toBeNull()
    expect(inline.currentTime).toBe(20)
  })
})
