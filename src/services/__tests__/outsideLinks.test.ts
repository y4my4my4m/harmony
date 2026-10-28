import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ tauri: false }))
const settings = vi.hoisted(() => ({
  trustedHosts: new Set<string>(),
  askEveryLink: false,
  trust: vi.fn(async (_host: string) => {}),
}))
const openUrl = vi.hoisted(() => vi.fn(async (_url: string) => {}))

vi.mock('@/services/instanceConfig', () => ({ isTauriRuntime: () => runtime.tauri }))
vi.mock('@/stores/outsideLinkSettings', () => ({ useOutsideLinkSettingsStore: () => settings }))
vi.mock('@/utils/internalLinks', () => ({ isInstanceHost: (host: string) => host === 'har.mony.lol' }))
vi.mock('@tauri-apps/plugin-opener', () => ({ openUrl }))

import {
  activateStoppedLink,
  installOutsideLinks,
  openLink,
  useOutsideLinkPrompt,
} from '../outsideLinks'

const prompt = useOutsideLinkPrompt()

function anchor(href: string, masked = false): HTMLAnchorElement {
  const a = document.createElement('a')
  a.href = href
  a.target = '_blank'
  a.textContent = masked ? 'label' : href
  if (masked) a.className = 'url-link masked-link'
  document.body.appendChild(a)
  return a
}

// Reads the decision after the document's listeners, then cancels the browser's default
// action so happy-dom does not navigate.
function click(el: Element, init: MouseEventInit = {}, type = 'click'): { defaultPrevented: boolean } {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 0, ...init })
  const seen = { defaultPrevented: false }
  const last = (e: Event) => {
    seen.defaultPrevented = e.defaultPrevented
    e.preventDefault()
  }
  window.addEventListener(type, last, { once: true })
  el.dispatchEvent(event)
  window.removeEventListener(type, last)
  return seen
}

let windowOpen: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  installOutsideLinks()
  runtime.tauri = false
  settings.trustedHosts = new Set()
  settings.askEveryLink = false
  settings.trust.mockClear()
  openUrl.mockClear()
  windowOpen = vi.spyOn(window, 'open').mockImplementation(() => null)
  prompt.cancel()
})

afterEach(() => {
  document.body.innerHTML = ''
  windowOpen.mockRestore()
})

