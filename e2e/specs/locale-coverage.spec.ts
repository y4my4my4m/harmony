// Journey: a user who chose Dutch sees Dutch on screens whose text was written into the components
// (User settings › Advanced, Admin › Federation) and dates in Dutch notation.

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, signIn, type SpecUser } from './harness'

const admin = adminClient()
let user: SpecUser

test.beforeAll(async () => {
  user = await createUser(admin, 'locnl')
  const { error } = await admin.from('profiles').update({ locale: 'nl', is_admin: true }).eq('id', user.id)
  if (error) throw new Error(`profile: ${error.message}`)
})

test.afterAll(async () => {
  await deleteUser(admin, user)
})

test('Dutch reaches settings, the admin panel and dates', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('harmony-locale', 'nl'))
  await signIn(page, user)

  await page.goto('/settings/advanced')
  await expect(page.locator('html')).toHaveAttribute('lang', 'nl')
  await expect(page.getByText('Bètafuncties').first()).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Account verwijderen').first()).toBeVisible()
  await expect(page.getByText('Beta features')).toHaveCount(0)
  await expect(page.getByText('Danger zone', { exact: false })).toHaveCount(0)

  await page.goto('/admin?tab=federation')
  await expect(page.getByText('Federatiebeheer').first()).toBeVisible({ timeout: 30000 })
  await expect(page.getByText('Federation management')).toHaveCount(0)

  await page.goto('/settings/account')
  const { data: profile } = await admin.from('profiles').select('created_at').eq('id', user.id).single()
  const created = new Date(profile!.created_at as string)
  const opts = { year: 'numeric', month: 'long', day: 'numeric' } as const
  await expect(page.getByText(created.toLocaleDateString('nl', opts), { exact: true })).toBeVisible({ timeout: 30000 })
  await expect(page.getByText(created.toLocaleDateString('en-US', opts), { exact: true })).toHaveCount(0)
})
