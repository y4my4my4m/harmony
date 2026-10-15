// A server without an icon shows its initials as dots: up to two, from the first two words.
import { describe, expect, it } from 'vitest'
import { glyphRows, serverInitials, serverMonogramUrl } from '@/utils/serverMonogram'
import { getServerIconUrl } from '@/utils/serverUtils'

const svgOf = (url: string) => decodeURIComponent(url.slice('data:image/svg+xml,'.length))

describe('server monogram', () => {
  it('takes up to two initials, upper-cased, without accents or leading symbols', () => {
    expect(serverInitials('Review server')).toEqual(['R', 'S'])
    expect(serverInitials('harmony')).toEqual(['H'])
    expect(serverInitials('Élan vital club')).toEqual(['E', 'V'])
    expect(serverInitials('dev-ops')).toEqual(['D', 'O'])
    expect(serverInitials('Q & A')).toEqual(['Q', 'A'])
    expect(serverInitials('   ')).toEqual([])
  })

  it('lights the glyph dots and dims the rest of the panel', () => {
    const svg = svgOf(serverMonogramUrl('Harmony')!)
    const lit = (svg.match(/<path d="([^"]*)" stroke="#fff" stroke-width/)![1].match(/M/g) ?? []).length
    expect(lit).toBe(glyphRows('H').join('').split('').filter((b) => b === '1').length)
    expect(svg).toContain('stroke-opacity=".16"')
  })

  it('gives a stable mirrored mark to characters outside the font', () => {
    const rows = glyphRows('日')
    expect(rows).toHaveLength(7)
    rows.forEach((r) => expect(r).toBe(r.split('').reverse().join('')))
    expect(glyphRows('日')).toEqual(rows)
    expect(serverMonogramUrl('日本語サーバー')).toBe(serverMonogramUrl('日本語サーバー'))
  })

  it('replaces the default image only when a name is known', () => {
    expect(getServerIconUrl(null, 96, 'Review server')).toBe(serverMonogramUrl('Review server'))
    expect(getServerIconUrl('/default_server.webp', 96, 'Review server')).toBe(serverMonogramUrl('Review server'))
    expect(getServerIconUrl(null)).toBe('/default_server.webp')
    expect(getServerIconUrl('https://cdn.example/icon.png', 96, 'Review server')).toBe('https://cdn.example/icon.png')
  })
})
