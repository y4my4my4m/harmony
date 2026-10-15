// Journey: @everyone and @here are offered in the composer where the member holds Mention
// Everyone in that channel, as handle_role_mention_notifications resolves it. A member whose role
// is allowed it only in #news gets @everyone there and not in #general.

import { test, expect, type Page } from '@playwright/test'
import { addChannel, addMember, adminClient, createUser, deleteUser, openChannel, seedServer, signIn, type SeededServer, type SpecUser } from './harness'

const admin = adminClient()
// Bit position in permission_bit_names().
const MENTION_EVERYONE = 2 ** 20

let owner: SpecUser
let member: SpecUser
let server: SeededServer
let newsId: string

test.beforeAll(async () => {
  owner = await createUser(admin, 'menev')
  member = await createUser(admin, 'menevm')
  server = await seedServer(admin, owner, `Mentions ${owner.username}`)
  await addMember(admin, member, server.id)
  newsId = await addChannel(admin, server, 'news')
  const { data: role, error } = await admin
    .from('server_roles')
    .insert({ server_id: server.id, name: 'announcers', position: 1, permissions: 0 })
    .select('id')
    .single()
  if (error || !role) throw new Error(`role: ${error?.message}`)
  const { error: assignError } = await admin.from('user_roles').insert({ user_id: member.id, role_id: role.id, server_id: server.id })
  if (assignError) throw new Error(`assign: ${assignError.message}`)
  const { error: overrideError } = await admin.from('channel_permission_overrides').insert({
    channel_id: newsId,
    target_type: 'role',
    role_id: role.id,
    allow_permissions: MENTION_EVERYONE,
    deny_permissions: 0,
  })
  if (overrideError) throw new Error(`override: ${overrideError.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, member)
  await deleteUser(admin, owner)
})

async function typeEveryone(page: Page): Promise<void> {
  const input = page.locator('[data-testid="message-input"] .rich-text-editor')
  await input.click()
  await input.pressSequentially('@ever', { delay: 30 })
}

test('Mention Everyone allowed in one channel offers @everyone there only', async ({ page }) => {
  test.setTimeout(90_000)
  await signIn(page, member)

  await test.step('#news, where the role is allowed it, offers @everyone', async () => {
    await openChannel(page, server.id, newsId)
    await typeEveryone(page)
    await expect(page.getByRole('option').filter({ hasText: '@everyone' })).toBeVisible({ timeout: 15000 })
    await page.keyboard.press('Escape')
  })

  await test.step('#general, where it is not, does not', async () => {
    await openChannel(page, server.id, server.generalChannelId)
    await typeEveryone(page)
    // The list either closes or offers no @everyone; give the permission lookup time to land.
    await page.waitForTimeout(1500)
    await expect(page.getByRole('option').filter({ hasText: '@everyone' })).toHaveCount(0)
  })
})
