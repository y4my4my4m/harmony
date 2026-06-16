import { describe, it, expect } from 'vitest'
import { parseContentToMessageParts } from '@/utils/unifiedContentProcessing'

describe('parseContentToMessageParts URL previews', () => {
  it('enables preview for plain URLs', async () => {
    const parts = await parseContentToMessageParts('see https://example.com ok')
    const urlPart = parts.find((p) => p.type === 'url')
    expect(urlPart).toMatchObject({ url: 'https://example.com', preview: true })
    expect(parts.some((p) => p.type === 'text' && p.text?.includes('<'))).toBe(false)
  })

  it('disables preview for angle-bracket wrapped URLs (Discord-style)', async () => {
    const parts = await parseContentToMessageParts('see <https://example.com> ok')
    const urlPart = parts.find((p) => p.type === 'url')
    expect(urlPart).toMatchObject({ url: 'https://example.com', preview: false })
    expect(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).not.toContain('<')
    expect(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).not.toContain('>')
  })

  it('still parses a normal URL after a suppressed one', async () => {
    const parts = await parseContentToMessageParts('<https://a.com> and https://b.com')
    const urls = parts.filter((p) => p.type === 'url')
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatchObject({ url: 'https://a.com', preview: false })
    expect(urls[1]).toMatchObject({ url: 'https://b.com', preview: true })
  })

  it('handles suppressed and plain URLs in one message', async () => {
    const parts = await parseContentToMessageParts('<https://a.com/x.png>https://b.com/y.png')
    const urls = parts.filter((p) => p.type === 'url')
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatchObject({ url: 'https://a.com/x.png', preview: false })
    expect(urls[1]).toMatchObject({ url: 'https://b.com/y.png', preview: true })
    expect(parts.map((p) => (p.type === 'text' ? p.text : '')).join('')).not.toContain('<')
  })

  it('splits glued attachment URLs into separate url parts', async () => {
    const a = 'https://db.example.com/a.png'
    const b = 'https://db.example.com/b.png'
    const parts = await parseContentToMessageParts(`${a}${b}`)
    const urls = parts.filter((p) => p.type === 'url')
    expect(urls).toHaveLength(2)
    expect(urls[0]).toMatchObject({ url: a })
    expect(urls[1]).toMatchObject({ url: b })
  })

  it('keeps fenced code blocks intact when they contain URLs', async () => {
    const fenced = '```json\n{"url": "https://example.com"}\n```'
    const parts = await parseContentToMessageParts(`before ${fenced} after`)
    expect(parts.filter((p) => p.type === 'url')).toHaveLength(0)
    expect(parts.some((p) => p.type === 'text' && p.text === fenced)).toBe(true)
  })
})
