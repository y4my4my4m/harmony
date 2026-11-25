// Journey: play together. Two people in a DM start DrawinPhone, play a whole game in sandboxed
// frames through the federation backend's relay, and the starter ends it for everyone. The frame
// runs in an opaque origin with no storage and no network, and one that navigates itself away is
// cut off. An instance admin turns the app off and the launcher stops offering it.
//
// The backend runs as a child process (backend.ts): page.route() carries the frame document and
// routeWebSocket() bridges the relay socket to it.

import { test, expect, devices, type Browser, type BrowserContext, type FrameLocator, type Page } from '@playwright/test'
import { addMember, adminClient, createUser, deleteUser, dismissAnnouncements, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'
import { startBackend, type Backend } from './backend'
import JSZip from 'jszip'
import { createHash } from 'node:crypto'

test.use({ serviceWorkers: 'block' })
test.describe.configure({ mode: 'serial' })

const admin = adminClient()
let alice: SpecUser
let bob: SpecUser
let boss: SpecUser
let dm = ''
let backend: Backend
let server: SeededServer
let voiceId = ''

async function must<T extends { error: { message: string } | null }>(what: string, result: PromiseLike<T>): Promise<T> {
  const r = await result
  if (r.error) throw new Error(`${what}: ${r.error.message}`)
  return r
}

async function open(browser: Browser, user: SpecUser): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ serviceWorkers: 'block' })
  const page = await context.newPage()
  await backend.route(page)
  await signIn(page, user)
  return { context, page }
}

const game = (page: Page): FrameLocator => page.frameLocator('[data-testid="play-together-frame"]')

/** A DM's Activities entry is in its header's More options menu. */
async function openDmActivities(page: Page): Promise<void> {
  await page.getByTestId('dm-more').click()
  await page.getByTestId('activities-menu-item').click()
}

/** The launcher, each app card and the sandbox note lie within the dialog's left and right edges. */
async function expectLauncherFits(page: Page): Promise<void> {
  const launcher = page.getByTestId('activities-launcher')
  const dialog = page.getByRole('dialog').filter({ has: launcher })
  const parts = [launcher, launcher.locator('.act-launcher__note'), ...await launcher.locator('.act-launcher__app').all()]
  await expect(async () => {
    const frame = await dialog.boundingBox()
    if (!frame) throw new Error('no launcher dialog')
    for (const part of parts) {
      const box = await part.boundingBox()
      if (!box) throw new Error('launcher part not laid out')
      expect(box.x).toBeGreaterThanOrEqual(frame.x)
      expect(box.x + box.width).toBeLessThanOrEqual(frame.x + frame.width)
    }
  }).toPass({ timeout: 5000 })
}

/** The game frame is the topmost element at its centre: nothing in the page paints over it. */
async function expectFrameOnTop(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => {
    const frame = document.querySelector('[data-testid="play-together-frame"]')
    if (!frame) return 'no frame'
    const box = frame.getBoundingClientRect()
    const top = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
    return top === frame ? 'frame' : `${top?.tagName.toLowerCase()}.${[...(top?.classList ?? [])].join('.')}`
  }), { timeout: 5000 }).toBe('frame')
}

async function scribble(page: Page): Promise<void> {
  const box = await game(page).locator('[data-testid="dp-canvas"]').boundingBox()
  if (!box) throw new Error('no canvas')
  const x = box.x + box.width * 0.3
  const y = box.y + box.height * 0.4
  await page.mouse.move(x, y)
  await page.mouse.down()
  for (let i = 1; i <= 12; i++) await page.mouse.move(x + i * 14, y + Math.sin(i) * 30, { steps: 2 })
  await page.mouse.up()
}

