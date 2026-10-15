// Journey: personal emojis (20261013100001_user_emojis.sql).
//
// An AI-generated emoji is seeded as the generation webhook leaves it: a user-scope row with
// is_ai_generated, no server and no domain. Its owner opens the picker, which caches the
// personal groups, then in Settings › My emojis renames it and deletes it by keyboard: Escape
// cancels an inline rename without closing settings, results are announced, focus stays on
// the row's controls (then the list heading once it empties), and the picker shows the new
// name and then nothing without a reload.
// An instance admin finds another user's AI emoji only under the User emojis source, deletes
// it, and the deletion is audited as user_emoji_delete.
//
// The stack has no AI backend: emoji images come from the dev server and no generation
// runs. axe covers the settings section, its rename form and the admin list.

import { test, expect, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'
import { expectNoAxeViolations } from './a11y'

const admin = adminClient()
const IMAGE_URL = `${process.env.BASE_URL || 'http://localhost:5173'}/default_server.webp`

let owner: SpecUser
let other: SpecUser
let moderator: SpecUser
let server: SeededServer
let ownerEmojiId: string
let otherEmojiId: string
let aiName: string
let otherName: string

async function seedAiEmoji(user: SpecUser, name: string): Promise<string> {
  const { data, error } = await admin
    .from('emojis')
    .insert({
      name,
      url: IMAGE_URL,
      server_id: null,
      domain: null,
      scope: 'user',
      uploader: user.id,
      is_ai_generated: true,
    })
    .select('id')
    .single()
  if (error || !data) throw new Error(`seed emoji ${name}: ${error?.message}`)
  return data.id
}

test.beforeAll(async () => {
  owner = await createUser(admin, 'uemo')
  other = await createUser(admin, 'uemx')
  moderator = await createUser(admin, 'uema')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', moderator.id)
  if (error) throw new Error(`promote ${moderator.username}: ${error.message}`)
  server = await seedServer(admin, owner, `Emoji Hub ${owner.username}`)
  aiName = `aicat_${owner.username}`
  otherName = `aiowl_${other.username}`
  ownerEmojiId = await seedAiEmoji(owner, aiName)
  otherEmojiId = await seedAiEmoji(other, otherName)
})

test.afterAll(async () => {
  await admin.from('emojis').delete().in('id', [ownerEmojiId, otherEmojiId].filter(Boolean))
  await deleteUser(admin, owner)
  await deleteUser(admin, other)
  await deleteUser(admin, moderator)
})

const picker = (page: Page) => page.locator('.emoji-picker-content')

/** Opens the composer's emoji picker, waits for its personal groups, then closes it. */
async function pickerShows(page: Page, present: string | null, absent: string[]) {
  const trigger = page.locator('[data-testid="message-input"] button[aria-label="Emoji picker"]:visible').first()
  await trigger.click()
  await expect(picker(page)).toBeVisible({ timeout: 15000 })
  // Custom emoji are buttons named ":name:"; their images are decorative.
  if (present) await expect(picker(page).locator(`button[aria-label=":${present}:"]`).first()).toBeVisible({ timeout: 15000 })
  for (const name of absent) await expect(picker(page).locator(`button[aria-label=":${name}:"]`)).toHaveCount(0)
  // The picker is a modal dialog; Escape closes it and returns focus to the trigger.
  await page.keyboard.press('Escape')
  await expect(picker(page)).toBeHidden({ timeout: 5000 })
}

async function openMyEmojis(page: Page) {
  await page.locator('[data-region="user"]').getByRole('button', { name: 'Settings' }).click()
  await page.waitForURL(/\/settings/)
  await page.locator('.settings-sidebar').getByText('My emojis', { exact: true }).click()
  await page.waitForURL(/\/settings\/emojis/)
  const section = page.getByTestId('my-emojis')
  await expect(section).toBeVisible({ timeout: 15000 })
  return section
}

test('the owner renames and deletes an AI emoji by keyboard; the picker follows', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await openChannel(page, server.id, server.generalChannelId)
  await pickerShows(page, aiName, [])

  let section = await openMyEmojis(page)
  const row = section.locator('.emoji-item')
  await expect(row).toHaveCount(1)
  await expect(row).toContainText(`:${aiName}:`)
  await expect(row.locator('.emoji-badge')).toContainText('AI-generated')
  await expect(row).toContainText('not used yet')
  await expectNoAxeViolations(page, { include: '[data-testid="my-emojis"]', label: 'settings/emojis list' })

  const live = page.getByTestId('live-announcer-polite')
  const renameButton = section.getByRole('button', { name: `Rename :${aiName}:` })
  await renameButton.focus()
  await page.keyboard.press('Enter')
  const input = section.getByRole('textbox', { name: `New name for :${aiName}:` })
  await expect(input).toBeFocused()
  await expect(input).toHaveValue(aiName)
  await expectNoAxeViolations(page, { include: '[data-testid="my-emojis"]', label: 'settings/emojis rename form' })

  await page.keyboard.type('discarded')
  await page.keyboard.press('Escape')
  await expect(input).toBeHidden()
  await expect(renameButton).toBeFocused()
  await expect(page).toHaveURL(/\/settings\/emojis/)
  await expect(row).toContainText(`:${aiName}:`)

  const newName = `dancer_${owner.username}`
  await page.keyboard.press('Enter')
  await expect(input).toBeFocused()
  await page.keyboard.type(newName)
  await page.keyboard.press('Enter')
  await expect(row.locator('.emoji-name')).toHaveText(`:${newName}:`)
  await expect(live).toHaveText(`Renamed :${aiName}: to :${newName}:`, { timeout: 5000 })
  await expect(section.getByRole('button', { name: `Rename :${newName}:` })).toBeFocused()
  await expect
    .poll(async () => (await admin.from('emojis').select('name').eq('id', ownerEmojiId).single()).data?.name)
    .toBe(newName)

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chat/${server.id}`))
  await pickerShows(page, newName, [aiName])

  section = await openMyEmojis(page)
  const deleteButton = section.getByRole('button', { name: `Delete :${newName}:` })
  await deleteButton.focus()
  await page.keyboard.press('Enter')
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toBeVisible()
  await expect(dialog).toContainText(`Delete :${newName}:?`)
  await dialog.getByRole('button', { name: 'Delete', exact: true }).focus()
  await page.keyboard.press('Enter')
  await expect(dialog).toBeHidden()
  await expect(section).toContainText('You have no personal emojis yet.')
  await expect(live).toHaveText(`Deleted :${newName}:`, { timeout: 5000 })
  await expect(section.getByRole('heading', { name: 'Your emojis' })).toBeFocused()
  await expect
    .poll(async () => (await admin.from('emojis').select('id').eq('id', ownerEmojiId)).data?.length)
    .toBe(0)

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chat/${server.id}`))
  await pickerShows(page, null, [newName, aiName])
})

