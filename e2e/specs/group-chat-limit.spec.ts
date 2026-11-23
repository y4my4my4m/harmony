// Journey: a group chat holds 10 people, its creator included, as a Discord group DM. The picker
// counts the spots left and stops at the tenth person; the group is made with all ten. The
// database refuses an eleventh (20261116100001_group_conversation_limit.sql, pgTAP 296).
//
// The creator is an established account. An account younger than new_account_hours may start
// conversations with 5 strangers per hour (new_account_stranger_dms_per_hour,
// 20261109200001_instance_write_limits.sql), and each stranger in a new group counts: a new
// account's group of 10 is refused at the sixth (instance-limits.spec.ts covers the cap).

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let owner: SpecUser
const candidates: SpecUser[] = []

test.beforeAll(async () => {
  owner = await createUser(admin, 'grlo')
  const aged = await admin.from('profiles')
    .update({ created_at: new Date(Date.now() - 30 * 86_400_000).toISOString() }).eq('id', owner.id)
  if (aged.error) throw new Error(`age owner: ${aged.error.message}`)
  for (let i = 0; i < 10; i++) candidates.push(await createUser(admin, 'grlm'))
})

test.afterAll(async () => {
  const { data: groups } = await admin.from('conversations').select('id').eq('created_by', owner?.id ?? '').eq('type', 'group')
  for (const g of groups ?? []) await admin.from('conversations').delete().eq('id', g.id)
  for (const user of candidates) await deleteUser(admin, user)
  await deleteUser(admin, owner)
})

test('the group chat picker stops at 10 people and the group holds them all', async ({ page }) => {
  test.setTimeout(180_000)
  await signIn(page, owner)
  await page.goto('/dm')
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="dm-sidebar"]')).toBeVisible({ timeout: 30000 })

  await page.getByRole('button', { name: 'Create group chat' }).click()
  const spots = page.getByTestId('group-invite-spots')
  await expect(spots).toHaveText('9 spots left')

  await page.getByTestId('group-invite-search').fill('grlm')
  const results = page.getByTestId('group-invite-result')
  await expect(results).toHaveCount(10, { timeout: 15000 })
  for (let picked = 1; picked <= 9; picked++) {
    await results.first().click()
    await expect(page.getByText(`Selected users (${picked})`)).toBeVisible()
  }
  await expect(spots).toHaveText('This group is full: a group holds up to 10 people.')

  // The one left over cannot be picked.
  await expect(results).toHaveCount(1)
  await expect(results).toHaveAttribute('aria-disabled', 'true')
  await results.click()
  await expect(page.getByText('Selected users (9)')).toBeVisible()

  await page.getByRole('button', { name: 'Create group (10)' }).click()
  await expect.poll(async () => {
    const { data } = await admin.from('conversations').select('id').eq('created_by', owner.id).eq('type', 'group')
    if (!data?.length) return 0
    const { count } = await admin.from('conversation_participants')
      .select('id', { count: 'exact', head: true }).eq('conversation_id', data[0].id).is('left_at', null)
    return count ?? 0
  }, { timeout: 30000 }).toBe(10)
})