test.beforeAll(async () => {
  backend = await startBackend()
  alice = await createUser(admin, 'pta')
  bob = await createUser(admin, 'ptb')
  boss = await createUser(admin, 'ptadm')
  await must('admin flag', admin.from('profiles').update({ is_admin: true }).eq('id', boss.id))
  await must('app on', admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone'))
  const conversation = await must('dm', admin.from('conversations').insert({ type: 'direct', created_by: alice.id }).select('id').single())
  dm = conversation.data!.id
  await must('participants', admin.from('conversation_participants').insert([
    { conversation_id: dm, user_id: alice.id }, { conversation_id: dm, user_id: bob.id },
  ]))
  server = await seedServer(admin, alice, `Arcade ${alice.username}`)
  await addMember(admin, bob, server.id)
  const voice = await must('voice channel', admin.from('channels').insert({ server_id: server.id, name: 'arcade', type: 1 }).select('id').single())
  voiceId = voice.data!.id
  await must('in the call', admin.from('voice_channel_participants').insert([
    { channel_id: voiceId, user_id: alice.id, server_id: server.id }, { channel_id: voiceId, user_id: bob.id, server_id: server.id },
  ]))
})

/** The voice store as a call to the arcade channel leaves it; no LiveKit runs in this stack. */
async function enterCall(page: Page, user: SpecUser, overlay: boolean): Promise<void> {
  await page.evaluate(({ serverId, channelId, userId, roster, overlay }) => {
    type Store = { $patch: (fn: (state: Record<string, any>) => void) => void }
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, Store> } } } }
    }
    const stores = root.__vue_app__.config.globalProperties.$pinia._s
    stores.get('unifiedVoiceChannel')!.$patch((state) => {
      state.isConnected = true
      state.currentServerId = serverId
      state.currentChannelId = channelId
      state.currentChannelName = 'arcade'
      state.localState.userId = userId
      if (overlay) state.isOverlayVisible = true
    })
    stores.get('serverUsers')?.$patch((state) => {
      state.usersInVoiceChannels = { ...state.usersInVoiceChannels, [channelId]: roster }
    })
  }, { serverId: server.id, channelId: voiceId, userId: user.id, roster: [alice.id, bob.id], overlay })
}

test.afterAll(async () => {
  test.setTimeout(120_000)
  await admin.from('activity_apps').delete().eq('id', 'tictac')
  await admin.from('activity_apps').update({ enabled: true }).eq('id', 'drawinphone')
  if (voiceId) await admin.from('activity_sessions').delete().eq('channel_id', voiceId)
  if (server) await admin.from('servers').delete().eq('id', server.id)
  await admin.from('activity_sessions').delete().eq('conversation_id', dm)
  await admin.from('conversations').delete().eq('id', dm)
  for (const user of [alice, bob, boss]) if (user) await deleteUser(admin, user)
  await backend?.stop()
})

