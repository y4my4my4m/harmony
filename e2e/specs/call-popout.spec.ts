// Journey: the call's side chat and the call pop-out.
//
// In a server call the call view's Chat button opens the voice channel's text chat beside the
// call, as Discord shows it: the channel's messages and a working composer, the routed view
// yielding its list meanwhile. A message from someone else while the chat is closed puts a dot
// on the button; the open state survives a reload.
//
// Pop out moves the call view, its side chat included, into a second window of the same page
// without rejoining: the same <video> element keeps playing there, the stylesheets and <html>
// attributes are mirrored, the mute shortcut works with the pop-out focused, and the main window
// keeps a minimized dock. Closing the window, or Return, brings the view back; leaving the call
// closes the window. A watch-together player follows the stage into the pop-out and back.
// Document Picture-in-Picture is removed from the page so the pop-out takes the window.open
// path Playwright can follow; components/voice/__tests__/callPopout.test.ts covers the PiP path.
//
// The stack has no LiveKit and no realtime: the voice store is set as a joined call leaves it,
// and the chat store is handed the realtime insert a member's message would deliver.

import fs from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
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
import { expectNoAxeViolations } from './a11y'

test.use({ serviceWorkers: 'block' })

const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))

const admin = adminClient()
let owner: SpecUser
let member: SpecUser
let server: SeededServer
let loungeId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'cpo')
  member = await createUser(admin, 'cpm')
  server = await seedServer(admin, owner, `Call popout ${owner.username}`)
  await addMember(admin, member, server.id)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  loungeId = data.id
  const { error: seedError } = await admin.from('messages').insert({
    channel_id: loungeId,
    user_id: owner.id,
    content: [{ type: 'text', text: 'Lounge hello' }],
    created_at: new Date(Date.now() - 60_000).toISOString(),
  })
  if (seedError) throw new Error(`seed message: ${seedError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

/** The voice store as a joined call leaves it; `camera` users have their camera on. */
async function enterVoice(page: Page, opts: { selfId: string; others: string[]; camera?: string[] }) {
  await page.evaluate((o) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    const state = (userId: string) => ({
      userId, isAudioEnabled: true, isVideoEnabled: o.camera.includes(userId), isScreenSharing: false,
      isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
    })
    voice.$patch((s) => {
      s.isConnected = true
      s.currentServerId = o.serverId
      s.currentChannelId = o.channelId
      s.currentChannelName = 'lounge'
      s.localState = state(o.selfId)
      s.allUsers = o.others.map(state)
    })
    // Registers the voice shortcuts as a join does.
    voice.setupPushToTalk()
  }, { serverId: server.id, channelId: loungeId, camera: [], ...opts })
}

/** The realtime insert of a message by `userId` in the lounge, handed to the chat store. */
async function receiveMessage(page: Page, userId: string, text: string) {
  await page.evaluate(({ channelId, userId, text }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const chat = root.__vue_app__.config.globalProperties.$pinia._s.get('chat')
    if (!chat) throw new Error('chat store not created')
    chat.addMessageToCache({
      id: crypto.randomUUID(),
      channel_id: channelId,
      user_id: userId,
      content: [{ type: 'text', text }],
      created_at: new Date(),
    })
  }, { channelId: loungeId, userId, text })
}

const dock = (page: Page) => page.getByRole('region', { name: 'Voice connection' })

/** Document PiP removed: the pop-out opens with window.open, which Playwright reports as a popup. */
async function withoutDocumentPip(page: Page) {
  await page.addInitScript(() => {
    delete (window as unknown as { documentPictureInPicture?: unknown }).documentPictureInPicture
  })
}

async function popOut(page: Page) {
  const opened = page.waitForEvent('popup')
  await page.getByTestId('voice-overlay').getByRole('button', { name: 'Pop out call' }).click()
  const popup = await opened
  await expect(popup.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
  return popup
}

async function openCallView(page: Page) {
  await dock(page).getByRole('button', { name: 'Open call view' }).click()
  const view = page.getByRole('dialog', { name: 'lounge' })
  await expect(view).toBeVisible({ timeout: 15000 })
  return view
}

test('side chat: the voice channel chat beside the call, unread dot, remembered, axe', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { selfId: owner.id, others: [member.id] })

  let view = await openCallView(page)
  const toggle = view.getByTestId('call-chat-toggle')
  const panel = view.getByTestId('call-side-chat')

  await test.step('Chat opens the voice channel chat beside the call', async () => {
    await expect(toggle).toHaveAccessibleName('Chat')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await toggle.click()
    await expect(panel).toBeVisible()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(toggle).toHaveAttribute('aria-controls', (await panel.getAttribute('id'))!)
    await expect(page).toHaveURL(new RegExp(`/chat/${server.id}/${loungeId}$`))
    await expect(panel.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'Lounge hello' })).toBeVisible({ timeout: 30000 })
    // The routed view yields its list while the side chat shows it.
    await expect(page.getByTestId('call-chat-elsewhere')).toHaveCount(1)
  })

  await test.step('a message sent from the side chat lands in the channel', async () => {
    const editor = panel.locator('[data-testid="message-input"] .rich-text-editor')
    await editor.click()
    await editor.pressSequentially('Hello from the call', { delay: 10 })
    await page.keyboard.press('Enter')
    const posted = panel.locator('[data-testid="message-list"] .message-item').filter({ hasText: 'Hello from the call' }).last()
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    const { data } = await admin.from('messages').select('id').eq('channel_id', loungeId).eq('user_id', owner.id)
    expect(data).toHaveLength(2)
  })

  await test.step('axe on the call view with the chat open', async () => {
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'))
    await expectNoAxeViolations(page, { include: '[data-testid="voice-overlay"]', label: 'call view with chat' })
  })

  await test.step('closing the chat returns focus to its button and the list to the routed view', async () => {
    await panel.getByRole('button', { name: 'Close chat' }).click()
    await expect(panel).toHaveCount(0)
    await expect(toggle).toBeFocused()
    await expect(page.getByTestId('call-chat-elsewhere')).toHaveCount(0)
  })

  await test.step('a message from someone else while closed puts a dot on Chat', async () => {
    await expect(view.getByTestId('call-chat-unread')).toHaveCount(0)
    await receiveMessage(page, member.id, 'Are you watching?')
    await expect(view.getByTestId('call-chat-unread')).toBeVisible()
    await expect(toggle).toHaveAccessibleName('Chat, new messages')
    await toggle.click()
    await expect(panel.locator('.message-item').filter({ hasText: 'Are you watching?' })).toBeVisible({ timeout: 15000 })
    await expect(view.getByTestId('call-chat-unread')).toHaveCount(0)
    await expect(toggle).toHaveAccessibleName('Chat')
  })

  await test.step('the open chat is remembered', async () => {
    await page.reload()
    await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
    await enterVoice(page, { selfId: owner.id, others: [member.id] })
    view = await openCallView(page)
    await expect(view.getByTestId('call-side-chat')).toBeVisible()
    await expect(view.getByTestId('call-chat-toggle')).toHaveAttribute('aria-expanded', 'true')
    await view.getByTestId('call-chat-toggle').click()
    await expect(view.getByTestId('call-side-chat')).toHaveCount(0)
  })
})

test('pop-out: the call view moves to its own window and back without rejoining', async ({ page }) => {
  test.setTimeout(180_000)
  await withoutDocumentPip(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { selfId: owner.id, others: [member.id], camera: [member.id] })
  await openCallView(page)

  // The member's camera tile plays a canvas stream in place of the LiveKit track.
  await page.evaluate(() => {
    const video = document.querySelector<HTMLVideoElement>('[data-testid="voice-overlay"] video.tile-video')
    if (!video) throw new Error('no camera tile')
    const canvas = document.createElement('canvas')
    canvas.width = 160
    canvas.height = 90
    const ctx = canvas.getContext('2d')!
    let frame = 0
    setInterval(() => {
      ctx.fillStyle = `hsl(${(frame++ * 7) % 360} 70% 50%)`
      ctx.fillRect(0, 0, 160, 90)
    }, 30)
    video.srcObject = canvas.captureStream(30)
    void video.play()
    ;(window as unknown as { __tileVideo: HTMLVideoElement }).__tileVideo = video
  })

  const videoState = () => page.evaluate(async () => {
    const video = (window as unknown as { __tileVideo: HTMLVideoElement }).__tileVideo
    const before = video.currentTime
    await new Promise((r) => setTimeout(r, 400))
    return {
      inMain: video.ownerDocument === document,
      connected: video.isConnected,
      paused: video.paused,
      advancing: video.currentTime > before,
    }
  })

  let popup = await popOut(page)

  await test.step('the call view is in the pop-out, styled as in the app; the main window has the dock', async () => {
    await expect(popup).toHaveTitle('Harmony — lounge')
    await expect(page.getByTestId('voice-overlay')).toHaveCount(0)
    await expect(dock(page).getByRole('button', { name: 'Return call to the app' })).toBeVisible()
    await expect(dock(page).getByRole('button', { name: 'Show call window' })).toBeVisible()
    const mainTheme = await page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    expect(await popup.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(mainTheme)
    const grid = await popup.evaluate(() => getComputedStyle(document.querySelector('[data-testid="voice-overlay"]')!).display)
    expect(grid).toBe('grid')
    // Not modal in its own window.
    await expect(popup.getByTestId('voice-overlay')).not.toHaveAttribute('aria-modal', 'true')
  })

  await test.step('the same video element keeps playing in the pop-out', async () => {
    const state = await videoState()
    expect(state).toEqual({ inMain: false, connected: true, paused: false, advancing: true })
  })

  await test.step('the mute shortcut works with the pop-out focused', async () => {
    const mute = popup.getByTestId('voice-mute')
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await popup.getByTestId('voice-overlay').focus()
    await popup.keyboard.press('Control+Shift+KeyM')
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await popup.keyboard.press('Control+Shift+KeyM')
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('the side chat works in the pop-out', async () => {
    await popup.getByTestId('call-chat-toggle').click()
    const panel = popup.getByTestId('call-side-chat')
    await expect(panel.locator('.message-item').filter({ hasText: 'Lounge hello' })).toBeVisible({ timeout: 30000 })
    const editor = panel.locator('[data-testid="message-input"] .rich-text-editor')
    await editor.click()
    await editor.pressSequentially('Typed in the pop-out', { delay: 10 })
    await popup.keyboard.press('Enter')
    const posted = panel.locator('.message-item').filter({ hasText: 'Typed in the pop-out' }).last()
    await expect(posted).toBeVisible({ timeout: 30000 })
    await expect(posted).not.toHaveAttribute('data-message-id', /^temp-/, { timeout: 30000 })
    // The main window, routed to the lounge, points at the chat beside the call.
    await expect(page.getByTestId('call-chat-elsewhere')).toBeVisible()
    await expectNoAxeViolations(popup, { include: '[data-testid="voice-overlay"]', label: 'popped-out call view' })
  })

  await test.step('closing the window brings the view back, video still playing', async () => {
    await popup.close()
    await expect(page.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
    await expect(page.getByTestId('call-side-chat')).toBeVisible()
    const state = await videoState()
    expect(state).toEqual({ inMain: true, connected: true, paused: false, advancing: true })
  })

  await test.step('Return in the pop-out closes it and brings the view back', async () => {
    popup = await popOut(page)
    const closed = popup.waitForEvent('close')
    await popup.getByRole('button', { name: 'Return call to the app' }).click()
    await closed
    await expect(page.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
  })

  await test.step('leaving the call closes the pop-out', async () => {
    popup = await popOut(page)
    const closed = popup.waitForEvent('close')
    await popup.getByTestId('voice-leave').click()
    await closed
    await expect(page.getByTestId('voice-dock')).toHaveCount(0)
  })
})

interface Box { name: string; x: number; y: number; width: number; height: number }

/** The minimized dock's container, the parts of its label and its visible controls. */
async function miniDockLayout(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('.minimized-container')
    if (!root) throw new Error('no minimized dock')
    const box = (name: string, el: Element): Box => {
      const r = el.getBoundingClientRect()
      return { name, x: r.x, y: r.y, width: r.width, height: r.height }
    }
    const parts: Box[] = []
    const info = root.querySelector('.minimized-info')!
    for (const [name, sel] of [
      ['icon', '.channel-icon'],
      ['name', '.dock-channel-text'],
      ['count', '.participant-count'],
      ['shield', '.voice-encryption-badge'],
      ['speakers', '.recent-speakers'],
    ] as const) {
      const el = info.querySelector(sel)
      if (el && el.getBoundingClientRect().width > 0) parts.push(box(name, el))
    }
    for (const button of root.querySelectorAll<HTMLElement>('.minimized-controls button')) {
      if (button.getBoundingClientRect().width > 1) parts.push(box(button.getAttribute('aria-label') ?? '?', button))
    }
    const text = (sel: string) => {
      const el = info.querySelector<HTMLElement>(sel)!
      return { clipped: el.scrollWidth > el.clientWidth + 1, width: el.clientWidth }
    }
    return { container: box('container', root), parts, name: text('.dock-channel-text'), count: text('.participant-count') }
  })
}

function expectTidy(layout: Awaited<ReturnType<typeof miniDockLayout>>, label: string) {
  const { container, parts } = layout
  for (const p of parts) {
    expect(p.x, `${label}: ${p.name} starts inside the dock`).toBeGreaterThanOrEqual(container.x)
    expect(p.x + p.width, `${label}: ${p.name} ends inside the dock`).toBeLessThanOrEqual(container.x + container.width + 0.5)
  }
  for (let i = 0; i < parts.length; i++) {
    for (let j = i + 1; j < parts.length; j++) {
      const a = parts[i]
      const b = parts[j]
      const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
      const vertical = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
      expect(overlap > 0.5 && vertical > 0.5, `${label}: ${a.name} overlaps ${b.name}`).toBe(false)
    }
  }
  expect(layout.count.clipped, `${label}: participant count clipped`).toBe(false)
}

test('the minimized dock keeps its label and its controls apart, popped out or not', async ({ page }) => {
  test.setTimeout(180_000)
  await withoutDocumentPip(page)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page, { selfId: owner.id, others: [member.id] })
  await page.evaluate(({ ids }) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!
    voice.$patch((s) => {
      s.connectionMode = 'livekit'
      s.isEncrypted = true
      s.recentSpeakers = ids.map((userId: string, i: number) => ({ userId, lastSpokeAt: Date.now() - i }))
    })
  }, { ids: [member.id, owner.id] })

  await dock(page).getByTestId('dock-minimize').click()
  const info = page.locator('.minimized-info')
  await expect(info).toBeVisible()
  // Away from the default corner the dock carries mute and deafen.
  const start = (await info.boundingBox())!
  await page.mouse.move(start.x + 20, start.y + start.height / 2)
  await page.mouse.down()
  await page.mouse.move(start.x + 320, start.y - 260, { steps: 12 })
  await page.mouse.up()
  await expect(page.getByTestId('mini-mute')).toBeVisible()

  await test.step('in the app', async () => {
    const layout = await miniDockLayout(page)
    expectTidy(layout, 'in the app')
    expect(layout.name.clipped).toBe(false)
  })

  const setChannelName = (name: string) => page.evaluate((name) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')!.$patch((s) => {
      s.currentChannelName = name
    })
  }, name)

  await test.step('a long channel name gives way to the count and the controls', async () => {
    await setChannelName('the very long name of a voice channel that never fits')
    await expect(page.locator('.dock-channel-text')).toHaveText(/very long/)
    const layout = await miniDockLayout(page)
    expectTidy(layout, 'long name')
    expect(layout.name.clipped).toBe(true)
    expect(layout.name.width).toBeGreaterThan(40)
    await setChannelName('lounge')
  })

  await test.step('popped out: Show and Return replace Open, nothing overlaps', async () => {
    await page.getByTestId('mini-expand').click()
    await openCallView(page)
    const popup = await popOut(page)
    await expect(dock(page).getByRole('button', { name: 'Return call to the app' })).toBeVisible()
    await expect(dock(page).getByRole('button', { name: 'Show call window' })).toBeVisible()
    await expect(page.getByTestId('mini-mute')).toBeVisible()
    const layout = await miniDockLayout(page)
    expectTidy(layout, 'popped out')
    expect(layout.name.clipped).toBe(false)
    await expect(page.locator('.minimized-controls button:visible')).toHaveCount(5)

    await dock(page).getByRole('button', { name: 'Show call window' }).click()
    const closed = popup.waitForEvent('close')
    await dock(page).getByRole('button', { name: 'Return call to the app' }).click()
    await closed
  })
})

test('pop-out: the watch-together player follows the stage into the pop-out and back', async ({ page }) => {
  test.setTimeout(180_000)
  // A plain media server: Playwright's request routing does not serve media requests made from
  // a popup's about:blank document.
  const media = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'video/webm', 'content-length': CLIP.length })
    res.end(CLIP)
  })
  await new Promise<void>((resolve) => media.listen(0, '127.0.0.1', resolve))
  const clipUrl = `http://127.0.0.1:${(media.address() as AddressInfo).port}/clip.webm`
  try {
    await withoutDocumentPip(page)
    await signIn(page, owner)
    await openChannel(page, server.id, server.generalChannelId)
    await enterVoice(page, { selfId: owner.id, others: [member.id] })

    // Started once the page is in the call, at the slowest rate voice_activities allows (0.25):
    // the 6 s clip lasts 24 s, the whole test under a loaded runner.
    const { error } = await admin.from('voice_activities').upsert({
      channel_id: loungeId,
      server_id: server.id,
      source: 'url',
      item: { url: clipUrl, title: 'Clip' },
      host_id: owner.id,
      playing: true,
      rate: 0.25,
      position_ms: 0,
      position_at: new Date().toISOString(),
    })
    if (error) throw new Error(`activity: ${error.message}`)
    try {
      await openCallView(page)
      await expect(page.getByTestId('activity-stage')).toBeVisible({ timeout: 15000 })
      await expect(page.getByTestId('activity-host')).toBeVisible()

      const playing = (p: Page) => p.evaluate(() => {
        const media = document.querySelector<HTMLVideoElement>('[data-testid="activity-media"]')
        return !!media && !media.paused && media.readyState >= 2
      })
      const covers = async (p: Page) => {
        const slot = await p.getByTestId('activity-slot').boundingBox()
        const box = await p.getByTestId('activity-host').boundingBox()
        return !!slot && !!box && Math.abs(slot.x - box.x) < 2 && Math.abs(slot.y - box.y) < 2 && Math.abs(slot.width - box.width) < 2
      }
      await expect.poll(() => playing(page), { timeout: 15000 }).toBe(true)

      const popup = await popOut(page)

      await test.step('the player sits over the stage in the pop-out and plays', async () => {
        await expect(popup.getByTestId('activity-host')).toBeVisible({ timeout: 15000 })
        await expect(page.getByTestId('activity-host')).toHaveCount(0)
        await expect.poll(() => covers(popup), { timeout: 10000 }).toBe(true)
        await expect.poll(() => playing(popup), { timeout: 15000 }).toBe(true)
      })

      await test.step('closing the pop-out brings the player back over the stage', async () => {
        await popup.close()
        await expect(page.getByRole('dialog', { name: 'lounge' })).toBeVisible({ timeout: 15000 })
        await expect(page.getByTestId('activity-host')).toBeVisible()
        await expect.poll(() => covers(page), { timeout: 10000 }).toBe(true)
        await expect.poll(() => playing(page), { timeout: 15000 }).toBe(true)
      })
    } finally {
      await admin.from('voice_activities').delete().eq('channel_id', loungeId)
    }
  } finally {
    media.close()
  }
})
