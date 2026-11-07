// Journey: Admin › Funding keeps an edit made while the page is still loading. The settings
// arrive first and can be changed at once; the donation lists load after them. A switch turned
// while a list loads leaves Save enabled, and the save stores it.
//
// instance_funding is snapshotted before and restored after.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'
import { enableFunding } from './funding'

test.use({ serviceWorkers: 'block' })

const admin = adminClient()
let staff: SpecUser
let snapshot: Record<string, unknown> | null = null

test.beforeAll(async () => {
  const { data } = await admin.from('instance_funding').select('*').limit(1).maybeSingle()
  snapshot = data
  staff = await createUser(admin, 'fundd')
  const { error } = await admin.from('profiles').update({ is_admin: true }).eq('id', staff.id)
  if (error) throw new Error(error.message)
  await enableFunding(admin, { messagesPublic: true })
})

test.afterAll(async () => {
  if (snapshot) {
    const { id, ...rest } = snapshot
    await admin.from('instance_funding').update(rest).eq('id', id as string)
  }
  await deleteUser(admin, staff)
})

test('a switch turned while the donation lists load is saved', async ({ page }) => {
  test.setTimeout(90_000)
  let release = () => {}
  const held = new Promise<void>((resolve) => { release = resolve })
  await page.route('**/rest/v1/instance_donation_history*', async (route) => {
    await held
    await route.continue()
  })

  await signIn(page, staff)
  await page.goto('/admin?tab=funding')
  const toggle = page.getByTestId('admin-supporter-messages-public')
  await expect(toggle).toBeChecked({ timeout: 30_000 })

  // The checkbox is drawn as a slider; its label takes the click.
  await page.locator('label.toggle-label', { has: toggle }).click()
  await expect(toggle).not.toBeChecked()
  const listed = page.waitForResponse((r) => r.url().includes('/rest/v1/instance_donation_history'))
  release()
  await listed

  const save = page.locator('.funding-module .save-btn')
  await expect(save).toBeEnabled({ timeout: 10_000 })
  await save.click()
  await expect(save).toBeDisabled({ timeout: 15_000 })
  await expect.poll(async () => {
    const { data } = await admin.from('instance_funding').select('supporter_messages_public').limit(1).single()
    return data?.supporter_messages_public
  }).toBe(false)
})
