// Journey: watching a screen share in the call view, the dock and the pop-out.
//
// A popped-out stream plays in the call window only: the main window's dock shows no video of
// it, minimized or not, and the in-app picture-in-picture frame waits for the window to close;
// in the call window the stream offers neither that frame nor full screen. Full screen keeps its
// floating chrome readable and clear of the side chat, the filmstrip and the stream's own
// controls. At phone width the call view's header keeps its title and count clear of its
// buttons, and an unwatched stream in the filmstrip keeps its Watch button inside its tile and
// clear of the name. The minimized dock's preview is a labelled button with legible text.
//
// The stack has no LiveKit: the voice store is set as a joined call leaves it, and the member's
// stream is a canvas played into the tile's video where a frame matters.

import { test, expect, type Page, type Locator } from '@playwright/test'
import {
  addMember,
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let owner: SpecUser
let streamer: SpecUser
let other: SpecUser
let server: SeededServer
let loungeId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'svo')
  streamer = await createUser(admin, 'svs')
  other = await createUser(admin, 'svt')
  server = await seedServer(admin, owner, `Stream view ${owner.username}`)
  await addMember(admin, streamer, server.id)
  await addMember(admin, other, server.id)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  loungeId = data.id
})

test.afterAll(async () => {
  if (server) await admin.from('servers').delete().eq('id', server.id)
  for (const user of [owner, streamer, other]) await deleteUser(admin, user)
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

interface VoiceOptions {
  /** Users sharing their screen. */
  streaming: string[]
  /** 'p2p' receives every stream; 'livekit' only those in watched. */
  mode: 'p2p' | 'livekit'
  watched?: string[]
}

async function enterVoice(page: Page, opts: VoiceOptions) {
  await page.evaluate((o) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    const state = (userId: string) => ({
      userId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: o.streaming.includes(userId),
      isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
    })
    voice.$patch((s) => {
      s.isConnected = true
      s.connectionMode = o.mode
      s.currentServerId = o.serverId
      s.currentChannelId = o.channelId
      s.currentChannelName = 'lounge'
      s.localState = state(o.selfId)
      s.allUsers = o.others.map(state)
      s.watchedStreamUserIds = o.watched
    })
  }, { serverId: server.id, channelId: loungeId, selfId: owner.id, others: [streamer.id, other.id], watched: [], ...opts })
}

/** A canvas stream in every stream tile's video, so the tiles show a frame. */
async function playCanvasInStreamTiles(page: Page) {
  await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 1280
    canvas.height = 720
    const ctx = canvas.getContext('2d')!
    let frame = 0
    setInterval(() => {
      ctx.fillStyle = `hsl(${(frame++ * 5) % 360} 60% 40%)`
      ctx.fillRect(0, 0, 1280, 720)
    }, 33)
    const stream = canvas.captureStream(30)
    for (const video of document.querySelectorAll<HTMLVideoElement>('.voice-tile.is-screen video')) {
      video.srcObject = stream
      void video.play()
    }
  })
}

const dock = (page: Page) => page.getByTestId('voice-dock')
const box = async (locator: Locator) => (await locator.boundingBox())!

async function openCallView(page: Page) {
  await page.getByRole('button', { name: 'Open call view' }).click()
  const view = page.getByRole('dialog', { name: 'lounge' })
  await expect(view).toBeVisible({ timeout: 15000 })
  return view
}