test('an instance admin finds a user AI emoji under User emojis and deletes it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, moderator)
  await page.goto('/admin')
  await page.getByRole('tab', { name: 'Emojis' }).click()
  const panel = page.locator('.instance-emoji-admin')
  await expect(panel).toBeVisible({ timeout: 20000 })

  await panel.getByRole('searchbox').fill(otherName)
  await expect(panel.locator('.empty-state')).toHaveText('No instance emojis match.', { timeout: 10000 })

  await panel.getByRole('combobox', { name: 'Source' }).selectOption('user')
  await expect(panel.getByRole('searchbox', { name: 'Search by name or owner' })).toHaveValue(otherName)
  const row = panel.locator('.emoji-row').filter({ hasText: `:${otherName}:` })
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(panel.locator('.emoji-row')).toHaveCount(1)
  await expect(row).toContainText(`owned by @${other.username}`)
  await expect(row.locator('.badge.ai')).toContainText('AI-generated')
  await expect(row.locator('.badge.personal')).toHaveText('personal')
  await expectNoAxeViolations(page, { include: '.instance-emoji-admin', label: 'admin user emojis' })

  await row.getByRole('button', { name: 'Delete' }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText(`Delete :${otherName}: from @${other.username}'s emojis?`)
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.locator('.empty-state')).toHaveText('No user emojis match.', { timeout: 10000 })

  await expect
    .poll(async () => (await admin.from('emojis').select('id').eq('id', otherEmojiId)).data?.length)
    .toBe(0)
  await expect
    .poll(async () => {
      const { data } = await admin
        .from('admin_audit_log')
        .select('action_type, admin_id, action_details')
        .eq('target_id', otherEmojiId)
      return data?.map((r) => [r.action_type, r.admin_id, r.action_details?.owner_username])
    })
    .toEqual([['user_emoji_delete', moderator.id, other.username]])
})
