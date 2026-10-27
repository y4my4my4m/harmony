// Journey: Admin → Emojis, remote emoji importer. A cached remote emoji whose image is gone
// is drawn as the broken-emoji icon after one failed request. The error handler used to set
// the image to /emoji-placeholder.png, which does not exist; that failure re-entered the
// handler, so each dead image requested the placeholder without end.

import crypto from 'node:crypto'
import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
const tag = crypto.randomUUID().slice(0, 8)
const DEAD = `dead-${tag}.e2e.test`
const SHORTCODE = `deadmoji${tag}`
let staff: SpecUser
let emojiId: string

test.beforeAll(async () => {
  staff = await createUser(admin, 'emjimp')
  const { error: adminError } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (adminError) throw new Error(`admin: ${adminError.message}`)
  const { data, error } = await admin
    .from('remote_emojis_cache')
    .insert({
      shortcode: SHORTCODE,
      origin_domain: DEAD,
      full_code: `:${SHORTCODE}@${DEAD}:`,
      url: `https://${DEAD}/emoji/${SHORTCODE}.png`,
      usage_count: 999999,
    })
    .select('id')
    .single()
  if (error) throw new Error(`remote emoji: ${error.message}`)
  emojiId = data.id
})

test.afterAll(async () => {
  await admin.from('remote_emojis_cache').delete().eq('id', emojiId)
  await deleteUser(admin, staff)
})

test('a remote emoji whose image is gone shows the broken icon after one request', async ({ page }) => {
  test.setTimeout(120_000)
  let deadRequests = 0
  let placeholderRequests = 0
  await page.route(`https://${DEAD}/**`, (route) => {
    deadRequests++
    return route.fulfill({ status: 404, body: '' })
  })
  await page.route('**/emoji-placeholder.png', (route) => {
    placeholderRequests++
    return route.fulfill({ status: 404, body: '' })
  })

  await signIn(page, staff)
  await page.goto('/admin?tab=emojis')
  const card = page.locator('.emoji-card').filter({ hasText: `:${SHORTCODE}:` })
  await expect(card).toBeVisible({ timeout: 30000 })
  await expect(card.getByTestId('emoji-importer-broken')).toBeVisible({ timeout: 10000 })
  await expect(card.getByRole('img', { name: `:${SHORTCODE}:` })).toBeVisible()

  // A loop would keep requesting; a settled page has made one request for the dead image.
  await page.waitForTimeout(2000)
  expect(placeholderRequests).toBe(0)
  expect(deadRequests).toBeLessThanOrEqual(2)
})
