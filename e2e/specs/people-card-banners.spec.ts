// Journey: people cards carry the profile banner. Trending → People and the followers list
// show each account's banner across the card's top, or its profile colour when it has none.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const BASE_URL = process.env.BASE_URL || 'http://localhost:5173'
// The dev server's own asset stands in for a banner image.
const BANNER = new URL('/default_avatar.webp', BASE_URL).href

let reader: SpecUser
let banner: SpecUser
let plain: SpecUser

test.beforeAll(async () => {
  reader = await createUser(admin, 'pbr')
  banner = await createUser(admin, 'pbb')
  plain = await createUser(admin, 'pbp')
  await admin.from('profiles').update({ banner_url: BANNER, followers_count: 9000 }).eq('id', banner.id)
  await admin.from('profiles').update({ color: '#123456', followers_count: 8999 }).eq('id', plain.id)
  const { error } = await admin.from('follows').insert([
    { follower_id: banner.id, following_id: reader.id, status: 'accepted' },
    { follower_id: plain.id, following_id: reader.id, status: 'accepted' },
  ])
  if (error) throw new Error(`follows: ${error.message}`)
})

test.afterAll(async () => {
  for (const u of [reader, banner, plain]) await deleteUser(admin, u)
})

test('trending people and followers show banners, or the profile colour', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, reader)

  await page.goto('/social/trending')
  await page.getByRole('tab', { name: 'People' }).click()
  const people = page.getByTestId('trending-people')
  const bannerCard = people.locator('.profile-card').filter({ hasText: banner.username })
  await expect(bannerCard.locator('.card-banner img')).toHaveAttribute('src', BANNER, { timeout: 90_000 })
  const plainCard = people.locator('.profile-card').filter({ hasText: plain.username })
  await expect(plainCard.locator('.card-banner')).toHaveCSS('background-color', 'rgb(18, 52, 86)')
  await expect(plainCard.locator('.card-banner img')).toHaveCount(0)

  await page.goto('/social/followers')
  const followerCard = page.locator('.user-card').filter({ hasText: banner.username })
  await expect(followerCard.locator('.card-banner img')).toHaveAttribute('src', BANNER, { timeout: 90_000 })
  await expect(page.locator('.user-card').filter({ hasText: plain.username }).locator('.card-banner')).toHaveCSS('background-color', 'rgb(18, 52, 86)')

  // Rows stack: each starts where the one above it ends.
  await expect.poll(async () => {
    const rows = await page.locator('.virtual-user-row').evaluateAll((els) =>
      els.map((el) => ({ top: el.getBoundingClientRect().top, bottom: el.getBoundingClientRect().bottom }))
        .sort((a, b) => a.top - b.top))
    return rows.length === 2 && rows[1].top >= rows[0].bottom - 1
  }).toBe(true)
})
