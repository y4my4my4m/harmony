// Journey: the Instances directory and its Instance details dialog show a peer's own icon and
// banner, read through the federation backend's probe; a Harmony peer that publishes none shows
// the Harmony app icon, and another peer its monogram. The probe answers and the peer's images
// are stubbed: route() serves them, so the context blocks service workers.

import crypto from 'node:crypto'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let viewer: SpecUser
const tag = crypto.randomUUID().slice(0, 8)
const BRANDED = `brand-${tag}.e2e.test`
const PLAIN = `plain-${tag}.e2e.test`
const OTHER = `other-${tag}.e2e.test`
const ICON = `https://${BRANDED}/storage/v1/object/public/server_icons/instance/icon.png`
const BANNER = `https://${BRANDED}/storage/v1/object/public/server_banners/instance/banner.png`
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)

test.use({ serviceWorkers: 'block' })

test.beforeAll(async () => {
  viewer = await createUser(admin, 'ipb')
  const now = new Date().toISOString()
  const { error } = await admin.from('federated_instances').insert([
    { domain: BRANDED, software: 'harmony', version: '1.9.1', last_seen_at: now, metadata: {} },
    { domain: PLAIN, software: 'harmony', version: '1.9.1', last_seen_at: now, metadata: {} },
    { domain: OTHER, software: 'mastodon', version: '4.5.0', last_seen_at: now, metadata: {} },
  ])
  if (error) throw new Error(`instances: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('federated_instances').delete().in('domain', [BRANDED, PLAIN, OTHER])
  await deleteUser(admin, viewer)
})

async function stubPeers(page: Page) {
  await page.route('**/api/federation/instances/probe**', (route) => {
    const domain = new URL(route.request().url()).searchParams.get('domain')
    if (domain === BRANDED) {
      return route.fulfill({ json: { domain, software: 'harmony', api_available: true, federation_enabled: true, icon_url: ICON, banner_url: BANNER } })
    }
    if (domain === PLAIN || domain === OTHER) {
      return route.fulfill({ json: { domain, software: domain === PLAIN ? 'harmony' : 'mastodon', api_available: true, federation_enabled: true } })
    }
    return route.fulfill({ status: 404, json: { error: 'Could not discover instance' } })
  })
  await page.route(`https://${BRANDED}/**`, (route) => route.fulfill({ contentType: 'image/png', body: PIXEL }))
}

async function openDetails(page: Page, domain: string) {
  const card = page.locator(`.instance-card[aria-label="${domain}"]`)
  await expect(card).toBeVisible({ timeout: 30000 })
  await card.click()
  const modal = page.locator('.instance-detail-modal')
  await expect(modal.locator('.instance-domain')).toHaveText(domain, { timeout: 30000 })
  return modal
}

test('a peer\'s icon and banner appear on its card and in its details', async ({ page }) => {
  test.setTimeout(120_000)
  await stubPeers(page)
  await signIn(page, viewer)
  await page.goto('/social/instances')

  const card = page.locator(`.instance-card[aria-label="${BRANDED}"]`)
  await expect(card.locator('img.instance-icon-img')).toHaveAttribute('src', ICON, { timeout: 30000 })
  await expect(card.locator('.instance-card-banner')).toHaveCSS('background-image', `url("${BANNER}")`)

  const modal = await openDetails(page, BRANDED)
  const icon = modal.locator('.instance-icon-wrap img.instance-icon-img')
  await expect(icon).toHaveAttribute('src', ICON)
  await expect.poll(() => icon.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth)).toBe(1)
  await expect(modal.locator('.instance-modal-banner')).toHaveCSS('background-image', `url("${BANNER}")`)
})

test('without published branding a Harmony peer shows the Harmony icon, another peer its monogram', async ({ page }) => {
  test.setTimeout(120_000)
  await stubPeers(page)
  await signIn(page, viewer)
  await page.goto('/social/instances')

  const plain = await openDetails(page, PLAIN)
  await expect(plain.locator('.instance-icon-wrap img.instance-icon-img')).toHaveAttribute('src', /\/img\/app_icon_square\.webp$/)
  await plain.locator('.close-btn').click()
  await expect(plain).toBeHidden()

  const other = await openDetails(page, OTHER)
  await expect(other.locator('.instance-icon-wrap img')).toHaveCount(0)
  await expect(other.locator('.instance-monogram')).toHaveText('O')
})
