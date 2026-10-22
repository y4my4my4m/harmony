import { describe, it, expect } from 'vitest'
import {
  driveFileIdsIn,
  driveFileUrl,
  driveLinkFromPath,
  driveLinkFromUrl,
  driveLinkPath,
} from '@/services/drive/driveLinks'

// The app's own origin is an instance host (utils/internalLinks.ts); any other host is not.
const ID = '3f2b8c1e-9a4d-4e6f-8b7a-1c2d3e4f5a6b'
const TOKEN = 'h5KAj-hPSm5hwCpMfeKM8aZl'
const here = () => `${window.location.protocol}//${window.location.host}`

describe('driveLinkFromPath', () => {
  it('reads a file id from /drive/file/<id>', () => {
    expect(driveLinkFromPath(`/drive/file/${ID}`)).toEqual({ kind: 'file', id: ID })
    expect(driveLinkFromPath(`/drive/file/${ID}/`)).toEqual({ kind: 'file', id: ID })
    expect(driveLinkFromPath(`/drive/file/${ID.toUpperCase()}?x=1#y`)).toEqual({ kind: 'file', id: ID })
  })

  it('reads a token from /d/<token>', () => {
    expect(driveLinkFromPath(`/d/${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN })
    expect(driveLinkFromPath(`/d/${TOKEN}/`)).toEqual({ kind: 'token', token: TOKEN })
  })

  it.each([
    '/drive', '/drive/file', '/drive/file/not-a-uuid', `/drive/file/${ID}/extra`, `/drive/folder/${ID}`,
    '/d/short', `/d/${'x'.repeat(65)}`, `/d/${TOKEN}/extra`, '/d/abc.def.ghi.jkl.mno', `/x/drive/file/${ID}`,
  ])('ignores %s', (path) => {
    expect(driveLinkFromPath(path)).toBeNull()
  })
})

describe('driveLinkFromUrl', () => {
  it('reads links on this instance', () => {
    expect(driveLinkFromUrl(`${here()}/drive/file/${ID}`)).toEqual({ kind: 'file', id: ID })
    expect(driveLinkFromUrl(`${here()}/d/${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN })
  })

  it('ignores the same paths on another host', () => {
    expect(driveLinkFromUrl(`https://elsewhere.example/drive/file/${ID}`)).toBeNull()
    expect(driveLinkFromUrl(`https://elsewhere.example/d/${TOKEN}`)).toBeNull()
  })

  it('ignores what is not an http(s) URL', () => {
    expect(driveLinkFromUrl(`javascript:alert(1)//drive/file/${ID}`)).toBeNull()
    expect(driveLinkFromUrl('not a url')).toBeNull()
  })
})

describe('driveFileUrl and driveLinkPath', () => {
  it('builds the shareable address on the given origin', () => {
    expect(driveFileUrl(ID, 'https://har.mony.lol/')).toBe(`https://har.mony.lol/drive/file/${ID}`)
  })

  it('builds the in-app path of either kind', () => {
    expect(driveLinkPath({ kind: 'file', id: ID })).toBe(`/drive/file/${ID}`)
    expect(driveLinkPath({ kind: 'token', token: TOKEN })).toBe(`/d/${TOKEN}`)
  })
})

describe('driveFileIdsIn', () => {
  it('finds this instance\'s file links in pasted text, once each, in order', () => {
    const other = '00000000-0000-4000-8000-000000000001'
    const text = `see ${here()}/drive/file/${ID}, and (${here()}/drive/file/${other}). again ${here()}/drive/file/${ID}`
    expect(driveFileIdsIn(text)).toEqual([ID, other])
  })

  it('skips token links, foreign hosts and plain text', () => {
    const text = `${here()}/d/${TOKEN} https://elsewhere.example/drive/file/${ID} /drive/file/${ID}`
    expect(driveFileIdsIn(text)).toEqual([])
  })
})
