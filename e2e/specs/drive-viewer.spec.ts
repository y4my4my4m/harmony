// Journey: Drive opens files in the media viewer. The viewer names the file and its place
// among the files of the view; an image zooms from the toolbar, the wheel, a double click and
// the keys, pans by dragging within its edges, and rotates; the arrow keys and buttons step
// through the files and each step resets the image; Download saves the file under its name; a
// PDF shows in a frame and a text file shows a card with its own Download; Escape closes and
// focus returns to the file. The picture in Details opens the same viewer at its file. The
// scrim is the viewer's blurred dark one. On a phone, opened from Details, a swipe steps
// through the files, a pinch and a double tap zoom, one finger pans a zoomed image, a swipe
// down closes, and Back closes without leaving Drive.
//
// Drive files are uploaded through storage as their owner, which is what Drive's upload does;
// created_at orders them newest first.

import { randomUUID } from 'node:crypto'
import zlib from 'node:zlib'
import { test, expect, devices, type Download, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, userClient, type SpecUser } from './harness'

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.from(type, 'ascii')
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(zlib.crc32(Buffer.concat([head, data])))
  return Buffer.concat([len, head, data, crc])
}

/** 8-bit RGB PNG: the left half `left`, the right half `right`. */
function png(width: number, height: number, left: [number, number, number], right: [number, number, number]): Buffer {
  const row = Buffer.alloc(1 + width * 3)
  for (let x = 0; x < width; x++) row.set(x < width / 2 ? left : right, 1 + x * 3)
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr.set([8, 2, 0, 0, 0], 8)
  return Buffer.concat([
    Buffer.from('89504e470d0a1a0a', 'hex'),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(Buffer.concat(Array.from({ length: height }, () => row)))),
    pngChunk('IEND', Buffer.alloc(0)),
  ])
}

const FILES = [
  { name: 'harbour.png', mimeType: 'image/png', body: png(800, 600, [14, 165, 233], [249, 115, 22]) },
  { name: 'lighthouse.png', mimeType: 'image/png', body: png(600, 800, [34, 197, 94], [168, 85, 247]) },
  { name: 'notes.pdf', mimeType: 'application/pdf', body: Buffer.from('%PDF-1.4\n%%EOF\n') },
  { name: 'agenda.txt', mimeType: 'text/plain', body: Buffer.from('1. ferry\n2. lunch\n') },
]

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  test.setTimeout(120_000)
  user = await createUser(admin, 'dview')
  const client = await userClient(user)
  const now = Date.now()
  for (const [i, file] of FILES.entries()) {
    const path = `u/${user.id}/${randomUUID()}.${file.name.split('.').pop()}`
    const { error } = await client.storage.from('message_media').upload(path, file.body, { contentType: file.mimeType, metadata: { name: file.name } })
    if (error) throw new Error(`upload ${file.name}: ${error.message}`)
    const { error: dateError } = await admin.from('drive_files')
      .update({ created_at: new Date(now - (i + 1) * 60_000).toISOString() }).eq('path', path)
    if (dateError) throw new Error(`created_at of ${file.name}: ${dateError.message}`)
  }
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const position = (page: Page) => viewer(page).locator('.lightbox-position')
const fileName = (page: Page) => viewer(page).locator('.lightbox-name')
const image = (page: Page) => viewer(page).locator('img.media-image')
const tile = (page: Page, name: string) => page.getByTestId('drive-items').getByTestId('drive-file').filter({ hasText: name })

/** The image's transform as numbers: pan in px, rotation in degrees, displayed scale. */
const transform = (page: Page) =>
  image(page).evaluate((img) => {
    const text = (img as HTMLElement).style.transform
    const [, x, y] = /translate3d\((-?[\d.]+)px, (-?[\d.]+)px/.exec(text) ?? ['', '0', '0']
    const rotation = /rotate\((-?[\d.]+)deg\)/.exec(text)?.[1] ?? '0'
    const scale = /scale\(([\d.]+)\)/.exec(text)?.[1] ?? '1'
    return { x: Number(x), y: Number(y), rotation: Number(rotation), scale: Number(scale) }
  })

async function centreOf(page: Page) {
  const box = (await viewer(page).locator('.lightbox-stage').boundingBox())!
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
}

async function openDrive(page: Page) {
  await signIn(page, user)
  await page.goto('/drive')
  await dismissAnnouncements(page)
  await page.getByTestId('drive-layout-list').click()
  await expect(tile(page, 'agenda.txt')).toBeVisible({ timeout: 30000 })
}

// A double click on a file not yet selected does not reach open-file; the file is selected first.
async function openFile(page: Page, name: string) {
  await tile(page, name).click()
  await tile(page, name).dblclick()
}

/** Tap a file, then its picture in Details: a phone's way in. */
async function openFromDetails(page: Page, name: string) {
  await tile(page, name).tap()
  await page.getByTestId('drive-details-open-media').tap()
}

async function opened(page: Page, name: string) {
  await expect(viewer(page)).toBeVisible()
  await expect(fileName(page)).toHaveText(name)
}

async function loaded(page: Page, width: number) {
  await expect.poll(() => image(page).evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth), { timeout: 15000 }).toBe(width)
}