describe('document link activation', () => {
  it('holds a masked link for the dialog and focuses it', () => {
    const a = anchor('https://evil.example/login', true)
    const event = click(a)
    expect(event.defaultPrevented).toBe(true)
    expect(prompt.pending.value).toEqual({ url: 'https://evil.example/login', host: 'evil.example', masked: true, document })
    expect(document.activeElement).toBe(a)
  })

  it('leaves a plain link to the browser', () => {
    const event = click(anchor('https://example.com/'))
    expect(event.defaultPrevented).toBe(false)
    expect(prompt.pending.value).toBeNull()
  })

  it('holds a plain link with ask-every-link on', () => {
    settings.askEveryLink = true
    const event = click(anchor('https://example.com/'))
    expect(event.defaultPrevented).toBe(true)
    expect(prompt.pending.value?.masked).toBe(false)
  })

  it('lets a trusted masked link through', () => {
    settings.trustedHosts = new Set(['evil.example'])
    const event = click(anchor('https://www.evil.example/login', true))
    expect(event.defaultPrevented).toBe(false)
    expect(prompt.pending.value).toBeNull()
  })

  it('never holds a link to this instance', () => {
    settings.askEveryLink = true
    const event = click(anchor('https://har.mony.lol/invite/abcd1234', true))
    expect(event.defaultPrevented).toBe(false)
    expect(prompt.pending.value).toBeNull()
  })

  it('holds a masked link opened with a middle click or a modifier', () => {
    expect(click(anchor('https://evil.example/', true), { button: 1 }, 'auxclick').defaultPrevented).toBe(true)
    prompt.cancel()
    expect(click(anchor('https://evil.example/', true), { ctrlKey: true }).defaultPrevented).toBe(true)
    prompt.cancel()
    expect(click(anchor('https://evil.example/', true), { metaKey: true }).defaultPrevented).toBe(true)
    prompt.cancel()
    expect(click(anchor('https://evil.example/', true), { shiftKey: true }).defaultPrevented).toBe(true)
  })

  it('leaves a plain middle click and a right click to the browser', () => {
    expect(click(anchor('https://example.com/'), { button: 1 }, 'auxclick').defaultPrevented).toBe(false)
    expect(click(anchor('https://evil.example/', true), { button: 2 }, 'auxclick').defaultPrevented).toBe(false)
  })

  it('leaves a click a component already handled', () => {
    const a = anchor('https://evil.example/', true)
    a.addEventListener('click', (e) => e.preventDefault())
    click(a)
    expect(prompt.pending.value).toBeNull()
  })

  it('leaves mailto and download links alone', () => {
    settings.askEveryLink = true
    expect(click(anchor('mailto:a@example.com')).defaultPrevented).toBe(false)
    const file = anchor('https://cdn.example/file.zip')
    file.setAttribute('download', 'file.zip')
    expect(click(file).defaultPrevented).toBe(false)
    expect(prompt.pending.value).toBeNull()
  })

  it('refuses a link of another scheme', () => {
    const a = document.createElement('a')
    a.setAttribute('href', 'javascript:alert(1)')
    document.body.appendChild(a)
    expect(click(a).defaultPrevented).toBe(true)
    expect(prompt.pending.value).toBeNull()
  })

  it('opens a plain link outside the native app, and leaves relative links to the router', async () => {
    runtime.tauri = true
    expect(click(anchor('https://example.com/')).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://example.com/'))
    const relative = document.createElement('a')
    relative.setAttribute('href', '/channels/1')
    document.body.appendChild(relative)
    expect(click(relative).defaultPrevented).toBe(false)
    expect(openUrl).toHaveBeenCalledTimes(1)
  })

  it('opens a link to this instance the router left in the system browser from the native app', async () => {
    runtime.tauri = true
    expect(click(anchor('https://har.mony.lol/invite/abcd1234'), { ctrlKey: true }).defaultPrevented).toBe(true)
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://har.mony.lol/invite/abcd1234'))
    expect(prompt.pending.value).toBeNull()
  })

  it('holds a masked link in the native app too', () => {
    runtime.tauri = true
    expect(click(anchor('https://evil.example/', true)).defaultPrevented).toBe(true)
    expect(prompt.pending.value?.url).toBe('https://evil.example/')
    expect(openUrl).not.toHaveBeenCalled()
  })

  it('handles an anchor whose click stops before the document', () => {
    const a = anchor('https://evil.example/', true)
    let prevented = false
    a.addEventListener('click', (e) => {
      e.stopPropagation()
      activateStoppedLink(e)
      prevented = e.defaultPrevented
      e.preventDefault()
    })
    click(a)
    expect(prevented).toBe(true)
    expect(prompt.pending.value?.url).toBe('https://evil.example/')
  })
})

describe('hrefs the browser reads as another host', () => {
  function raw(href: string, text = 'docs'): HTMLAnchorElement {
    const a = document.createElement('a')
    a.setAttribute('href', href)
    a.textContent = text
    document.body.appendChild(a)
    return a
  }

  it('holds a masked backslash link for the dialog, with the URL it opens', () => {
    for (const href of ['\\\\evil.example/x', '/\\evil.example/x', '\\/evil.example/x']) {
      const a = raw(href)
      a.className = 'url-link masked-link'
      expect(click(a).defaultPrevented, href).toBe(true)
      expect(prompt.pending.value?.url, href).toBe(new URL('//evil.example/x', document.baseURI).href)
      prompt.cancel()
    }
  })

  it('holds a backslash link with ask-every-link on', () => {
    settings.askEveryLink = true
    expect(click(raw('\\\\evil.example/x')).defaultPrevented).toBe(true)
    expect(prompt.pending.value?.host).toBe('evil.example')
  })

  it('opens a scheme-relative link over https in the macOS and Linux app', async () => {
    runtime.tauri = true
    const base = document.createElement('base')
    base.href = 'tauri://localhost/'
    document.head.appendChild(base)
    try {
      expect(click(raw('//evil.example/x', '//evil.example/x')).defaultPrevented).toBe(true)
      await vi.waitFor(() => expect(openUrl).toHaveBeenCalledWith('https://evil.example/x'))
    } finally {
      base.remove()
    }
  })
})

describe('anchor text naming another host', () => {
  it('holds an unclassed anchor whose text is another URL', () => {
    const a = document.createElement('a')
    a.href = 'https://evil.example/'
    a.target = '_blank'
    a.innerHTML = '<span>https://</span><span>github.com/me</span>'
    document.body.appendChild(a)
    expect(click(a).defaultPrevented).toBe(true)
    expect(prompt.pending.value).toMatchObject({ url: 'https://evil.example/', masked: true })
  })

  it('leaves an anchor whose text is its own URL, or names no host', () => {
    expect(click(anchor('https://github.com/me')).defaultPrevented).toBe(false)
    const named = anchor('https://example.com/')
    named.textContent = 'Report a bug'
    expect(click(named).defaultPrevented).toBe(false)
    expect(prompt.pending.value).toBeNull()
  })
})

describe('a link in the call pop-out', () => {
  it('holds the link for the dialog of its own window', () => {
    const popout = document.implementation.createHTMLDocument('call')
    const a = popout.createElement('a')
    a.setAttribute('href', 'https://evil.example/')
    a.className = 'masked-link'
    a.textContent = 'label'
    popout.body.appendChild(a)
    const event = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 })
    a.addEventListener('click', (e) => activateStoppedLink(e as MouseEvent), { once: true })
    a.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    expect(prompt.pending.value?.document).toBe(popout)
  })
})

