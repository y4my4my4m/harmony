import { describe, expect, it } from 'vitest'
import {
  isDeceptiveAnchorText,
  markMaskedAnchors,
  outsideLinkAction,
  resolveLinkHref,
  splitUrlForDisplay,
  trustHostOf,
  type OutsideLinkContext,
} from '../outsideLinks'
import { isMaskedUrlPart, maskedUrlsIn } from '../maskedLinks'

const OWN = 'har.mony.lol'

function ctx(over: Partial<OutsideLinkContext> = {}): OutsideLinkContext {
  return {
    masked: false,
    trustedHosts: new Set<string>(),
    askEveryLink: false,
    isOwnHost: (host) => host === OWN || host === 'localhost:5173',
    base: `https://${OWN}/channels/1`,
    ...over,
  }
}

describe('outsideLinkAction', () => {
  it('confirms a masked link', () => {
    expect(outsideLinkAction('https://evil.example/login', ctx({ masked: true }))).toBe('confirm')
  })

  it('opens a plain link at once', () => {
    expect(outsideLinkAction('https://example.com/a', ctx())).toBe('open')
  })

  it('confirms a plain link with ask-every-link on', () => {
    expect(outsideLinkAction('https://example.com/a', ctx({ askEveryLink: true }))).toBe('confirm')
  })

  it('opens a trusted host without asking, masked or with ask-every-link on', () => {
    const trustedHosts = new Set(['example.com'])
    expect(outsideLinkAction('https://example.com/x', ctx({ masked: true, trustedHosts }))).toBe('open')
    expect(outsideLinkAction('https://www.example.com/x', ctx({ masked: true, askEveryLink: true, trustedHosts }))).toBe('open')
  })

  it('does not trust a subdomain, a look-alike or another port of a trusted host', () => {
    const trustedHosts = new Set(['example.com'])
    expect(outsideLinkAction('https://evil.example.com/', ctx({ masked: true, trustedHosts }))).toBe('confirm')
    expect(outsideLinkAction('https://example.com.evil.net/', ctx({ masked: true, trustedHosts }))).toBe('confirm')
    expect(outsideLinkAction('https://example.com:8443/', ctx({ masked: true, trustedHosts }))).toBe('confirm')
  })

  it('checks the host past user:password@', () => {
    const trustedHosts = new Set(['example.com'])
    expect(outsideLinkAction('https://example.com@evil.net/', ctx({ masked: true, trustedHosts }))).toBe('confirm')
  })

  it('never asks for this instance, masked or with ask-every-link on', () => {
    const all = ctx({ masked: true, askEveryLink: true })
    expect(outsideLinkAction(`https://${OWN}/invite/abcd1234`, all)).toBe('own')
    expect(outsideLinkAction(`https://${OWN}/d/sometoken`, all)).toBe('own')
    expect(outsideLinkAction('/channels/x', all)).toBe('own')
    expect(outsideLinkAction('posts/1', all)).toBe('own')
    expect(outsideLinkAction('blob:https://har.mony.lol/0f0f', all)).toBe('own')
  })

  it('reads a protocol-relative link as outside', () => {
    expect(outsideLinkAction('//evil.example/x', ctx({ masked: true }))).toBe('confirm')
    expect(outsideLinkAction(`//${OWN}/x`, ctx({ masked: true }))).toBe('own')
  })

  it('reads a backslash href as the browser does: another host', () => {
    for (const href of ['\\\\evil.example/x', '/\\evil.example/x', '\\/evil.example/x', ' \\\\evil.example']) {
      expect(outsideLinkAction(href, ctx({ masked: true })), href).toBe('confirm')
      expect(outsideLinkAction(href, ctx({ askEveryLink: true })), href).toBe('confirm')
      expect(outsideLinkAction(href, ctx()), href).toBe('open')
      expect(resolveLinkHref(href, ctx().base)?.host, href).toBe('evil.example')
    }
  })

  it('keeps only same-origin references as own', () => {
    expect(outsideLinkAction('?q=1', ctx({ askEveryLink: true }))).toBe('own')
    expect(outsideLinkAction('../x', ctx({ askEveryLink: true }))).toBe('own')
    expect(outsideLinkAction('\\channels', ctx({ askEveryLink: true }))).toBe('own')
  })

  it('opens a scheme-relative link over https from the macOS and Linux app', () => {
    const native = { base: 'tauri://localhost/channels/1' }
    expect(resolveLinkHref('//evil.example/x', native.base)?.href).toBe('https://evil.example/x')
    expect(resolveLinkHref('\\\\evil.example/x', native.base)?.href).toBe('https://evil.example/x')
    expect(outsideLinkAction('//evil.example/x', ctx({ ...native, masked: true }))).toBe('confirm')
    expect(outsideLinkAction('/channels/2', ctx({ ...native, askEveryLink: true }))).toBe('own')
  })

  it('refuses a scheme hidden by control characters', () => {
    expect(outsideLinkAction('java\tscript:alert(1)', ctx())).toBe('refuse')
  })

  it('leaves mailto and tel to the platform, never asking', () => {
    expect(outsideLinkAction('mailto:a@example.com', ctx({ masked: true, askEveryLink: true }))).toBe('native')
    expect(outsideLinkAction('TEL:+15551234', ctx({ askEveryLink: true }))).toBe('native')
  })

  it('refuses every other scheme', () => {
    for (const href of ['javascript:alert(1)', 'data:text/html,x', 'file:///etc/passwd', 'ftp://example.com/', 'steam://run/1', 'JavaScript:void(0)']) {
      expect(outsideLinkAction(href, ctx()), href).toBe('refuse')
    }
  })

  it('refuses an http URL without a host', () => {
    expect(outsideLinkAction('https://', ctx())).toBe('refuse')
  })
})