test('a popped-out stream plays in the call window only, and comes back when it closes', async ({ page }) => {
  test.setTimeout(180_000)
  await page.addInitScript(() => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
  })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { streaming: [streamer.id], mode: 'p2p' })

  await test.step('in the app, the dock previews the stream', async () => {
    await expect(dock(page).locator('video').first()).toBeAttached({ timeout: 15000 })
  })

  const view = await openCallView(page)
  const streamTile = (root: Page) => root.locator(`.voice-tile.is-screen[data-user-id="${streamer.id}"]`)
  await expect(streamTile(page)).toBeVisible()

  await test.step('the in-app frame shows the stream before the pop-out', async () => {
    await streamTile(page).hover()
    await streamTile(page).getByRole('button', { name: 'Pop out', exact: true }).click()
    await expect(page.locator('section.pip')).toBeVisible()
  })

  const opened = page.waitForEvent('popup')
  await view.getByRole('button', { name: 'Pop out call' }).click()
  const popup = await opened
  await expect(popup.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })

  await test.step('popped out: no video of the call in the main window, the frame waits', async () => {
    await expect(streamTile(popup).locator('video')).toBeAttached()
    await expect(page.locator('.minimized-container')).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)
    await expect(page.locator('section.pip')).toHaveCount(0)
    // Expanded to the full dock while popped out: still no strip, no thumbnail.
    await page.locator('.minimized-info').click()
    await expect(page.locator('.dock-container')).toBeVisible()
    await expect(page.locator('video')).toHaveCount(0)
  })

  await test.step('in the call window the stream offers neither the in-app frame nor full screen', async () => {
    await streamTile(popup).hover()
    await expect(streamTile(popup).getByRole('button', { name: 'Exit focus' })).toBeVisible()
    await expect(streamTile(popup).getByRole('button', { name: 'Close pop-out' })).toHaveCount(0)
    await expect(streamTile(popup).getByRole('button', { name: 'Pop out', exact: true })).toHaveCount(0)
    await expect(streamTile(popup).getByRole('button', { name: 'Full screen' })).toHaveCount(0)
    await streamTile(popup).getByRole('button', { name: 'More options' }).click()
    const menu = popup.getByRole('menu')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: /Pop out|Close pop-out|Full screen/ })).toHaveCount(0)
    await popup.keyboard.press('Escape')
  })

  await test.step('closed, the call view and the frame come back to the main window', async () => {
    await popup.close()
    await expect(page.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
    await expect(streamTile(page).locator('video')).toBeAttached()
    await expect(page.locator('section.pip')).toBeVisible()
  })
})

test('full screen keeps its chrome readable and clear of the chat, the filmstrip and the stream controls', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 1440, height: 900 })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { streaming: [streamer.id], mode: 'p2p' })
  const view = await openCallView(page)
  const focusTile = page.locator('.voice-tile.focus-tile')
  await expect(focusTile).toHaveAttribute('data-user-id', streamer.id, { timeout: 15000 })
  await playCanvasInStreamTiles(page)
  await view.getByTestId('call-chat-toggle').click()
  await expect(view.getByTestId('call-side-chat')).toBeVisible()

  await view.locator('.voice-header').getByRole('button', { name: 'Full screen' }).click()
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(true)
  // The chrome hides 2.5 s after the pointer last moved; each step moves it first.
  let jiggle = 0
  const showChrome = async () => {
    await page.mouse.move(300 + (jiggle++ % 2) * 10, 400)
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
  }
  await showChrome()

  const header = view.locator('.voice-header')
  const controls = view.locator('.voice-controls')
  const filmstrip = view.locator('.filmstrip-container')
  const chat = view.getByTestId('call-side-chat')

  await test.step('the header ends where the chat begins', async () => {
    await showChrome()
    expect((await box(header)).x + (await box(header)).width).toBeLessThanOrEqual((await box(chat)).x + 1)
    await expect(chat.getByRole('button', { name: 'Close chat' })).toBeVisible()
    const close = await box(chat.getByRole('button', { name: 'Close chat' }))
    const hit = await page.evaluate(({ x, y }) => document.elementFromPoint(x, y)?.closest('[data-testid="call-chat-close"]') !== null, { x: close.x + close.width / 2, y: close.y + close.height / 2 })
    expect(hit).toBe(true)
  })

  await test.step('the filmstrip sits above the controls', async () => {
    await showChrome()
    const strip = await box(filmstrip)
    const bar = await box(controls)
    expect(strip.y + strip.height).toBeLessThanOrEqual(bar.y + 1)
    const covered = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLElement>('.voice-controls button'))
      .filter((b) => b.getBoundingClientRect().width > 0)
      .filter((b) => {
        const r = b.getBoundingClientRect()
        return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('.voice-controls') === null
      })
      .map((b) => b.getAttribute('aria-label')))
    expect(covered).toEqual([])
  })

  await test.step("the stream's own controls clear the header and the filmstrip", async () => {
    await showChrome()
    await focusTile.hover({ position: { x: 400, y: 300 } })
    const actions = await box(focusTile.locator('.tile-actions'))
    const head = await box(header)
    expect(actions.y).toBeGreaterThanOrEqual(head.y + head.height)
    const pill = await box(focusTile.locator('.tile-pill'))
    expect(pill.y + pill.height).toBeLessThanOrEqual((await box(filmstrip)).y + 1)
  })

  await test.step('the chrome text reads against its background', async () => {
    await showChrome()
    const contrast = await page.evaluate(() => {
      // rgb()/rgba() in 0-255; color-mix() computes to color(srgb r g b / a) in 0-1.
      const parse = (c: string) => {
        const n = (c.match(/[\d.]+/g) ?? []).map(Number)
        return c.startsWith('color(srgb') ? [n[0] * 255, n[1] * 255, n[2] * 255, n[3] ?? 1] : n
      }
      const luminance = ([r, g, b]: number[]) => {
        const f = (v: number) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const header = document.querySelector('.voice-container .voice-header') as HTMLElement
      const [r, g, b, a = 1] = parse(getComputedStyle(header).backgroundColor)
      // Composited over the black stage.
      const bg = [r * a, g * a, b * a]
      const fg = parse(getComputedStyle(header.querySelector('.channel-name')!).color)
      const [hi, lo] = [luminance(fg), luminance(bg)].sort((x, y) => y - x)
      return (hi + 0.05) / (lo + 0.05)
    })
    expect(contrast).toBeGreaterThanOrEqual(4.5)
  })

  await page.keyboard.press('Escape')
  await expect.poll(() => page.evaluate(() => !!document.fullscreenElement)).toBe(false)
})

