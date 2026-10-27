// Journey: Trending's time range and the Instances filters open the app's own menu, as the
// post visibility picker does, not the system's <select> list. The chip is a menu button
// named for what it picks and its value; the menu holds menuitemradio options with the
// current one checked. Keyboard: Enter opens on the checked option, arrows move, Enter
// picks and focus returns to the chip; ArrowUp opens on the last option; Escape closes
// without a change. A pick lands in the URL (?range=) as the native select's did.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'socsel')
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('the trending time range is a keyboard-operable menu', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/social/trending')
  await dismissAnnouncements(page)

  const filters = page.getByRole('toolbar', { name: 'Filters' })
  await expect(filters).toBeVisible({ timeout: 30000 })
  const chip = filters.getByRole('button', { name: 'Time range, Last 24 hours' })
  const menu = page.getByRole('menu', { name: 'Time range' })

  await test.step('no native select; the chip is a menu button', async () => {
    await expect(filters.locator('select')).toHaveCount(0)
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('aria-haspopup', 'menu')
    await expect(chip).toHaveAttribute('aria-expanded', 'false')
  })

  await test.step('Enter opens it on the checked option', async () => {
    await chip.focus()
    await page.keyboard.press('Enter')
    await expect(menu).toBeVisible()
    await expect(chip).toHaveAttribute('aria-expanded', 'true')
    await expect(menu.getByRole('menuitemradio')).toHaveText(['Last hour', 'Last 6 hours', 'Last 24 hours', 'Last week', 'Last month'])
    const checked = menu.getByRole('menuitemradio', { name: 'Last 24 hours' })
    await expect(checked).toHaveAttribute('aria-checked', 'true')
    await expect(checked).toBeFocused()
  })

  await test.step('ArrowDown and Enter pick the next one; focus returns to the chip', async () => {
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: 'Last week' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toBeHidden()
    await expect(page).toHaveURL(/[?&]range=7d/)
    const picked = filters.getByRole('button', { name: 'Time range, Last week' })
    await expect(picked).toBeFocused()
  })

  await test.step('ArrowUp opens on the last option; Escape closes without a change', async () => {
    const picked = filters.getByRole('button', { name: 'Time range, Last week' })
    await page.keyboard.press('ArrowUp')
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: 'Last month' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toBeHidden()
    await expect(picked).toBeFocused()
    await expect(page).toHaveURL(/[?&]range=7d/)
  })

  await test.step('a click opens it and a click on an option picks it', async () => {
    await filters.getByRole('button', { name: 'Time range, Last week' }).click()
    await menu.getByRole('menuitemradio', { name: 'Last hour' }).click()
    await expect(menu).toBeHidden()
    await expect(page).toHaveURL(/[?&]range=1h/)
    await expect(filters.getByRole('button', { name: 'Time range, Last hour' })).toBeVisible()
  })

  await test.step('a click elsewhere closes it', async () => {
    await filters.getByRole('button', { name: 'Time range, Last hour' }).click()
    await expect(menu).toBeVisible()
    await page.mouse.click(5, 400)
    await expect(menu).toBeHidden()
  })
})

test('the instance status filter is the same menu', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await page.goto('/social/instances')
  await dismissAnnouncements(page)
  const chip = page.getByRole('button', { name: 'Status, All statuses' })
  await expect(chip).toBeVisible({ timeout: 30000 })
  await expect(page.locator('.explore-controls select')).toHaveCount(0)
  await chip.focus()
  await page.keyboard.press('Enter')
  const menu = page.getByRole('menu', { name: 'Status' })
  await expect(menu.getByRole('menuitemradio', { name: 'All statuses' })).toBeFocused()
  await page.keyboard.press('ArrowDown')
  await page.keyboard.press('Enter')
  await expect(page.getByRole('button', { name: 'Status, Online' })).toBeFocused()
  await expect(page.getByRole('button', { name: 'Software, All software' })).toBeVisible()
})