describe('isDeceptiveAnchorText', () => {
  it('is text naming another host than the href', () => {
    expect(isDeceptiveAnchorText('https://github.com/me', 'https://evil.example/')).toBe(true)
    expect(isDeceptiveAnchorText('  paypal.com  ', 'https://evil.example/')).toBe(true)
    expect(isDeceptiveAnchorText('github.com\u200b/me', 'https://evil.example/')).toBe(true)
  })

  it('is not the URL itself, a label naming no host, or a non-http href', () => {
    expect(isDeceptiveAnchorText('https://github.com/me', 'https://github.com/me')).toBe(false)
    expect(isDeceptiveAnchorText('github.com/me…', 'https://www.github.com/me/repo')).toBe(false)
    expect(isDeceptiveAnchorText('my blog', 'https://evil.example/')).toBe(false)
    expect(isDeceptiveAnchorText('@alice@mastodon.social', 'https://mastodon.social/@alice')).toBe(false)
    expect(isDeceptiveAnchorText('', 'https://evil.example/')).toBe(false)
    expect(isDeceptiveAnchorText('example.com', 'mailto:a@evil.example')).toBe(false)
  })
})

describe('markMaskedAnchors', () => {
  it('classes http(s) anchors whose text is a label or names another host', () => {
    const html = markMaskedAnchors(
      '<a href="https://evil.example/">https://github.com/me</a> <a href="https://a.example/x">docs</a> ' +
        '<a href="https://a.example/x">a.example/x</a> <a href="mailto:me@a.example">mail me</a>',
    )
    const box = document.createElement('div')
    box.innerHTML = html
    expect(Array.from(box.querySelectorAll('a'), (a) => a.classList.contains('masked-link'))).toEqual([true, true, false, false])
  })

  it('returns HTML without anchors untouched', () => {
    expect(markMaskedAnchors('plain <b>text</b>')).toBe('plain <b>text</b>')
  })
})

describe('trustHostOf', () => {
  it('lower-cases, drops www., a trailing dot and a default port', () => {
    expect(trustHostOf('https://WWW.Example.COM./path?q=1')).toBe('example.com')
    expect(trustHostOf('http://example.com:80/')).toBe('example.com')
    expect(trustHostOf('https://example.com:443/')).toBe('example.com')
  })

  it('keeps any other port and an IPv6 literal', () => {
    expect(trustHostOf('http://localhost:8080/x')).toBe('localhost:8080')
    expect(trustHostOf('http://[::1]:3000/')).toBe('[::1]:3000')
  })

  it('gives an internationalised host in punycode', () => {
    expect(trustHostOf('https://пример.рф/')).toBe('xn--e1afmkfd.xn--p1ai')
  })

  it('keys on the host, not the user:password@ before it', () => {
    expect(trustHostOf('https://example.com@evil.net/')).toBe('evil.net')
  })

  it('is null for anything but http(s)', () => {
    expect(trustHostOf('mailto:a@example.com')).toBeNull()
    expect(trustHostOf('javascript:alert(1)')).toBeNull()
    expect(trustHostOf('/relative')).toBeNull()
  })

  it('matches the trusted_link_hosts host check', () => {
    const check = /^(\[[0-9a-f:.]+\]|[a-z0-9_-]+(\.[a-z0-9_-]+)*)(:[0-9]{1,5})?$/
    for (const url of ['https://Sub.Example.co.uk:8443/', 'https://пример.рф/', 'http://[2001:db8::1]/', 'https://my_host.example/']) {
      const host = trustHostOf(url)!
      expect(check.test(host) && !host.startsWith('www.'), `${url} → ${host}`).toBe(true)
    }
  })
})

describe('splitUrlForDisplay', () => {
  it('splits scheme, host and the rest', () => {
    expect(splitUrlForDisplay('https://example.com/a?b=1#c')).toEqual({ before: 'https://', host: 'example.com', after: '/a?b=1#c' })
  })

  it('keeps user:password@ out of the host run', () => {
    expect(splitUrlForDisplay('https://paypal.com:pw@evil.net/login')).toEqual({ before: 'https://paypal.com:pw@', host: 'evil.net', after: '/login' })
  })

  it('shows a port with the host and an internationalised host in punycode', () => {
    expect(splitUrlForDisplay('http://localhost:8080')).toEqual({ before: 'http://', host: 'localhost:8080', after: '/' })
    expect(splitUrlForDisplay('https://пример.рф/x')?.host).toBe('xn--e1afmkfd.xn--p1ai')
  })

  it('is null for anything but http(s)', () => {
    expect(splitUrlForDisplay('javascript:alert(1)')).toBeNull()
  })
})

describe('masked url parts', () => {
  it('is a url part with a label that has visible text', () => {
    expect(isMaskedUrlPart({ type: 'url', url: 'https://a.example', label: 'docs' })).toBe(true)
    expect(isMaskedUrlPart({ type: 'url', url: 'https://a.example', label: 'paypal.com' })).toBe(true)
    expect(isMaskedUrlPart({ type: 'url', url: 'https://a.example' })).toBe(false)
    expect(isMaskedUrlPart({ type: 'url', url: 'https://a.example', label: '​⁦' })).toBe(false)
    expect(isMaskedUrlPart({ type: 'text', url: 'https://a.example', label: 'x' })).toBe(false)
  })

  it('collects the URLs of masked parts', () => {
    const parts = [
      { type: 'text', text: 'see ' },
      { type: 'url', url: 'https://a.example', label: 'docs' },
      { type: 'url', url: 'https://b.example' },
    ]
    expect([...maskedUrlsIn(parts)]).toEqual(['https://a.example'])
    expect(maskedUrlsIn('<p>html</p>').size).toBe(0)
  })
})
