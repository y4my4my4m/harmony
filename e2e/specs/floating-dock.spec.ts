// Journey: the floating voice dock window (desktop app, index.html?dock=1).
//
// The desktop app opens this page in a borderless, always-on-top window and drives it over
// Tauri events (src/services/floatingDock.ts). A browser has no Tauri runtime, so an init
// script stands in for its IPC (window.__TAURI_INTERNALS__): the page's real
// @tauri-apps/api code runs against it, events the main window would send are delivered
// through it, and every command the page invokes is recorded. Window geometry answers as the
// desktop would: the dock window and the main window at fixed screen positions.
//
// The main window's side (tear-off on release outside the window, Float, re-docking where
// it was dropped) runs in the desktop app only and is covered by unit tests
// (UnifiedVoiceDock.floatingDock.test.ts, floatingDock.test.ts).

import { test, expect, type Page } from '@playwright/test'
import { expectNoAxeViolations } from './a11y'

interface Recorded {
  cmd: string
  args: any
}

/** Installs a stand-in for the Tauri IPC before any page script runs. */
async function installTauri(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const listeners: Record<string, number[]> = {}
    const callbacks: Record<number, (payload: unknown) => void> = {}
    let nextId = 1
    const geometry = {
      dock: { pos: { x: 2000, y: 100 }, size: { width: 360, height: 56 } },
      main: { pos: { x: 100, y: 100 }, size: { width: 1200, height: 800 }, inner: { x: 100, y: 130 }, scale: 1 },
    }
    const recorded: Array<{ cmd: string; args: unknown }> = []
    ;(window as any).__dock = {
      recorded,
      geometry,
      deliver(event: string, payload: unknown) {
        for (const id of listeners[event] ?? []) callbacks[id]?.({ event, id, payload })
      },
    }
    ;(window as any).__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: 'dock' }, currentWebview: { windowLabel: 'dock', label: 'dock' } },
      transformCallback(callback: (payload: unknown) => void) {
        const id = nextId++
        callbacks[id] = callback
        return id
      },
      unregisterCallback(id: number) {
        delete callbacks[id]
      },
      convertFileSrc: (path: string) => path,
      async invoke(cmd: string, args: any) {
        recorded.push({ cmd, args: JSON.parse(JSON.stringify(args ?? null)) })
        const which = args?.label === 'main' ? geometry.main : geometry.dock
        switch (cmd) {
          case 'plugin:event|listen':
            ;(listeners[args.event] ??= []).push(args.handler)
            return args.handler
          case 'plugin:event|unlisten':
            return null
          case 'plugin:window|get_all_windows':
            return ['main', 'dock']
          case 'plugin:window|outer_position':
            return which.pos
          case 'plugin:window|inner_position':
            return 'inner' in which ? which.inner : which.pos
          case 'plugin:window|outer_size':
            return which.size
          case 'plugin:window|scale_factor':
            return 'scale' in which ? which.scale : 1
          case 'plugin:window|is_visible':
            return true
          case 'plugin:window|is_minimized':
            return false
          default:
            return null
        }
      },
    }
  })
}

const recorded = (page: Page): Promise<Recorded[]> => page.evaluate(() => (window as any).__dock.recorded)
const commands = async (page: Page) =>
  (await recorded(page)).filter((r) => r.cmd === 'plugin:event|emit' && r.args.event === 'dock://command').map((r) => r.args.payload)

const STATE = {
  channelName: 'lounge',
  selfId: 'me',
  participants: [
    { userId: 'me', name: 'Avery', avatar: '/default_avatar.webp', speaking: true, muted: false, deafened: false },
    { userId: 'bob', name: 'Blake', avatar: '/default_avatar.webp', speaking: false, muted: true, deafened: false },
  ],
  muted: false,
  deafened: false,
  speakLocked: false,
  deafenLocked: false,
  encrypted: true,
  reconnecting: false,
  startedAt: null,
  labels: {
    mute: 'Mute', unmute: 'Unmute', deafen: 'Deafen', undeafen: 'Undeafen', backToApp: 'Back to the app',
    leave: 'Leave voice', participants: 'Participants', inCall: '2 in call',
    dragHint: 'Drag to move. Drop it on Harmony to put it back.', reconnecting: 'Reconnecting…',
  },
  html: { className: '', style: '', attributes: { 'data-theme': 'dark' } },
}