describe('middle click', () => {
  it('holds a masked link reported as a click with button 1', () => {
    expect(click(anchor('https://evil.example/', true), { button: 1 }).defaultPrevented).toBe(true)
    expect(prompt.pending.value?.url).toBe('https://evil.example/')
  })

  it('opens once when one press arrives as a click and an auxclick', async () => {
    runtime.tauri = true
    const a = anchor('https://example.com/')
    const at = performance.now()
    const press = (type: string) => {
      const event = new MouseEvent(type, { bubbles: true, cancelable: true, button: 1 })
      Object.defineProperty(event, 'timeStamp', { value: at })
      a.dispatchEvent(event)
      return event.defaultPrevented
    }
    expect(press('click')).toBe(true)
    await vi.waitFor(() => expect(openUrl).toHaveBeenCalledTimes(1))
    expect(press('auxclick')).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(openUrl).toHaveBeenCalledTimes(1)
  })
})

describe('the dialog', () => {
  it('opens the held link in a new tab, trusting its host when asked', async () => {
    click(anchor('https://www.evil.example/login', true))
    await prompt.proceed(true)
    expect(windowOpen).toHaveBeenCalledWith('https://www.evil.example/login', '_blank', 'noopener,noreferrer')
    expect(settings.trust).toHaveBeenCalledWith('evil.example')
    expect(prompt.pending.value).toBeNull()
  })

  it('opens without trusting, and Cancel opens nothing', async () => {
    click(anchor('https://evil.example/', true))
    await prompt.proceed(false)
    expect(settings.trust).not.toHaveBeenCalled()
    click(anchor('https://evil.example/', true))
    prompt.cancel()
    expect(windowOpen).toHaveBeenCalledTimes(1)
  })
})

describe('openLink', () => {
  it('opens a plain URL at once and holds a masked one', () => {
    openLink('https://example.com/')
    expect(windowOpen).toHaveBeenCalledTimes(1)
    openLink('https://evil.example/', { masked: true })
    expect(windowOpen).toHaveBeenCalledTimes(1)
    expect(prompt.pending.value?.url).toBe('https://evil.example/')
  })

  it('returns focus to the opener it is given', () => {
    const button = document.createElement('button')
    document.body.appendChild(button)
    openLink('https://evil.example/', { masked: true, opener: button })
    expect(document.activeElement).toBe(button)
  })

  it('never opens another scheme', () => {
    openLink('javascript:alert(1)')
    openLink('mailto:a@example.com')
    expect(windowOpen).not.toHaveBeenCalled()
    expect(prompt.pending.value).toBeNull()
  })
})
