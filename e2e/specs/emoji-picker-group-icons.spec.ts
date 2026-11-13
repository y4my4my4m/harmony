// Journey: the emoji picker's personal sections carry real icons. "My Emoji" shows the
// viewer's avatar (a bucket-path avatar_url resolved to a storage URL, drawn round); the
// instance section shows the icon other instances see (instance_config instance_icon), or
// the app icon when none is set. An avatar uploaded in Settings shows in "My Emoji" when the
// picker opens again, without a reload.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { test, expect, type Locator } from '@playwright/test'
import { adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const AVATAR = fs.readFileSync(path.join(ROOT, 'public/default_avatar.webp'))
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
)

const admin = adminClient()
let user: SpecUser
let server: SeededServer
let changer: SpecUser
let changerServer: SeededServer
const emojiIds: string[] = []
const stored: string[] = []
const avatars: string[] = []
let instanceIcon: string | null = null

async function emoji(owner: SpecUser, scope: 'user' | 'instance', name: string): Promise<void> {
  const objectPath = `${owner.id}/${name}.png`
  const { error: uploadError } = await admin.storage.from('emojis').upload(objectPath, PNG, { contentType: 'image/png', upsert: true })
  if (uploadError) throw new Error(`emoji upload: ${uploadError.message}`)
  stored.push(objectPath)
  const url = admin.storage.from('emojis').getPublicUrl(objectPath).data.publicUrl
  const { data, error } = await admin
    .from('emojis')
    .insert({ name, url, server_id: null, domain: null, scope, uploader: scope === 'user' ? owner.id : null, is_ai_generated: false })
    .select('id')
    .single()
  if (error || !data) throw new Error(`emoji ${name}: ${error?.message}`)
  emojiIds.push(data.id)
}

async function avatarOf(owner: SpecUser): Promise<string> {
  const { data } = await admin.from('profiles').select('avatar_url').eq('id', owner.id).single()
  return (data?.avatar_url as string | null) ?? ''
}

async function setAvatar(owner: SpecUser): Promise<void> {
  const avatarPath = `${owner.id}/avatar-e2e.webp`
  const { error: avatarError } = await admin.storage.from('avatars').upload(avatarPath, AVATAR, { contentType: 'image/webp', upsert: true })
  if (avatarError) throw new Error(`avatar upload: ${avatarError.message}`)
  avatars.push(avatarPath)
  const { error } = await admin.from('profiles').update({ avatar_url: avatarPath }).eq('id', owner.id)
  if (error) throw new Error(`avatar_url: ${error.message}`)
}

test.beforeAll(async () => {
  user = await createUser(admin, 'emoic')
  server = await seedServer(admin, user, `Icons ${user.username}`)
  await setAvatar(user)
  await emoji(user, 'user', `mine_${user.username}`.slice(0, 32))
  await emoji(user, 'instance', `inst_${user.username}`.slice(0, 32))
  changer = await createUser(admin, 'emoav')
  changerServer = await seedServer(admin, changer, `Avatar ${changer.username}`)
  await setAvatar(changer)
  await emoji(changer, 'user', `mine_${changer.username}`.slice(0, 32))
  const { data } = await admin.from('instance_config').select('config_value').eq('config_key', 'instance_icon').maybeSingle()
  instanceIcon = typeof data?.config_value === 'string' && data.config_value.trim() ? data.config_value.trim() : null
})

test.afterAll(async () => {
  if (emojiIds.length) await admin.from('emojis').delete().in('id', emojiIds)
  if (stored.length) await admin.storage.from('emojis').remove(stored)
  const uploaded = changer ? await avatarOf(changer) : ''
  if (uploaded && !/^https?:/.test(uploaded)) avatars.push(uploaded)
  if (avatars.length) await admin.storage.from('avatars').remove(avatars)
  await deleteUser(admin, user)
  await deleteUser(admin, changer)
})

const headerIcon = (picker: Locator, title: RegExp) =>
  picker.locator('.section-title-collapsible', { hasText: title }).locator('img').first()

test('My Emoji shows my avatar and the instance section shows the instance icon', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, user)
  await openChannel(page, server.id, server.generalChannelId)
  await page.locator('[data-region="composer"]').getByRole('button', { name: /emoji/i }).last().click()
  const picker = page.locator('.media-picker-popup').first()
  await expect(picker).toBeVisible({ timeout: 15000 })

  const mine = headerIcon(picker, /My Emoji/)
  await expect(mine).toBeVisible({ timeout: 15000 })
  await expect(mine).toHaveAttribute('src', new RegExp(`/avatars/${user.id}/avatar-e2e\\.webp`))
  await expect(mine).toHaveClass(/shape-round\b/)
  await expect.poll(() => mine.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0), { timeout: 15000 }).toBe(true)

  const instance = picker.locator('.section-title-collapsible').filter({ hasText: /Emoji\s*$/ }).filter({ hasNotText: 'My Emoji' }).locator('img').first()
  await expect(instance).toBeVisible()
  const src = await instance.getAttribute('src')
  if (instanceIcon) expect(src).toContain(instanceIcon.replace(/^https?:\/\/[^/]+/, ''))
  else expect(src).toMatch(/\/img\/app_icon_square\.webp$/)
})

test('My Emoji follows an avatar uploaded in Settings, without a reload', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, changer)
  await openChannel(page, changerServer.id, changerServer.generalChannelId)
  await page.evaluate(() => { (window as any).__sameDocument = true })
  const emojiButton = page.locator('[data-region="composer"]').getByRole('button', { name: /emoji/i }).last()
  const picker = page.locator('.media-picker-popup').first()
  const mine = headerIcon(picker, /My Emoji/)

  await emojiButton.click()
  await expect(mine).toHaveAttribute('src', new RegExp(`/avatars/${changer.id}/avatar-e2e\\.webp`), { timeout: 15000 })
  await page.keyboard.press('Escape')
  await expect(picker).toBeHidden()

  await page.locator('[data-region="user"] [data-action="settings"]').click()
  await page.getByRole('navigation', { name: 'Settings sections' }).getByRole('button', { name: 'My account' }).click()
  await page.locator('.user-account-settings .avatar-wrapper input[type="file"]').setInputFiles({
    name: 'avatar.webp',
    mimeType: 'image/webp',
    buffer: AVATAR,
  })
  await page.getByTestId('crop-apply').click()
  await expect(page.getByText('Avatar updated')).toBeVisible({ timeout: 30000 })
  await expect.poll(() => avatarOf(changer)).not.toBe(`${changer.id}/avatar-e2e.webp`)
  const uploaded = (await avatarOf(changer)).replace(/^.*\/avatars\//, '').replace(/\?.*$/, '')

  await page.getByRole('button', { name: 'Close settings' }).click()
  await page.waitForURL(new RegExp(`/chat/${changerServer.id}/${changerServer.generalChannelId}`), { timeout: 15000 })
  await emojiButton.click()
  await expect(mine).toHaveAttribute('src', new RegExp(`/avatars/${uploaded.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`), { timeout: 15000 })
  expect(await page.evaluate(() => (window as any).__sameDocument)).toBe(true)
})
