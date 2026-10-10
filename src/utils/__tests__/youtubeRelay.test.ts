import { describe, it, expect, vi, afterEach } from 'vitest'

const stored = vi.hoisted(() => ({ value: null as { origin: string } | null }))
vi.mock('@/services/instanceConfig', () => ({ getStoredInstance: () => stored.value }))

import {
  buildYouTubePlayerSrc,
  isYouTubePlayerOrigin,
  youtubeRelayOrigin,
} from '@/utils/embedDetection'
import { isAllowedEmbedFrameSrc } from '@/utils/sanitize'

const VIDEO = new URL('https://youtu.be/rFrPz1WkBvk?t=90')

function onProtocol(protocol: string) {
  vi.spyOn(window, 'location', 'get').mockReturnValue({
    ...window.location,
    protocol,
    origin: protocol === 'tauri:' ? 'tauri://localhost' : 'http://tauri.localhost',
  } as Location)
}

afterEach(() => {
  vi.restoreAllMocks()
  stored.value = null
})

describe('YouTube relay', () => {
  it('frames YouTube directly from an http(s) page', () => {
    onProtocol('http:')
    stored.value = { origin: 'https://har.mony.lol' }
    expect(youtubeRelayOrigin()).toBeNull()
    const src = buildYouTubePlayerSrc(VIDEO)!
    expect(src.startsWith('https://www.youtube.com/embed/rFrPz1WkBvk?start=90&enablejsapi=1')).toBe(true)
    expect(isYouTubePlayerOrigin('https://har.mony.lol')).toBe(false)
  })

  it('frames the instance relay from a tauri:// page', () => {
    onProtocol('tauri:')
    stored.value = { origin: 'https://har.mony.lol' }
    expect(buildYouTubePlayerSrc(VIDEO)).toBe('https://har.mony.lol/youtube-embed.html?v=rFrPz1WkBvk&start=90')
    expect(isYouTubePlayerOrigin('https://har.mony.lol')).toBe(true)
    expect(isYouTubePlayerOrigin('https://www.youtube.com')).toBe(true)
    expect(isYouTubePlayerOrigin('https://evil.example')).toBe(false)
  })

  it('uses no relay without an https instance', () => {
    onProtocol('tauri:')
    expect(youtubeRelayOrigin()).toBeNull()
    stored.value = { origin: 'http://192.168.1.5:8080' }
    expect(youtubeRelayOrigin()).toBeNull()
  })

  it('lets only the relay page through the frame allowlist', () => {
    onProtocol('tauri:')
    stored.value = { origin: 'https://har.mony.lol' }
    expect(isAllowedEmbedFrameSrc('https://har.mony.lol/youtube-embed.html?v=abc123')).toBe(true)
    expect(isAllowedEmbedFrameSrc('https://har.mony.lol/index.html')).toBe(false)
    expect(isAllowedEmbedFrameSrc('https://other.example/youtube-embed.html?v=abc123')).toBe(false)
    onProtocol('http:')
    expect(isAllowedEmbedFrameSrc('https://har.mony.lol/youtube-embed.html?v=abc123')).toBe(false)
  })
})
