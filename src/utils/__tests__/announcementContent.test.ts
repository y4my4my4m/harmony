import { describe, it, expect, vi } from 'vitest'

vi.mock('@/utils/storageImageUtils', () => ({
  isLocalStorageUrl: (url: string) => url.startsWith('http://localhost:54321/'),
}))

import { renderAnnouncementHtml } from '@/utils/announcementContent'

const PARTY = 'https://har.example/storage/v1/object/public/emojis/instance/party.png'
const emojis = new Map([
  ['party', PARTY],
  ['wave', 'http://localhost:54321/storage/v1/object/public/emojis/instance/wave.png'],
  ['elsewhere', 'http://cdn.example/x.png'],
])

const imgs = (html: string) => {
  const el = document.createElement('div')
  el.innerHTML = html
  return [...el.querySelectorAll('img')].map((i) => ({ src: i.getAttribute('src'), alt: i.getAttribute('alt'), cls: i.className }))
}

describe('renderAnnouncementHtml', () => {
  it('shows a shortcode as the instance emoji of that name', () => {
    const html = renderAnnouncementHtml('Release day :party:\nsee you', emojis)
    expect(imgs(html)).toEqual([{ src: PARTY, alt: ':party:', cls: 'inline-emoji' }])
    expect(html).toContain('<br>see you')
  })

  it('leaves an unknown shortcode as text and still reads the one after it', () => {
    const html = renderAnnouncementHtml('<p>:nope:party: done</p>', emojis)
    expect(html).toContain(':nope')
    expect(imgs(html).map((i) => i.alt)).toEqual([':party:'])
  })

  it('takes this instance\'s storage over http, and no other http host', () => {
    expect(imgs(renderAnnouncementHtml(':wave: :elsewhere:', emojis)).map((i) => i.alt)).toEqual([':wave:'])
  })

  it('leaves shortcodes inside code and pre', () => {
    const html = renderAnnouncementHtml('<p><code>:party:</code></p><pre>:party:</pre>', emojis)
    expect(imgs(html)).toEqual([])
  })

  it('keeps an authored image only with an https source', () => {
    const html = renderAnnouncementHtml(
      '<p><img src="https://example.org/a.png" alt="a" class="wide" onerror="alert(1)">'
        + '<img src="http://example.org/b.png" alt="b"><img src="data:image/png;base64,AAAA" alt="c"></p>',
    )
    expect(imgs(html)).toEqual([{ src: 'https://example.org/a.png', alt: 'a', cls: 'wide' }])
    expect(html).not.toContain('onerror')
  })

  it('renders shortcodes as text without an emoji list', () => {
    expect(renderAnnouncementHtml('hi :party:')).toBe('hi :party:')
  })

  it('escapes an emoji address into the attribute', () => {
    const html = renderAnnouncementHtml(':q:', new Map([['q', 'https://x.example/a"><script>.png']]))
    const el = document.createElement('div')
    el.innerHTML = html
    expect(el.querySelectorAll('script')).toHaveLength(0)
    expect(imgs(html)).toEqual([{ src: 'https://x.example/a"><script>.png', alt: ':q:', cls: 'inline-emoji' }])
  })
})
