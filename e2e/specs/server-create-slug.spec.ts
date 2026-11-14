// Journey: a server is created whatever private servers exist. A new server's slug comes from the
// Latin letters and digits of its name; when a private server the creator cannot see already held
// that slug, the create failed with "Couldn't create the server" (migration 20261114300001).

import { test, expect } from '@playwright/test'
import { adminClient, createUser, deleteUser, dismissAnnouncements, signIn, type SpecUser } from './harness'

const admin = adminClient()
let creator: SpecUser
let other: SpecUser
const tag = `sl${Date.now().toString(36)}`
const hiddenName = `Hidden ${tag}`
const newName = `めじたぐ Hidden ${tag}支部`
let hiddenId = ''

test.beforeAll(async () => {
  creator = await createUser(admin, 'slugc')
  other = await createUser(admin, 'slugo')
  const { data, error } = await admin.from('servers')
    .insert({ name: hiddenName, public: false, owner: other.id }).select('id, slug').single()
  if (error || !data) throw new Error(`private server: ${error?.message}`)
  hiddenId = data.id
  expect(data.slug).toBe(`hidden-${tag}`)
})

test.afterAll(async () => {
  await admin.from('servers').delete().eq('owner', creator.id)
  if (hiddenId) await admin.from('servers').delete().eq('id', hiddenId)
  await deleteUser(admin, creator)
  await deleteUser(admin, other)
})

test('a server whose slug a hidden private server holds is created, with the next slug', async ({ page }) => {
  test.setTimeout(120_000)
  await signIn(page, creator)
  await page.goto('/chat')
  await dismissAnnouncements(page)
  await page.getByRole('button', { name: 'Harmony Portal' }).click()
  await page.getByRole('dialog', { name: 'Discover communities' }).locator('.create-server-btn').click()
  await page.locator('[data-testid="create-server-name-input"]').fill(newName)
  await page.locator('[data-testid="create-server-btn"]').click()

  await expect.poll(async () => (await admin.from('servers').select('id').eq('owner', creator.id)).data?.length ?? 0,
    { timeout: 20000 }).toBe(1)
  const { data: made } = await admin.from('servers').select('id, name, slug').eq('owner', creator.id).single()
  expect(made?.name).toBe(newName)
  expect(made?.slug).toBe(`hidden-${tag}-1`)
  await page.waitForURL(new RegExp(`/chat/${made?.id}`), { timeout: 30000 })
  await expect(page.getByRole('dialog', { name: /Create (a|your) server/i })).toHaveCount(0)
})
