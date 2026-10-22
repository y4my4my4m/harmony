// Journey: My account keeps what the user typed.
// - Opened with nothing edited (a user without a bio), it offers nothing to save.
// - An edit is marked unsaved, survives a switch to another section and back, and Escape
//   asks before discarding it: Escape in the prompt keeps the edit, "Discard changes"
//   leaves Settings with the stored profile unchanged.
// - Uploading an avatar keeps the unsaved display name and bio.

import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Page } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let fresh: SpecUser
let switcher: SpecUser
let uploader: SpecUser

const AVATAR = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../public/default_avatar.webp'),
)

test.beforeAll(async () => {
  fresh = await createUser(admin, 'accfresh')
  switcher = await createUser(admin, 'accswitch')
  uploader = await createUser(admin, 'accupload')
})

test.afterAll(async () => {
  await deleteUser(admin, fresh)
  await deleteUser(admin, switcher)
  await deleteUser(admin, uploader)
})

const account = (page: Page) => page.locator('.user-account-settings')
const nameField = (page: Page) => account(page).getByRole('textbox', { name: 'Display name' })
const bioField = (page: Page) => account(page).getByRole('textbox', { name: 'Bio' })
const nav = (page: Page) => page.getByRole('navigation', { name: 'Settings sections' })
const prompt = (page: Page) => page.getByRole('alertdialog', { name: 'Discard unsaved changes?' })

/** True when the form offers an enabled Save. */
async function saveOffered(page: Page): Promise<boolean> {
  const saves = account(page).getByRole('button', { name: /^Save( changes)?$/ })
  for (const save of await saves.all()) if (await save.isEnabled()) return true
  return false
}

async function storedProfile(user: SpecUser) {
  const { data } = await admin.from('profiles').select('display_name, bio, avatar_url').eq('id', user.id).single()
  return data as { display_name: string; bio: string | null; avatar_url: string | null }
}

async function openAccount(page: Page, user: SpecUser) {
  await signIn(page, user)
  await page.goto('/settings/account')
  await expect(nameField(page)).toHaveValue(user.displayName, { timeout: 30000 })
}

test('opened with nothing edited, My account offers nothing to save', async ({ page }) => {
  test.setTimeout(90_000)
  expect((await storedProfile(fresh)).bio).toBeNull()
  await openAccount(page, fresh)
  await page.waitForTimeout(1000)
  expect(await saveOffered(page)).toBe(false)

  await bioField(page).fill('now there is something')
  await expect.poll(() => saveOffered(page)).toBe(true)
  await bioField(page).fill('')
  await expect.poll(() => saveOffered(page)).toBe(false)
})

test('an unsaved edit survives a section switch; Escape asks before discarding it', async ({ page }) => {
  test.setTimeout(120_000)
  await openAccount(page, switcher)
  const edited = 'Kept Across Sections'

  await test.step('switching to Security and back keeps the edit', async () => {
    await nameField(page).fill(edited)
    await nav(page).getByRole('button', { name: 'Security' }).click()
    await expect(nameField(page)).toHaveCount(0)
    await nav(page).getByRole('button', { name: 'My account' }).click()
    await expect(nameField(page)).toHaveValue(edited)
  })

  await test.step('the edit is marked unsaved', async () => {
    await expect(page.getByRole('region', { name: 'You have unsaved profile changes' })).toBeVisible()
  })

  await test.step('Escape in the field asks; Escape in the prompt keeps the edit and Settings', async () => {
    await nameField(page).focus()
    await page.keyboard.press('Escape')
    await expect(prompt(page)).toBeVisible()
    await expect(page).toHaveURL(/\/settings\/account$/)
    await page.keyboard.press('Escape')
    await expect(prompt(page)).toBeHidden()
    await expect(page).toHaveURL(/\/settings\/account$/)
    await expect(nameField(page)).toHaveValue(edited)
  })

  await test.step('"Discard changes" leaves Settings and stores nothing', async () => {
    await nameField(page).focus()
    await page.keyboard.press('Escape')
    await prompt(page).getByRole('button', { name: 'Discard changes' }).click()
    await page.waitForURL((url) => !url.pathname.startsWith('/settings'), { timeout: 15000 })
    expect((await storedProfile(switcher)).display_name).toBe(switcher.displayName)
  })

  await test.step('reopened, the form shows the stored profile', async () => {
    await page.goto('/settings/account')
    await expect(nameField(page)).toHaveValue(switcher.displayName, { timeout: 30000 })
    expect(await saveOffered(page)).toBe(false)
  })
})

test('uploading an avatar keeps the unsaved display name and bio', async ({ page }) => {
  test.setTimeout(120_000)
  await openAccount(page, uploader)
  const before = await storedProfile(uploader)

  await nameField(page).fill('Typed Before Avatar')
  await bioField(page).fill('bio typed before the avatar')

  await account(page).locator('.avatar-wrapper input[type="file"]').setInputFiles({
    name: 'avatar.webp',
    mimeType: 'image/webp',
    buffer: AVATAR,
  })
  await page.getByTestId('crop-apply').click()
  await expect(page.getByText('Avatar updated')).toBeVisible({ timeout: 30000 })
  await expect.poll(async () => (await storedProfile(uploader)).avatar_url).not.toBe(before.avatar_url)

  await expect(nameField(page)).toHaveValue('Typed Before Avatar')
  await expect(bioField(page)).toHaveValue('bio typed before the avatar')
  expect(await saveOffered(page)).toBe(true)

  await test.step('Save stores both; nothing is left to save', async () => {
    await account(page).getByRole('button', { name: /^Save( changes)?$/ }).click()
    await expect(page.getByText('Profile updated')).toBeVisible({ timeout: 15000 })
    await expect.poll(async () => (await storedProfile(uploader)).display_name).toBe('Typed Before Avatar')
    expect((await storedProfile(uploader)).bio).toBe('bio typed before the avatar')
    await expect.poll(() => saveOffered(page)).toBe(false)
  })
})
