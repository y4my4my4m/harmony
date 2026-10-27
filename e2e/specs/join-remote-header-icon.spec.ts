// Journey: the Join remote server dialog heads with the tile every dialog header uses: a
// translucent tint of the brand blue behind a glyph in the link colour, computed styles equal to
// Create Channel's header. Run under a custom theme, where the palette writes the brand tokens
// itself. The theme is the profile's appearance_settings, written before the page loads.

import { test, expect, type Locator } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  openCreateChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let user: SpecUser
let server: SeededServer

test.use({ colorScheme: 'dark', serviceWorkers: 'block' })

test.beforeAll(async () => {
  user = await createUser(admin, 'jrh')
  server = await seedServer(admin, user, `Header ${user.username}`)
  const { error } = await admin.from('profiles').update({
    appearance_settings: { theme: 'custom', customThemeMode: 'dark', customAccentColor: '#0EA5E9', customPrimaryColor: '#0EA5E9' },
  }).eq('id', user.id)
  if (error) throw new Error(`appearance: ${error.message}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('id', server.id)
  await deleteUser(admin, user)
})

async function tileColours(tile: Locator, glyph: Locator) {
  return {
    background: await tile.evaluate((el) => getComputedStyle(el).backgroundColor),
    glyph: await glyph.evaluate((el) => getComputedStyle(el).color),
  }
}

/** Alpha of a computed CSS colour: rgb()/rgba() or color(srgb r g b / a). */
function alphaOf(colour: string): number {
  const slash = /\/\s*([\d.]+)\s*\)$/.exec(colour)
  if (slash) return Number(slash[1])
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(colour)
  return rgba ? Number(rgba[1]) : 1
}

test('the Join remote server header tile matches the other dialog headers', async ({ page }) => {
  test.setTimeout(120_000)
  // Discovery is not under test; an empty answer keeps the dialog idle.
  await page.route('**/api/federation/**', (route) => route.fulfill({ status: 404, json: { error: 'not found' } }))
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await expect(page.locator('html')).toHaveAttribute('data-theme-type', 'dark')

  const create = await openCreateChannel(page)
  const reference = await tileColours(create.locator('.icon-container'), create.locator('.modal-icon'))
  await page.keyboard.press('Escape')
  await expect(create).toBeHidden()

  await page.getByRole('button', { name: 'Harmony Portal' }).click()
  await page.getByRole('button', { name: 'Join by URL' }).click()
  const dialog = page.getByRole('dialog', { name: 'Join remote server' })
  await expect(dialog).toBeVisible()
  const join = await tileColours(dialog.locator('.header-icon'), dialog.locator('.header-icon svg'))

  expect(alphaOf(join.background)).toBeLessThan(0.5)
  expect(join).toEqual(reference)
})
