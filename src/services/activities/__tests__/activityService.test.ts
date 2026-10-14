import { describe, expect, it, vi } from 'vitest'

vi.mock('@/supabase', () => ({ supabase: {} }))
vi.mock('@/services/instanceConfig', () => ({ apiUrl: (p: string) => p, getStoredInstance: () => null }))

const { expectedPosition, isListenActivity, parseActivityLink } = await import('@/services/activities/activityService')

describe('expectedPosition', () => {
  const base = { position_ms: 10_000, position_at: 1_000_000, rate: 1 }

  it('holds still while paused', () => {
    expect(expectedPosition({ ...base, playing: false }, 1_005_000)).toBe(10_000)
  })

  it('advances by the elapsed database time times the rate', () => {
    expect(expectedPosition({ ...base, playing: true }, 1_005_000)).toBe(15_000)
    expect(expectedPosition({ ...base, playing: true, rate: 1.5 }, 1_004_000)).toBe(16_000)
  })

  it('never goes below zero', () => {
    expect(expectedPosition({ ...base, position_ms: 0, playing: true }, 900_000)).toBe(0)
  })
})

describe('parseActivityLink', () => {
  it('reads YouTube links, start time included', () => {
    expect(parseActivityLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=1m5s')).toMatchObject({
      source: 'youtube', item: { video_id: 'dQw4w9WgXcQ' }, startMs: 65_000,
    })
    expect(parseActivityLink('https://youtu.be/dQw4w9WgXcQ')?.item.video_id).toBe('dQw4w9WgXcQ')
  })

  it('reads SoundCloud and Spotify links', () => {
    expect(parseActivityLink('https://soundcloud.com/someone/night-drive?si=1')).toEqual({
      source: 'soundcloud', item: { url: 'https://soundcloud.com/someone/night-drive' },
    })
    expect(parseActivityLink('https://open.spotify.com/intl-ja/track/4uLU6hMCjMI75M1A2tKUQC')).toEqual({
      source: 'spotify', item: { uri: 'spotify:track:4uLU6hMCjMI75M1A2tKUQC' },
    })
  })

  it('reads direct media files over https only', () => {
    expect(parseActivityLink('https://cdn.example/movie%20night.mp4')).toMatchObject({
      source: 'url', item: { title: 'movie night.mp4', mime_type: 'video/*' },
    })
    expect(parseActivityLink('https://cdn.example/song.mp3')?.item.mime_type).toBe('audio/*')
    expect(parseActivityLink('http://cdn.example/movie.mp4')).toBeNull()
    expect(parseActivityLink('https://example.com/page')).toBeNull()
    expect(parseActivityLink('not a link')).toBeNull()
  })

  it('tells listen activities from watch ones', () => {
    expect(isListenActivity('spotify', {})).toBe(true)
    expect(isListenActivity('url', { mime_type: 'audio/*' })).toBe(true)
    expect(isListenActivity('file', { mime_type: 'video/webm' })).toBe(false)
  })
})
