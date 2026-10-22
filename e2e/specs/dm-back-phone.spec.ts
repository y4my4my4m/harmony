// Journey: on a phone the conversation list is the DM page. A conversation opened from the
// drawer takes the drawer's place in history (utils/overlayHistory.ts), so Back from it
// returns to /dm, which shows the list on screen; Back from the list leaves DMs for the
// channel before. Starting a new conversation stays one tap away on the list.

import { test, expect, devices, type Page } from '@playwright/test'
import {
  adminClient,
  createUser,
  deleteUser,
  messageList,
  openChannel,
  seedServer,
  signIn,
  type SeededServer,
  type SpecUser,
} from './harness'

const admin = adminClient()
let me: SpecUser
let mate: SpecUser
let server: SeededServer
let conversationId = ''

test.beforeAll(async () => {
  me = await createUser(admin, 'dbp')
  mate = await createUser(admin, 'dbpm')
  server = await seedServer(admin, me, `Phone DMs ${me.username}`)
  const { data, error } = await admin.from('conversations').insert({ type: 'direct', created_by: me.id }).select('id').single()
  if (error || !data) throw new Error(`conversation: ${error?.message}`)
  conversationId = data.id
  await admin.from('conversation_participants').insert([
    { conversation_id: conversationId, user_id: me.id },
    { conversation_id: conversationId, user_id: mate.id },
  ])
  await admin.from('messages').insert({ conversation_id: conversationId, user_id: mate.id, content: [{ type: 'text', text: 'hello from mate' }] })
})

test.afterAll(async () => {
  await deleteUser(admin, me)
  await deleteUser(admin, mate)
})

const { viewport, userAgent, deviceScaleFactor, isMobile, hasTouch } = devices['Pixel 7']
test.use({ viewport, userAgent, deviceScaleFactor, isMobile, hasTouch })

const dmButton = (page: Page) =>
  page.getByRole('navigation', { name: 'Servers' }).getByRole('button', { name: /^Direct messages/ })
/** The conversation's row in the list shown as the page, not the one in the closed drawer. */
const pageRow = (page: Page) =>
  page.locator(`main [data-testid="dm-conversation-item"][data-conversation-id="${conversationId}"]`)

test('Back from a conversation opened from the drawer shows the conversation list', async ({ page }) => {
  test.setTimeout(150_000)
  await signIn(page, me)
  await openChannel(page, server.id, server.generalChannelId)
  const channelUrl = page.url()

  await page.getByRole('button', { name: 'Navigation menu' }).click()
  await dmButton(page).tap()
  await expect(page).toHaveURL(/\/dm\/?$/)
  const drawerRow = page.locator(`#app-channel-panel [data-testid="dm-conversation-item"][data-conversation-id="${conversationId}"]`)
  await expect(drawerRow).toBeInViewport({ timeout: 30000 })
  await drawerRow.locator('[data-testid="dm-conversation-link"]').tap()
  await expect(page).toHaveURL(new RegExp(`/dm/${conversationId}$`))
  await expect(messageList(page).getByText('hello from mate')).toBeVisible({ timeout: 30000 })

  await page.goBack()
  await expect(page).toHaveURL(/\/dm\/?$/)
  await expect(pageRow(page)).toBeInViewport({ timeout: 15000 })
  await expect(page.locator('main').getByTestId('dm-new-conversation')).toBeInViewport()

  // The list opens the conversation again; Back returns to the list, then to the channel.
  await pageRow(page).locator('[data-testid="dm-conversation-link"]').tap()
  await expect(page).toHaveURL(new RegExp(`/dm/${conversationId}$`))
  await expect(messageList(page).getByText('hello from mate')).toBeVisible({ timeout: 30000 })
  await page.goBack()
  await expect(pageRow(page)).toBeInViewport({ timeout: 15000 })
  await page.goBack()
  await expect(page).toHaveURL(channelUrl)
})
