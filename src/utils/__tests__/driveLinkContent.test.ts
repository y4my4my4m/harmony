import { describe, it, expect } from 'vitest'
import { driveLinksIn, driveLinkUrlsIn, soleDriveLinkPart, withoutSoleDriveLink } from '@/utils/driveLinkContent'

// The app's own origin is an instance host (utils/internalLinks.ts); any other host is not.
const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const here = () => `${window.location.protocol}//${window.location.host}`
const fileUrl = () => `${here()}/drive/file/${ID}`
const tokenUrl = () => `${here()}/d/${TOKEN}`

describe('driveLinksIn', () => {
  it('finds both link forms in order, once each, without trailing punctuation', () => {
    const text = `see ${tokenUrl()}, and (${fileUrl()}). Again: ${tokenUrl()}!`
    expect(driveLinksIn(text)).toEqual([{ kind: 'token', token: TOKEN }, { kind: 'file', id: ID }])
  })

  it('ignores other hosts and other paths', () => {
    expect(driveLinksIn(`https://elsewhere.example/d/${TOKEN} ${here()}/drive https://example.com`)).toEqual([])
  })
})

describe('soleDriveLinkPart', () => {
  it('is the link part of a message that is only a Drive link, of either form', () => {
    const file = { type: 'url', url: fileUrl(), preview: true }
    expect(soleDriveLinkPart([file])).toBe(file)
    const token = { type: 'url', url: tokenUrl(), preview: true }
    expect(soleDriveLinkPart([{ type: 'text', text: '  ' }, token, { type: 'text', text: '\n' }])).toBe(token)
  })

  it('is null beside other text, beside another link, for a <url> link and for other links', () => {
    const file = { type: 'url', url: fileUrl(), preview: true }
    expect(soleDriveLinkPart([{ type: 'text', text: 'look ' }, file])).toBeNull()
    expect(soleDriveLinkPart([file, { type: 'text', text: ' ' }, { type: 'url', url: tokenUrl(), preview: true }])).toBeNull()
    expect(soleDriveLinkPart([{ ...file, preview: false }])).toBeNull()
    expect(soleDriveLinkPart([{ type: 'url', url: 'https://example.com/a', preview: true }])).toBeNull()
    expect(soleDriveLinkPart([file, { type: 'emoji', emoji: { name: 'x' } }])).toBeNull()
    expect(soleDriveLinkPart([])).toBeNull()
    expect(soleDriveLinkPart(null)).toBeNull()
  })
})

describe('withoutSoleDriveLink', () => {
  it('drops the link that is all the content and keeps it beside text', () => {
    const file = { type: 'url', url: fileUrl(), preview: true }
    expect(withoutSoleDriveLink([file])).toEqual([])
    const withText = [{ type: 'text', text: 'look ' }, file]
    expect(withoutSoleDriveLink(withText)).toBe(withText)
    expect(withoutSoleDriveLink('<p>html</p>')).toBe('<p>html</p>')
  })
})

describe('driveLinkUrlsIn', () => {
  it('lists the previewed Drive links of content parts', () => {
    expect(driveLinkUrlsIn([
      { type: 'text', text: 'a' },
      { type: 'url', url: fileUrl(), preview: true },
      { type: 'url', url: tokenUrl(), preview: false },
      { type: 'url', url: 'https://example.com/a', preview: true },
      { type: 'url', url: fileUrl(), preview: true },
    ])).toEqual([fileUrl()])
    expect(driveLinkUrlsIn('text')).toEqual([])
  })
})