test('two people play DrawinPhone in a DM, then the starter ends it', async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await open(browser, alice)
  const b = await open(browser, bob)

  await a.page.goto(`/dm/${dm}`)
  await openDmActivities(a.page)
  await expect(a.page.getByTestId('activities-launcher')).toBeVisible()
  await expectLauncherFits(a.page)
  await a.page.getByTestId('play-together-app-drawinphone').click()

  await expect(a.page.getByTestId('play-together-panel')).toBeVisible()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(1)
  await expect(a.page.getByTestId('play-together-third-party')).toHaveCount(0)

  // Bob joins from the notice in the conversation. The stack has no Realtime: the notice reaches
  // a page that loads the conversation after it was posted.
  await b.page.goto(`/dm/${dm}`)
  await expect(b.page.locator('[data-system-type="activity_started"]')).toHaveCount(1)
  await b.page.getByTestId('activity-system-join').click()
  await expect(game(b.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
  await expect(game(b.page).getByTestId('dp-player')).toHaveCount(2)
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(2)

  // Expanded, the panel covers the conversation and the game stays above it.
  await expectFrameOnTop(a.page)
  await a.page.getByTestId('play-together-expand').click()
  await expect(a.page.getByTestId('play-together-panel')).toHaveClass(/is-expanded/)
  await expectFrameOnTop(a.page)
  await a.page.getByTestId('play-together-expand').click()
  await expect(a.page.getByTestId('play-together-panel')).not.toHaveClass(/is-expanded/)
  await expectFrameOnTop(a.page)

  // Write, then draw the other's prompt.
  await game(a.page).getByTestId('dp-start').click()
  for (const [page, text] of [[a.page, 'a cat surfing a wave'], [b.page, 'a robot baking bread']] as const) {
    await game(page).getByTestId('dp-prompt-input').fill(text)
    await game(page).getByTestId('dp-submit').click()
  }
  for (const page of [a.page, b.page]) {
    await expect(game(page).getByTestId('dp-canvas')).toBeVisible({ timeout: 20_000 })
    await scribble(page)
    await game(page).getByTestId('dp-submit').click()
  }

  // The album: everyone sees it; the host steps through to the end.
  await expect(game(a.page).getByTestId('dp-album')).toBeVisible({ timeout: 20_000 })
  await expect(game(b.page).getByTestId('dp-album')).toBeVisible()
  await expect(game(b.page).getByTestId('dp-album')).toContainText(/a cat surfing a wave|a robot baking bread/)
  const next = game(a.page).getByTestId('dp-next')
  const again = game(a.page).getByTestId('dp-play-again')
  for (let i = 0; i < 12; i++) {
    await expect(next.or(again).first()).toBeVisible()
    if (await again.isVisible()) break
    await next.click().catch(() => {})
  }
  await expect(game(a.page).getByTestId('dp-play-again')).toBeVisible()

  // Alice started it: she ends it for everyone.
  await a.page.getByTestId('play-together-end').click()
  await expect(b.page.getByTestId('play-together-status')).toHaveText(/Ended/)
  await expect(game(b.page).getByTestId('dp-ended')).toBeVisible()
  await b.page.getByTestId('play-together-leave').click()
  await expect(b.page.getByTestId('play-together-panel')).toHaveCount(0)
  await b.page.reload()
  await expect(b.page.locator('[data-system-type="activity_ended"]')).toHaveCount(1, { timeout: 15_000 })
  await expect(b.page.locator('[data-system-type="activity_ended"]')).toContainText('2')
  const row = await must('session', admin.from('activity_sessions').select('status, end_reason, played_by').eq('conversation_id', dm).single())
  expect(row.data).toMatchObject({ status: 'ended', end_reason: 'host_ended' })
  expect((row.data!.played_by as string[]).sort()).toEqual([alice.id, bob.id].sort())

  await a.context.close()
  await b.context.close()
})

test('the activity frame runs in an opaque origin without storage or network', async ({ browser }) => {
  const a = await open(browser, alice)
  // A desktop shell's bridge as wry adds it on WebView2, in every frame: window.ipc calls
  // window.chrome.webview at send time.
  await a.page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown> & { chrome?: Record<string, unknown> }
    w.chrome = { ...(w.chrome ?? {}), webview: { postMessage: () => { (window as unknown as { __bridged?: boolean }).__bridged = true } } }
    Object.defineProperty(window, 'ipc', { value: Object.freeze({ postMessage: (m: string) => (w.chrome!.webview as { postMessage: (m: string) => void }).postMessage(m) }) })
    w.webkit = { messageHandlers: { ipc: { postMessage: () => {} } } }
  })
  await a.page.goto(`/dm/${dm}`)
  await openDmActivities(a.page)
  await a.page.getByTestId('play-together-app-drawinphone').click()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })

  await expect(a.page.getByTestId('play-together-frame')).toHaveAttribute('sandbox', 'allow-scripts allow-pointer-lock')
  const frame = a.page.frames().find((f) => f.url().includes('/activities/frame/drawinphone'))!
  const probe = await frame.evaluate(async () => {
    const attempt = async (fn: () => unknown) => {
      try {
        await fn()
        return 'open'
      } catch {
        return 'blocked'
      }
    }
    return {
      origin: self.origin,
      storage: await attempt(() => window.localStorage.length),
      cookie: await attempt(() => document.cookie),
      top: await attempt(() => window.top!.location.href),
      fetch: await attempt(() => fetch('/api/federation/health').then((r) => r.status)),
      // Firefox refuses the socket without an error event: only an open counts as open.
      socket: await attempt(() => new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${location.host || 'localhost'}/`)
        ws.onopen = resolve
        ws.onerror = reject
        setTimeout(() => reject(new Error('no open')), 3000)
      })),
    }
  })
  expect(probe).toEqual({ origin: 'null', storage: 'blocked', cookie: 'blocked', top: 'blocked', fetch: 'blocked', socket: 'blocked' })

  // The loader removed the shell's message ports before the activity ran: the bridge it left
  // behind reaches nothing. The app's own page keeps them.
  const ports = await frame.evaluate(() => {
    const w = window as unknown as Record<string, unknown> & { ipc: { postMessage: (m: string) => void } }
    let sent = 'sent'
    try { w.ipc.postMessage('{}') } catch { sent = 'refused' }
    return { chrome: typeof w.chrome, webkit: typeof w.webkit, sent, bridged: w.__bridged === true }
  })
  expect(ports).toEqual({ chrome: 'undefined', webkit: 'undefined', sent: 'refused', bridged: false })
  expect(await a.page.evaluate(() => typeof (window as unknown as { chrome?: unknown }).chrome)).toBe('object')

  // No WebRTC in the frame, and a document nested in it, which would have its own, runs neither an
  // inline script under the loader's nonce nor the activity's script.
  const nested = await frame.evaluate(async () => {
    const heard: unknown[] = []
    window.addEventListener('message', (event) => { if (event.source !== window.parent) heard.push(event.data) })
    const nonce = document.querySelector<HTMLScriptElement>('script[nonce]')!.nonce
    const src = document.querySelector<HTMLScriptElement>('script[src]')!.src
    for (const script of [`<script nonce="${nonce}">parent.postMessage(typeof RTCPeerConnection, '*')</` + 'script>', `<script src="${src}"></` + 'script>']) {
      const child = document.createElement('iframe')
      child.srcdoc = script
      const loaded = new Promise((resolve) => child.addEventListener('load', resolve))
      document.body.appendChild(child)
      await loaded
    }
    await new Promise((resolve) => setTimeout(resolve, 500))
    const w = window as unknown as Record<string, unknown>
    return { rtc: ['RTCPeerConnection', 'webkitRTCPeerConnection', 'RTCDataChannel'].map((name) => typeof w[name]), heard }
  })
  expect(nested).toEqual({ rtc: ['undefined', 'undefined', 'undefined'], heard: [] })

  // An activity that navigates its own frame away is detached and the frame blanked.
  await frame.evaluate(() => { location.href = '/activities/index.json' })
  await expect(a.page.getByText('tried to leave its sandbox')).toBeVisible()
  await expect(a.page.getByTestId('play-together-frame')).toHaveAttribute('src', 'about:blank')

  await a.page.getByTestId('play-together-end').click()
  await a.context.close()
})

test('an admin turns DrawinPhone off and the launcher stops offering it', async ({ browser }) => {
  const boss$ = await open(browser, boss)
  await boss$.page.goto('/admin?tab=activities')
  const toggle = boss$.page.getByTestId('activities-admin-toggle-drawinphone')
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  const row = await must('app', admin.from('activity_apps').select('enabled').eq('id', 'drawinphone').single())
  expect(row.data!.enabled).toBe(false)

  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await a.page.getByTestId('dm-more').click()
  await expect(a.page.getByTestId('dm-menu-add-people')).toBeVisible({ timeout: 30_000 })
  await expect(a.page.getByTestId('activities-menu-item')).toHaveCount(0)
  await a.page.keyboard.press('Escape')

  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')
  await boss$.context.close()
  await a.context.close()
})

test('a call plays DrawinPhone on its stage, and the frame takes input over the call view', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await open(browser, alice)
  const b = await open(browser, bob)

  await openChannel(a.page, server.id, server.generalChannelId)
  await enterCall(a.page, alice, false)
  await a.page.getByTestId('dock-activities-button').click()
  await a.page.getByTestId('play-together-app-drawinphone').click()

  // The call view opens with the game on its stage.
  const stage = a.page.locator('.voice-overlay [data-testid="play-together-panel"]')
  await expect(stage).toBeVisible()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })

  // Bob is in the call: the stage banner offers the game.
  await openChannel(b.page, server.id, server.generalChannelId)
  await enterCall(b.page, bob, true)
  await b.page.locator('.voice-overlay').getByTestId('play-together-join').click()
  await expect(game(b.page).getByTestId('dp-player')).toHaveCount(2, { timeout: 30_000 })
  await expect(game(a.page).getByTestId('dp-player')).toHaveCount(2)

  // The call view makes the rest of the page inert; the game must still take clicks and keys.
  await game(a.page).getByTestId('dp-start').click()
  await game(a.page).getByTestId('dp-prompt-input').fill('a duck conducting an orchestra')
  await expect(game(a.page).getByTestId('dp-prompt-input')).toHaveValue('a duck conducting an orchestra')
  await expect(game(b.page).getByTestId('dp-prompt-input')).toBeVisible()

  const row = await must('session', admin.from('activity_sessions').select('context, status').eq('channel_id', voiceId).eq('status', 'active').single())
  expect(row.data!.context).toBe('voice')

  await a.page.getByTestId('play-together-end').click()
  await expect(b.page.getByTestId('play-together-status')).toHaveText(/Ended/)
  await a.context.close()
  await b.context.close()
})

test('a game started in the call\'s pop-out runs in that window, and follows the call view back', async ({ browser }) => {
  test.setTimeout(150_000)
  const context = await browser.newContext({ serviceWorkers: 'block' })
  // window.open in place of Document Picture-in-Picture, whose window Playwright does not report.
  await context.addInitScript(() => { delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture })
  const page = await context.newPage()
  await backend.route(page)
  // Bob starts this one: an account starts 6 games in 10 minutes, and Alice starts the rest.
  await signIn(page, bob)
  await openChannel(page, server.id, server.generalChannelId)
  await enterCall(page, bob, true)
  await expect(page.getByTestId('voice-overlay')).toBeVisible({ timeout: 15_000 })

  const opened = page.waitForEvent('popup')
  await page.getByTestId('voice-overlay').getByRole('button', { name: 'Pop out call' }).click()
  const popup = await opened
  await backend.route(popup)
  await expect(popup.getByTestId('voice-overlay')).toBeVisible({ timeout: 15_000 })

  /** The frame lies over the panel's slot in this window. */
  const covers = async (p: Page) => {
    const slot = await p.getByTestId('play-together-slot').boundingBox()
    const box = await p.getByTestId('play-together-host').boundingBox()
    return !!slot && !!box && Math.abs(slot.x - box.x) < 2 && Math.abs(slot.y - box.y) < 2 && Math.abs(slot.width - box.width) < 2
  }

  await test.step('the frame is in the pop-out\'s document, over its stage; nothing of it is in the main window', async () => {
    await popup.getByTestId('overlay-activities-button').click()
    await popup.getByTestId('play-together-app-drawinphone').click()
    await expect(game(popup).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => covers(popup), { timeout: 10_000 }).toBe(true)
    await expectFrameOnTop(popup)
    await expect(page.getByTestId('play-together-host')).toHaveCount(0)
    await expect(page.getByTestId('play-together-mini')).toHaveCount(0)
  })

  const other = await open(browser, alice)
  await test.step('it plays there: two people, the round started and a prompt written in the pop-out', async () => {
    await openChannel(other.page, server.id, server.generalChannelId)
    await enterCall(other.page, alice, true)
    await other.page.locator('.voice-overlay').getByTestId('play-together-join').click()
    await expect(game(popup).getByTestId('dp-player')).toHaveCount(2, { timeout: 30_000 })
    await game(popup).getByTestId('dp-start').click()
    await game(popup).getByTestId('dp-prompt-input').fill('a lighthouse on the moon')
    await expect(game(other.page).getByTestId('dp-prompt-input')).toBeVisible()
  })

  await test.step('closing the pop-out brings the running game back over the main window\'s stage', async () => {
    await popup.close()
    await expect(page.getByTestId('voice-overlay')).toBeVisible({ timeout: 15_000 })
    await expect(game(page).getByTestId('dp-prompt-input')).toBeVisible({ timeout: 30_000 })
    await expect.poll(() => covers(page), { timeout: 10_000 }).toBe(true)
    await expectFrameOnTop(page)
    await expect(page.getByText('tried to leave its sandbox')).toHaveCount(0)
  })

  await test.step('opening the pop-out again takes it along', async () => {
    const again = page.waitForEvent('popup')
    await page.getByTestId('voice-overlay').getByRole('button', { name: 'Pop out call' }).click()
    const second = await again
    await backend.route(second)
    await expect(second.getByTestId('voice-overlay')).toBeVisible({ timeout: 15_000 })
    await expect(second.getByTestId('play-together-frame')).toHaveCount(1)
    await expect(page.getByTestId('play-together-host')).toHaveCount(0)
    await second.close()
    await expect(page.getByTestId('play-together-frame')).toHaveCount(1)
  })

  await page.getByTestId('play-together-end').click()
  await context.close()
  await other.context.close()
})

// The launcher is no part of the sign-in page, whatever the store holds: the sign-in that follows, in
// the same page, shows whether it was closed.
test('an account that signs out in another tab has its launcher closed here', async ({ browser }) => {
  test.setTimeout(120_000)
  const a = await open(browser, bob)
  const page = a.page
  await page.goto(`/dm/${dm}`)
  await openDmActivities(page)
  await expect(page.getByTestId('activities-launcher')).toBeVisible()

  const tab = await a.context.newPage()
  await backend.route(tab)
  await tab.goto('/settings/account')
  await dismissAnnouncements(tab)
  await tab.getByRole('button', { name: 'Log out' }).click()
  await expect(tab).toHaveURL(/\/login/, { timeout: 30_000 })
  await expect(page).toHaveURL(/\/login/, { timeout: 15_000 })
  await expect(page.getByTestId('activities-launcher')).toHaveCount(0)

  await page.evaluate(() => { (window as unknown as { __samePage?: boolean }).__samePage = true })
  await page.getByTestId('auth-email').fill(bob.email)
  await page.getByTestId('auth-password').fill(bob.password)
  await page.getByTestId('auth-submit').click()
  await expect(page).toHaveURL(/\/chat/, { timeout: 30_000 })
  await expect(page.getByRole('region', { name: 'Your account' })).toContainText(bob.displayName, { timeout: 30_000 })
  expect(await page.evaluate(() => (window as unknown as { __samePage?: boolean }).__samePage)).toBe(true)
  await page.waitForTimeout(500)
  await expect(page.getByTestId('activities-launcher')).toHaveCount(0)
  await a.context.close()
})

/** One stored local entry of `dataLen` bytes, listed by `records` central directory records declaring size 0. */
function sharedStoredEntry(records: number, dataLen: number): Buffer {
  const name = Buffer.from('x')
  const local = Buffer.alloc(30)
  local.writeUInt32LE(0x04034b50, 0)
  local.writeUInt16LE(name.length, 26)
  const head = Buffer.concat([local, name, Buffer.alloc(dataLen, 0x41)])
  const cds: Buffer[] = []
  for (let i = 0; i < records; i++) {
    const nm = Buffer.from(`f${i}.js`)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt32LE(dataLen, 20)
    cd.writeUInt16LE(nm.length, 28)
    cds.push(cd, nm)
  }
  const dir = Buffer.concat(cds)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(records, 8)
  end.writeUInt16LE(records, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(head.length, 16)
  return Buffer.concat([head, dir, end])
}

/** A 98-byte zip64 archive whose end record claims `count` entries. */
function zip64Claiming(count: number): Buffer {
  const z64 = Buffer.alloc(56)
  z64.writeUInt32LE(0x06064b50, 0)
  z64.writeUInt32LE(count >>> 0, 32)
  z64.writeUInt32LE(0x7fffff00, 48)
  const locator = Buffer.alloc(20)
  locator.writeUInt32LE(0x07064b50, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0xffff, 8)
  end.writeUInt16LE(0xffff, 10)
  return Buffer.concat([z64, locator, end])
}

/**
 * A minimal package: the activity protocol by hand (activities/sdk/protocol.ts), greeting every
 * member it hears of. It asks to save an image once on init, without a click, and again from its
 * button; pkg-saved lists each answer.
 */
async function testPackage(): Promise<{ zip: Buffer; entrySha: string }> {
  const app = `(() => {
    const names = new Map()
    const out = document.createElement('div')
    out.setAttribute('data-testid', 'pkg-hello')
    document.body.appendChild(out)
    const show = () => { out.textContent = 'Hello ' + [...names.values()].join(', ') }
    const saved = document.createElement('div')
    saved.setAttribute('data-testid', 'pkg-saved')
    document.body.appendChild(saved)
    const asked = new Map()
    const save = (label) => {
      const id = asked.size + 1
      asked.set(id, label)
      const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
      parent.postMessage({ hp: 1, t: 'save', id, blob: new Blob([png], { type: 'image/png' }), name: 'tictac' }, '*')
    }
    const button = document.createElement('button')
    button.setAttribute('data-testid', 'pkg-save')
    button.textContent = 'Save'
    button.onclick = () => save('click')
    document.body.appendChild(button)
    addEventListener('message', (event) => {
      const m = event.data
      if (!m || m.hp !== 1) return
      if (m.t === 'init') { for (const member of m.members) names.set(member.id, member.name); show(); save('auto') }
      if (m.t === 'join') { names.set(m.member.id, m.member.name); show() }
      if (m.t === 'saved') saved.textContent += asked.get(m.id) + ':' + m.ok + ' '
    })
    parent.postMessage({ hp: 1, t: 'ready', sdk: 'test' }, '*')
  })()`
  const zip = new JSZip()
  zip.file('tictac/manifest.json', JSON.stringify({
    id: 'tictac', name: 'Tic Tac', version: '1.0.0', description: 'Noughts and crosses, from a package',
    minPlayers: 2, maxPlayers: 2, contexts: ['direct', 'group'], icon: 'icon.svg', accent: '#7C3AED', entry: 'app.js',
  }))
  zip.file('tictac/app.js', app)
  zip.file('tictac/icon.svg', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><rect width="8" height="8" fill="#7C3AED"/></svg>')
  return { zip: await zip.generateAsync({ type: 'nodebuffer' }), entrySha: createHash('sha256').update(app).digest('hex') }
}

test('an admin installs an activity package, switches it on, and a member plays it', async ({ browser }) => {
  test.setTimeout(120_000)
  const { zip, entrySha } = await testPackage()
  const boss$ = await open(browser, boss)
  await boss$.page.goto('/admin?tab=activities')

  // Crafted zips are refused at once: a zip64 end record claiming 2^32 - 1 entries, and one stored
  // entry listed 20 times with a declared size of 0.
  const error = boss$.page.getByTestId('activities-admin-error')
  await boss$.page.getByTestId('activities-admin-file').setInputFiles({ name: 'endless.zip', mimeType: 'application/zip', buffer: zip64Claiming(0xffffffff) })
  await expect(error).toContainText('32 zip entries', { timeout: 5_000 })
  await boss$.page.getByTestId('activities-admin-file').setInputFiles({ name: 'copies.zip', mimeType: 'application/zip', buffer: sharedStoredEntry(20, 1024 * 1024) })
  await expect(error).toContainText('too large', { timeout: 5_000 })

  await boss$.page.getByTestId('activities-admin-file').setInputFiles({ name: 'tictac.zip', mimeType: 'application/zip', buffer: zip })
  const preview = boss$.page.getByTestId('activities-admin-preview')
  await expect(preview).toContainText('Tic Tac')
  await expect(preview).toContainText(createHash('sha256').update(zip).digest('hex'))
  await boss$.page.getByTestId('activities-admin-install-confirm').click()

  const toggle = boss$.page.getByTestId('activities-admin-toggle-tictac')
  await expect(toggle).toHaveAttribute('aria-checked', 'false')
  await toggle.click()
  await expect(toggle).toHaveAttribute('aria-checked', 'true')

  // The stored script is served sandboxed, at its hash.
  const served = await fetch(`${backend.url}/activities/pkg/tictac/${entrySha}.js`)
  expect(served.status).toBe(200)
  expect(served.headers.get('content-security-policy')).toBe("sandbox; default-src 'none'")

  // On a phone, an installed package waits for a computer; the built-in plays.
  const phone = await browser.newContext({ serviceWorkers: 'block', ...devices['Pixel 7'] })
  const p = await phone.newPage()
  await backend.route(p)
  await signIn(p, alice)
  await p.goto(`/dm/${dm}`)
  await openDmActivities(p)
  await expect(p.getByTestId('play-together-desktop-only-tictac')).toHaveText('Computer only')
  await expect(p.getByTestId('play-together-app-tictac')).toBeDisabled()
  await expect(p.getByTestId('play-together-app-drawinphone')).toBeEnabled()
  await expect(p.getByTestId('play-together-desktop-only-drawinphone')).toHaveCount(0)
  await phone.close()

  // Third-party label: on the package, not the built-in.
  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await openDmActivities(a.page)
  await expect(a.page.getByTestId('play-together-third-party-tictac')).toHaveText('Third-party')
  await expect(a.page.getByTestId('play-together-third-party-drawinphone')).toHaveCount(0)

  // Two cards fit the dialog side by side, and stacked at phone width.
  await expectLauncherFits(a.page)
  const desktop = a.page.viewportSize()!
  await a.page.setViewportSize({ width: 375, height: 812 })
  await expectLauncherFits(a.page)
  await a.page.setViewportSize(desktop)

  await a.page.getByTestId('play-together-app-tictac').click()
  await expect(game(a.page).getByTestId('pkg-hello')).toContainText(alice.displayName, { timeout: 30_000 })
  await expect(a.page.getByTestId('play-together-third-party')).toContainText('Harmony never asks for your password')

  // A save without a click in the frame is refused; one from a click downloads.
  await expect(game(a.page).getByTestId('pkg-saved')).toHaveText('auto:false')
  const download = a.page.waitForEvent('download')
  await game(a.page).getByTestId('pkg-save').click()
  expect((await download).suggestedFilename()).toBe('tictac.png')
  await expect(game(a.page).getByTestId('pkg-saved')).toHaveText('auto:false click:true')

  // Bob sees the label on the Join banner before joining.
  const b = await open(browser, bob)
  await b.page.goto(`/dm/${dm}`)
  await expect(b.page.getByTestId('play-together-banner')).toBeVisible({ timeout: 30_000 })
  await expect(b.page.getByTestId('play-together-banner-third-party')).toHaveText('Third-party')
  await b.context.close()

  await a.page.getByTestId('play-together-end').click()

  // Removing it ends its sessions and takes it out of the launcher.
  await boss$.page.getByTestId('activities-admin-remove-tictac').click()
  await boss$.page.getByTestId('activities-admin-remove-tictac').click()
  await expect(boss$.page.getByTestId('activities-admin-tictac')).toHaveCount(0)
  const row = await admin.from('activity_apps').select('id').eq('id', 'tictac')
  expect(row.data).toEqual([])

  await boss$.context.close()
  await a.context.close()
})

test('a member who cannot send, or is timed out, cannot join a channel\'s game', async ({ browser }) => {
  test.setTimeout(120_000)
  const quiet = await must('quiet channel', admin.from('channels').insert({ server_id: server.id, name: 'quiet', type: 0 }).select('id').single())
  const quietId = quiet.data!.id
  const everyone = await must('default role', admin.from('server_roles').select('id').eq('server_id', server.id).eq('is_default', true).single())
  await must('deny send', admin.from('channel_permission_overrides').insert({
    channel_id: quietId, target_type: 'role', role_id: everyone.data!.id, allow_permissions: 0, deny_permissions: 4096,
  }))

  const a = await open(browser, alice)
  const b = await open(browser, bob)

  await test.step('read-only in the channel: no Join, and the reason, on the banner and the card', async () => {
    await openChannel(a.page, server.id, quietId)
    await a.page.getByTestId('activities-button').click()
    await a.page.getByTestId('play-together-app-drawinphone').click()
    await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
    await openChannel(b.page, server.id, quietId)
    await expect(b.page.getByTestId('play-together-refusal')).toHaveText('You can’t send messages in this channel.', { timeout: 30_000 })
    await expect(b.page.getByTestId('play-together-join')).toHaveCount(0)
    await expect(b.page.getByTestId('activity-system-refusal')).toHaveText('You can’t send messages in this channel.')
    await expect(b.page.getByTestId('activity-system-join')).toHaveCount(0)
    await expect(game(a.page).getByTestId('dp-player')).toHaveCount(1)
    await a.page.getByTestId('play-together-end').click()
  })

  await test.step('timed out in the server: no Join in a channel he could send in, and the reason', async () => {
    await must('timeout', admin.from('server_member_timeouts').insert({
      server_id: server.id, user_id: bob.id, until: new Date(Date.now() + 3_600_000).toISOString(), reason: 'journey',
    }))
    await openChannel(a.page, server.id, server.generalChannelId)
    await a.page.getByTestId('activities-button').click()
    await a.page.getByTestId('play-together-app-drawinphone').click()
    await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })
    await openChannel(b.page, server.id, server.generalChannelId)
    await expect(b.page.getByTestId('play-together-refusal')).toHaveText('You are timed out in this server.', { timeout: 30_000 })
    await expect(b.page.getByTestId('play-together-join')).toHaveCount(0)
    await expect(game(a.page).getByTestId('dp-player')).toHaveCount(1)
    await a.page.getByTestId('play-together-end').click()
  })

  await admin.from('server_member_timeouts').delete().eq('server_id', server.id).eq('user_id', bob.id)
  await a.context.close()
  await b.context.close()
})

test('a game its last player leaves ends at once, and the banner goes with it', async ({ browser }) => {
  test.setTimeout(90_000)
  const a = await open(browser, alice)
  await a.page.goto(`/dm/${dm}`)
  await openDmActivities(a.page)
  await a.page.getByTestId('play-together-app-drawinphone').click()
  await expect(game(a.page).getByTestId('dp-lobby')).toBeVisible({ timeout: 30_000 })

  await a.page.getByTestId('play-together-leave').click()
  await expect(a.page.getByTestId('play-together-panel')).toHaveCount(0)
  // No reload: the leaving client reads the ended session again; the relay ends it without the
  // 60 s grace a dropped connection keeps.
  await expect(a.page.getByTestId('play-together-banner')).toHaveCount(0, { timeout: 10_000 })
  const row = await must('session', admin.from('activity_sessions').select('status, end_reason')
    .eq('conversation_id', dm).order('started_at', { ascending: false }).limit(1).single())
  expect(row.data).toMatchObject({ status: 'ended', end_reason: 'empty' })
  await a.context.close()
})
