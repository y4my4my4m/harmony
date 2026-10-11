import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// Handler stack, typing targets, recorder hold-off and the defaults choice
// (new installs Ctrl+Shift+M/D, existing installs keep M/D).

vi.mock('@/services/nativePtt', () => ({ armNativePtt: vi.fn(), disarmNativePtt: vi.fn() }))
vi.mock('@/utils/platform', () => ({ isTauriDesktop: () => false }))

const STORAGE_KEY = 'harmony-keybinds'

type Module = typeof import('../useKeybinds')

// The defaults choice runs at module load; every test imports a fresh module.
async function load(): Promise<Module> {
  vi.resetModules()
  return import('../useKeybinds')
}

function key(code: string, init: KeyboardEventInit = {}, target: EventTarget = document.body): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { code, bubbles: true, cancelable: true, ...init })
  target.dispatchEvent(event)
  return event
}

let mod: Module | null = null

beforeEach(() => {
  localStorage.clear()
  document.body.innerHTML = ''
})

afterEach(() => {
  if (mod) {
    mod.useKeybinds().cleanupListeners()
    mod.resetKeybindsForTests()
  }
  mod = null
})

async function connected(store?: Record<string, unknown>) {
  if (store) localStorage.setItem(STORAGE_KEY, JSON.stringify(store))
  mod = await load()
  const kb = mod.useKeybinds()
  kb.activateContext('voice-connected')
  kb.setupListeners()
  return kb
}

describe('defaults', () => {
  it('gives a fresh install the chorded mute and deafen and records the version', async () => {
    const kb = await connected()
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
    expect(kb.getKeybindDisplay('toggle-deafen')).toBe('Ctrl + Shift + D')
    expect(JSON.parse(localStorage.getItem(STORAGE_KEY)!).defaults).toBe(2)
  })

  it('keeps the chorded pair when a fresh install signs in and reloads before using voice', async () => {
    await load()
    localStorage.setItem('harmony_current_user_id', 'u1')
    const kb = await connected()
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
  })

  it('keeps single-key M and D for a record written before the change', async () => {
    const kb = await connected({ inputMode: 'voice_activity', releaseDelay: 200, keybinds: {} })
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('M')
    expect(kb.getKeybindDisplay('toggle-deafen')).toBe('D')
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!)
    expect(stored.defaults).toBe(2)
    expect(stored.keybinds['toggle-mute'].key).toBe('KeyM')
  })

  it('keeps M and D for an install that signed in before but never saved keybinds', async () => {
    localStorage.setItem('harmony_current_user_id', 'u1')
    const kb = await connected()
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('M')
  })

  it('leaves a customised legacy binding alone', async () => {
    const kb = await connected({ keybinds: { 'toggle-mute': { key: 'KeyQ', modifiers: { ctrl: false, alt: true, shift: false, meta: false }, enabled: true } } })
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('Alt + Q')
    expect(kb.getKeybindDisplay('toggle-deafen')).toBe('D')
  })

  it('reads a current record as stored', async () => {
    const kb = await connected({ defaults: 2, keybinds: {} })
    expect(kb.getKeybindDisplay('toggle-mute')).toBe('Ctrl + Shift + M')
  })
})

describe('handler stack', () => {
  it('restores the previous handler when the overlay unregisters its own', async () => {
    const kb = await connected()
    const store = vi.fn()
    const overlay = vi.fn()
    kb.registerHandler('toggle-mute', store)
    const dispose = kb.registerHandler('toggle-mute', overlay)

    key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(overlay).toHaveBeenCalledTimes(1)
    expect(store).not.toHaveBeenCalled()

    dispose()
    key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(store).toHaveBeenCalledTimes(1)
  })

  it('removes a handler that is not on top without touching the live one', async () => {
    const kb = await connected()
    const first = vi.fn()
    const second = vi.fn()
    kb.registerHandler('toggle-deafen', first)
    kb.registerHandler('toggle-deafen', second)
    kb.unregisterHandler('toggle-deafen', first)
    key('KeyD', { ctrlKey: true, shiftKey: true })
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
  })

  it('leaves the event unconsumed when the handler returns false', async () => {
    const kb = await connected()
    kb.activateContext('voice-overlay')
    kb.registerHandler('exit-fullscreen', () => false)
    const event = key('Escape')
    expect(event.defaultPrevented).toBe(false)
  })

  it('consumes the event when the handler acts', async () => {
    const kb = await connected()
    const handler = vi.fn()
    kb.registerHandler('toggle-mute', handler)
    const event = key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(handler).toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })
})

