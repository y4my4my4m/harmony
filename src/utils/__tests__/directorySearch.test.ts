/**
 * utils/directorySearch.ts: which text of the merged Other instances field reads as an instance
 * domain, the match applied on the page (the merged list's own), and when open discovery controls
 * fold on a list scroll.
 */

import { describe, it, expect } from 'vitest'
import { AUTO_COLLAPSE_PX, instanceDomainFromInput, serverMatchesQuery, shouldAutoCollapse } from '../directorySearch'

describe('instanceDomainFromInput', () => {
  it.each([
    ['example.social', 'example.social'],
    ['  Example.Social  ', 'example.social'],
    ['https://example.social/', 'example.social'],
    ['http://chat.example.org/servers/directory?page=2', 'chat.example.org'],
    ['example.social.', 'example.social'],
    ['example.social:443', 'example.social'],
    ['example.social:8443', 'example.social:8443'],
    ['127.0.0.2:41823', '127.0.0.2:41823'],
    ['https://127.0.0.2:41823/', '127.0.0.2:41823'],
    ['192.0.2.10', '192.0.2.10'],
    ['localhost:3000', 'localhost:3000'],
    ['https://localhost', 'localhost'],
    ['xn--bcher-kva.example', 'xn--bcher-kva.example'],
  ])('reads %j as %j', (input, domain) => {
    expect(instanceDomainFromInput(input)).toBe(domain)
  })

  it.each([
    [''],
    ['   '],
    ['music'],
    ['localhost'],
    ['lo-fi beats'],
    ['spacify cloud'],
    ['v1.2'],
    ['1.5'],
    ['server@example.social'],
    ['-bad.example'],
    ['bad-.example'],
    ['exa_mple.social'],
    ['ftp://example.social'],
    [`${'a'.repeat(64)}.example`],
  ])('leaves %j as text to filter by', (input) => {
    expect(instanceDomainFromInput(input)).toBeNull()
  })
})

describe('serverMatchesQuery', () => {
  const server = { name: 'Harbour Hall', summary: 'Ships and tides', handle: 'harbour@peer.example' }

  it('matches name, summary and handle, case-insensitively', () => {
    expect(serverMatchesQuery(server, 'harbour hall')).toBe(true)
    expect(serverMatchesQuery(server, 'TIDES')).toBe(true)
    expect(serverMatchesQuery(server, 'peer.example')).toBe(true)
  })

  it('matches category and instance as the merged list does, width and case folded', () => {
    const listed = { ...server, category: 'music', instance: { domain: 'peer.example', name: 'Peer Harbour' } }
    expect(serverMatchesQuery(listed, 'music')).toBe(true)
    expect(serverMatchesQuery(listed, 'peer harbour')).toBe(true)
    expect(serverMatchesQuery(listed, 'ＨＡＲＢＯＵＲ')).toBe(true)
    expect(serverMatchesQuery({ name: 'Bare' }, 'music')).toBe(false)
  })

  it('matches everything for blank text and nothing for absent text', () => {
    expect(serverMatchesQuery(server, '  ')).toBe(true)
    expect(serverMatchesQuery(server, 'lighthouse')).toBe(false)
    expect(serverMatchesQuery({ name: 'Bare', summary: null, handle: null }, 'tides')).toBe(false)
  })
})

describe('shouldAutoCollapse', () => {
  const open = { expanded: true, openedAt: 0, typing: false }

  it('folds once the list scrolls AUTO_COLLAPSE_PX below where the controls opened', () => {
    expect(shouldAutoCollapse({ ...open, scrollTop: AUTO_COLLAPSE_PX - 1 })).toBe(false)
    expect(shouldAutoCollapse({ ...open, scrollTop: AUTO_COLLAPSE_PX })).toBe(true)
    expect(shouldAutoCollapse({ ...open, openedAt: 500, scrollTop: 520 })).toBe(false)
    expect(shouldAutoCollapse({ ...open, openedAt: 500, scrollTop: 500 + AUTO_COLLAPSE_PX })).toBe(true)
  })

  it('waits for the controls\' own height when that is larger', () => {
    expect(shouldAutoCollapse({ ...open, scrollTop: 150, threshold: 180 })).toBe(false)
    expect(shouldAutoCollapse({ ...open, scrollTop: 180, threshold: 180 })).toBe(true)
    expect(shouldAutoCollapse({ ...open, scrollTop: AUTO_COLLAPSE_PX, threshold: 10 })).toBe(true)
  })

  it('never folds while a field in them is typed in, upward, or when folded', () => {
    expect(shouldAutoCollapse({ ...open, scrollTop: 400, typing: true })).toBe(false)
    expect(shouldAutoCollapse({ ...open, openedAt: 400, scrollTop: 0 })).toBe(false)
    expect(shouldAutoCollapse({ ...open, expanded: false, scrollTop: 400 })).toBe(false)
  })
})
