// Journey: a profile's Media tab opens its pictures in the media viewer. The viewer counts
// the pictures of the grid, steps with the arrow keys, zooms and rotates a picture, offers
// Download, closes on Escape with focus back on the tile, and View post leaves for the post.
//
// Pictures are fixtures served at fixed URLs: generated SVGs.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const FIXTURES = 'https://fixtures.harmony.test'
const picture = (fill: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600"><rect width="800" height="600" fill="${fill}"/><circle cx="400" cy="300" r="120" fill="#fff"/></svg>`
const PICTURES: Record<string, string> = { 'pier.svg': '#0ea5e9', 'dunes.svg': '#f97316' }

const admin = adminClient()
let user: SpecUser
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
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const viewer = (page: Page) => page.getByRole('dialog', { name: /Media viewer/ })
const shown = (page: Page) => viewer(page).locator('img.media-image')

test('the Media tab opens its pictures in the media viewer', async ({ page }) => {
  test.setTimeout(180_000)
  await page.route(`${FIXTURES}/**`, (route) => {
    const fill = PICTURES[new URL(route.request().url()).pathname.slice(1)]
    if (!fill) return route.fulfill({ status: 404, body: '' })
    return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: picture(fill) })
  })
  await signIn(page, user)
  await page.goto(`/social/profile/${user.username}`)
  await dismissAnnouncements(page)
  await page.getByRole('tablist', { name: 'Profile sections' }).getByRole('tab', { name: /^Media/ }).click()
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