test('the floating dock window shows the call, sends its controls and goes back when dropped on the app', async ({ page }) => {
  await installTauri(page)
  await page.goto('/?dock=1')

  await test.step('it asks the main window for the call once mounted', async () => {
    await expect.poll(async () => (await recorded(page)).some((r) => r.cmd === 'plugin:event|emit' && r.args.event === 'dock://ready'), { timeout: 30000 }).toBe(true)
    await page.evaluate((state) => (window as any).__dock.deliver('dock://state', state), STATE)
    const dock = page.getByRole('region', { name: 'lounge' })
    await expect(dock).toBeVisible()
    await expect(dock.getByText('2 in call')).toBeAttached()
    await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  })

  await test.step('the window is sized to the dock', async () => {
    await expect.poll(async () => (await recorded(page)).filter((r) => r.cmd === 'plugin:window|set_size').length).toBeGreaterThan(0)
    const sizes = (await recorded(page)).filter((r) => r.cmd === 'plugin:window|set_size')
    const last = sizes[sizes.length - 1].args.value
    expect(last.Logical.width).toBeGreaterThanOrEqual(320)
    expect(last.Logical.height).toBeGreaterThan(30)
  })

  await test.step('its controls are named and send commands', async () => {
    await page.getByRole('button', { name: 'Mute' }).click()
    await page.getByRole('button', { name: 'Deafen' }).click()
    await page.getByRole('button', { name: 'Participants' }).click()
    await expect(page.getByTestId('floating-dock-row-bob')).toContainText('Blake')
    await expectNoAxeViolations(page, { include: '[data-testid="floating-dock"]' })
    await expect.poll(() => commands(page)).toEqual([{ type: 'mute' }, { type: 'deafen' }])
  })

  await test.step('it drags natively from its info area', async () => {
    await page.getByTestId('floating-dock-drag').dispatchEvent('mousedown', { button: 0 })
    await expect.poll(async () => (await recorded(page)).some((r) => r.cmd === 'plugin:window|start_dragging')).toBe(true)
  })

  await test.step('dropped off the app it keeps floating; dropped on it, it goes back in', async () => {
    await page.evaluate(() => (window as any).__dock.deliver('tauri://move', { x: 2000, y: 100 }))
    await page.waitForTimeout(700)
    expect(await commands(page)).toHaveLength(2)

    await page.evaluate(() => {
      const dock = (window as any).__dock
      dock.geometry.dock.pos = { x: 400, y: 330 }
      dock.deliver('tauri://move', { x: 400, y: 330 })
    })
    // The app's content origin is (100, 130): the dock lands 300, 200 into it.
    await expect.poll(async () => (await commands(page)).slice(2)).toEqual([{ type: 'redock', at: { x: 300, y: 200 } }])
  })
})

test('a native drag that lands on the app puts the dock back, with no move event from the platform', async ({ page }) => {
  await installTauri(page)
  await page.goto('/?dock=1')
  await expect.poll(async () => (await recorded(page)).some((r) => r.cmd === 'plugin:event|emit' && r.args.event === 'dock://ready'), { timeout: 30000 }).toBe(true)
  await page.evaluate((state) => (window as any).__dock.deliver('dock://state', state), STATE)
  await expect(page.getByRole('region', { name: 'lounge' })).toBeVisible()

  await page.getByTestId('floating-dock-drag').dispatchEvent('mousedown', { button: 0 })
  await expect.poll(async () => (await recorded(page)).some((r) => r.cmd === 'plugin:window|start_dragging')).toBe(true)
  // The window manager carries the window over the app; the page only sees its position change.
  await page.evaluate(() => { (window as any).__dock.geometry.dock.pos = { x: 600, y: 230 } })
  await page.waitForTimeout(300)
  await page.evaluate(() => { (window as any).__dock.geometry.dock.pos = { x: 400, y: 330 } })
  await expect.poll(() => commands(page), { timeout: 5000 }).toEqual([{ type: 'redock', at: { x: 300, y: 200 } }])
})

test('Back to the app asks for the call view, once', async ({ page }) => {
  await installTauri(page)
  await page.goto('/?dock=1')
  await expect.poll(async () => (await recorded(page)).some((r) => r.cmd === 'plugin:event|emit' && r.args.event === 'dock://ready'), { timeout: 30000 }).toBe(true)
  await page.evaluate((state) => (window as any).__dock.deliver('dock://state', state), STATE)
  const back = page.getByRole('button', { name: 'Back to the app' })
  await back.click()
  await back.click()
  await expect.poll(() => commands(page)).toEqual([{ type: 'expand' }])
})
