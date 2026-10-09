import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const playAudio = vi.hoisted(() => vi.fn())
vi.mock('@/services/AudioThemeService', () => ({ audioThemeService: { playAudio } }))

import { installInterfaceSounds, shouldPlayClick } from '../interfaceSounds'

function mount(html: string): HTMLElement {
  document.body.innerHTML = html
  return document.body
}

describe('shouldPlayClick', () => {
  it('matches buttons, links and list rows through nested children', () => {
    mount('<button id="b"><span id="inner">x</span></button><a id="a" href="/x">x</a><div class="channel-item"><span id="ch">#</span></div>')
    expect(shouldPlayClick(document.getElementById('inner'))).toBe(true)
    expect(shouldPlayClick(document.getElementById('a'))).toBe(true)
    expect(shouldPlayClick(document.getElementById('ch'))).toBe(true)
  })

  it('skips plain text, disabled buttons and controls with their own sound', () => {
    mount(`
      <p id="p">text</p>
      <button id="dis" disabled>x</button>
      <button id="mic" class="icon-button" data-action="mic">m</button>
      <div class="reaction"><button id="react">1</button></div>
      <button id="opt" data-no-ui-sound>x</button>
    `)
    for (const id of ['p', 'dis', 'mic', 'react', 'opt']) {
      expect(shouldPlayClick(document.getElementById(id)), id).toBe(false)
    }
  })
})

describe('installInterfaceSounds', () => {
  let uninstall: () => void

  beforeEach(() => {
    playAudio.mockClear()
    uninstall = installInterfaceSounds()
  })
  afterEach(() => {
    uninstall()
    document.documentElement.removeAttribute('data-skin-ui-sounds')
  })

  it('plays ui_click only while the skin option is on', () => {
    mount('<button id="b">x</button>')
    const b = document.getElementById('b')!
    b.click()
    expect(playAudio).not.toHaveBeenCalled()
    document.documentElement.setAttribute('data-skin-ui-sounds', 'on')
    b.click()
    expect(playAudio).toHaveBeenCalledWith('ui_click')
    document.documentElement.setAttribute('data-skin-ui-sounds', 'off')
    b.click()
    expect(playAudio).toHaveBeenCalledTimes(1)
  })

  it('stops after uninstall', () => {
    document.documentElement.setAttribute('data-skin-ui-sounds', 'on')
    mount('<button id="b">x</button>')
    uninstall()
    document.getElementById('b')!.click()
    expect(playAudio).not.toHaveBeenCalled()
  })
})
