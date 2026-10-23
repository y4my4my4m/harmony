// Journey: appearance sync per device. Two browser contexts are two devices of one account.
// - A device with sync off keeps its own theme; the account copy and the other device keep
//   theirs. Its other settings (the video player) still reach the account.
// - Turning sync on asks which look stands. "This device's" writes it to the account, and the
//   other device takes it at its next start; "The one from your other devices" switches this
//   device to the account's.

import { test, expect, type Browser, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'appsync')
  const { error } = await admin.from('profiles')
    .update({ appearance_settings: { theme: 'light', savedAt: 1 } }).eq('id', user.id)
  if (error) throw new Error(`appearance: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

const themeRadio = (page: Page, name: string) =>
  page.getByTestId('theme-options').getByRole('radio', { name, exact: true })
const saveBar = (page: Page) => page.getByTestId('appearance-save-bar')
const syncSwitch = (page: Page) => page.getByRole('switch', { name: 'Sync appearance across devices' })
const dataTheme = (page: Page) => page.evaluate(() => document.documentElement.getAttribute('data-theme'))

async function account(): Promise<{ theme?: string; videoPlayer?: string }> {
  const { data } = await admin.from('profiles').select('appearance_settings').eq('id', user.id).single()
  return ((data as { appearance_settings: Record<string, string> | null }).appearance_settings) ?? {}
}

async function device(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage()
  await signIn(page, user)
  await openAppearance(page)
  return page
}

async function openAppearance(page: Page) {
  await page.goto('/settings/appearance')
  await dismissAnnouncements(page)
  await expect(page.getByTestId('theme-options')).toBeVisible({ timeout: 30000 })
}

async function save(page: Page) {
  const written = page.waitForResponse(
    (r) => r.url().includes('/rest/v1/profiles') && r.request().method() === 'PATCH', { timeout: 15000 })
  await saveBar(page).getByRole('button', { name: 'Save changes' }).click()
  await expect(saveBar(page)).toBeHidden()
  return written
}

test('a device keeps its own appearance until sync is turned on again', async ({ browser }) => {
  test.setTimeout(180_000)
  const a = await device(browser)
  const b = await device(browser)
  await expect(themeRadio(a, 'Light')).toBeChecked()
  await expect(syncSwitch(a)).toHaveAttribute('aria-checked', 'true')

  await test.step('device A turns sync off and picks Midnight; the account and device B keep Light', async () => {
    await syncSwitch(a).click()
    await expect(a.getByTestId('appearance-sync-adopt')).toHaveCount(0)
    await expect(a.getByTestId('appearance-sync')).toContainText('This device keeps its own theme')
    await themeRadio(a, 'Midnight').check({ force: true })
    await save(a)
    expect(await dataTheme(a)).toBe('midnight')
    await a.waitForTimeout(1500)
    expect((await account()).theme).toBe('light')

    await a.reload()
    await expect(themeRadio(a, 'Midnight')).toBeChecked({ timeout: 30000 })
    await expect(syncSwitch(a)).toHaveAttribute('aria-checked', 'false')

    await b.reload()
    await expect(themeRadio(b, 'Light')).toBeChecked({ timeout: 30000 })
  })

  await test.step('device A\'s other settings still reach the account', async () => {
    await a.getByTestId('video-player-setting').selectOption('native')
    expect((await save(a)).ok()).toBe(true)
    await expect.poll(async () => (await account()).videoPlayer).toBe('native')
    expect((await account()).theme).toBe('light')
  })

  await test.step('turning sync on with this device\'s look writes it; device B takes it at its next start', async () => {
    await syncSwitch(a).click()
    const adopt = a.getByTestId('appearance-sync-adopt')
    await expect(adopt).toBeVisible()
    await expect(adopt.getByRole('radio', { name: /The one from your other devices/ })).toBeChecked()
    await adopt.getByRole('radio', { name: /This device's/ }).check()
    await save(a)
    await expect.poll(async () => (await account()).theme, { timeout: 15000 }).toBe('midnight')
    expect(await dataTheme(a)).toBe('midnight')

    await b.reload()
    await expect(themeRadio(b, 'Midnight')).toBeChecked({ timeout: 30000 })
    expect(await dataTheme(b)).toBe('midnight')
  })

  await test.step('turning sync on with the other devices\' look switches this device to it', async () => {
    await syncSwitch(b).click()
    await themeRadio(b, 'Dark').check({ force: true })
    await save(b)
    expect(await dataTheme(b)).toBe('dark')
    await b.waitForTimeout(1500)
    expect((await account()).theme).toBe('midnight')

    await syncSwitch(b).click()
    await b.getByTestId('appearance-sync-adopt').getByRole('radio', { name: /The one from your other devices/ }).check()
    await save(b)
    await expect.poll(() => dataTheme(b)).toBe('midnight')
    await expect(themeRadio(b, 'Midnight')).toBeChecked()
  })

  await a.context().close()
  await b.context().close()
})
