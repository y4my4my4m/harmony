import { describe, expect, it } from 'vitest'
import { isMusicPlayerUrl, musicEmbedFor } from '@/utils/musicEmbeds'

describe('musicEmbedFor', () => {
  it('maps Spotify tracks, collections and locale-prefixed links', () => {
    expect(musicEmbedFor('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc')).toMatchObject({
      provider: 'spotify',
      src: 'https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC?utm_source=harmony&theme=0',
      height: 152,
      single: true,
    })
    expect(musicEmbedFor('https://open.spotify.com/intl-ja/album/1DFixLWuPkv3KT3TnV35m3')?.src)
      .toBe('https://open.spotify.com/embed/album/1DFixLWuPkv3KT3TnV35m3?utm_source=harmony&theme=0')
    expect(musicEmbedFor('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M')?.height).toBe(352)
  })

  it('follows a short link through the preview canonical URL', () => {
    expect(musicEmbedFor('https://spotify.link/AbCdEf123')).toBeNull()
    expect(musicEmbedFor('https://spotify.link/AbCdEf123', {
      provider: 'spotify', canonicalUrl: 'https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC',
    })?.src).toContain('/embed/track/4uLU6hMCjMI75M1A2tKUQC')
  })

  it('maps Apple Music songs and albums', () => {
    expect(musicEmbedFor('https://music.apple.com/us/album/blinding-lights/1499378108?i=1499378615')).toMatchObject({
      provider: 'apple-music',
      src: 'https://embed.music.apple.com/us/album/blinding-lights/1499378108?i=1499378615',
      height: 175,
    })
    expect(musicEmbedFor('https://music.apple.com/jp/album/after-hours/1499378108')?.height).toBe(450)
    expect(musicEmbedFor('https://music.apple.com/us/browse')).toBeNull()
  })

  it('maps SoundCloud tracks and sets, not profiles', () => {
    const track = musicEmbedFor('https://soundcloud.com/someone/night-drive?si=x')
    expect(track?.provider).toBe('soundcloud')
    expect(new URL(track!.src).searchParams.get('url')).toBe('https://soundcloud.com/someone/night-drive')
    expect(track?.height).toBe(166)
    expect(musicEmbedFor('https://soundcloud.com/someone/sets/summer')?.height).toBe(352)
    expect(musicEmbedFor('https://soundcloud.com/someone')).toBeNull()
    expect(musicEmbedFor('https://soundcloud.com/discover/sets/x')).toBeNull()
  })

  it('maps Deezer and Tidal', () => {
    expect(musicEmbedFor('https://www.deezer.com/en/track/3135556')?.src).toBe('https://widget.deezer.com/widget/dark/track/3135556')
    expect(musicEmbedFor('https://tidal.com/browse/album/77646169')?.src).toBe('https://embed.tidal.com/albums/77646169')
  })

  it('takes Bandcamp only from a provider player page', () => {
    const player = { url: 'https://bandcamp.com/EmbeddedPlayer/v=2/album=111/size=large/', height: 120 }
    expect(musicEmbedFor('https://band.bandcamp.com/album/x', { provider: 'bandcamp', player })?.src).toBe(player.url)
    expect(musicEmbedFor('https://band.bandcamp.com/album/x', { provider: 'bandcamp', player: { url: 'https://evil.example/p' } })).toBeNull()
  })

  it('refuses other hosts and non-https players', () => {
    expect(musicEmbedFor('https://example.com/track/123')).toBeNull()
    expect(isMusicPlayerUrl('http://w.soundcloud.com/player/')).toBe(false)
    expect(isMusicPlayerUrl('https://user:pass@open.spotify.com/embed/track/x')).toBe(false)
  })
})
