import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mount, enableAutoUnmount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import VideoControls from '../VideoControls.vue'

enableAutoUnmount(afterEach)

// jsdom has no media pipeline: duration, paused and play()/pause() are stubbed per element.
function stubMedia(video: HTMLVideoElement, duration = 60) {
  let paused = true
  let time = 0
  Object.defineProperty(video, 'duration', { configurable: true, get: () => duration })
  Object.defineProperty(video, 'paused', { configurable: true, get: () => paused })
  Object.defineProperty(video, 'ended', { configurable: true, get: () => false })
  Object.defineProperty(video, 'currentTime', {
    configurable: true,
    get: () => time,
    set: (v: number) => { time = v; video.dispatchEvent(new Event('timeupdate')) },
  })
  video.play = () => { paused = false; video.dispatchEvent(new Event('play')); return Promise.resolve() }
  video.pause = () => { paused = true; video.dispatchEvent(new Event('pause')) }
  return video
}

const Host = defineComponent({
  setup: () => () => h('div', { class: 'frame' }, [h('video', { src: 'clip.webm', controls: true }), h(VideoControls)]),
})

async function mountPlayer() {
  const wrapper = mount(Host, { attachTo: document.body })
  const frame = wrapper.element as HTMLElement
  const video = stubMedia(frame.querySelector('video')!)
  video.dispatchEvent(new Event('loadedmetadata'))
  await nextTick()
  return { wrapper, frame, video }
}

const playButton = (frame: HTMLElement) => frame.querySelector<HTMLButtonElement>('[data-testid="video-play"]')!
const seek = (frame: HTMLElement) => frame.querySelector<HTMLElement>('[data-testid="video-seek"]')!

beforeEach(() => localStorage.clear())

describe('VideoControls', () => {
  it("takes over the host's video and drops its native controls", async () => {
    const { frame, video } = await mountPlayer()
    expect(video.controls).toBe(false)
    expect(frame.classList.contains('hv-host')).toBe(true)
    expect(seek(frame).getAttribute('aria-valuemax')).toBe('60')
  })

  it('plays and pauses from the play button', async () => {
    const { frame, video } = await mountPlayer()
    playButton(frame).click()
    await nextTick()
    expect(video.paused).toBe(false)
    expect(playButton(frame).getAttribute('aria-label')).toBe('videoPlayer.pause')
    playButton(frame).click()
    await nextTick()
    expect(video.paused).toBe(true)
    expect(playButton(frame).getAttribute('aria-label')).toBe('videoPlayer.play')
  })

  it('seeks from the keyboard and names the position', async () => {
    const { frame, video } = await mountPlayer()
    seek(frame).dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }))
    seek(frame).dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true }))
    await nextTick()
    expect(video.currentTime).toBe(15)
    expect(seek(frame).getAttribute('aria-valuetext')).toBe('videoPlayer.seekValue')
    seek(frame).dispatchEvent(new KeyboardEvent('keydown', { key: '5', bubbles: true }))
    expect(video.currentTime).toBe(30)
    seek(frame).dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    expect(video.currentTime).toBe(0)
  })

  it('follows a video moved in place of its own (floating video re-dock)', async () => {
    const { frame, video } = await mountPlayer()
    const docked = stubMedia(document.createElement('video'), 90)
    docked.controls = true
    frame.replaceChild(docked, video)
    void docked.play()
    await nextTick()
    expect(docked.controls).toBe(false)
    expect(playButton(frame).getAttribute('aria-label')).toBe('videoPlayer.pause')
    expect(seek(frame).getAttribute('aria-valuemax')).toBe('90')
    playButton(frame).click()
    expect(docked.paused).toBe(true)
  })

  it('remembers the volume for the next player', async () => {
    const first = await mountPlayer()
    first.frame.querySelector<HTMLButtonElement>('[data-testid="video-mute"]')!.click()
    expect(first.video.muted).toBe(true)
    first.wrapper.unmount()
    const second = await mountPlayer()
    expect(second.video.muted).toBe(true)
  })
})
