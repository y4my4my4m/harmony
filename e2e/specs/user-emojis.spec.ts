// Journey: personal emojis (20261013100001_user_emojis.sql).
//
// An AI-generated emoji is seeded as the generation webhook leaves it: a user-scope row with
// is_ai_generated, no server and no domain. Its owner opens the picker, which caches the
// personal groups, then in Settings › My emojis renames it and deletes it by keyboard: Escape
// cancels an inline rename without closing settings, results are announced, focus stays on
// the row's controls (then the list heading once it empties), and the picker shows the new
// name and then nothing without a reload.
// An instance admin finds another user's AI emoji under the AI generated kind (not under
// Instance), removes it (a soft delete, audited as emoji_remove) and restores it from Removed.
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
  // The route's late title announcement for /settings/emojis can share the flush.
  await expect(live).toContainText(`Renamed :${aiName}: to :${newName}:`, { timeout: 5000 })
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
  // Removal keeps the row for messages that used it (remove_emoji).
  await expect
    .poll(async () => (await admin.from('emojis').select('deleted_at').eq('id', ownerEmojiId).single()).data?.deleted_at)
    .not.toBeNull()

  await page.goBack()
  await expect(page).toHaveURL(new RegExp(`/chat/${server.id}`))
  await pickerShows(page, null, [newName, aiName])
})

test('an instance admin finds a user AI emoji under AI generated, removes and restores it', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, moderator)
  await page.goto('/admin')
  await page.getByRole('tab', { name: 'Emojis' }).click()
  const panel = page.getByTestId('admin-emoji-library')
  await expect(panel).toBeVisible({ timeout: 20000 })
  const kinds = panel.getByRole('group', { name: 'Kind' })

  const search = panel.getByRole('searchbox', { name: 'Search emojis' })
  await search.fill(otherName)
  const row = panel.getByTestId('admin-emoji-row').filter({ hasText: `:${otherName}:` })
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row).toHaveAttribute('data-kind', 'ai')

  await kinds.getByRole('button', { name: 'Instance', exact: true }).click()
  await expect(panel.getByTestId('admin-emoji-empty')).toContainText('No emojis match.', { timeout: 10000 })

  await kinds.getByRole('button', { name: 'AI generated' }).click()
  await expect(kinds.getByRole('button', { name: 'AI generated' })).toHaveAttribute('aria-pressed', 'true')
  await expect(search).toHaveValue(otherName)
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(panel.getByTestId('admin-emoji-row')).toHaveCount(1)
  await expect(row).toContainText(`owned by @${other.username}`)
  await expect(row.locator('.badge.kind')).toHaveText('AI generated')
  await expectNoAxeViolations(page, { include: '[data-testid="admin-emoji-library"]', label: 'admin user emojis' })

  await row.getByRole('button', { name: `Remove :${otherName}:` }).click()
  const dialog = page.getByRole('alertdialog')
  await expect(dialog).toContainText(`Remove :${otherName}:?`)
  await dialog.getByRole('button', { name: 'Remove', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(panel.getByTestId('admin-emoji-empty')).toContainText('No emojis match.', { timeout: 10000 })

  // Soft delete: the row stays, marked removed.
  const removedAt = async () => {
    const { data } = await admin.from('emojis').select('deleted_at').eq('id', otherEmojiId).single()
    return data ? data.deleted_at : 'row missing'
  }
  await expect.poll(async () => typeof (await removedAt())).toBe('string')
  expect(await removedAt()).not.toBe('row missing')
  await expect
    .poll(async () => {
      const { data } = await admin
        .from('admin_audit_log')
        .select('action_type, admin_id, action_details')
        .eq('target_id', otherEmojiId)
      return data?.map((r) => [r.action_type, r.admin_id, r.action_details?.scope])
    })
    .toEqual([['emoji_remove', moderator.id, 'user']])

  await panel.getByRole('combobox', { name: 'Status' }).selectOption('removed')
  await expect(row).toBeVisible({ timeout: 10000 })
  await expect(row).toContainText(`removed by @${moderator.username}`)
  await row.getByRole('button', { name: `Restore :${otherName}:` }).click()
  await expect(panel.getByTestId('admin-emoji-empty')).toContainText('No emojis match.', { timeout: 10000 })
  await expect.poll(removedAt).toBeNull()
})
