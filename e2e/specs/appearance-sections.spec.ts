// Journey: Appearance with the custom theme opens short. Community presets show three with a
// toggle for the rest; Palette ideas and the Background editor start collapsed and open on
// demand; the palette's quick actions stay usable while it is closed.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'appsec')
  const { error } = await admin.from('profiles').update({ appearance_settings: { theme: 'custom', customThemeMode: 'dark', customPrimaryColor: '#445efc' } }).eq('id', user.id)
  if (error) throw new Error(`appearance: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('the custom theme editor opens with presets trimmed and the palette and background collapsed', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, user)
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  await expect(page.getByRole('radiogroup', { name: 'Theme' }).getByRole('radio', { name: 'Custom', exact: true })).toBeChecked({ timeout: 30000 })

  await test.step('three community presets, a toggle for the rest', async () => {
    const presets = page.locator('.community-presets-section .preset-card')
    await expect(presets).toHaveCount(3)
    const more = page.getByTestId('presets-more')
    await expect(more).toHaveAttribute('aria-expanded', 'false')
    await expect(more).toHaveText(/Show \d+ more/)
    await more.click()
    await expect(more).toHaveAttribute('aria-expanded', 'true')
    expect(await presets.count()).toBeGreaterThan(3)
    await expect(more).toHaveText(/Show fewer/)
    await more.click()
    await expect(presets).toHaveCount(3)
  })

  await test.step('palette ideas start collapsed; the toggle opens them', async () => {
    const toggle = page.getByTestId('palette-ideas-toggle')
    await expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await expect(page.locator('.palette-ideas .pi-grid')).toBeHidden()
    await expect(page.locator('.palette-ideas').getByRole('button', { name: 'Surprise me' })).toBeVisible()
    await toggle.click()
    await expect(toggle).toHaveAttribute('aria-expanded', 'true')
    await expect(page.locator('.palette-ideas .pi-card').first()).toBeVisible()
  })

  await test.step('the background editor starts collapsed', async () => {
    const header = page.locator('.theme-collapse-header').first()
    await expect(header).toContainText('Background')
    await expect(header).toHaveAttribute('aria-expanded', 'false')
    await expect(page.getByRole('group', { name: 'Background color' })).toBeHidden()
    await header.click()
    await expect(page.getByRole('group', { name: 'Background color' })).toBeVisible()
  })
})
