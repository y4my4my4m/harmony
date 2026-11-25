// Journey: dragging the voice dock.
//
// The dock paints over the media viewer and takes the pointer there as it paints: a drag that
// starts on the dock moves the dock, a drag that starts on the image moves the image, the dock's
// buttons work while the viewer is open, and Escape from a dock button still closes the viewer.
// The minimized dock drags the same way. A dialog covers the dock and takes the press where they
// overlap.
//
// The docked bar stays where it is dropped, the left edge included, across a reload; dropped
// within the snap radius of its home (bottom centre) it returns there.
//
// The stack has no LiveKit: the voice store is set as a joined call leaves it.

import zlib from 'node:zlib'
import { test, expect, type Locator, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  userClient,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let owner: SpecUser
let server: SeededServer
let loungeId: string

const MEDIA_ORIGIN = 'http://localhost:5192'

/** Solid RGB PNG, `width` x `height`. */
function png(width: number, height: number, rgb: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
    const crc = Buffer.alloc(4)
    crc.writeUInt32BE(zlib.crc32(body))
    return Buffer.concat([length, body, crc])
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8 // bit depth
  header[9] = 2 // colour type: RGB
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(rgb, 1 + x * 3)
  const pixels = Buffer.concat(Array.from({ length: height }, () => row))
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', zlib.deflateSync(pixels)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

const PHOTO = png(960, 640, [40, 120, 200])

test.beforeAll(async () => {
  owner = await createUser(admin, 'dkvo')
  server = await seedServer(admin, owner, `Dock viewer ${owner.username}`)
  const { data: general } = await admin.from('channels').select('category').eq('id', server.generalChannelId).single()
  const { data, error } = await admin
    .from('channels')
    .insert({ server_id: server.id, name: 'lounge', type: 1, category: general?.category ?? null })
    .select('id')
    .single()
  if (error || !data) throw new Error(`lounge: ${error?.message}`)
  loungeId = data.id
  const client = await userClient(owner)
  const { error: postError } = await client.from('messages').insert({
    channel_id: server.generalChannelId,
    user_id: owner.id,
    content: [
      { type: 'text', text: 'Bay photo' },
      { type: 'file', fileType: 'image', url: `${MEDIA_ORIGIN}/e2e-media/bay.png`, fileName: 'bay.png', altText: 'A blue bay' },
    ],
  })
  if (postError) throw new Error(`post: ${postError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, owner)
})

type StoreHandle = { $patch: (fn: (state: Record<string, any>) => void) => void; [key: string]: any }

/** The voice store as a joined call leaves it. */
async function enterVoice(page: Page) {
  await page.evaluate((o) => {
    const root = document.querySelector('#app') as unknown as {
      __vue_app__: { config: { globalProperties: { $pinia: { _s: Map<string, StoreHandle> } } } }
    }
    const voice = root.__vue_app__.config.globalProperties.$pinia._s.get('unifiedVoiceChannel')
    if (!voice) throw new Error('voice store not created')
    voice.$patch((s) => {
      s.isConnected = true
      s.currentServerId = o.serverId
      s.currentChannelId = o.channelId
      s.currentChannelName = 'lounge'
      s.localState = {
        userId: o.selfId, isAudioEnabled: true, isVideoEnabled: false, isScreenSharing: false,
        isMuted: false, isDeafened: false, isSpeaking: false, audioLevel: 0,
      }
      s.allUsers = []
    })
  }, { serverId: server.id, channelId: loungeId, selfId: owner.id })
}

const dock = (page: Page) => page.getByRole('region', { name: 'Voice connection' })
const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const viewerImage = (page: Page) => viewer(page).getByRole('img', { name: 'A blue bay' })

/** By keyboard: the docked bar can sit over the message. */
async function openViewer(page: Page) {
  await messageList(page).getByRole('article').filter({ hasText: 'Bay photo' })
    .getByRole('button', { name: 'View image full size' }).focus()
  await page.keyboard.press('Enter')
  await expect(viewerImage(page)).toBeVisible()
}

async function box(locator: Locator) {
  const b = await locator.boundingBox()
  if (!b) throw new Error('no box')
  return b
}

/** Element under the pointer at the centre of `locator`, as hit testing finds it. */
async function hitInside(page: Page, locator: Locator, within: string): Promise<boolean> {
  const b = await box(locator)
  return page.evaluate(({ x, y, within }) => !!document.elementFromPoint(x, y)?.closest(within), {
    x: b.x + b.width / 2, y: b.y + b.height / 2, within,
  })
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number) {
  await page.mouse.move(from.x, from.y)
  await page.mouse.down()
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 12 })
  // The dock applies the pointer once per frame and drops a pending frame on release.
  await page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))))
  await page.mouse.up()
}

test('the dock takes the pointer over the media viewer, the image keeps its drag, a dialog covers the dock', async ({ page }) => {
  test.setTimeout(150_000)
  await page.route('**/e2e-media/**', (route) => route.fulfill({ status: 200, contentType: 'image/png', body: PHOTO }))
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page)
  const name = dock(page).locator('.user-details')
  await expect(name).toBeVisible({ timeout: 15000 })

  await openViewer(page)

  await test.step('a drag that starts on the dock moves the dock and leaves the image', async () => {
    expect(await hitInside(page, name, '[data-testid="voice-dock"]')).toBe(true)
    const image = await box(viewerImage(page))
    const before = await box(name)
    await drag(page, { x: before.x + 10, y: before.y + before.height / 2 }, -100, -140)
    const after = await box(name)
    expect(after.x - before.x).toBeCloseTo(-100, -1)
    expect(after.y - before.y).toBeCloseTo(-140, -1)
    await expect(viewer(page)).toBeVisible()
    expect(await box(viewerImage(page))).toEqual(image)
  })

  await test.step('the dock buttons work over the viewer; Escape from one closes the viewer', async () => {
    const mute = dock(page).getByTestId('dock-mute')
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'true')
    await expect(viewer(page)).toBeVisible()
    await expect(mute).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
    await mute.click()
    await expect(mute).toHaveAttribute('aria-pressed', 'false')
  })

  await test.step('a drag that starts on the image moves the image and leaves the dock', async () => {
    await openViewer(page)
    const dockBefore = await box(name)
    const image = await box(viewerImage(page))
    // Above the moved dock, which covers the image centre.
    await drag(page, { x: image.x + image.width / 2, y: image.y + 60 }, 120, 0)
    await expect.poll(async () => (await box(viewerImage(page))).x - image.x).toBeGreaterThan(60)
    expect(await box(name)).toEqual(dockBefore)
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
  })

  await test.step('the minimized dock drags over the viewer', async () => {
    await dock(page).getByTestId('dock-minimize').click()
    const info = page.locator('.minimized-info')
    await expect(info).toBeVisible()
    await openViewer(page)
    expect(await hitInside(page, info, '[data-testid="voice-dock"]')).toBe(true)
    const image = await box(viewerImage(page))
    const before = await box(info)
    await drag(page, { x: before.x + 20, y: before.y + before.height / 2 }, 260, -200)
    const after = await box(info)
    expect(after.x - before.x).toBeCloseTo(260, -1)
    expect(after.y - before.y).toBeCloseTo(-200, -1)
    await expect(viewer(page)).toBeVisible()
    expect(await box(viewerImage(page))).toEqual(image)
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
  })

  await test.step('a dialog covers the dock and takes the press where they overlap', async () => {
    const info = page.locator('.minimized-info')
    expect(await hitInside(page, info, '[data-testid="voice-dock"]')).toBe(true)
    await page.getByRole('button', { name: 'Add an attachment or poll' }).focus()
    await page.keyboard.press('Enter')
    await page.getByTestId('upload-menu-poll').focus()
    await page.keyboard.press('Enter')
    const form = page.getByTestId('poll-create-form')
    await expect(form).toBeVisible({ timeout: 15000 })
    expect(await hitInside(page, info, '[data-testid="voice-dock"]')).toBe(false)
    await page.keyboard.press('Escape')
    await expect(form).toBeHidden()
    expect(await hitInside(page, info, '[data-testid="voice-dock"]')).toBe(true)
  })
})

test('the docked bar stays at the window edge it is dropped on, and snaps home near it', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await enterVoice(page)
  const bar = page.locator('.dock-container')
  const name = dock(page).locator('.user-details')
  await expect(name).toBeVisible({ timeout: 15000 })
  const home = await box(bar)
  const centre = page.viewportSize()!.width / 2
  // Centre of the bar, and its top: the bar widens as its later buttons load.
  const place = async () => {
    const b = await box(bar)
    return { centre: Math.round(b.x + b.width / 2), top: b.y }
  }

  await test.step('dropped near home, the bar snaps back to bottom centre', async () => {
    const from = await box(name)
    await drag(page, { x: from.x + 10, y: from.y + from.height / 2 }, 30, -25)
    await expect.poll(place).toEqual({ centre: Math.round(centre), top: home.y })
  })

  await test.step('dragged past the left edge, the bar stays against it at the height it was dropped', async () => {
    const from = await box(name)
    await drag(page, { x: from.x + 10, y: from.y + from.height / 2 }, -home.x - 200, -160)
    const at = await box(bar)
    expect(at.x).toBeCloseTo(0, 0)
    expect(at.y - home.y).toBeCloseTo(-160, -1)
  })

  await test.step('the edge position survives a reload', async () => {
    const before = await box(bar)
    await page.reload()
    await openChannel(page, server.id, server.generalChannelId)
    await enterVoice(page)
    await expect(name).toBeVisible({ timeout: 15000 })
    // The bar animates in.
    await expect.poll(async () => {
      const b = await box(bar)
      return { x: b.x, y: b.y }
    }).toEqual({ x: before.x, y: before.y })
  })
})