async function downloadOf(page: Page, click: () => Promise<void>): Promise<Download> {
  const download = page.waitForEvent('download', { timeout: 30000 })
  await click()
  return download
}

test('a Drive file opens in the media viewer: zoom, pan, rotate, step, download and close', async ({ page }) => {
  test.setTimeout(180_000)
  await openDrive(page)
  await openFile(page, 'harbour.png')
  await opened(page, 'harbour.png')
  await expect(position(page)).toHaveText('1 of 4')
  await loaded(page, 800)

  await test.step('the scrim is dark and blurs the page behind', async () => {
    const style = await viewer(page).evaluate((el) => {
      const overlay = getComputedStyle(el.parentElement!)
      return { blur: overlay.backdropFilter, background: overlay.backgroundColor }
    })
    expect(style.blur).toBe('blur(24px)')
    expect(style.background).toBe('rgba(0, 0, 0, 0.88)')
  })

  await test.step('the toolbar, the wheel, a double click and the keys zoom the image', async () => {
    const zoomOut = viewer(page).getByRole('button', { name: 'Zoom out' })
    await expect(zoomOut).toBeDisabled()
    await viewer(page).getByRole('button', { name: 'Zoom in' }).click()
    await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(1.25, 2)
    await zoomOut.click()
    await expect.poll(async () => (await transform(page)).scale).toBe(1)

    const c = await centreOf(page)
    await page.mouse.move(c.x, c.y)
    await page.mouse.wheel(0, -100)
    await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(1.25, 2)
    await page.mouse.dblclick(c.x, c.y)
    await expect.poll(async () => (await transform(page)).scale).toBe(1)
    await page.keyboard.press('+')
    await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(1.25, 2)
    await page.keyboard.press('0')
    await expect.poll(async () => (await transform(page)).scale).toBe(1)
    await page.mouse.dblclick(c.x, c.y)
    await expect.poll(async () => (await transform(page)).scale).toBe(2.5)
  })

  await test.step('a drag pans the zoomed image no further than its edge', async () => {
    const c = await centreOf(page)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(c.x - 150, c.y, { steps: 5 })
    await page.mouse.up()
    await expect.poll(async () => (await transform(page)).x).toBeCloseTo(-150, 0)
    await page.mouse.move(c.x, c.y)
    await page.mouse.down()
    await page.mouse.move(c.x - 2000, c.y, { steps: 5 })
    await page.mouse.up()
    const edge = await viewer(page).evaluate((el) => {
      const img = el.querySelector<HTMLImageElement>('img.media-image')!
      const stage = el.querySelector<HTMLElement>('.lightbox-stage')!.getBoundingClientRect()
      return -(img.offsetWidth * 2.5 - stage.width) / 2
    })
    await expect.poll(async () => (await transform(page)).x).toBeCloseTo(edge, 0)
    await expect(viewer(page)).toBeVisible()
  })

  await test.step('Rotate turns the image a quarter and recentres it', async () => {
    await viewer(page).getByRole('button', { name: 'Rotate right' }).click()
    await expect.poll(() => transform(page)).toMatchObject({ x: 0, y: 0, rotation: 90 })
  })

  await test.step('the next file shows reset, and Download saves it under its name', async () => {
    await page.keyboard.press('ArrowRight')
    await opened(page, 'lighthouse.png')
    await expect(position(page)).toHaveText('2 of 4')
    await loaded(page, 600)
    expect(await transform(page)).toEqual({ x: 0, y: 0, rotation: 0, scale: 1 })
    const download = await downloadOf(page, () => viewer(page).getByTestId('lightbox-download').click())
    expect(download.suggestedFilename()).toBe('lighthouse.png')
  })

  await test.step('a PDF shows in a frame, without image tools', async () => {
    await viewer(page).getByRole('button', { name: 'Next' }).click()
    await opened(page, 'notes.pdf')
    await expect(position(page)).toHaveText('3 of 4')
    await expect(viewer(page).locator('iframe.media-pdf-frame')).toHaveAttribute('src', /\/message_media\/u\//)
    await expect(viewer(page).getByRole('button', { name: 'Rotate right' })).toHaveCount(0)
    await expect(viewer(page).getByRole('button', { name: 'Zoom in' })).toHaveCount(0)
  })

  await test.step('a text file shows its card, whose Download saves it', async () => {
    await page.keyboard.press('ArrowRight')
    await opened(page, 'agenda.txt')
    await expect(position(page)).toHaveText('4 of 4')
    await expect(viewer(page).getByRole('button', { name: 'Next' })).toHaveCount(0)
    const card = viewer(page).locator('.media-file-card')
    await expect(card).toContainText('No preview for this file.')
    const download = await downloadOf(page, () => card.getByRole('button', { name: 'Download' }).click())
    expect(download.suggestedFilename()).toBe('agenda.txt')
  })

  await test.step('Escape closes the viewer and focus returns to the file', async () => {
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
    await expect(page).toHaveURL(/\/drive/)
    await expect(tile(page, 'harbour.png')).toBeFocused()
  })

  await test.step("the picture in Details opens the same viewer at its file", async () => {
    await tile(page, 'lighthouse.png').click()
    const opener = page.getByTestId('drive-details-open-media')
    await opener.click()
    await opened(page, 'lighthouse.png')
    await expect(position(page)).toHaveText('2 of 4')
    await viewer(page).getByRole('button', { name: 'Previous' }).click()
    await opened(page, 'harbour.png')
    await viewer(page).getByRole('button', { name: 'Close' }).click()
    await expect(viewer(page)).toBeHidden()
    await expect(opener).toBeFocused()
  })
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  type Point = { x: number; y: number }

  // Real touch input through CDP: the page sees trusted touch pointer events.
  async function touch(page: Page, paths: Point[][], steps = 10) {
    const cdp = await page.context().newCDPSession(page)
    const at = (i: number) => paths.map((p, id) => {
      const from = p[0]
      const to = p[p.length - 1]
      return { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps, id }
    })
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: at(0) })
    for (let i = 1; i <= steps; i++) {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: at(i) })
    }
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    await cdp.detach()
  }

  test('swipes step through the files, a pinch and a double tap zoom, a swipe down and Back close', async ({ page }) => {
    test.setTimeout(180_000)
    await openDrive(page)
    await openFromDetails(page, 'harbour.png')
    await opened(page, 'harbour.png')
    await expect(position(page)).toHaveText('1 of 4')
    await loaded(page, 800)

    await test.step('a swipe left shows the next file, a swipe right the one before', async () => {
      const c = await centreOf(page)
      await touch(page, [[{ x: c.x + 140, y: c.y }, { x: c.x - 140, y: c.y }]])
      await opened(page, 'lighthouse.png')
      await expect(position(page)).toHaveText('2 of 4')
      await touch(page, [[{ x: c.x - 140, y: c.y }, { x: c.x + 140, y: c.y }]])
      await opened(page, 'harbour.png')
      await loaded(page, 800)
    })

    await test.step('a pinch zooms, one finger pans the zoomed image, a double tap zooms back out', async () => {
      const { x, y } = await centreOf(page)
      await touch(page, [
        [{ x: x - 30, y }, { x: x - 130, y }],
        [{ x: x + 30, y }, { x: x + 130, y }],
      ])
      await expect.poll(async () => (await transform(page)).scale).toBeGreaterThan(2)
      const before = (await transform(page)).x
      await touch(page, [[{ x, y }, { x: x - 60, y }]])
      await expect.poll(async () => (await transform(page)).x).toBeLessThan(before - 30)
      await expect(position(page)).toHaveText('1 of 4')
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(async () => (await transform(page)).scale).toBe(1)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(async () => (await transform(page)).scale).toBeCloseTo(2.5, 1)
      await page.touchscreen.tap(x, y)
      await page.touchscreen.tap(x, y)
      await expect.poll(async () => (await transform(page)).scale).toBe(1)
    })

    await test.step('Rotate is on the toolbar; the zoom buttons give way to the pinch', async () => {
      await expect(viewer(page).getByRole('button', { name: 'Rotate right' })).toBeVisible()
      await expect(viewer(page).getByRole('button', { name: 'Zoom in' })).toBeHidden()
    })

    await test.step('a swipe down closes the viewer and stays in Drive', async () => {
      const c = await centreOf(page)
      await touch(page, [[{ x: c.x, y: c.y - 100 }, { x: c.x, y: c.y + 220 }]])
      await expect(viewer(page)).toBeHidden()
      await expect(page).toHaveURL(/\/drive/)
    })

    await test.step('Back closes the viewer and stays in Drive', async () => {
      // Chrome yields no click for a tap right after the synthetic swipe; the tap repeats until one opens.
      await expect(async () => {
        await page.getByTestId('drive-details-open-media').tap()
        await expect(viewer(page)).toBeVisible({ timeout: 1000 })
      }).toPass({ timeout: 15000 })
      await opened(page, 'harbour.png')
      await page.goBack()
      await expect(viewer(page)).toBeHidden()
      await page.waitForTimeout(400)
      await expect(page).toHaveURL(/\/drive/)
      await expect(tile(page, 'agenda.txt')).toBeVisible()
    })
  })
})
