// Journey: a theme saved in Appearance survives a reload right after Save.
// - Save writes the profile copy at once; a reload a moment later keeps the saved theme.
// - When the profile write does not land before the reload (offline, slow), the copy saved
//   on this device is newer than the profile's and wins; the profile catches up after load.

import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'apprel')
  const { error } = await admin.from('profiles').update({ appearance_settings: { theme: 'light' } }).eq('id', user.id)
  if (error) throw new Error(`appearance: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const themeRadio = (page: Page, name: string) =>
  page.getByTestId('theme-options').getByRole('radio', { name, exact: true })
const saveBar = (page: Page) => page.getByTestId('appearance-save-bar')
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'))

async function storedTheme(): Promise<string | undefined> {
  const { data } = await admin.from('profiles').select('appearance_settings').eq('id', user.id).single()
  return (data as { appearance_settings: { theme?: string } | null }).appearance_settings?.theme
}

async function openAppearance(page: Page) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  await expect(page.getByTestId('theme-options')).toBeVisible({ timeout: 30000 })
}

/** Reloads, then samples data-theme every 150 ms for 3 s once Appearance is back. */
async function reloadAndSample(page: Page): Promise<Array<string | null>> {
  await page.reload()
  await expect(page.getByTestId('theme-options')).toBeVisible({ timeout: 30000 })
  const seen: Array<string | null> = []
  for (let i = 0; i < 20; i++) {
    seen.push(await dataTheme(page))
    await page.waitForTimeout(150)
  }
  return seen
}

async function pickAndSave(page: Page, name: string) {
  await themeRadio(page, name).check({ force: true })
  await expect(saveBar(page)).toBeVisible()
  await saveBar(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(saveBar(page)).toBeHidden()
}

test('a theme saved just before a reload stays', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)
  await openAppearance(page)
  await expect(themeRadio(page, 'Light')).toBeChecked()

  await test.step('Save, then reload at once', async () => {
    await pickAndSave(page, 'Dark')
    const seen = await reloadAndSample(page)
    expect(seen.every((theme) => theme === 'dark'), `data-theme after reload: ${seen.join(',')}`).toBe(true)
    await expect(themeRadio(page, 'Dark')).toBeChecked()
    await expect.poll(storedTheme).toBe('dark')
  })

  await test.step('the profile write fails before the reload: this device\'s newer save wins', async () => {
    await page.route('**/rest/v1/profiles*', (route) => {
      const request = route.request()
      if (request.method() === 'PATCH' && (request.postData() ?? '').includes('appearance_settings')) return route.abort()
      return route.fallback()
    })
    await pickAndSave(page, 'Light')
    await page.waitForTimeout(1500)
    expect(await storedTheme()).toBe('dark')
    await page.unroute('**/rest/v1/profiles*')

    const seen = await reloadAndSample(page)
    expect(seen.every((theme) => theme === 'light'), `data-theme after reload: ${seen.join(',')}`).toBe(true)
    await expect(themeRadio(page, 'Light')).toBeChecked()
    await expect.poll(storedTheme, { timeout: 15000 }).toBe('light')
  })
})