test('at phone width the header and the filmstrip keep their parts apart', async ({ page }) => {
  test.setTimeout(180_000)
  await page.setViewportSize({ width: 375, height: 812 })
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  // The owner watches one stream; the other is unwatched in the filmstrip.
  await enterVoice(page, { streaming: [streamer.id, other.id], mode: 'livekit', watched: [streamer.id] })
  const view = await openCallView(page)
  // A remote stream already running takes the focus when the view opens.
  await expect(view.locator('.voice-tile.focus-tile')).toHaveAttribute('data-user-id', streamer.id)

  await test.step('title and count clear of the header buttons', async () => {
    const controls = await box(view.locator('.header-controls'))
    for (const sel of ['.channel-name', '.participant-count']) {
      const part = await box(view.locator('.voice-header').locator(sel))
      expect(part.x + part.width, sel).toBeLessThanOrEqual(controls.x + 1)
    }
    await expect(view.locator('.channel-name')).toHaveText('lounge')
  })

  await test.step('the unwatched stream keeps Watch inside its tile and clear of the name', async () => {
    const tile = view.locator(`.filmstrip .voice-tile.is-screen[data-user-id="${other.id}"]`)
    await expect(tile).toBeVisible()
    const watch = tile.getByRole('button', { name: 'Watch stream' })
    const t = await box(tile)
    const w = await box(watch)
    const p = await box(tile.locator('.tile-pill'))
    expect(w.x).toBeGreaterThanOrEqual(t.x)
    expect(w.x + w.width).toBeLessThanOrEqual(t.x + t.width + 0.5)
    expect(w.y).toBeGreaterThanOrEqual(t.y)
    expect(w.y + w.height).toBeLessThanOrEqual(p.y + 0.5)
  })
})

test("the minimized dock's preview is a labelled button with legible text", async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { streaming: [streamer.id], mode: 'p2p' })
  await page.getByTestId('dock-minimize').click()
  const preview = page.getByTestId('mini-video-open')
  await expect(preview).toBeVisible({ timeout: 15000 })
  await expect(preview).toHaveAccessibleName(/is sharing their screen\. Open call view$/)
  const label = page.locator('.mini-video-label')
  await expect(label).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(page.locator('.mini-pip-btn')).toHaveCSS('color', 'rgb(255, 255, 255)')
  await expect(page.locator('.mini-pip-btn')).toHaveAccessibleName('Pop out')
  await preview.focus()
  await page.keyboard.press('Enter')
  await expect(page.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
})
