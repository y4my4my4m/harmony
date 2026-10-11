// Journey: the Direct messages button returns to the conversation last opened, as Discord's
// Home button does. From a server channel it opens that conversation; pressed again while in
// DMs it shows the conversation list. On a phone the list is the DM page and the button
// opens it.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  dismissAnnouncements,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let alice: SpecUser
let bob: SpecUser
let server: SeededServer
let withAlice = ''
let withBob = ''

async function directConversation(a: SpecUser, b: SpecUser, text: string): Promise<string> {
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: a.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  await admin.from('conversation_participants').insert([
    { conversation_id: data.id, user_id: a.id },
    { conversation_id: data.id, user_id: b.id },
  ])
  await admin.from('messages').insert({ conversation_id: data.id, user_id: b.id, content: [{ type: 'text', text }] })
  return data.id
}

test.beforeAll(async () => {
  me = await createUser(admin, 'dmr')
  alice = await createUser(admin, 'dmra')
  bob = await createUser(admin, 'dmrb')
  server = await seedServer(admin, me, `Return ${me.username}`)
  withAlice = await directConversation(me, alice, 'hi from alice')
  withBob = await directConversation(me, bob, 'hi from bob')
})

test.afterAll(async () => {
  await deleteUser(admin, me)
  await deleteUser(admin, alice)
  await deleteUser(admin, bob)
})

const dmButton = (page: Page) =>
  page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Direct messages/ })

test('Direct messages returns to the last opened conversation, then shows the list', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, me)
  await page.goto(`/dm/${withAlice}`)
  await dismissAnnouncements(page)
  await expect(page.locator('[data-testid="message-list"]').getByText('hi from alice')).toBeVisible({ timeout: 30000 })
  // The newest incoming message (bob's) does not decide; the last opened one does.
  await admin.from('messages').insert({ conversation_id: withBob, user_id: bob.id, content: [{ type: 'text', text: 'bob again' }] })

  await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
  await expect(page.locator('[data-testid="message-list"]')).toBeVisible({ timeout: 30000 })
  await dmButton(page).click()
  await expect(page).toHaveURL(new RegExp(`/dm/${withAlice}$`))
  await expect(page.locator('[data-testid="message-list"]').getByText('hi from alice')).toBeVisible({ timeout: 30000 })

  await dmButton(page).click()
  await expect(page).toHaveURL(/\/dm\/?$/)
})

test.describe('on a phone', () => {
  const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
  test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

  test('Direct messages opens the conversation list', async ({ page }) => {
    test.setTimeout(150_000)
    await signIn(page, me)
    await page.goto(`/dm/${withAlice}`)
    await dismissAnnouncements(page)
    await expect(page.locator('[data-testid="message-list"]').getByText('hi from alice')).toBeVisible({ timeout: 30000 })
    await page.goto(`/chat/${server.id}/${server.generalChannelId}`)
    await expect(page.locator('[data-testid="message-list"]')).toBeAttached({ timeout: 30000 })
    await page.getByRole('button', { name: 'Navigation menu' }).click()
    await expect(dmButton(page)).toBeVisible({ timeout: 10000 })
    await dmButton(page).click()
    await expect(page).toHaveURL(/\/dm\/?$/)
  })
})
