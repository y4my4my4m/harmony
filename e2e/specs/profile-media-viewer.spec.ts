// Journey: a profile's Media tab opens its pictures in the media viewer. The viewer counts
// the pictures of the grid, steps with the arrow keys, zooms and rotates a picture, offers
// Download, closes on Escape with focus back on the tile, and View post leaves for the post.
// A video plays on its own, repeats, and opens muted when the viewer was last left muted.
//
// Media are fixtures served at fixed URLs: generated SVGs and the 6 s VP9/Opus WebM clip.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const FIXTURES = 'https://fixtures.harmony.test'
const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${fill}"/><circle cx="400" cy="300" r="120" fill="#fff"/></svg>`
const PICTURES: Record<string, string> = { 'pier.svg': '#0ea5e9', 'dunes.svg': '#f97316' }
const CLIP = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '../fixtures/clip-6s.webm'))

const admin = adminClient()
let user: SpecUser
let videoUser: SpecUser
let postId: string

test.beforeAll(async () => {
  user = await createUser(admin, 'pmview')
  const { data, error } = await admin.from('posts').insert({
    author_id: user.id,
    visibility: 'public',
    is_local: true,
    content: [{ type: 'text', text: 'two from the coast' }],
    media_attachments: [
      { type: 'image', url: `${FIXTURES}/pier.svg`, mime_type: 'image/svg+xml', description: 'The pier at dawn' },
      { type: 'image', url: `${FIXTURES}/dunes.svg`, mime_type: 'image/svg+xml', description: 'Dunes' },
    ],
  }).select('id').single()
  if (error || !data) throw new Error(`post: ${error?.message}`)
  postId = data.id

  videoUser = await createUser(admin, 'pmvideo')
  const { error: videoError } = await admin.from('posts').insert({
    author_id: videoUser.id,
    visibility: 'public',
    is_local: true,
    content: [{ type: 'text', text: 'the swell' }],
    media_attachments: [
      { type: 'video', url: `${FIXTURES}/swell.webm`, mime_type: 'video/webm', description: 'Swell at the breakwater' },
    ],
  })
  if (videoError) throw new Error(`video post: ${videoError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
  await deleteUser(admin, videoUser)
})

const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const shown = (page: Page) => viewer(page).locator('img.media-image')

async function openMediaTab(page: Page, owner: SpecUser) {
  await page.route(`${FIXTURES}/**`, (route) => {
    const name = new URL(route.request().url()).pathname.slice(1)
    if (name.endsWith('.webm')) {
      return route.fulfill({ status: 200, contentType: 'video/webm', body: CLIP, headers: { 'Accept-Ranges': 'bytes' } })
    }
    const fill = PICTURES[name]
    if (!fill) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: picture(fill) })
  })
  await signIn(page, owner)
  await page.goto(`/social/profile/${owner.username}`)
  await dismissAnnouncements(page)
  await page.getByRole('tablist', { name: 'Profile sections' }).getByRole('tab', { name: /^Media/ }).click()
}

test('the Media tab opens its pictures in the media viewer', async ({ page }) => {
  test.setTimeout(180_000)
  await openMediaTab(page, user)
  const tile = page.getByRole('button', { name: /The pier at dawn/ })
  await expect(tile).toBeVisible({ timeout: 30000 })

  await test.step('a tile opens the viewer at its first picture', async () => {
    await tile.click()
    await expect(viewer(page)).toBeVisible()
    await expect(viewer(page).locator('.lightbox-position')).toHaveText('1 of 2')
    await expect(shown(page)).toHaveAttribute('src', `${FIXTURES}/pier.svg`)
    await expect(shown(page)).toHaveAttribute('alt', 'The pier at dawn')
    await expect(viewer(page).getByTestId('lightbox-download')).toBeVisible()
  })

  await test.step('the picture zooms and rotates; the next one shows reset', async () => {
    await viewer(page).getByRole('button', { name: 'Zoom in' }).click()
    await viewer(page).getByRole('button', { name: 'Rotate right' }).click()
    await expect(shown(page)).toHaveAttribute('style', /rotate\(90deg\)/)
    await page.keyboard.press('ArrowRight')
    await expect(viewer(page).locator('.lightbox-position')).toHaveText('2 of 2')
    await expect(shown(page)).toHaveAttribute('src', `${FIXTURES}/dunes.svg`)
    await expect(shown(page)).toHaveAttribute('style', /rotate\(0deg\) scale\(1\)/)
  })

  await test.step('Escape closes the viewer and focus returns to the tile', async () => {
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
    await expect(tile).toBeFocused()
  })

  await test.step('View post leaves the viewer for the post', async () => {
    await tile.click()
    await viewer(page).getByRole('link', { name: 'View post' }).click()
    await expect(viewer(page)).toBeHidden()
    await expect(page).toHaveURL(new RegExp(`/${postId}$`))
  })
})

test('a video of the Media tab plays on its own, repeats, and opens muted as the viewer was left', async ({ page }) => {
  test.setTimeout(180_000)
  await openMediaTab(page, videoUser)
  const tile = page.getByRole('button', { name: /Swell at the breakwater/ })
  await expect(tile).toBeVisible({ timeout: 30000 })
  const video = viewer(page).locator('video.media-video')
  const state = (v: Locator) => v.evaluate((el: HTMLVideoElement) => ({ playing: !el.paused && el.currentTime > 0, loop: el.loop, muted: el.muted }))
  const stored = () => page.evaluate(() => localStorage.getItem('harmony-lightbox-video-muted'))

  async function reopen() {
    await page.keyboard.press('Escape')
    await expect(viewer(page)).toBeHidden()
    await tile.click()
    await expect(viewer(page)).toBeVisible()
  }

  await test.step('the video starts on its own with sound and repeats', async () => {
    await tile.click()
    await expect(viewer(page)).toBeVisible()
    await expect(video).toHaveAttribute('src', `${FIXTURES}/swell.webm`)
    await expect.poll(async () => (await state(video)).playing, { timeout: 15000 }).toBe(true)
    expect(await state(video)).toMatchObject({ loop: true, muted: false })
  })

  await test.step('muted in the viewer, it opens muted the next time', async () => {
    await viewer(page).getByTestId('video-controls').hover()
    await viewer(page).getByTestId('video-mute').click()
    await expect.poll(async () => (await state(video)).muted).toBe(true)
    await expect.poll(stored).toBe('true')
    await reopen()
    await expect.poll(async () => (await state(video)).playing, { timeout: 15000 }).toBe(true)
    expect(await state(video)).toMatchObject({ loop: true, muted: true })
  })

  await test.step('unmuted in the viewer, it opens with sound the next time', async () => {
    await viewer(page).getByTestId('video-controls').hover()
    await viewer(page).getByTestId('video-mute').click()
    await expect.poll(async () => (await state(video)).muted).toBe(false)
    await expect.poll(stored).toBe('false')
    await reopen()
    await expect.poll(async () => (await state(video)).playing, { timeout: 15000 }).toBe(true)
    expect((await state(video)).muted).toBe(false)
  })
})