describe('typing targets', () => {
  const targets: Array<[string, string]> = [
    ['input', '<input id="t">'],
    ['select', '<select id="t"><option>a</option></select>'],
    ['role=combobox', '<div role="combobox" tabindex="0" id="t"></div>'],
    ['role=textbox', '<div role="textbox" tabindex="0" id="t"></div>'],
    ['role=listbox child', '<div role="listbox"><div role="option" id="t" tabindex="0"></div></div>'],
    ['role=grid child', '<div role="grid"><div role="row"><div role="gridcell" id="t" tabindex="0"></div></div></div>'],
    ['role=slider', '<div role="slider" tabindex="0" id="t"></div>'],
    ['contenteditable ancestor', '<div contenteditable="true"><span id="t">x</span></div>'],
  ]

  for (const [name, html] of targets) {
    it(`does not fire a press shortcut or eat the key inside ${name}`, async () => {
      const kb = await connected({ defaults: 2, keybinds: { 'toggle-mute': { key: 'KeyM', modifiers: { ctrl: false, alt: false, shift: false, meta: false }, enabled: true } } })
      const handler = vi.fn()
      kb.registerHandler('toggle-mute', handler)
      document.body.innerHTML = html
      const event = key('KeyM', {}, document.getElementById('t')!)
      expect(handler).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    })
  }

  it('fires a Ctrl shortcut in a text field: it types nothing', async () => {
    const kb = await connected()
    const handler = vi.fn()
    kb.registerHandler('toggle-mute', handler)
    document.body.innerHTML = '<textarea id="t"></textarea>'
    const event = key('KeyM', { ctrlKey: true, shiftKey: true }, document.getElementById('t')!)
    expect(handler).toHaveBeenCalledTimes(1)
    expect(event.defaultPrevented).toBe(true)
  })

  it('fires on a plain button', async () => {
    const kb = await connected({ defaults: 2, keybinds: { 'toggle-mute': { key: 'KeyM', modifiers: { ctrl: false, alt: false, shift: false, meta: false }, enabled: true } } })
    const handler = vi.fn()
    kb.registerHandler('toggle-mute', handler)
    document.body.innerHTML = '<button id="t">x</button>'
    key('KeyM', {}, document.getElementById('t')!)
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('keeps push to talk live in a text field without eating the character', async () => {
    const kb = await connected()
    kb.setInputMode('push_to_talk')
    kb.setReleaseDelay(0)
    const hold = vi.fn()
    kb.registerHandler('push-to-talk', hold)
    document.body.innerHTML = '<textarea id="t"></textarea>'
    const event = key('KeyV', {}, document.getElementById('t')!)
    expect(hold).toHaveBeenCalledWith(true)
    expect(event.defaultPrevented).toBe(false)
  })

  it('does not run the Escape keybind inside a text field', async () => {
    const kb = await connected()
    kb.activateContext('voice-overlay')
    const handler = vi.fn()
    kb.registerHandler('exit-fullscreen', handler)
    document.body.innerHTML = '<input id="t">'
    const event = key('Escape', {}, document.getElementById('t')!)
    expect(handler).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(false)
  })
})

describe('enable toggles, recording and conflicts', () => {
  it('a disabled shortcut does not fire and stays disabled after reload', async () => {
    const kb = await connected()
    const handler = vi.fn()
    kb.registerHandler('toggle-mute', handler)
    kb.setKeybindEnabled('toggle-mute', false)
    key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(handler).not.toHaveBeenCalled()

    mod!.resetKeybindsForTests()
    mod = await load()
    expect(mod.useKeybinds().getKeybind('toggle-mute')?.enabled).toBe(false)
  })

  it('holds every keybind off while a recorder listens', async () => {
    const kb = await connected()
    const handler = vi.fn()
    kb.registerHandler('toggle-mute', handler)
    const release = kb.beginRecording()
    key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(handler).not.toHaveBeenCalled()
    release()
    key('KeyM', { ctrlKey: true, shiftKey: true })
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('finds an enabled binding on the same combination', async () => {
    const kb = await connected()
    const ctrlShift = { ctrl: true, alt: false, shift: true, meta: false }
    expect(kb.findConflict('toggle-mute', 'KeyD', ctrlShift)?.id).toBe('toggle-deafen')
    expect(kb.findConflict('toggle-deafen', 'KeyD', ctrlShift)).toBeNull()
    kb.setKeybindEnabled('toggle-deafen', false)
    expect(kb.findConflict('toggle-mute', 'KeyD', ctrlShift)).toBeNull()
  })
})
