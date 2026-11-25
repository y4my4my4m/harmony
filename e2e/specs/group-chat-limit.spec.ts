// Journey: a group chat holds 10 people, its creator included, as a Discord group DM. The picker
// counts the spots left and stops at the tenth person; the group is made with all ten. The
// database refuses an eleventh (20261116100001_group_conversation_limit.sql, pgTAP 296). Add people
// in a conversation's header counts everyone in it, the viewer once: a direct conversation has 8
// spots left, a group of 5 has 5, a full group none.
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
  const { data: groups } = await admin.from('conversations').select('id').eq('created_by', owner?.id ?? '')
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

async function seedConversation(type: 'direct' | 'group', others: SpecUser[]): Promise<string> {
  const { data, error } = await admin.from('conversations').insert({ type, created_by: owner.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  const { error: joinError } = await admin.from('conversation_participants')
    .insert([owner, ...others].map((user) => ({ conversation_id: data.id, user_id: user.id })))
  if (joinError) throw new Error(`participants: ${joinError.message}`)
  return data.id
}

test('Add people in the header of a conversation counts everyone already in it', async ({ page }) => {
  test.setTimeout(180_000)
  const direct = await seedConversation('direct', candidates.slice(0, 1))
  const small = await seedConversation('group', candidates.slice(0, 4))
  const full = await seedConversation('group', candidates.slice(0, 9))
  await signIn(page, owner)

  const openAddPeople = async (id: string) => {
    await page.goto(`/dm/${id}`)
    await dismissAnnouncements(page)
    await page.getByTestId('dm-more').click({ timeout: 30000 })
    await page.getByTestId('dm-menu-add-people').click()
    return page.getByTestId('group-invite-spots')
  }
  const participants = page.locator('.existing-participants-section')

  await test.step('a direct conversation becomes a group of both and up to eight more', async () => {
    await expect(await openAddPeople(direct)).toHaveText('8 spots left')
    await expect(participants).toContainText('Current participants (2)')
    await expect(participants.locator('.you-badge')).toHaveCount(1)
  })

  await test.step('a group of five has five spots left', async () => {
    await expect(await openAddPeople(small)).toHaveText('5 spots left')
    await expect(participants).toContainText('Current participants (5)')
  })

  await test.step('a full group takes nobody', async () => {
    await expect(await openAddPeople(full)).toHaveText('This group is full: a group holds up to 10 people.')
    await page.getByTestId('group-invite-search').fill(candidates[9].username)
    const result = page.getByTestId('group-invite-result')
    await expect(result).toHaveCount(1, { timeout: 15000 })
    await expect(result).toHaveAttribute('aria-disabled', 'true')
    await result.click()
    await expect(page.getByText(/^Selected users/)).toHaveCount(0)
  })
})
