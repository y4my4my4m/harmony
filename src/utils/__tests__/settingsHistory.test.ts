import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRouter, createWebHistory, type Router } from 'vue-router'
import { pushLayer, resetLayersForTests } from '@/utils/a11y/layers'
import { installOverlayHistory } from '@/utils/overlayHistory'
import {
  leaveSettings,
  markedState,
  settingsEntryOf,
  settingsExit,
  SETTINGS_STATE_KEY,
  type SettingsEntry,
} from '@/utils/settingsHistory'

// vue-router history.state: position counts entries of the tab; back is the previous
// in-app location, null on the first entry of a page load.
const state = (position: number, back: string | null, extra: Record<string, unknown> = {}) => ({
  position,
  back,
  current: '/settings',
  forward: null,
  replaced: false,
  scroll: null,
  ...extra,
})

describe('settingsEntryOf', () => {
  it('an unmarked entry pushed from the app is the base, with the app under it', () => {
    expect(settingsEntryOf(state(4, '/chat/s/c'))).toEqual({ base: 4, inApp: true })
  })

  it('an unmarked first entry of a tab has nothing of the app under it', () => {
    expect(settingsEntryOf(state(1, null))).toEqual({ base: 1, inApp: false })
  })

  it('a marked entry keeps the base it was given', () => {
    const marked = state(6, '/settings', { [SETTINGS_STATE_KEY]: { base: 4, inApp: true } })
    expect(settingsEntryOf(marked)).toEqual({ base: 4, inApp: true })
  })

  it('no state reads as an unmarked first entry', () => {
    expect(settingsEntryOf(null)).toEqual({ base: 0, inApp: false })
  })
})

describe('markedState', () => {
  it('adds the entry and keeps the router fields', () => {
    const marked = markedState(state(5, '/settings'), { base: 4, inApp: true })
    expect(marked).toMatchObject({ position: 5, back: '/settings', [SETTINGS_STATE_KEY]: { base: 4, inApp: true } })
  })

  it('returns null when the entry is already recorded', () => {
    const marked = state(5, '/settings', { [SETTINGS_STATE_KEY]: { base: 4, inApp: true } })
    expect(markedState(marked, { base: 4, inApp: true })).toBeNull()
  })

  it('returns null without a state object', () => {
    expect(markedState(null, { base: 0, inApp: false })).toBeNull()
  })
})

describe('settingsExit', () => {
  it('goes back one from the only Settings entry', () => {
    expect(settingsExit({ base: 4, inApp: true }, state(4, '/chat/s/c'))).toEqual({ kind: 'back', delta: -1 })
  })

  it('goes back past sections and overlay entries pushed on top', () => {
    expect(settingsExit({ base: 4, inApp: true }, state(6, '/settings/appearance'))).toEqual({ kind: 'back', delta: -3 })
  })

  it('replaces the entry of a tab that opened on Settings', () => {
    expect(settingsExit({ base: 1, inApp: false }, state(1, null))).toEqual({ kind: 'replace', delta: -0 })
  })

  it('returns to the base entry before replacing it when sections were pushed', () => {
    expect(settingsExit({ base: 1, inApp: false }, state(3, '/settings/appearance'))).toEqual({ kind: 'replace', delta: -2 })
  })

  it('treats a position below the base as the base', () => {
    expect(settingsExit({ base: 4, inApp: true }, state(2, null))).toEqual({ kind: 'back', delta: -1 })
  })
})

describe('leaveSettings', () => {
  const Page = { render: () => null }
  let router: Router
  let uninstall: () => void
  const nativeGo = window.history.go.bind(window.history)
  // happy-dom applies history.go() synchronously. Browsers apply it on a later task, each
  // relative to the entry current then; a refused traversal does nothing.
  let refuseGo = false
  const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
  const position = () => (window.history.state as { position: number }).position
  const path = () => router.currentRoute.value.fullPath

  /** A discard prompt: a dialog layer with a Back entry, closed by its answer. */
  async function openPrompt() {
    const remove = pushLayer({ kind: 'dialog', element: () => document.body, onEscape: () => remove() })
    await settle()
    return remove
  }

  beforeEach(async () => {
    refuseGo = false
    vi.spyOn(window.history, 'go').mockImplementation((delta?: number) => {
      setTimeout(() => {
        if (!refuseGo) nativeGo(delta)
      }, 0)
    })
    resetLayersForTests()
    router = createRouter({
      history: createWebHistory(),
      routes: [
        { path: '/a', component: Page },
        { path: '/b', component: Page },
        { path: '/chat', name: 'Chat', component: Page },
        { path: '/settings/:section?', component: Page },
      ],
    })
    uninstall = installOverlayHistory(router, () => true)
    await router.push('/a')
    await router.push('/b')
    await settle()
  })

  afterEach(() => {
    uninstall()
    router.options.history.destroy()
    resetLayersForTests()
    vi.restoreAllMocks()
  })

  it('after Discard closes the prompt, goes back once past Settings', async () => {
    await router.push('/settings')
    const entry = settingsEntryOf(window.history.state)
    const closePrompt = await openPrompt()

    closePrompt() // drops the prompt's entry with go(-1)
    await leaveSettings(router, entry)
    await settle()

    expect(path()).toBe('/b')
    expect(position()).toBe(entry.base - 1)
  })

  it('a tab that opened on Settings replaces the base entry with chat after the prompt closes', async () => {
    await router.push('/settings')
    const entry: SettingsEntry = { base: position(), inApp: false }
    const closePrompt = await openPrompt()

    closePrompt()
    await leaveSettings(router, entry)
    await settle()

    expect(path()).toBe('/chat')
    expect(position()).toBe(entry.base)
  })

  it('a refused traversal leaves the next navigation alone', async () => {
    await router.push('/settings')
    const entry: SettingsEntry = { base: position(), inApp: false }
    await router.push('/settings/appearance')
    await settle()

    refuseGo = true
    await leaveSettings(router, entry)
    await settle()
    refuseGo = false

    await router.push('/a')
    await settle()
    expect(path()).toBe('/a')
  })
})
