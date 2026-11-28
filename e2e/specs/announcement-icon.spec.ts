// Journey: an announcement's Icon field takes an emoji or a name, as the admin form says. An
// emoji shows as typed and `megaphone` as the megaphone icon, in the pop-up, on Today and in
// User settings → Announcements; an unknown word shows the info icon.
//
// Announcements are instance-wide: these end 15 minutes after they start and are deleted
// afterwards.
import { test, expect, type Locator } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser
const ids: string[] = []
const tag = Date.now().toString(36)
const EMOJI_TITLE = `Emoji icon ${tag}`
const NAMED_TITLE = `Megaphone icon ${tag}`
const UNKNOWN_TITLE = `Unknown icon ${tag}`

test.beforeAll(async () => {
  user = await createUser(admin, 'annicon')
  // The pop-up shows announcements that start after the account was made.
  const now = Date.now()
  for (const [title, icon, offset] of [[EMOJI_TITLE, '📣', 300], [NAMED_TITLE, 'megaphone', 200], [UNKNOWN_TITLE, 'party', 100]] as const) {
    const { data, error } = await admin
      .from('instance_announcements')
      .insert({
        title,
        content: `<p>${title}</p>`,
        icon,
        is_active: true,
        show_popup: true,
        starts_at: new Date(now + offset).toISOString(),
        ends_at: new Date(now + 15 * 60_000).toISOString(),
      })
      .select('id')
      .single()
    if (error || !data) throw new Error(`announcement ${title}: ${error?.message}`)
    ids.push(data.id)
  }
})

test.afterAll(async () => {
  if (ids.length) await admin.from('instance_announcements').delete().in('id', ids)
  await deleteUser(admin, user)
})

async function expectIcons(card: (title: string) => Locator) {
  await expect(card(EMOJI_TITLE).getByText('📣', { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(card(EMOJI_TITLE).locator('.icon-wrap.icon-info')).toHaveCount(0)
  await expect(card(NAMED_TITLE).locator('.icon-wrap.icon-megaphone')).toHaveCount(1)
  await expect(card(UNKNOWN_TITLE).locator('.icon-wrap.icon-info')).toHaveCount(1)
}

test('an announcement shows the emoji or named icon its admin chose', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, user)

  await test.step('the pop-up', async () => {
    const dialog = page.getByRole('dialog', { name: 'Announcements' })
    await expect(dialog).toBeVisible({ timeout: 30000 })
    await expectIcons((title) => dialog.locator('.announcement-card').filter({ hasText: title }))
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  await test.step('Today', async () => {
    await page.goto('/today')
    await expectIcons((title) => page.locator('.today-announcement').filter({ hasText: title }))
  })

  await test.step('User settings → Announcements', async () => {
    await page.goto('/settings/announcements')
    await expectIcons((title) => page.locator('.announcement-card').filter({ hasText: title }))
  })
})
